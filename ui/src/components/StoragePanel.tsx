// Settings > Storage: what Keel keeps on disk, deleting old archived sessions
// (a list first, then the delete), leftovers of deleted sessions, the archive
// policy, how long spilled output and usage records are kept (with what is
// past it now, and when the daily cleanup next runs) and the backups.
import { useCallback, useEffect, useState } from "react";
import { composing } from "../lib/keys.ts";
import { api, reportError } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { ago, cn, when } from "../lib/utils.ts";
import { confirmAction } from "./Confirm.tsx";
import { fmtBytes } from "./ResourcesPanel.tsx";
import { Card, SettingRow } from "./Settings.tsx";

type Report = {
  measured_ms: number; scanned_ms?: number; state_dir: string; total_bytes: number; database_bytes: number; attachments_bytes: number;
  sessions: { count: number; transcript_bytes: number }; archived_sessions: { count: number; transcript_bytes: number }; subagent_sessions: { count: number; transcript_bytes: number };
  spilled_output_bytes: number; checkpoints_bytes: number; worktrees_bytes: number; reports_bytes: number; backups_bytes: number; plugins_bytes: number;
  memory_transcripts_bytes: number; uploads_bytes: number; artifacts_bytes: number; logs_bytes: number; other_bytes: number;
  leftovers: { count: number; bytes: number };
  by_session: { id: string; title: string; archived: boolean; subagent: boolean; transcript_bytes: number; spill_bytes: number; checkpoints: number; checkpoint_bytes: number; bytes: number; updated_ms: number }[];
  checkpoint_folders: { workspace: string; bytes: number; checkpoints: number; sessions: number; session_list: CheckpointSession[] }[];
  orphan_checkpoints: number;
};
type CheckpointSession = { id: string; title: string; archived: boolean; subagent: boolean; checkpoints: number; checkpoint_bytes: number; updated_ms: number };
type Backup = { name: string; path: string; created_ms: number | null; reason: string; sessions: number | null; events: number | null; bytes: number | null; unreadable?: string; kind?: "full" | "delta"; base?: string; base_missing?: true; checked?: "whole" | "pages"; failed?: string; newest_whole?: true };
type Due = { spill: { before_ms: number | null; files: number; bytes: number; sessions: number; session_ids: string[]; busy_sessions: number; pinned_sessions: number }; usage: { before_ms: number | null; calls: number; tools: number }; next_ms: number };
type Proposed = { spill_days: number; usage_days: number; due: Due };
type Candidate = { id: string; title: string; updated_ms: number; bytes: number; family_updated_ms: number; subagents: { id: string; title: string }[] };

const count = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const btn = "h-8 shrink-0 rounded-md border border-line-strong bg-raised px-3 text-ui font-medium hover:bg-hover disabled:opacity-50";

export const useSettings = () => {
  const [s, setS] = useState<Record<string, any> | null>(null);
  const [unreadable, setUnreadable] = useState<string | undefined>();
  useEffect(() => { api<{ settings: Record<string, any>; unreadable?: string }>("/api/settings").then((r) => (setS(r.settings), setUnreadable(r.unreadable))).catch(reportError); }, []);
  const patch = useCallback((p: Record<string, any>) => api<{ settings: Record<string, any> }>("/api/settings", { method: "PATCH", body: JSON.stringify(p) }).then((r) => setS(r.settings)), []);
  const reset = useCallback(() => api<{ settings: Record<string, any>; moved_to?: string }>("/api/settings/reset", { method: "POST" }).then((r) => (setS(r.settings), setUnreadable(undefined), r.moved_to)), []);
  return [s, patch, unreadable, reset] as const;
};

// settings.json could not be read: what is shown are the defaults, and saving
// stays refused until the file is fixed (and the daemon restarted) or reset.
function UnreadableSettings({ why, onReset }: { why: string; onReset: () => Promise<string | undefined> }) {
  const [moved, setMoved] = useState<string | undefined>();
  return (
    <div role="alert" data-testid="settings-unreadable" className="flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/10 px-5 py-4 text-ui">
      <div className="min-w-0 flex-1">
        <div className="font-medium">settings.json cannot be read; these are the defaults</div>
        <div className="mt-0.5 text-muted">{why}. Saving is off so the file keeps your other settings. Fix it and restart the daemon, or reset: the file moves aside, kept as is.</div>
        {moved && <div className="mt-1 truncate font-mono text-caption text-faint" title={moved}>{moved}</div>}
      </div>
      <button type="button" className={btn} onClick={() => onReset().then(setMoved).catch(reportError)}>Reset</button>
    </div>
  );
}

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
        onKeyDown={(e) => e.key === "Enter" && !composing(e) && (e.currentTarget as HTMLInputElement).blur()}
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
        // Three columns with room; on a narrow page the name and the size share a line and the bar runs under both.
        <div key={r.label} className="grid grid-cols-[9rem_1fr_5.5rem] items-center gap-x-3 gap-y-1.5 text-ui @max-[30rem]/settings:grid-cols-[minmax(0,1fr)_auto]">
          <span className="truncate" title={r.hint}>{r.label}</span>
          <div className="h-2 rounded-full bg-sunken @max-[30rem]/settings:col-span-2 @max-[30rem]/settings:row-start-2">
            <div className="h-2 rounded-full bg-series-1" style={{ width: `${Math.max(r.bytes ? 1 : 0, (r.bytes / max) * 100)}%` }} />
          </div>
          <span className="text-right tabular-nums text-muted @max-[30rem]/settings:col-start-2 @max-[30rem]/settings:row-start-1">{fmtBytes(r.bytes)}</span>
        </div>
      ))}
    </div>
  );
}

export function StoragePanel() {
  const [r, setR] = useState<Report | null>(null);
  const [allSessions, setAllSessions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState("30");
  const [found, setFound] = useState<{ days: number; sessions: Candidate[]; bytes: number } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [cpDone, setCpDone] = useState<string | null>(null);
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [backupsFailed, setBackupsFailed] = useState(false);
  // The full backup the last restart did not wait for: the daemon makes it within a minute of its start.
  const [owed, setOwed] = useState<{ since_ms: number; why: string } | null>(null);
  const [settings, patch, unreadable, resetSettings] = useSettings();
  const [due, setDue] = useState<Due | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  const [proposed, setProposed] = useState<Proposed | null>(null);
  // The retention as the daemon acts on it, and the values in settings.json it does not take for one.
  const [acted, setActed] = useState<{ spill_days: number; usage_days: number; invalid: { name: string; value: unknown }[] } | null>(null);
  const loadDue = useCallback(() => api<{ settings: { spill_days: number; usage_days: number }; invalid?: { name: string; value: unknown }[]; due: Due; proposed?: Proposed }>("/api/storage/retention").then((x) => (setDue(x.due), setProposed(x.proposed ?? null), setActed({ ...x.settings, invalid: x.invalid ?? [] }))).catch(reportError), []);
  useEffect(() => { loadDue(); }, [loadDue]);

  const load = useCallback((refresh = false) => {
    setBusy(true);
    return Promise.all([
      api<Report>(`/api/storage${refresh ? "?refresh=1" : ""}`).then(setR),
      api<{ backups: Backup[]; owed?: { since_ms: number; why: string } | null }>("/api/backups").then((b) => (setBackups(b.backups), setOwed(b.owed ?? null), setBackupsFailed(false)), (e) => { setBackupsFailed(true); throw e; }),
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
    const subs = found.sessions.reduce((n, s) => n + s.subagents.length, 0);
    const ok = await confirmAction({ title: `Delete ${found.sessions.length} archived sessions?`, body: `Their transcripts and spilled output go${subs ? `, with ${subs} subagent sessions` : ""}, ${fmtBytes(found.bytes)} in all. A family where a subagent works or changed since this list is skipped. This cannot be undone; a backup can bring them back.`, action: "Delete", danger: true });
    if (!ok) return;
    const x = await api<{ deleted: string[]; skipped: { why: string }[] }>("/api/storage/cleanup", {
      method: "POST", body: JSON.stringify({ older_than_days: found.days, sessions: found.sessions.map((s) => ({ id: s.id, updated_ms: s.updated_ms, family_updated_ms: s.family_updated_ms })) }),
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

  // What is past the retention goes only after it was listed here: the sessions and the instants of that listing.
  const records = due ? due.usage.calls + due.usage.tools : 0;
  const removeDue = async () => {
    if (!due) return;
    const parts = [
      due.spill.files ? `${count(due.spill.files, "file")} of spilled output (${fmtBytes(due.spill.bytes)}) of ${count(due.spill.sessions, "session")} last used before ${when(due.spill.before_ms!)}` : "",
      records ? `${count(records, "usage record")} from before ${when(due.usage.before_ms!)}` : "",
    ].filter(Boolean);
    const ok = await confirmAction({ title: "Remove what is past these times?", body: `${parts.join(", and ")}. A session that reads a removed output again is told the retention removed it and to run its command again. This cannot be undone.`, action: "Remove", danger: true });
    if (!ok) return;
    const x = await api<{ removed: { spill_files: number; spill_bytes: number; usage_calls: number; usage_tools: number }; due: Due }>("/api/storage/retention", { method: "POST", body: JSON.stringify({ spill_before_ms: due.spill.before_ms, usage_before_ms: due.usage.before_ms, sessions: due.spill.session_ids }) });
    setDue(x.due);
    setKept(`Removed ${count(x.removed.spill_files, "file")} (${fmtBytes(x.removed.spill_bytes)}) and ${count(x.removed.usage_calls + x.removed.usage_tools, "usage record")}.`);
    load(true);
  };
  const spared = due ? [due.spill.busy_sessions ? count(due.spill.busy_sessions, "working session") : "", due.spill.pinned_sessions ? count(due.spill.pinned_sessions, "pinned session") : ""].filter(Boolean).join(" and ") : "";

  if (!r) return <div className="text-ui text-faint">Measuring.</div>;
  // The rows add up to the total, which is what du says of the folder.
  const other = r.plugins_bytes + r.reports_bytes + r.logs_bytes + r.other_bytes;
  return (
    <div className="flex flex-col gap-4" data-testid="storage-panel">
      {unreadable !== undefined && <UnreadableSettings why={unreadable} onReset={resetSettings} />}
      <Card>
        {/* The total keeps a width of its own: when the note and the button do not fit beside it they go under it. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line py-4">
          <div className="min-w-[min(100%,12rem)] flex-1">
            <div className="text-title font-semibold tabular-nums tracking-[-0.01em]" data-testid="storage-total">{fmtBytes(r.total_bytes)}</div>
            <div className="truncate font-mono text-caption text-faint" title={r.state_dir}>{r.state_dir}</div>
          </div>
          <span className="text-caption text-faint" title={when(r.measured_ms)}>measured {ago(r.measured_ms) === "now" ? "just now" : `${ago(r.measured_ms)} ago`}</span>
          {/* The sessions' sizes come from a read of every event, made once a start and kept: when that read is older than the sizes on disk, it says so. */}
          {r.scanned_ms !== undefined && r.measured_ms - r.scanned_ms > 120_000 && <span className="text-caption text-faint" title={when(r.scanned_ms)} data-testid="storage-scanned">sessions read {ago(r.scanned_ms)} ago</span>}
          <button type="button" className={cn(btn, "ml-auto")} disabled={busy} onClick={() => load(true)}>{busy ? "Measuring" : "Measure again"}</button>
        </div>
        <Bars rows={[
          { label: "Conversations", bytes: r.database_bytes, hint: `${r.sessions.count} sessions, ${r.archived_sessions.count} archived, ${r.subagent_sessions.count} subagents; ${fmtBytes(r.attachments_bytes)} of attachments` },
          { label: "Checkpoints", bytes: r.checkpoints_bytes, hint: "file snapshots per turn, for rewind" },
          { label: "Worktrees", bytes: r.worktrees_bytes },
          { label: "Spilled output", bytes: r.spilled_output_bytes, hint: "long tool output and command logs" },
          { label: "Memory transcripts", bytes: r.memory_transcripts_bytes, hint: "each session as the memory tool reads it" },
          { label: "Uploads and artifacts", bytes: r.uploads_bytes + r.artifacts_bytes, hint: "files attached to messages and files sessions made for you" },
          { label: "Backups", bytes: r.backups_bytes },
          { label: "Other", bytes: other, hint: "plugin data, reports, logs, settings and listing files" },
        ]} />
      </Card>

      <Card>
        <div className="py-4">
          <div className="text-base font-medium">Delete old archived sessions</div>
          <div className="mt-0.5 text-ui text-muted">Lists the sessions archived at least this long ago. Nothing is deleted until you confirm the list.</div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="flex h-8 items-center gap-2 rounded-md border border-line-strong bg-raised px-2.5 text-ui">
              <span className="text-muted">Archived</span>
              <input aria-label="Days archived" data-testid="cleanup-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !composing(e) && find().catch(reportError)} className="w-12 bg-transparent text-right tabular-nums outline-none" />
              <span className="text-muted">days ago or more</span>
            </label>
            <button type="button" className={btn} onClick={() => find().catch(reportError)} data-testid="cleanup-find">Find</button>
            {done && <span className="text-ui text-muted" data-testid="cleanup-done">{done}</span>}
          </div>
          {found && (
            <div className="mt-3 rounded-md border border-line" data-testid="cleanup-list">
              {found.sessions.length === 0 && <p className="k-empty px-3 py-3">No archived session is that old.</p>}
              {found.sessions.slice(0, 12).map((s) => (
                <div key={s.id} className="flex h-9 items-center gap-3 border-b border-line/60 px-3 text-ui last:border-0">
                  <span className="min-w-0 flex-1 truncate">{s.title || "Untitled"}</span>
                  {s.subagents.length > 0 && <span className="rounded-xs bg-sunken px-1.5 text-micro text-muted" data-testid="cleanup-subagents" title={s.subagents.map((x) => x.title || x.id).join("\n")}>+{s.subagents.length} subagent{s.subagents.length > 1 ? "s" : ""}</span>}
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

      {settings && (
        <Card>
          <SettingRow label="Keep spilled output" hint="Long tool output, command logs and fetched pages go this long after their session was last used. A pinned session and one that is working keep theirs. Empty is never.">
            <DaysField label="Keep spilled output for days" testid="retention-spill" value={(acted ? acted.spill_days : settings.retention.spill_days) || null} onSave={(v) => patch({ retention: { spill_days: v ?? 0 } }).then(loadDue)} />
          </SettingRow>
          <SettingRow label="Keep usage records" hint="One record per model call and tool call: cost by day, latency, cache. The running month is always kept, and each session keeps its own totals. Empty is never.">
            <DaysField label="Keep usage records for days" testid="retention-usage" value={(acted ? acted.usage_days : settings.retention.usage_days) || null} onSave={(v) => patch({ retention: { usage_days: v ?? 0 } }).then(loadDue)} />
          </SettingRow>
          {/* A value written into the file by hand that is not a number of days: read as never, and said. */}
          {!!acted?.invalid.length && (
            <div className="py-4 text-ui text-warn" data-testid="retention-invalid">
              settings.json holds {acted.invalid.map((i) => `${i.name}: ${JSON.stringify(i.value)}`).join(" and ")}, which is not a whole number of days. It is read as never: nothing is removed for it until you set it here.
            </div>
          )}
          {/* Nothing set: nothing is ever removed. The page proposes a retention and says what it would list. */}
          {proposed && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-4">
              <div className="min-w-[min(100%,16rem)] flex-1 text-ui text-muted" data-testid="retention-proposed">
                Nothing is removed until you set these. Suggested: spilled output {proposed.spill_days} days after its session was last used, usage records {proposed.usage_days} days.
                {" "}{proposed.due.spill.files + proposed.due.usage.calls + proposed.due.usage.tools === 0 ? "Nothing would be past them now." : `Past them now: ${count(proposed.due.spill.files, "file")} of spilled output (${fmtBytes(proposed.due.spill.bytes)}) in ${count(proposed.due.spill.sessions, "session")}, ${count(proposed.due.usage.calls + proposed.due.usage.tools, "usage record")}.`}
                {" "}The first cleanup runs a day after you accept.
              </div>
              <button type="button" className={btn} data-testid="retention-accept" onClick={() => patch({ retention: { spill_days: proposed.spill_days, usage_days: proposed.usage_days } }).then(loadDue).catch(reportError)}>Use {proposed.spill_days} and {proposed.usage_days} days</button>
            </div>
          )}
          {due && !proposed && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-4">
              <div className="min-w-[min(100%,16rem)] flex-1 text-ui text-muted" data-testid="retention-due">
                {due.spill.files + records === 0 ? "Nothing is past these now." : `Past these now: ${count(due.spill.files, "file")} of spilled output (${fmtBytes(due.spill.bytes)}) in ${count(due.spill.sessions, "session")}, ${count(records, "usage record")}.`}
                {spared && ` ${spared} left alone.`}
                {" "}The daily cleanup next runs {when(due.next_ms)}.
                {kept && <span className="text-faint" data-testid="retention-done"> {kept}</span>}
              </div>
              <button type="button" className={btn} data-testid="retention-remove" disabled={due.spill.files + records === 0} onClick={() => removeDue().catch(reportError)}>Remove now</button>
            </div>
          )}
        </Card>
      )}

      <Card>
        <div className="flex items-center gap-3 border-b border-line py-4">
          <div className="min-w-0 flex-1">
            <div className="text-base font-medium">Backups</div>
            <div className="mt-0.5 text-ui text-muted">A checked copy of the conversations, their attached files and the settings{settings?.backup.before_restart ? ", made before every restart" : ""}. The last {settings?.backup.keep ?? 5} are kept; one that holds only what changed keeps the full backup it is read over. Restore with <span className="font-mono text-caption">keel restore NAME</span> while the daemon is stopped.</div>
          </div>
          <button type="button" className={btn} data-testid="backup-now" onClick={() => api("/api/backups", { method: "POST" }).then(() => load(true)).catch(reportError)}>Back up now</button>
        </div>
        {backupsFailed && <p className="py-4 text-ui text-danger" data-testid="backups-failed">The list of backups could not be read.</p>}
        {!backupsFailed && owed && (
          <div className="flex h-10 items-center gap-3 border-b border-line/60 text-ui" data-testid="backup-owed" title={`The restart at ${when(owed.since_ms)} did not wait for it: ${owed.why}.`}>
            <span className="tabular-nums">{when(owed.since_ms)}</span>
            <span className="min-w-0 truncate text-caption text-muted">a full backup is owed: made after the start</span>
          </div>
        )}
        {!backupsFailed && !owed && backups?.length === 0 && <p className="k-empty py-4">No backups yet.</p>}
        {backups?.map((b) => (
          <div key={b.name} className="flex h-10 items-center gap-3 border-b border-line/60 text-ui last:border-0" data-testid="backup-row">
            <span className="tabular-nums">{b.created_ms ? when(b.created_ms) : b.name}</span>
            {b.unreadable ? (
              <span className="min-w-0 truncate text-caption text-danger" title={b.unreadable} data-testid="backup-unreadable">manifest unreadable; not checked, never pruned</span>
            ) : (
              <>
                <span className="text-caption text-faint">{b.reason}</span>
                {b.failed ? <span className="min-w-0 truncate text-caption text-danger" title={b.failed} data-testid="backup-failed">not known whole: failed its check</span>
                  : b.checked === "pages" && !b.base_missing && <span className="text-caption text-faint" title="Its pages were checked when it was made. It is read back whole over its full backup a little later." data-testid="backup-pages">pages checked</span>}
                {b.base_missing ? <span className="min-w-0 truncate text-caption text-danger" title={`It holds the changes since ${b.base}, which is gone.`} data-testid="backup-base-missing">its full backup is gone; cannot be restored</span>
                  : b.base && <span className="min-w-0 truncate text-caption text-faint" title={`The changes since ${b.base}`} data-testid="backup-delta">changes only</span>}
                {b.newest_whole && <span className="text-caption text-muted" title="The newest backup that was read back whole and is the database that was backed up." data-testid="backup-newest-whole">newest known whole</span>}
                <span className="ml-auto text-caption tabular-nums text-muted">{b.sessions} sessions</span>
                <span className="w-16 text-right text-caption tabular-nums text-muted">{fmtBytes(b.bytes ?? 0)}</span>
              </>
            )}
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
        {r.checkpoint_folders.length === 0 && <p className="k-empty py-4">No checkpoints yet.</p>}
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
                    <button type="button" onClick={() => !s.subagent && navigate({ name: "session", id: s.id })} className="k-link min-w-0 flex-1 truncate text-left hover:underline">{s.title || "Untitled"}</button>
                    {s.archived && <span className="rounded-xs bg-sunken px-1.5 text-micro text-muted">archived</span>}
                    {s.subagent && <span className="rounded-xs bg-sunken px-1.5 text-micro text-muted">subagent</span>}
                    <span className="text-caption tabular-nums text-faint">{s.checkpoints} checkpoints, about {fmtBytes(s.checkpoint_bytes)}</span>
                    <span className="w-16 text-right text-caption tabular-nums text-faint" title={when(s.updated_ms)}>{ago(s.updated_ms)}</span>
                    <button type="button" data-testid="checkpoint-drop" className="k-btn" onClick={() => dropCheckpoints({ sessions: [s.id] }, `of ${s.title || "this session"}`).catch(reportError)}>
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
          {(allSessions ? r.by_session : r.by_session.slice(0, 15)).map((s) => (
            <div key={s.id} className="group flex h-9 w-full items-center gap-3 border-b border-line/60 px-5 text-ui last:border-0 hover:bg-hover" data-testid="storage-session">
              <button type="button" onClick={() => !s.subagent && navigate({ name: "session", id: s.id })} className="k-link min-w-0 flex-1 truncate text-left hover:underline">{s.title || "Untitled"}</button>
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
          {r.by_session.length > 15 && (
            <button type="button" data-testid="storage-sessions-more" onClick={() => setAllSessions(!allSessions)} className="h-9 w-full px-5 text-left text-caption text-muted hover:bg-hover hover:text-fg">
              {allSessions ? "Show the largest 15" : `${r.by_session.length - 15} more`}
            </button>
          )}
        </div>
      </Card>
    </div>
  );
}
