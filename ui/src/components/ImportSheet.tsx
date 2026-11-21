// Import sessions from Claude Code, Codex and the Rust Keel: browse each
// harness's sessions, preview what an import brings, and import a read-only
// copy (the original is never changed). A session imported before opens, or is
// brought up to date with what its source gained.
import { Dialog } from "@base-ui/react/dialog";
import { Switch } from "@base-ui/react/switch";
import { ArrowDownToLine, FileUp, FolderOpen, History, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { KEEL_FILE_MAX, sizeText } from "../../../src/core/keel-file.ts";
import type { Found, Harness } from "../../../src/integrations/import/types.ts";
import { useFleet } from "../lib/fleet.ts";
import { api, reportError, failed } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { takeOver, TOOL } from "./TakeOver.tsx";
import { noteRows, OriginalStrip, ResumeCard, useStopped, type Intent, type Original, type Wait } from "./ResumeFrom.tsx";
import { ago, cn } from "../lib/utils.ts";
import { Select } from "./Select.tsx";
import { Seg, tabId } from "./Seg.tsx";

// `original`, `wait`: on a machine reached over ssh, what the harness that still runs it does, and a resume waiting for it.
type Row = Found & { imported?: { session_id: string; synced_ms: number; grew: boolean; went_on?: boolean }; original?: Original; wait?: Wait };
type HarnessState = { harness: Harness; label: string; store: string; installed: boolean; total: number; interactive: number };
type Preview = {
  session: Found & { cwd_exists: boolean };
  counts: { prompts: number; assistant_messages: number; tool_calls: number; thoughts_dropped: number; skipped: number; media: number };
  notes: string[];
  tail: { role: string; text: string }[];
  links: { session_id: string; title: string; updated_ms: number; imported_ms: number }[];
};

// What names the row on the daemon: the file and the session id together (two
// transcripts may carry one id), or the id alone for stores of many sessions.
const ident = (row: Row) => (row.harness === "keel" ? { harness: row.harness, id: row.id } : { harness: row.harness, id: row.id, path: row.path });

let open = false;
const subs = new Set<() => void>();
export function setImportOpen(o: boolean) { open = o; subs.forEach((f) => f()); }
export function ImportOverlay() {
  const o = useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => open);
  return <ImportSheet open={o} onOpenChange={setImportOpen} />;
}


const size = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(0)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);
const home = (p?: string) => (p ?? "").replace(/^\/home\/[^/]+/, "~");

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-base font-semibold tabular-nums">{n.toLocaleString()}</span>
      <span className="text-micro text-faint">{label}</span>
    </div>
  );
}

// Where the list comes from: this machine's stores, or another machine's,
// read by its daemon (an import from there goes on here, its tools there).
const paths = (from: string) => from
  ? { list: `/api/fleet/machines/${from}/transcripts`, preview: `/api/fleet/machines/${from}/transcripts/preview`, import: `/api/fleet/machines/${from}/transcripts/import` }
  : { list: "/api/import/sessions", preview: "/api/import/preview", import: "/api/import" };

function PreviewPane({ row, from, resume, intent, onIntent, onDone }: { row: Row; from: string; resume?: { machineName: string }; intent: Intent; onIntent: (i: Intent) => void; onDone: () => void }) {
  const [p, setP] = useState<Preview | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // Only the answer for the row shown now counts: a slower answer for the row
  // picked before is dropped, and Import waits for this row's own preview.
  useEffect(() => {
    let live = true;
    setP(null);
    setErr("");
    const u = new URLSearchParams(Object.entries(from ? { harness: row.harness, id: row.id } : ident(row)) as [string, string][]);
    api<Preview>(`${paths(from).preview}?${u}`).then((r) => { if (live) setP(r); }, (e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [row, from]); // the row picked again (a fresh listing's) is read again: copies made since show
  const shown = p && p.session.id === row.id && (from || row.harness === "keel" || p.session.path === row.path) ? p : null;
  // A copy opens by its own id, the one the preview on screen names (a copy
  // made after it was read does not take its place); the original is not read.
  const open = (id: string) => { onDone(); navigate({ name: "session", id }); };
  const go = async (mode?: "new" | "update") => {
    setBusy(true);
    try {
      const r = await api<{ session: { id: string } }>(paths(from).import, { method: "POST", body: JSON.stringify({ ...(from ? { harness: row.harness, id: row.id } : ident(row)), mode }) });
      onDone();
      navigate({ name: "session", id: r.session.id });
    } catch (e) {
      setErr(failed(e, { at: "ImportSheet" }));
    } finally {
      setBusy(false);
    }
  };
  const done = row.imported;
  // Its original was ended and the copy is owed: the card above finishes it, with what was in flight.
  const stopped = useStopped({ machine: from, harness: row.harness, id: row.id });
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="import-preview">
      <div className="border-b border-line px-5 py-4">
        <div className="text-base font-semibold leading-snug">{row.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-faint">
          <span className="inline-flex items-center gap-1"><FolderOpen className="size-3.5" />{home(row.cwd) || "no folder"}{shown && !shown.session.cwd_exists && row.cwd ? " (gone: the copy keeps it until you move the session)" : ""}</span>
          {row.model && <span className="font-mono">{row.model}</span>}
          <span>{ago(row.updated_ms)}</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {err && <p className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-caption text-danger" data-testid="import-error">{err}</p>}
        {resume && <ResumeCard target={{ machine: from, harness: row.harness, id: row.id }} tool={TOOL[row.harness] ?? row.harness} machineName={resume.machineName} intent={intent} onIntent={onIntent} onDone={onDone} />}
        {!shown && !err && <p className="text-ui text-faint">Reading the session</p>}
        {shown && (() => { const p = shown; return (
          <>
            <div className="flex gap-6" data-testid="import-counts">
              <Stat n={p.counts.prompts} label="prompts" />
              <Stat n={p.counts.assistant_messages} label="replies" />
              <Stat n={p.counts.tool_calls} label="tool calls" />
              {p.counts.media > 0 && <Stat n={p.counts.media} label="images" />}
            </div>
            {p.notes.length > 0 && (
              <ul className="mt-3 space-y-1">
                {p.notes.map((n) => <li key={n} className="text-caption text-muted">{n}</li>)}
              </ul>
            )}
            <div className="mt-5 k-label">Last messages</div>
            <div className="mt-2 space-y-2">
              {p.tail.map((m, i) => (
                <div key={i} className={cn("rounded-lg px-3 py-2 text-ui", m.role === "user" ? "ml-10 bg-accent-soft" : "mr-10 border border-line bg-raised")}>
                  <p className="line-clamp-6 whitespace-pre-wrap break-words">{m.text}</p>
                </div>
              ))}
            </div>
            {p.links.length > 1 && (
              <>
                <div className="mt-5 k-label">{p.links.length} copies here</div>
                <div className="mt-2 divide-y divide-line rounded-lg border border-line" data-testid="import-copies">
                  {p.links.map((l) => (
                    <button key={l.session_id} type="button" onClick={() => open(l.session_id)} data-testid="import-copy" data-id={l.session_id} className="flex w-full items-center gap-3 px-3 py-2 text-left text-ui hover:bg-hover">
                      <span className="min-w-0 flex-1 truncate">{l.title}</span>
                      <span className="shrink-0 text-micro text-faint tabular-nums">copied {ago(l.imported_ms)} · active {ago(l.updated_ms)}</span>
                      <span className="shrink-0 text-caption text-accent">Open</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        ); })()}
      </div>
      <div className="flex items-center gap-2 border-t border-line px-5 py-3">
        <span className="min-w-0 flex-1 text-caption text-faint" data-testid="import-foot">
          {stopped ? "The original was stopped. Finish the copy above: a plain import would leave out what it was in the middle of." : done ? (done.went_on ? `Imported before; the copy went on here${done.grew ? " and the original too" : ""}, so it is not updated.` : done.grew ? "Imported before; the original has gone on since." : "Imported before.") : row.original ? "Import makes a copy and leaves the original running; resuming ends it." : "A copy: the original stays as it is."}
        </span>
        {done ? (
          <>
            <button type="button" disabled={busy} onClick={() => go("new")} data-testid="import-new" className="h-8 rounded-lg px-3 text-ui text-muted hover:bg-hover hover:text-fg">New copy</button>
            {done.grew && !done.went_on && <button type="button" disabled={busy} onClick={() => go("update")} data-testid="import-update" className="h-8 rounded-lg border border-line-strong px-3 text-ui font-medium hover:bg-hover">Update</button>}
            <button type="button" disabled={busy} onClick={() => open(shown?.links[0]?.session_id ?? done.session_id)} data-testid="import-open" className="h-8 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:opacity-90">Open</button>
          </>
        ) : (
          <button type="button" disabled={busy || !shown || stopped} onClick={() => go()} data-testid="import-go" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:opacity-90 disabled:opacity-40">
            <ArrowDownToLine className="size-4" /> Import
          </button>
        )}
      </div>
    </div>
  );
}

type Item = { harness: Harness; id: string; path?: string; title: string };
type Fail = { item: Item; error: string; reason?: string };

type RunningRow = { id: string; name: string; kind: string; state: string; cwd: string; harness: Harness | null; transcript_path: string | null; imported?: string };

// The sessions the agent view runs now: copy one, or take it over (it ends
// where it runs and goes on here). Nothing running shows nothing; a list that
// could not be read, or an agent view not set, says so (the stored
// transcripts below stay usable either way).
function Running({ onDone }: { onDone: () => void }) {
  const [rows, setRows] = useState<RunningRow[]>([]);
  const [why, setWhy] = useState<{ text: string; unset?: boolean } | null>(null);
  const [err, setErr] = useState("");
  const list = useCallback(() => {
    api<{ sessions: RunningRow[]; not_listed?: string[]; unset?: true }>("/api/import/running").then((r) => {
      setRows(r.sessions);
      setWhy(r.not_listed?.length ? { text: r.not_listed.join("; "), unset: r.unset } : null);
    }, (e) => { setRows([]); setWhy({ text: failed(e, { at: "ImportSheet running" }) }); });
  }, []);
  useEffect(list, [list]);
  const shown = rows.filter((r) => r.harness);
  if (!shown.length && !why) return null;
  const go = async (p: Promise<{ session: { id: string } } | null>) => {
    setErr("");
    try {
      const r = await p;
      if (!r) return;
      onDone();
      navigate({ name: "session", id: r.session.id });
    } catch (e) {
      setErr(failed(e, { at: "ImportSheet" }));
    }
  };
  return (
    <div className="border-b border-line" data-testid="import-running">
      <div className="px-3 pt-2 pb-1 k-label">Running now</div>
      {why && (
        <div className="flex items-center gap-2 px-3 pb-2 text-caption text-muted" data-testid="import-running-unlisted">
          <span className="size-1.5 shrink-0 rounded-full bg-warn" />
          <span className="min-w-0 flex-1">{why.unset ? "Running sessions are listed once the agent view is set." : `Could not list running sessions: ${why.text}`}</span>
          {why.unset
            ? <button type="button" onClick={() => { onDone(); navigate({ name: "settings", section: "elsewhere" }); }} className="h-6 shrink-0 rounded-md px-2 text-caption text-accent hover:bg-accent-soft">Set it</button>
            : <button type="button" onClick={list} data-testid="import-running-retry" className="h-6 shrink-0 rounded-md px-2 text-caption text-accent hover:bg-accent-soft">Retry</button>}
        </div>
      )}
      {shown.map((r) => (
        <div key={r.id} data-testid="import-running-row" data-id={r.id} className="flex items-center gap-2 px-3 py-1.5">
          <span className="size-1.5 shrink-0 rounded-full bg-ok" />
          <span className="min-w-0 flex-1 truncate text-ui">{r.name || r.id}<span className="ml-1.5 text-micro text-faint">{TOOL[r.kind] ?? r.kind} · {r.state}{!r.transcript_path ? " · no transcript here" : ""}</span></span>
          <button type="button" disabled={!r.transcript_path} title={r.transcript_path ? "Import a copy; the original keeps running" : "The agent view names no transcript of it on this machine, so there is nothing to copy"} onClick={() => go(api("/api/import", { method: "POST", body: JSON.stringify({ outside: r.id, mode: r.imported ? "open" : undefined }) }))}
            className="h-6 shrink-0 rounded-md px-2 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent">{r.imported ? "Open copy" : "Copy"}</button>
          <button type="button" data-testid="import-takeover" disabled={!r.transcript_path} onClick={() => go(takeOver(r.id, r.name || r.id, TOOL[r.kind] ?? r.kind))}
            className="h-6 shrink-0 rounded-md border border-line-strong px-2 text-caption font-medium hover:bg-hover disabled:opacity-40">Take over</button>
        </div>
      ))}
      {err && <p className="mx-3 mb-2 rounded-md bg-danger-soft px-2 py-1 text-caption text-danger" data-testid="import-running-error">{err}</p>}
    </div>
  );
}

export function ImportSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [harness, setHarness] = useState<Harness>("claude");
  const panel = useId();
  const [harnesses, setHarnesses] = useState<HarnessState[]>([]);
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState<string | undefined>();
  const [sel, setSel] = useState<Row | null>(null);
  const [building, setBuilding] = useState(false);
  const seq = useRef(0);
  const shown = useRef(0); // how many rows the list holds
  const [bulk, setBulk] = useState("");
  // A Keel file (a session exported from another Keel) picked from disk: sent
  // as it is. It opens at once; what the import had to change (another model,
  // another folder, a file that did not travel) is said first.
  const pick = useRef<HTMLInputElement>(null);
  type KeelFile = { state: "sending"; name: string } | { state: "failed"; name: string; error: string } | { state: "done"; name: string; id: string; title: string; events: number; files: number; notes: string[] };
  const [keelFile, setKeelFile] = useState<KeelFile | null>(null);
  const openSession = (id: string) => { setKeelFile(null); onOpenChange(false); navigate({ name: "session", id }); };
  const importKeelFile = async (file: File) => {
    setKeelFile({ state: "sending", name: file.name });
    try {
      if (file.size > KEEL_FILE_MAX) throw new Error(`it is ${sizeText(file.size)}, and a Keel file can be at most ${sizeText(KEEL_FILE_MAX)}`);
      const r = await api<{ session: { id: string; title: string }; events_imported: number; files_imported: number; notes: string[] }>("/api/sessions/import", { method: "POST", headers: { "content-type": "application/x-ndjson" }, body: file });
      if (!r.notes.length) return openSession(r.session.id);
      setKeelFile({ state: "done", name: file.name, id: r.session.id, title: r.session.title, events: r.events_imported, files: r.files_imported, notes: r.notes });
    } catch (e) {
      setKeelFile({ state: "failed", name: file.name, error: (e as { status?: number }).status === 413 ? `it is larger than a Keel file can be (${sizeText(KEEL_FILE_MAX)})` : failed(e, { at: "ImportSheet keel file" }) });
    }
  };
  // The filter the shown rows and count came from.
  const [shownFor, setShownFor] = useState<{ q: string; all: boolean }>({ q: "", all: false });
  const [from, setFrom] = useState("");
  const [intent, setIntent] = useState<Intent>(null);
  const machines = useFleet((s) => s.machines);
  // Machines whose transcripts can be read: a linked daemon, or one reached over ssh (its helper reads them).
  const linked = useMemo(() => machines.filter((m) => m.source !== "local" && m.enabled && m.workspace_root && (m.daemon?.state === "linked" || m.transport === "ssh")), [machines]);
  const ssh = machines.find((m) => m.id === from && m.transport === "ssh");

  // Every session the shown list holds (the filter that produced it, never
  // one typed since), counted across its pages and confirmed before the first
  // copy; then imported 200 at a time. Ones imported before stay as they are;
  // a failed one is named with its reason and can be tried again alone.
  const [confirm, setConfirm] = useState<Item[] | null>(null);
  const [fails, setFails] = useState<Fail[]>([]);
  const collect = async () => {
    const u = new URLSearchParams({ harness, limit: "500" });
    if (shownFor.q) u.set("q", shownFor.q);
    if (shownFor.all) u.set("show", "all");
    // Read to the end; a list that changed above a page while it was read is read again whole.
    let items: Item[] = [];
    for (let tries = 0, cursor: string | undefined, done = false; !done; ) {
      if (cursor) u.set("cursor", cursor);
      else u.delete("cursor");
      const r: { sessions: Row[]; next_cursor?: string; changed?: boolean } = await api(`/api/import/sessions?${u}`);
      if (r.changed && ++tries < 4) { items = []; cursor = undefined; continue; }
      for (const x of r.sessions) if (!x.imported) items.push({ ...ident(x), title: x.title });
      cursor = r.next_cursor;
      done = cursor === undefined;
    }
    if (items.length) setConfirm(items);
    else setBulk("Every session this list shows was imported before");
  };
  const importAll = async (items: Item[]) => {
    setConfirm(null);
    setFails([]);
    let done = 0;
    const missed: Fail[] = [];
    for (let i = 0; i < items.length; i += 200) {
      setBulk(`Importing ${done + missed.length} of ${items.length}`);
      const r = await api<{ results: any[] }>("/api/import/batch", { method: "POST", body: JSON.stringify({ items: items.slice(i, i + 200).map(({ title: _, ...x }) => x) }) });
      r.results.forEach((x, k) => {
        if (x.ok) done++;
        else missed.push({ item: items[i + k]!, error: x.error ?? `failed (${x.status})`, reason: x.reason });
      });
    }
    setFails(missed);
    setBulk(`Imported ${done}${missed.length ? `; ${missed.length} not imported` : ""}`);
    load();
  };

  const load = useCallback(async (cursor?: string, refresh = false, want = 60): Promise<void> => {
    const n = ++seq.current;
    const u = new URLSearchParams({ harness, limit: String(Math.min(want, 500)) });
    if (cursor) u.set("cursor", cursor);
    if (q.trim()) u.set("q", q.trim());
    if (all) u.set("show", "all");
    if (refresh) u.set("refresh", "1");
    try {
      const r = await api<{ sessions: Row[]; total: number; next_cursor?: string; changed?: boolean; harnesses: HarnessState[]; index: { building: boolean } }>(`${paths(from).list}?${u}`);
      if (n !== seq.current) return;
      // A session arrived, left or moved above this page since the pages before
      // it were read: the list is read again from the top, as far as it was shown.
      if (cursor && r.changed) return load(undefined, false, shown.current + 60);
      setHarnesses(r.harnesses);
      setTotal(r.total);
      setNext(r.next_cursor);
      setBuilding(r.index.building);
      setRows((prev) => { const rows = cursor ? [...(prev ?? []), ...r.sessions] : r.sessions; shown.current = rows.length; return rows; });
      if (from) noteRows(from, r.sessions);
      // The row on show is taken from the fresh listing, so its preview reads
      // again (a copy made since the last listing shows) even when it was
      // picked from the listing before this one.
      if (!cursor) setSel((cur) => (cur && r.sessions.find((x) => x.harness === cur.harness && x.id === cur.id && x.path === cur.path)) || cur);
      if (!cursor) setShownFor({ q: q.trim(), all });
    } catch (e) {
      // A cursor the daemon does not take (one a page of an older build held
      // through an upgrade): the list is read again from the top, as far as it was shown.
      if (cursor && (e as { status?: number }).status === 400) return load(undefined, false, shown.current + 60);
      reportError(e);
    }
  }, [harness, q, all, from]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => load(), q ? 180 : 0);
    return () => clearTimeout(t);
  }, [open, load, q]);
  // The first listing of a large store goes on in the background: look again until it is whole.
  useEffect(() => {
    if (!open || !building) return;
    const t = setTimeout(() => load(), 1500);
    return () => clearTimeout(t);
  }, [open, building, load]);
  useEffect(() => { setSel(null); setRows(null); setConfirm(null); setFails([]); setBulk(""); setIntent(null); }, [harness, from]);
  // What runs the shown conversations there is looked at again every few
  // seconds while the sheet is open: a harness starts, works and ends meanwhile.
  const watched = !!ssh && !!rows?.length;
  useEffect(() => {
    if (!open || !watched) return;
    const t = setInterval(() => {
      const u = new URLSearchParams({ harness, limit: "60", peek: "1" });
      if (shownFor.q) u.set("q", shownFor.q);
      if (shownFor.all) u.set("show", "all");
      api<{ sessions: Row[] }>(`${paths(from).list}?${u}`).then((r) => {
        noteRows(from, r.sessions);
        // A conversation resumed since (its wait ended) now shows as imported.
        setRows((prev) => prev && prev.map((x) => r.sessions.find((y) => y.id === x.id && y.harness === x.harness) ?? x));
      }, () => {});
    }, 4000);
    return () => clearInterval(t);
  }, [open, watched, from, harness, shownFor]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup
          data-testid="import-sheet"
          className="fixed inset-x-4 top-[6vh] bottom-[6vh] z-50 mx-auto flex max-w-6xl flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-3 transition-[transform,opacity] duration-200 data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:opacity-0"
        >
          <div className="flex items-center gap-3 border-b border-line px-4 py-3">
            <History className="size-4 text-muted" />
            <Dialog.Title className="font-semibold">Import sessions</Dialog.Title>
            <Seg
              kind="tabs"
              // Each source is listed over the network and a change drops the pick: the arrows only move, Space or Enter chooses.
              manual
              panel={panel}
              className="ml-2"
              label="Where to import from"
              value={harness}
              onChange={setHarness}
              options={(harnesses.length ? harnesses : [{ harness: "claude", label: "Claude Code" }, { harness: "codex", label: "Codex" }, { harness: "keel", label: "Keel (Rust)" }] as HarnessState[]).map((h) => ({
                value: h.harness,
                testid: `import-tab-${h.harness}`,
                className: cn(h.installed === false && "opacity-50"),
                label: <>{h.label}{h.interactive !== undefined && <span className="ml-1.5 tabular-nums text-faint">{h.interactive.toLocaleString()}</span>}</>,
              }))}
            />
            <input ref={pick} type="file" accept=".jsonl,application/x-ndjson,application/jsonl" hidden data-testid="import-keel-file-input" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importKeelFile(f); }} />
            <button type="button" data-testid="import-keel-file" title="A session exported from another Keel as a Keel file" disabled={keelFile?.state === "sending"} onClick={() => pick.current?.click()} className="ml-auto flex h-7 items-center gap-1.5 rounded-md px-2 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-50">
              <FileUp className="size-3.5" />
              Import a Keel file
            </button>
            {linked.length > 0 && (
              <label className="flex items-center gap-1.5 text-caption text-faint">
                On
                <Select data-testid="import-from" value={from} onChange={(e) => setFrom(e.target.value)} className="h-7 rounded-md border border-line bg-raised px-1.5 text-caption text-fg outline-none focus-visible:border-accent">
                  <option value="">this machine</option>
                  {linked.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              </label>
            )}
            <button type="button" title="Read the stores again" onClick={() => load(undefined, true)} className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg">
              <RefreshCw className={cn("size-3.5", building && "animate-spin")} />
            </button>
            <Dialog.Close className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"><X className="size-4" /></Dialog.Close>
          </div>
          {keelFile && (
            <div data-testid="import-keel-result" data-state={keelFile.state} className={cn("flex items-start gap-3 border-b border-line px-4 py-2.5 text-caption", keelFile.state === "failed" ? "bg-danger-soft text-danger" : "bg-sunken text-muted")}>
              <FileUp className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1 space-y-0.5">
                {keelFile.state === "sending" && <p>Importing {keelFile.name}</p>}
                {keelFile.state === "failed" && <p>{keelFile.name} was not imported: {keelFile.error}</p>}
                {keelFile.state === "done" && (
                  <>
                    <p className="text-fg">Imported “{keelFile.title || "Session"}” from {keelFile.name}: {keelFile.events} event{keelFile.events === 1 ? "" : "s"}{keelFile.files ? ` and ${keelFile.files} attached file${keelFile.files === 1 ? "" : "s"}` : ""}.</p>
                    {keelFile.notes.map((n) => <p key={n} data-testid="import-keel-note">{n}</p>)}
                  </>
                )}
              </div>
              {keelFile.state === "done" && <button type="button" data-testid="import-keel-open" onClick={() => openSession(keelFile.id)} className="h-6 shrink-0 rounded-md bg-accent px-2 font-medium text-accent-fg hover:opacity-90">Open</button>}
              {keelFile.state !== "sending" && <button type="button" aria-label="Dismiss" onClick={() => setKeelFile(null)} className="grid size-6 shrink-0 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"><X className="size-3.5" /></button>}
            </div>
          )}
          <div className="flex min-h-0 flex-1">
            <div className="flex w-[26rem] shrink-0 flex-col border-r border-line">
              <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                <Search className="size-4 shrink-0 text-faint" />
                <input data-testid="import-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, folder or prompt" className="h-8 min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-faint" />
                <label className="flex shrink-0 items-center gap-1.5 text-caption text-faint" title="Also subagents and sessions nobody sat at (headless, loops)">
                  All
                  <Switch.Root checked={all} onCheckedChange={setAll} className="k-switch">
                    <Switch.Thumb className="k-switch-thumb" />
                  </Switch.Root>
                </label>
              </div>
              {!from && <Running onDone={() => onOpenChange(false)} />}
              <div className="flex items-center gap-2 px-3 py-1.5 text-micro text-faint tabular-nums">
                <span className="min-w-0 flex-1 truncate" data-testid="import-total">{bulk || (rows ? `${total.toLocaleString()} session${total === 1 ? "" : "s"}${building ? " · reading the store" : ""}` : "Reading")}</span>
                {rows && total > 0 && !building && !from && !confirm && (
                  <button type="button" data-testid="import-all" disabled={bulk.startsWith("Importing") || shownFor.q !== q.trim() || shownFor.all !== all} onClick={() => collect().catch((e) => { setBulk(""); reportError(e); })} className="shrink-0 rounded-sm px-1.5 py-0.5 text-accent hover:bg-accent-soft disabled:opacity-50" title="Import every session this list shows; ones imported before stay as they are">
                    Import all
                  </button>
                )}
              </div>
              {confirm && (
                <div className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-line bg-raised px-3 py-2 text-caption" data-testid="import-all-confirm">
                  <span className="min-w-0 flex-1">Import {confirm.length.toLocaleString()} new {confirm.length === 1 ? "copy" : "copies"}{shownFor.q ? ` matching "${shownFor.q}"` : ""}?</span>
                  <button type="button" onClick={() => setConfirm(null)} className="h-6 rounded-md px-2 text-muted hover:bg-hover hover:text-fg">Cancel</button>
                  <button type="button" data-testid="import-all-go" onClick={() => importAll(confirm).catch((e) => { setBulk(""); reportError(e); })} className="h-6 rounded-md bg-accent px-2 font-medium text-accent-fg hover:opacity-90">Import</button>
                </div>
              )}
              {fails.length > 0 && (
                <div className="mx-3 mb-2 rounded-md border border-line border-l-[3px] border-l-st-fail bg-raised text-caption" data-testid="import-fails">
                  <ul className="max-h-40 divide-y divide-line overflow-y-auto">
                    {fails.map((f) => (
                      <li key={f.item.harness + f.item.id + (f.item.path ?? "")} className="px-3 py-1.5" data-testid="import-fail">
                        <div className="truncate font-medium text-fg">{f.item.title || f.item.id}</div>
                        <div className="text-muted">{f.error}{f.reason === "no_model" && <button type="button" onClick={() => { onOpenChange(false); navigate({ name: "settings", section: "providers" }); }} className="k-link ml-1 text-accent hover:underline">Set up a provider</button>}</div>
                      </li>
                    ))}
                  </ul>
                  <div className="flex justify-end border-t border-line px-2 py-1">
                    <button type="button" data-testid="import-retry-failed" disabled={bulk.startsWith("Importing")} onClick={() => importAll(fails.map((f) => f.item)).catch((e) => { setBulk(""); reportError(e); })} className="h-6 rounded-md px-2 text-accent hover:bg-accent-soft disabled:opacity-50">Retry failed</button>
                  </div>
                </div>
              )}
              <div role="tabpanel" id={panel} aria-labelledby={tabId(panel, harness)} className="min-h-0 flex-1 overflow-y-auto" data-testid="import-list">
                {rows?.map((r) => (
                  <div key={r.path + r.id} className={cn("border-b border-line/60 transition-colors", sel?.id === r.id ? "k-picked" : "hover:bg-hover")}>
                    <button
                      type="button"
                      data-testid="import-row"
                      data-id={r.id}
                      onClick={() => { setSel(r); setIntent(null); }}
                      className="block w-full px-3 py-2 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-ui font-medium">{r.title}</span>
                        {r.imported && <span className="shrink-0 rounded-xs bg-ok/15 px-1.5 text-micro font-medium text-ok" data-testid="import-imported">{r.imported.grew ? "imported · grew" : "imported"}</span>}
                        {r.kind !== "interactive" && <span className="shrink-0 rounded-xs bg-sunken px-1.5 text-micro text-muted">{r.kind}</span>}
                      </div>
                      <div className="mt-0.5 flex gap-2 text-micro text-faint">
                        <span className="min-w-0 flex-1 truncate">{home(r.cwd)}</span>
                        <span className="shrink-0 tabular-nums">{size(r.size_bytes)}</span>
                        <span className="shrink-0">{ago(r.updated_ms)}</span>
                      </div>
                    </button>
                    {ssh && <OriginalStrip target={{ machine: from, harness: r.harness, id: r.id }} tool={TOOL[r.harness] ?? r.harness} onPick={(i) => { setSel(r); setIntent(i); }} onOpen={(id) => { onOpenChange(false); navigate({ name: "session", id }); }} />}
                  </div>
                ))}
                {rows?.length === 0 && <p className="k-empty px-3 py-4">No sessions match.</p>}
                {next !== undefined && (
                  <button type="button" onClick={() => load(next)} className="w-full py-2 text-caption text-accent hover:bg-hover">More</button>
                )}
              </div>
            </div>
            {sel ? (
              <PreviewPane row={sel} from={from} resume={ssh ? { machineName: ssh.name } : undefined} intent={intent} onIntent={setIntent} onDone={() => onOpenChange(false)} />
            ) : (
              <div className="flex-1 p-6">
                <div className="k-empty max-w-md">
                  <b>No session picked</b>
                  <p>Pick a session to see what an import brings.</p>
                  <p className="mt-1">{from ? "That machine reads its own stores and never writes to them. The copy goes on here with any model, and its tools run on that machine." : "Keel reads the other harness's store and never writes to it. The copy keeps its folder and goes on here with any model."}</p>
                </div>
              </div>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
