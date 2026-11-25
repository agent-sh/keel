// The import sheet's other machines: each fleet machine whose harness sessions
// can be read (a linked daemon, or one reached over ssh through its helper)
// has its own part of the list under its separator, as the sidebar separates
// machines. Its last list is kept by the daemon and shown at once, dated, then
// replaced by the live one; a machine that does not answer keeps showing it.
// Under the separator, what its Claude Code and Codex hold open now.
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Found } from "../../../src/integrations/import/types.ts";
import { every } from "../lib/clock.ts";
import type { Machine } from "../lib/fleet.ts";
import { api, failed } from "../lib/store.ts";
import { ago, cn, fmtSize } from "../lib/utils.ts";
import { noteRows, OriginalStrip, type Intent, type Original, type Wait } from "./ResumeFrom.tsx";
import { TOOL } from "./TakeOver.tsx";
import { MachineSep } from "./Where.tsx";

export type RowData = Found & { imported?: { session_id: string; synced_ms: number; grew: boolean; went_on?: boolean }; original?: Original; wait?: Wait; in_text?: true; machine?: string };
type Listed = { sessions: RowData[]; total: number; harnesses?: Store[]; next_cursor?: string; changed?: boolean; cached_ms?: number; stale?: string; none?: boolean };
type Running = { sessions: RowData[]; supported: boolean; offline?: string };

// What a harness reports of its store on a machine. An empty list there is no store when it is not installed.
export type Store = { harness: string; label?: string; installed?: boolean };
// The words for an empty list of a harness whose store is not on the machine (not for a search that found nothing).
export const noStore = (stores: Store[] | undefined, harness: string, q: string) => {
  const h = stores?.find((x) => x.harness === harness);
  return h && h.installed === false && !q.trim() ? `No ${h.label ?? h.harness} store on this machine.` : undefined;
};

const home = (p?: string) => (p ?? "").replace(/^\/home\/[^/]+/, "~");

// One session of a list: its title, folder, size and age; where it was copied before.
export function SessionRow({ r, picked, onPick, testid = "import-row", strip }: { r: RowData; picked: boolean; onPick: () => void; testid?: string; strip?: React.ReactNode }) {
  return (
    <div className={cn("border-b border-line/60 transition-colors", picked ? "k-picked" : "hover:bg-hover")}>
      <button type="button" data-testid={testid} data-id={r.id} data-machine={r.machine} onClick={onPick} className="block w-full px-3 py-2 text-left">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-ui font-medium">{r.title}</span>
          {r.in_text && <span className="shrink-0 rounded-xs bg-accent-soft px-1.5 text-micro text-accent-ink" data-testid="import-in-text" title="The words are in what was said, not in the title or prompts">in the conversation</span>}
          {r.imported && <span className="shrink-0 rounded-xs bg-ok/15 px-1.5 text-micro font-medium text-ok" data-testid="import-imported">{r.imported.grew ? "imported · grew" : "imported"}</span>}
          {r.kind !== "interactive" && <span className="shrink-0 rounded-xs bg-sunken px-1.5 text-micro text-muted">{r.kind}</span>}
        </div>
        <div className="mt-0.5 flex gap-2 text-micro text-faint">
          <span className="min-w-0 flex-1 truncate">{home(r.cwd)}</span>
          <span className="shrink-0 tabular-nums">{fmtSize(r.size_bytes)}</span>
          <span className="shrink-0">{ago(r.updated_ms)}</span>
        </div>
      </button>
      {strip}
    </div>
  );
}

// What one machine's part of the list holds. `at`: when the daemon last read the machine, set while the
// list shown is the kept one (the live one has not come, or the machine does not answer: `why`).
export type Far = { rows: RowData[] | null; total: number; harnesses?: Store[]; next?: string; at?: number; why?: string; error?: string; running: RowData[]; runOff?: string };
const EMPTY: Far = { rows: null, total: 0, running: [] };

// The machines whose sessions the sheet shows: one reached over ssh, or a paired daemon (one that is out of
// reach too: its last list stays). One with no folder granted is named, since a copy would have nowhere to run.
export const readable = (machines: Machine[]) => machines.filter((m) => m.source !== "local" && m.enabled && (m.transport === "ssh" || (m.daemon && m.daemon.state !== "none"))).sort((a, b) => a.name.localeCompare(b.name));
const granted = (m: Machine) => !!m.workspace_root;

export function useFarLists({ open, machines, harness, q, all }: { open: boolean; machines: Machine[]; harness: string; q: string; all: boolean }) {
  const [far, setFar] = useState<Record<string, Far>>({});
  const seqs = useRef<Record<string, number>>({});
  const had = useRef<Record<string, boolean>>({}); // the machines asked live since the sheet opened: the first ask reads their stores again
  const held = useRef(far);
  held.current = far;
  const mine = useRef(machines);
  mine.current = machines;
  const patch = useCallback((id: string, p: Partial<Far>) => setFar((f) => ({ ...f, [id]: { ...EMPTY, ...f[id], ...p } })), []);
  const ids = machines.filter(granted).map((m) => m.id).join(",");
  const tag = (id: string, rows: RowData[]) => rows.map((r) => ({ ...r, machine: id }));

  const load = useCallback(async (id: string, cursor?: string) => {
    const n = (seqs.current[id] = (seqs.current[id] ?? 0) + 1);
    const base = `/api/fleet/machines/${id}/transcripts`;
    const u = new URLSearchParams({ harness, limit: "60" });
    if (q.trim()) u.set("q", q.trim());
    if (all) u.set("show", "all");
    // What was kept comes first, so the sheet is not empty while the machine is asked.
    if (!cursor && held.current[id]?.rows == null) {
      try {
        const c = await api<Listed>(`${base}?${u}&cached=1`);
        if (n === seqs.current[id] && !c.none) { noteRows(id, c.sessions); patch(id, { rows: tag(id, c.sessions), total: c.total, next: undefined, at: c.cached_ms, why: "reading it again", error: undefined }); }
      } catch { /* the live list says what is wrong */ }
    }
    if (cursor) u.set("cursor", cursor);
    if (!had.current[id] && !cursor) { u.set("refresh", "1"); had.current[id] = true; }
    try {
      const r = await api<Listed>(`${base}?${u}`);
      if (n !== seqs.current[id]) return;
      noteRows(id, r.sessions);
      const rows = tag(id, r.sessions);
      setFar((f) => ({ ...f, [id]: { ...EMPTY, ...f[id], rows: cursor ? [...(f[id]?.rows ?? []), ...rows] : rows, total: r.total, harnesses: r.harnesses, next: r.next_cursor, at: r.cached_ms, why: r.stale, error: undefined } }));
    } catch (e) {
      if (n !== seqs.current[id]) return;
      patch(id, { error: failed(e, { at: "ImportSheet machine" }) });
    }
  }, [harness, q, all, patch]);

  // The sheet opening, or the harness, the words or the machines changing: each machine is read again.
  useEffect(() => {
    if (!open) { had.current = {}; return; }
    const t = setTimeout(() => { for (const id of ids.split(",").filter(Boolean)) void load(id); }, q ? 180 : 0);
    return () => clearTimeout(t);
  }, [open, ids, load, q]);
  useEffect(() => { setFar((f) => Object.fromEntries(Object.entries(f).map(([id, x]) => [id, { ...EMPTY, running: x.running, runOff: x.runOff }]))); }, [harness]);

  // What runs there now, looked at every few seconds while the sheet is open.
  const watch = useCallback(async () => {
    for (const m of mine.current) {
      if (!granted(m)) continue;
      try {
        const r = await api<Running>(`/api/fleet/machines/${m.id}/running`);
        noteRows(m.id, r.sessions);
        patch(m.id, { running: tag(m.id, r.sessions), runOff: r.offline });
      } catch { /* the next look tries again */ }
    }
  }, [patch]);
  useEffect(() => {
    if (!open || !ids) return;
    void watch();
    return every(5000, () => void watch());
  }, [open, ids, watch]);

  return { far, more: (id: string) => { const n = held.current[id]?.next; if (n) void load(id, n); }, again: (id: string) => { had.current[id] = false; void load(id); } };
}

// The jump chips under the search: one to each machine's part of the list, with how many it holds.
export function MachineJumps({ machines, far }: { machines: Machine[]; far: Record<string, Far> }) {
  if (!machines.length) return null;
  return (
    <span className="flex shrink-0 items-center gap-1" data-testid="import-machine-jumps">
      {machines.map((m) => (
        <button key={m.id} type="button" data-testid="import-machine-jump" data-machine={m.id}
          onClick={() => document.querySelector(`[data-testid="import-machine"][data-machine="${CSS.escape(m.id)}"]`)?.scrollIntoView({ block: "start" })}
          className="rounded-sm px-1.5 py-0.5 text-accent hover:bg-accent-soft">
          {m.name}{far[m.id]?.rows ? ` ${far[m.id]!.total.toLocaleString()}` : ""}
        </button>
      ))}
    </span>
  );
}

type Pick = (r: RowData, intent: Intent) => void;

// Each machine's part: its separator (name, whether it answers, how many), the date of the list when it is
// the kept one, what runs there now, and its sessions.
export function MachineSections({ machines, far, harness, q, pickedKey, onPick, onOpen, more, again }: { machines: Machine[]; far: Record<string, Far>; harness: string; q: string; pickedKey: string; onPick: Pick; onOpen: (sessionId: string) => void; more: (id: string) => void; again: (id: string) => void }) {
  return (
    <>
      {machines.map((m) => {
        const f = far[m.id] ?? EMPTY;
        const ssh = m.transport === "ssh";
        const key = (r: RowData) => `${m.id}:${r.harness}:${r.id}`;
        const strip = (r: RowData) => ssh ? <OriginalStrip target={{ machine: m.id, harness: r.harness, id: r.id }} tool={TOOL[r.harness] ?? r.harness} onPick={(i) => onPick(r, i)} onOpen={onOpen} /> : undefined;
        const kept = f.at !== undefined;
        return (
          <section key={m.id} data-testid="import-machine" data-machine={m.id} data-state={f.error && !f.rows ? "failed" : kept ? "kept" : f.rows ? "live" : "reading"}>
            <MachineSep machine={m.id} count={f.rows ? f.total : 0} testid="import-machine-sep" className="k-machine-sep-band"
              note={!granted(m) ? undefined : kept ? <span data-testid="import-machine-kept">{ago(f.at!) === "now" ? "last read just now" : `last read ${ago(f.at!)} ago`}{f.why ? ` · ${f.why}` : ""}</span> : !f.rows && !f.error ? "reading" : undefined} />
            {!granted(m) && (
              <p className="px-3 py-2 text-caption text-muted" data-testid="import-machine-ungranted">
                No folder is granted on {m.name}, so a copy of its sessions would have nowhere to run. Grant one in Settings, Machines.
              </p>
            )}
            {f.runOff && <p className="px-3 py-1.5 text-caption text-muted" data-testid="import-machine-running-off">What runs there now is not known: {f.runOff}</p>}
            {f.running.length > 0 && (
              <div data-testid="import-machine-running">
                <div className="px-3 pt-2 pb-1 k-label">Running now</div>
                {f.running.map((r) => <SessionRow key={key(r)} r={r} testid="import-machine-running-row" picked={pickedKey === key(r)} onPick={() => onPick(r, null)} strip={strip(r)} />)}
              </div>
            )}
            {f.error && !f.rows && (
              <div className="flex items-center gap-2 px-3 py-2 text-caption text-muted" data-testid="import-machine-error">
                <span className="size-1.5 shrink-0 rounded-full bg-warn" />
                <span className="min-w-0 flex-1">{f.error}</span>
                <button type="button" onClick={() => again(m.id)} className="flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-caption text-accent hover:bg-accent-soft"><RefreshCw className="size-3" />Retry</button>
              </div>
            )}
            {/* A session shown under Running now is not shown again below it. */}
            {f.rows?.filter((r) => !f.running.some((x) => key(x) === key(r))).map((r) => <SessionRow key={key(r) + r.path} r={r} testid="import-machine-row" picked={pickedKey === key(r)} onPick={() => onPick(r, null)} strip={strip(r)} />)}
            {f.rows?.length === 0 && <p className="k-empty px-3 py-3" data-testid="import-machine-empty">{noStore(f.harnesses, harness, q) ?? "No sessions match."}</p>}
            {f.next !== undefined && !kept && <button type="button" onClick={() => more(m.id)} className="w-full py-2 text-caption text-accent hover:bg-hover">More</button>}
          </section>
        );
      })}
    </>
  );
}
