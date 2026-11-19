// Import sessions from Claude Code, Codex and the Rust Keel: browse each
// harness's sessions, preview what an import brings, and import a read-only
// copy (the original is never changed). A session imported before opens, or is
// brought up to date with what its source gained.
import { Dialog } from "@base-ui/react/dialog";
import { Switch } from "@base-ui/react/switch";
import { ArrowDownToLine, FolderOpen, History, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Found, Harness } from "../../../src/integrations/import/types.ts";
import { useFleet } from "../lib/fleet.ts";
import { api, reportError } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { ago, cn } from "../lib/utils.ts";

type Row = Found & { imported?: { session_id: string; synced_ms: number; grew: boolean } };
type HarnessState = { harness: Harness; label: string; store: string; installed: boolean; total: number; interactive: number };
type Preview = {
  session: Found & { cwd_exists: boolean };
  counts: { prompts: number; assistant_messages: number; tool_calls: number; thoughts_dropped: number; skipped: number; media: number };
  notes: string[];
  tail: { role: string; text: string }[];
  links: { session_id: string; imported_ms: number }[];
};

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

function PreviewPane({ row, from, onDone }: { row: Row; from: string; onDone: () => void }) {
  const [p, setP] = useState<Preview | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setP(null);
    setErr("");
    api<Preview>(`${paths(from).preview}?harness=${row.harness}&id=${encodeURIComponent(row.id)}`).then(setP, (e) => setErr(e.message));
  }, [row.harness, row.id, from]);
  const go = async (mode?: "new" | "update" | "open") => {
    setBusy(true);
    try {
      const r = await api<{ session: { id: string } }>(paths(from).import, { method: "POST", body: JSON.stringify({ harness: row.harness, id: row.id, mode }) });
      onDone();
      navigate({ name: "session", id: r.session.id });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const done = row.imported;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="import-preview">
      <div className="border-b border-line px-5 py-4">
        <div className="text-base font-semibold leading-snug">{row.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-faint">
          <span className="inline-flex items-center gap-1"><FolderOpen className="size-3.5" />{home(row.cwd) || "no folder"}{p && !p.session.cwd_exists && row.cwd ? " (gone)" : ""}</span>
          {row.model && <span className="font-mono">{row.model}</span>}
          <span>{ago(row.updated_ms)}</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {err && <p className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-caption text-danger" data-testid="import-error">{err}</p>}
        {!p && !err && <p className="text-ui text-faint">Reading the session</p>}
        {p && (
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
            <div className="mt-5 text-caption font-medium uppercase tracking-wide text-faint">Last messages</div>
            <div className="mt-2 space-y-2">
              {p.tail.map((m, i) => (
                <div key={i} className={cn("rounded-lg px-3 py-2 text-ui", m.role === "user" ? "ml-10 bg-accent-soft" : "mr-10 border border-line bg-raised")}>
                  <p className="line-clamp-6 whitespace-pre-wrap break-words">{m.text}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-line px-5 py-3">
        <span className="min-w-0 flex-1 text-caption text-faint">
          {done ? (done.grew ? "Imported before; the original has gone on since." : "Imported before.") : "A copy: the original stays as it is."}
        </span>
        {done ? (
          <>
            <button type="button" disabled={busy} onClick={() => go("new")} className="h-8 rounded-lg px-3 text-ui text-muted hover:bg-hover hover:text-fg">New copy</button>
            {done.grew && <button type="button" disabled={busy} onClick={() => go("update")} data-testid="import-update" className="h-8 rounded-lg border border-line-strong px-3 text-ui font-medium hover:bg-hover">Update</button>}
            <button type="button" disabled={busy} onClick={() => go("open")} data-testid="import-open" className="h-8 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:opacity-90">Open</button>
          </>
        ) : (
          <button type="button" disabled={busy || !p} onClick={() => go()} data-testid="import-go" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:opacity-90 disabled:opacity-40">
            <ArrowDownToLine className="size-4" /> Import
          </button>
        )}
      </div>
    </div>
  );
}

export function ImportSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [harness, setHarness] = useState<Harness>("claude");
  const [harnesses, setHarnesses] = useState<HarnessState[]>([]);
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState<number | undefined>();
  const [sel, setSel] = useState<Row | null>(null);
  const [building, setBuilding] = useState(false);
  const seq = useRef(0);
  const [bulk, setBulk] = useState("");
  const [from, setFrom] = useState("");
  const machines = useFleet((s) => s.machines);
  const linked = useMemo(() => machines.filter((m) => m.source !== "local" && m.enabled && m.daemon?.state === "linked" && m.workspace_root), [machines]);

  // Every session the filter shows, imported 200 at a time; ones imported before are left as they are.
  const importAll = async () => {
    const u = new URLSearchParams({ harness, limit: "500" });
    if (q.trim()) u.set("q", q.trim());
    if (all) u.set("show", "all");
    const items: { harness: Harness; id: string }[] = [];
    for (let cursor: number | undefined = 0; cursor !== undefined; ) {
      u.set("cursor", String(cursor));
      const r: { sessions: Row[]; next_cursor?: number } = await api(`/api/import/sessions?${u}`);
      for (const x of r.sessions) if (!x.imported) items.push({ harness: x.harness, id: x.id });
      cursor = r.next_cursor;
    }
    let done = 0, failed = 0;
    for (let i = 0; i < items.length; i += 200) {
      setBulk(`Importing ${done} of ${items.length}`);
      const r = await api<{ counts: Record<string, number> }>("/api/import/batch", { method: "POST", body: JSON.stringify({ items: items.slice(i, i + 200) }) });
      done += (r.counts.created ?? 0) + (r.counts.opened ?? 0);
      failed += r.counts.failed ?? 0;
    }
    setBulk(`Imported ${done}${failed ? `, ${failed} could not be read` : ""}`);
    load(0);
  };

  const load = useCallback(async (cursor = 0, refresh = false) => {
    const n = ++seq.current;
    const u = new URLSearchParams({ harness, limit: "60", cursor: String(cursor) });
    if (q.trim()) u.set("q", q.trim());
    if (all) u.set("show", "all");
    if (refresh) u.set("refresh", "1");
    try {
      const r = await api<{ sessions: Row[]; total: number; next_cursor?: number; harnesses: HarnessState[]; index: { building: boolean } }>(`${paths(from).list}?${u}`);
      if (n !== seq.current) return;
      setHarnesses(r.harnesses);
      setTotal(r.total);
      setNext(r.next_cursor);
      setBuilding(r.index.building);
      setRows((prev) => (cursor ? [...(prev ?? []), ...r.sessions] : r.sessions));
    } catch (e) {
      reportError(e);
    }
  }, [harness, q, all, from]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => load(0), q ? 180 : 0);
    return () => clearTimeout(t);
  }, [open, load, q]);
  // The first listing of a large store goes on in the background: look again until it is whole.
  useEffect(() => {
    if (!open || !building) return;
    const t = setTimeout(() => load(0), 1500);
    return () => clearTimeout(t);
  }, [open, building, load]);
  useEffect(() => { setSel(null); setRows(null); }, [harness, from]);

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
            <div className="ml-2 flex rounded-lg bg-panel p-0.5 text-caption" role="tablist">
              {(harnesses.length ? harnesses : [{ harness: "claude", label: "Claude Code" }, { harness: "codex", label: "Codex" }, { harness: "keel", label: "Keel (Rust)" }] as HarnessState[]).map((h) => (
                <button
                  key={h.harness}
                  type="button"
                  role="tab"
                  aria-selected={harness === h.harness}
                  data-testid={`import-tab-${h.harness}`}
                  onClick={() => setHarness(h.harness)}
                  className={cn("rounded-md px-2.5 py-1 text-muted transition-colors", harness === h.harness ? "bg-raised text-fg shadow-1" : "hover:text-fg", h.installed === false && "opacity-50")}
                >
                  {h.label}
                  {h.interactive !== undefined && <span className="ml-1.5 tabular-nums text-faint">{h.interactive.toLocaleString()}</span>}
                </button>
              ))}
            </div>
            {linked.length > 0 && (
              <label className="ml-auto flex items-center gap-1.5 text-caption text-faint">
                On
                <select data-testid="import-from" value={from} onChange={(e) => setFrom(e.target.value)} className="h-7 rounded-md border border-line bg-raised px-1.5 text-caption text-fg outline-none focus-visible:border-accent">
                  <option value="">this machine</option>
                  {linked.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </label>
            )}
            <button type="button" title="Read the stores again" onClick={() => load(0, true)} className={cn(!linked.length && "ml-auto", "grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg")}>
              <RefreshCw className={cn("size-3.5", building && "animate-spin")} />
            </button>
            <Dialog.Close className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"><X className="size-4" /></Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="flex w-[26rem] shrink-0 flex-col border-r border-line">
              <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                <Search className="size-4 shrink-0 text-faint" />
                <input data-testid="import-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, folder or prompt" className="h-8 min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-faint" />
                <label className="flex shrink-0 items-center gap-1.5 text-caption text-faint" title="Also subagents and sessions nobody sat at (headless, loops)">
                  All
                  <Switch.Root checked={all} onCheckedChange={setAll} className="relative flex h-4 w-7 rounded-full bg-line-strong p-0.5 transition-colors data-checked:bg-accent">
                    <Switch.Thumb className="size-3 rounded-full bg-raised transition-transform data-checked:translate-x-3" />
                  </Switch.Root>
                </label>
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5 text-micro text-faint tabular-nums">
                <span className="min-w-0 flex-1 truncate" data-testid="import-total">{bulk || (rows ? `${total.toLocaleString()} session${total === 1 ? "" : "s"}${building ? " · reading the store" : ""}` : "Reading")}</span>
                {rows && total > 0 && !building && !from && (
                  <button type="button" data-testid="import-all" disabled={bulk.startsWith("Importing")} onClick={() => importAll().catch((e) => { setBulk(""); reportError(e); })} className="shrink-0 rounded-sm px-1.5 py-0.5 text-accent hover:bg-accent-soft disabled:opacity-50" title="Import every session this list shows; ones imported before stay as they are">
                    Import all
                  </button>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto" data-testid="import-list">
                {rows?.map((r) => (
                  <button
                    key={r.path + r.id}
                    type="button"
                    data-testid="import-row"
                    data-id={r.id}
                    onClick={() => setSel(r)}
                    className={cn("block w-full border-b border-line/60 px-3 py-2 text-left transition-colors hover:bg-hover", sel?.id === r.id && "bg-accent-soft hover:bg-accent-soft")}
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-ui font-medium">{r.title}</span>
                      {r.imported && <span className="shrink-0 rounded-xs bg-ok/15 px-1.5 text-micro font-medium text-ok" data-testid="import-imported">{r.imported.grew ? "imported · grew" : "imported"}</span>}
                      {r.kind !== "interactive" && <span className="shrink-0 rounded-xs bg-panel px-1.5 text-micro text-muted">{r.kind}</span>}
                    </div>
                    <div className="mt-0.5 flex gap-2 text-micro text-faint">
                      <span className="min-w-0 flex-1 truncate">{home(r.cwd)}</span>
                      <span className="shrink-0 tabular-nums">{size(r.size_bytes)}</span>
                      <span className="shrink-0">{ago(r.updated_ms)}</span>
                    </div>
                  </button>
                ))}
                {rows?.length === 0 && <p className="px-3 py-6 text-center text-ui text-faint">No sessions match.</p>}
                {next !== undefined && (
                  <button type="button" onClick={() => load(next)} className="w-full py-2 text-caption text-accent hover:bg-hover">More</button>
                )}
              </div>
            </div>
            {sel ? (
              <PreviewPane row={sel} from={from} onDone={() => onOpenChange(false)} />
            ) : (
              <div className="grid flex-1 place-items-center px-10 text-center">
                <div>
                  <p className="text-ui font-medium">Pick a session to see what an import brings</p>
                  <p className="mt-1 text-caption text-faint">{from ? "That machine's daemon reads its stores and never writes to them. The copy goes on here with any model, and its tools run on that machine." : "Keel reads the other harness's store and never writes to it. The copy keeps its folder and goes on here with any model."}</p>
                </div>
              </div>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
