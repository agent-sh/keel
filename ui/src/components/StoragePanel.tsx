// Settings > Storage: what Keel keeps on disk, deleting old archived sessions
// (a list first, then the delete), leftovers of deleted sessions, the archive
// policy and the backups.
import { useCallback, useEffect, useState } from "react";
import { api, reportError } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { ago, cn, when } from "../lib/utils.ts";
import { confirmAction } from "./Confirm.tsx";
import { fmtBytes } from "./ResourcesPanel.tsx";
import { Card, SettingRow } from "./Settings.tsx";

type Report = {
  measured_ms: number; state_dir: string; total_bytes: number; database_bytes: number; attachments_bytes: number;
  sessions: { count: number; transcript_bytes: number }; archived_sessions: { count: number; transcript_bytes: number }; subagent_sessions: { count: number; transcript_bytes: number };
  spilled_output_bytes: number; checkpoints_bytes: number; worktrees_bytes: number; reports_bytes: number; backups_bytes: number; plugins_bytes: number;
  leftovers: { count: number; bytes: number };
  by_session: { id: string; title: string; archived: boolean; subagent: boolean; transcript_bytes: number; spill_bytes: number; checkpoints: number; checkpoint_bytes: number; bytes: number; updated_ms: number }[];
  checkpoint_folders: { workspace: string; bytes: number; checkpoints: number; sessions: number; session_list: CheckpointSession[] }[];
  orphan_checkpoints: number;
};
type CheckpointSession = { id: string; title: string; archived: boolean; subagent: boolean; checkpoints: number; checkpoint_bytes: number; updated_ms: number };
type Backup = { name: string; path: string; created_ms: number; reason: string; sessions: number; events: number; bytes: number };
type Candidate = { id: string; title: string; updated_ms: number; bytes: number };

const btn = "h-8 shrink-0 rounded-md border border-line-strong bg-raised px-3 text-ui font-medium hover:bg-hover disabled:opacity-50";

export const useSettings = () => {
  const [s, setS] = useState<Record<string, any> | null>(null);
  useEffect(() => { api<{ settings: Record<string, any> }>("/api/settings").then((r) => setS(r.settings)).catch(reportError); }, []);
  const patch = useCallback((p: Record<string, any>) => api<{ settings: Record<string, any> }>("/api/settings", { method: "PATCH", body: JSON.stringify(p) }).then((r) => setS(r.settings)), []);
  return [s, patch] as const;
};

// A number of days, or Never when empty.
function DaysField({ value, onSave, label, testid }: { value: number | null; onSave: (v: number | null) => Promise<unknown>; label: string; testid?: string }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  const [bad, setBad] = useState(false);
  useEffect(() => setText(value == null ? "" : String(value)), [value]);
  const save = () => {
    const t = text.trim();
    const v = t === "" ? null : Number(t);
    if (v !== null && (!Number.isInteger(v) || v < 1)) return setBad(true);
    setBad(false);
    if (v !== value) onSave(v).catch((e) => { setBad(true); reportError(e); });
  };
  return (
    <label className={cn("flex h-8 items-center gap-2 rounded-md border bg-raised px-2.5 text-ui", bad ? "border-danger" : "border-line-strong")}>
      <input
        aria-label={label}
        data-testid={testid}
        inputMode="numeric"
        value={text}
        placeholder="Never"
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        className="w-14 bg-transparent text-right tabular-nums outline-none placeholder:text-faint"
      />
      <span className="text-muted">days</span>
    </label>
  );
}

function Bars({ rows }: { rows: { label: string; bytes: number; hint?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.bytes));
  return (
    <div className="flex flex-col gap-2.5 py-4" data-testid="storage-kinds">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[9rem_1fr_5.5rem] items-center gap-3 text-ui">
          <span className="truncate" title={r.hint}>{r.label}</span>
          <div className="h-2 rounded-full bg-sunken">
            <div className="h-2 rounded-full bg-series-1" style={{ width: `${Math.max(r.bytes ? 1 : 0, (r.bytes / max) * 100)}%` }} />
          </div>
          <span className="text-right tabular-nums text-muted">{fmtBytes(r.bytes)}</span>
        </div>
      ))}
    </div>
  );
}

export function StoragePanel() {
  const [r, setR] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState("30");
  const [found, setFound] = useState<{ days: number; sessions: Candidate[]; bytes: number } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [cpDone, setCpDone] = useState<string | null>(null);
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [settings, patch] = useSettings();

  const load = useCallback((refresh = false) => {
    setBusy(true);
    return Promise.all([
      api<Report>(`/api/storage${refresh ? "?refresh=1" : ""}`).then(setR),
      api<{ backups: Backup[] }>("/api/backups").then((b) => setBackups(b.backups)),
    ]).catch(reportError).finally(() => setBusy(false));
  }, []);
  useEffect(() => { load(true); }, [load]);

  const find = async () => {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1) return;
    const x = await api<{ sessions: Candidate[]; bytes: number }>("/api/storage/cleanup", { method: "POST", body: JSON.stringify({ older_than_days: n }) });
    setFound({ days: n, ...x });
    setDone(null);
  };
  const remove = async () => {
    if (!found?.sessions.length) return;
    const ok = await confirmAction({ title: `Delete ${found.sessions.length} archived sessions?`, body: `Their transcripts and spilled output go, ${fmtBytes(found.bytes)} in all. This cannot be undone; a backup can bring them back.`, action: "Delete", danger: true });
    if (!ok) return;
    const x = await api<{ deleted: string[]; skipped: { why: string }[] }>("/api/storage/cleanup", {
      method: "POST", body: JSON.stringify({ older_than_days: found.days, sessions: found.sessions.map((s) => ({ id: s.id, updated_ms: s.updated_ms })) }),
    });
    setDone(`Deleted ${x.deleted.length}${x.skipped.length ? `; ${x.skipped.length} skipped (${[...new Set(x.skipped.map((s) => s.why))].join(", ")})` : ""}.`);
    setFound(null);
    load(true);
  };

  const dropCheckpoints = async (what: { sessions?: string[]; archived?: boolean }, label: string) => {
    const ok = await confirmAction({ title: `Drop the checkpoints ${label}?`, body: "Their turns can no longer be rewound. Files in the folder are not touched.", action: "Drop", danger: true });
    if (!ok) return;
    const x = await api<{ removed_checkpoints: number; freed_bytes: number }>("/api/storage/checkpoints", { method: "POST", body: JSON.stringify(what) });
    setCpDone(`Dropped ${x.removed_checkpoints} checkpoints; ${fmtBytes(x.freed_bytes)} freed.`);
    load(true);
  };

  if (!r) return <div className="text-ui text-faint">Measuring.</div>;
  const other = r.plugins_bytes + r.reports_bytes;
  return (
    <div className="flex flex-col gap-4" data-testid="storage-panel">
      <Card>
        <div className="flex items-center gap-3 border-b border-line py-4">
          <div className="min-w-0 flex-1">
            <div className="text-title font-semibold tabular-nums tracking-[-0.01em]" data-testid="storage-total">{fmtBytes(r.total_bytes)}</div>
            <div className="truncate font-mono text-caption text-faint" title={r.state_dir}>{r.state_dir}</div>
          </div>
          <span className="text-caption text-faint" title={when(r.measured_ms)}>measured {ago(r.measured_ms) === "now" ? "just now" : `${ago(r.measured_ms)} ago`}</span>
          <button type="button" className={btn} disabled={busy} onClick={() => load(true)}>{busy ? "Measuring" : "Measure again"}</button>
        </div>
        <Bars rows={[
          { label: "Conversations", bytes: r.database_bytes, hint: `${r.sessions.count} sessions, ${r.archived_sessions.count} archived, ${r.subagent_sessions.count} subagents; ${fmtBytes(r.attachments_bytes)} of attachments` },
          { label: "Checkpoints", bytes: r.checkpoints_bytes, hint: "file snapshots per turn, for rewind" },
          { label: "Worktrees", bytes: r.worktrees_bytes },
          { label: "Spilled output", bytes: r.spilled_output_bytes, hint: "long tool output and command logs" },
          { label: "Backups", bytes: r.backups_bytes },
          { label: "Other", bytes: other, hint: "plugin data and reports" },
        ]} />
      </Card>

      <Card>
        <div className="py-4">
          <div className="text-base font-medium">Delete old archived sessions</div>
          <div className="mt-0.5 text-ui text-muted">Lists the sessions archived at least this long ago. Nothing is deleted until you confirm the list.</div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="flex h-8 items-center gap-2 rounded-md border border-line-strong bg-raised px-2.5 text-ui">
              <span className="text-muted">Archived</span>
              <input aria-label="Days archived" data-testid="cleanup-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} onKeyDown={(e) => e.key === "Enter" && find().catch(reportError)} className="w-12 bg-transparent text-right tabular-nums outline-none" />
              <span className="text-muted">days ago or more</span>
            </label>
            <button type="button" className={btn} onClick={() => find().catch(reportError)} data-testid="cleanup-find">Find</button>
            {done && <span className="text-ui text-muted" data-testid="cleanup-done">{done}</span>}
          </div>
          {found && (
            <div className="mt-3 rounded-md border border-line" data-testid="cleanup-list">
              {found.sessions.length === 0 && <p className="px-3 py-3 text-ui text-faint">No archived session is that old.</p>}
              {found.sessions.slice(0, 12).map((s) => (
                <div key={s.id} className="flex h-9 items-center gap-3 border-b border-line/60 px-3 text-ui last:border-0">
                  <span className="min-w-0 flex-1 truncate">{s.title || "Untitled"}</span>
                  <span className="text-caption tabular-nums text-faint" title={when(s.updated_ms)}>{ago(s.updated_ms)}</span>
                  <span className="w-16 text-right text-caption tabular-nums text-muted">{fmtBytes(s.bytes)}</span>
                </div>
              ))}
              {found.sessions.length > 12 && <p className="px-3 py-2 text-caption text-faint">and {found.sessions.length - 12} more</p>}
              {found.sessions.length > 0 && (
                <div className="flex items-center justify-end gap-3 border-t border-line px-3 py-2">
                  <span className="text-caption text-muted">{found.sessions.length} sessions, {fmtBytes(found.bytes)}</span>
                  <button type="button" onClick={() => remove().catch(reportError)} data-testid="cleanup-delete" className="h-8 rounded-md bg-danger px-3 text-ui font-medium text-accent-fg hover:opacity-90">Delete {found.sessions.length}</button>
                </div>
              )}
            </div>
          )}
        </div>
        {r.leftovers.count > 0 && (
          <SettingRow label="Leftovers" hint={`${fmtBytes(r.leftovers.bytes)} of spilled output from ${r.leftovers.count} sessions that were deleted.`}>
            <button type="button" className={btn} onClick={() => api("/api/storage/cleanup", { method: "POST", body: JSON.stringify({ leftovers: true }) }).then(() => load(true)).catch(reportError)}>Remove</button>
          </SettingRow>
        )}
      </Card>

      {settings && (
        <Card>
          <SettingRow label="Archive idle sessions" hint="A session nobody touched for this long moves to Archived. Empty is never.">
            <DaysField label="Archive idle sessions after days" testid="archive-idle" value={settings.archive.archive_idle_days} onSave={(v) => patch({ archive: { archive_idle_days: v } })} />
          </SettingRow>
          <SettingRow label="Delete archived sessions" hint="An archived session is deleted this long after it was archived. Empty is never.">
            <DaysField label="Delete archived sessions after days" testid="archive-delete" value={settings.archive.delete_archived_days} onSave={(v) => patch({ archive: { delete_archived_days: v } })} />
          </SettingRow>
        </Card>
      )}

      <Card>
        <div className="flex items-center gap-3 border-b border-line py-4">
          <div className="min-w-0 flex-1">
            <div className="text-base font-medium">Backups</div>
            <div className="mt-0.5 text-ui text-muted">A checked copy of the conversations and settings{settings?.backup.before_restart ? ", made before every restart" : ""}. The last {settings?.backup.keep ?? 5} are kept. Restore with <span className="font-mono text-caption">keel restore NAME</span> while the daemon is stopped.</div>
          </div>
          <button type="button" className={btn} data-testid="backup-now" onClick={() => api("/api/backups", { method: "POST" }).then(() => load(true)).catch(reportError)}>Back up now</button>
        </div>
        {backups.length === 0 && <p className="py-4 text-ui text-faint">No backups yet.</p>}
        {backups.map((b) => (
          <div key={b.name} className="flex h-10 items-center gap-3 border-b border-line/60 text-ui last:border-0" data-testid="backup-row">
            <span className="tabular-nums">{when(b.created_ms)}</span>
            <span className="text-caption text-faint">{b.reason}</span>
            <span className="ml-auto text-caption tabular-nums text-muted">{b.sessions} sessions</span>
            <span className="w-16 text-right text-caption tabular-nums text-muted">{fmtBytes(b.bytes)}</span>
          </div>
        ))}
      </Card>

      <Card>
        <div className="flex items-center gap-3 border-b border-line py-4">
          <div className="min-w-0 flex-1">
            <div className="text-base font-medium">Checkpoints</div>
            <div className="mt-0.5 text-ui text-muted">Snapshots of each folder before and after every turn, so a turn can be rewound. Dropping a session's checkpoints frees what no other session needs; its turns can no longer be rewound.</div>
          </div>
          {r.by_session.some((s) => s.archived && s.checkpoints) || r.orphan_checkpoints ? (
            <button type="button" className={btn} data-testid="checkpoints-archived" onClick={() => dropCheckpoints({ archived: true }, "of every archived session").catch(reportError)}>
              Drop archived
            </button>
          ) : null}
        </div>
        {cpDone && <p className="pt-3 text-ui text-muted" data-testid="checkpoints-done">{cpDone}</p>}
        {r.checkpoint_folders.length === 0 && <p className="py-4 text-ui text-faint">No checkpoints yet.</p>}
        {r.checkpoint_folders.map((f) => (
          <div key={f.workspace} className="border-b border-line/60 last:border-0" data-testid="checkpoint-folder">
            <button
              type="button"
              aria-expanded={openFolder === f.workspace}
              onClick={() => setOpenFolder(openFolder === f.workspace ? null : f.workspace)}
              className="flex h-10 w-full items-center gap-3 text-left text-ui hover:bg-hover"
            >
              <span aria-hidden className={cn("w-3 text-caption text-faint transition-transform", openFolder === f.workspace && "rotate-90")}>›</span>
              <span className="min-w-0 flex-1 truncate font-mono text-caption" title={f.workspace}>{f.workspace}</span>
              <span className="text-caption tabular-nums text-faint">{f.sessions} sessions, {f.checkpoints} checkpoints</span>
              <span className="w-16 text-right text-caption tabular-nums text-muted">{fmtBytes(f.bytes)}</span>
            </button>
            {openFolder === f.workspace && (
              <div className="mb-2 max-h-80 overflow-y-auto rounded-md border border-line bg-sunken/40" data-testid="checkpoint-sessions">
                {f.session_list.map((s) => (
                  <div key={s.id} className="flex h-9 items-center gap-3 border-b border-line/60 px-3 text-ui last:border-0" data-testid="checkpoint-session" data-id={s.id}>
                    <button type="button" onClick={() => !s.subagent && navigate({ name: "session", id: s.id })} className="min-w-0 flex-1 truncate text-left hover:underline">{s.title || "Untitled"}</button>
                    {s.archived && <span className="rounded-xs bg-sunken px-1.5 text-micro text-muted">archived</span>}
                    {s.subagent && <span className="rounded-xs bg-sunken px-1.5 text-micro text-muted">subagent</span>}
                    <span className="text-caption tabular-nums text-faint">{s.checkpoints} checkpoints, about {fmtBytes(s.checkpoint_bytes)}</span>
                    <span className="w-16 text-right text-caption tabular-nums text-faint" title={when(s.updated_ms)}>{ago(s.updated_ms)}</span>
                    <button type="button" data-testid="checkpoint-drop" className="h-7 rounded-md border border-line-strong bg-raised px-2 text-caption font-medium hover:bg-hover" onClick={() => dropCheckpoints({ sessions: [s.id] }, `of ${s.title || "this session"}`).catch(reportError)}>
                      Drop
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </Card>

      <Card>
        <div className="flex items-center py-4 text-base font-medium">
          Largest sessions
          <span className="ml-auto text-caption font-normal text-faint">transcript, spilled output and its share of checkpoints</span>
        </div>
        <div className="-mx-5 border-t border-line">
          {r.by_session.slice(0, 15).map((s) => (
            <div key={s.id} className="group flex h-9 w-full items-center gap-3 border-b border-line/60 px-5 text-ui last:border-0 hover:bg-hover" data-testid="storage-session">
              <button type="button" onClick={() => !s.subagent && navigate({ name: "session", id: s.id })} className="min-w-0 flex-1 truncate text-left hover:underline">{s.title || "Untitled"}</button>
              {s.archived && <span className="rounded-xs bg-sunken px-1.5 text-micro text-muted">archived</span>}
              {s.subagent && <span className="rounded-xs bg-sunken px-1.5 text-micro text-muted">subagent</span>}
              {s.checkpoints > 0 && (
                <button
                  type="button"
                  data-testid="session-checkpoints"
                  title={`${s.checkpoints} checkpoints, about ${fmtBytes(s.checkpoint_bytes)}. Drop them.`}
                  onClick={() => dropCheckpoints({ sessions: [s.id] }, `of ${s.title || "this session"}`).catch(reportError)}
                  className="rounded-xs px-1.5 text-micro tabular-nums text-faint hover:bg-sunken hover:text-fg"
                >
                  {fmtBytes(s.checkpoint_bytes)} checkpoints
                </button>
              )}
              <span className="text-caption tabular-nums text-faint" title={when(s.updated_ms)}>{ago(s.updated_ms)}</span>
              <span className="w-16 text-right text-caption tabular-nums text-muted">{fmtBytes(s.bytes)}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
