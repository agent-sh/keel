import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog } from "@base-ui/react/dialog";
import { Tabs } from "@base-ui/react/tabs";
import { FileDiff, History, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, onFeature, reportError } from "../lib/store.ts";
import { ago, cn } from "../lib/utils.ts";
import { DiffView, RevertButton, type FileChange } from "./DiffView.tsx";

type Turn = { turn: number; prompt: string; created: number; files: FileChange[]; added: number; removed: number; scope: "tree" | "written" };
type Diff = { files: FileChange[]; diff: string; truncated: boolean; scope: "tree" | "written" };
type RewindResult = { files: string[]; skipped: string[]; outside: string[]; undo: string | null; scope: string };
type Pending = { title: string; body: { turn?: number; paths?: string[] }; preview: RewindResult };

// What the session changed: the whole session's diff with a revert per file,
// and each turn's diff with "rewind to before this turn". Extra tabs (the
// worktree's branch review) plug in through `extraTabs`.
export function ChangesPanel({ sessionId, open, onOpenChange, extraTabs }: {
  sessionId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  extraTabs?: { id: string; label: string; panel: ReactNode }[];
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [scope, setScope] = useState<{ scope: string; reason: string | null }>({ scope: "tree", reason: null });
  const [session, setSession] = useState<Diff | null>(null);
  const [turnDiff, setTurnDiff] = useState<Record<number, Diff>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [includeOutside, setIncludeOutside] = useState(false);
  const [done, setDone] = useState<RewindResult | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<string>("session");

  const load = useCallback(async () => {
    try {
      const r = await api<{ turns: Turn[]; scope: string; reason: string | null }>(`/api/sessions/${sessionId}/checkpoints`);
      setTurns(r.turns);
      setScope({ scope: r.scope, reason: r.reason });
      setTurnDiff({});
      const first = r.turns[0]?.turn;
      setSession(first === undefined ? { files: [], diff: "", truncated: false, scope: "tree" } : await api<Diff>(`/api/sessions/${sessionId}/checkpoints/diff?from=${first}`));
    } catch (e) {
      setErr((e as Error).message);
      reportError(e, { at: "changes load" });
    }
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    load();
    return onFeature({ frame: (f) => { if (f.name === "checkpoints" && f.session_id === sessionId) load(); }, reconnect: load });
  }, [open, load]);

  const openTurn = async (t: number) => {
    if (turnDiff[t]) return;
    const d = await api<Diff>(`/api/sessions/${sessionId}/checkpoints/diff?turn=${t}`).catch((e) => (reportError(e), null));
    if (d) setTurnDiff((m) => ({ ...m, [t]: d }));
  };

  const ask = async (title: string, body: Pending["body"]) => {
    setErr("");
    setDone(null);
    try {
      const preview = await api<RewindResult>(`/api/sessions/${sessionId}/rewind`, { method: "POST", body: JSON.stringify({ ...body, preview: true }) });
      setIncludeOutside(false);
      setPending({ title, body, preview });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const run = async (body: object) => {
    setErr("");
    try {
      const r = await api<RewindResult>(`/api/sessions/${sessionId}/rewind`, { method: "POST", body: JSON.stringify(body) });
      setDone(r);
      setPending(null);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const firstTurn = turns[0]?.turn;
  const tabCls = "h-8 rounded-md px-3 text-ui text-muted outline-none hover:text-fg data-[active]:bg-raised data-[active]:text-fg data-[active]:shadow-2 focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px] transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup
          data-testid="changes-panel"
          className="fixed right-4 top-4 bottom-4 z-50 flex w-[min(68rem,calc(100vw-2rem))] flex-col rounded-2xl border border-line bg-bg shadow-2 transition-[transform,opacity] duration-200 data-starting-style:translate-x-4 data-starting-style:opacity-0 data-ending-style:translate-x-4 data-ending-style:opacity-0"
        >
          <Tabs.Root value={tab} onValueChange={(v) => setTab(String(v))} className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
              <Dialog.Title className="font-semibold">Changes</Dialog.Title>
              <Tabs.List className="flex gap-0.5 rounded-lg bg-panel p-0.5">
                <Tabs.Tab value="session" className={tabCls} data-testid="tab-session">Session</Tabs.Tab>
                <Tabs.Tab value="turns" className={tabCls} data-testid="tab-turns">By turn</Tabs.Tab>
                {extraTabs?.map((t) => <Tabs.Tab key={t.id} value={t.id} className={tabCls} data-testid={`tab-${t.id}`}>{t.label}</Tabs.Tab>)}
              </Tabs.List>
              {scope.scope === "written" && (
                <span className="truncate text-caption text-warn" title={scope.reason ?? ""}>Only files the tools wrote are tracked: {scope.reason}</span>
              )}
              <Dialog.Close className="ml-auto grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg">
                <X className="size-4" />
              </Dialog.Close>
            </div>
            {(done || err) && (
              <div className={cn("flex items-center gap-3 border-b border-line px-4 py-2 text-ui", err ? "bg-danger-soft text-danger" : "bg-accent-soft/50")} data-testid="rewind-done">
                {err ? err : (
                  <>
                    <span>Restored {done!.files.length} file{done!.files.length === 1 ? "" : "s"}{done!.skipped.length ? `, kept ${done!.skipped.length} changed outside the session` : ""}.</span>
                    {done!.undo && (
                      <button data-testid="rewind-undo" className="font-medium text-accent hover:underline" onClick={() => { run({ checkpoint: done!.undo }); }}>
                        Undo
                      </button>
                    )}
                  </>
                )}
                <button className="ml-auto text-faint hover:text-fg" onClick={() => { setDone(null); setErr(""); }}><X className="size-3.5" /></button>
              </div>
            )}
            <Tabs.Panel value="session" className="min-h-0 flex-1 overflow-y-auto p-4">
              {session && session.files.length > 0 && firstTurn !== undefined && (
                <div className="mb-3 flex items-center gap-2">
                  <span className="text-ui text-muted">
                    {session.files.length} file{session.files.length === 1 ? "" : "s"} changed since the session's first change
                  </span>
                  <button
                    data-testid="revert-all"
                    onClick={() => ask("Revert everything the session changed?", { turn: firstTurn })}
                    className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-ui hover:bg-hover"
                  >
                    <RotateCcw className="size-3.5" /> Revert all
                  </button>
                </div>
              )}
              {session && (
                <DiffView
                  files={session.files}
                  patch={session.diff}
                  empty="The session has not changed any files yet."
                  actions={(f) => firstTurn !== undefined && <RevertButton onClick={() => ask(`Revert ${f.path}?`, { turn: firstTurn, paths: [f.path] })} />}
                />
              )}
            </Tabs.Panel>
            <Tabs.Panel value="turns" className="min-h-0 flex-1 overflow-y-auto p-4">
              {turns.length === 0 && <p className="py-10 text-center text-ui text-faint">No turn has changed files yet.</p>}
              <ol className="flex flex-col gap-2">
                {[...turns].reverse().map((t) => (
                  <li key={t.turn} className="rounded-xl border border-line bg-raised" data-testid="turn-checkpoint">
                    <details onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && openTurn(t.turn)}>
                      <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2">
                        <History className="size-4 shrink-0 text-faint" />
                        <span className="min-w-0 flex-1 truncate text-ui">{t.prompt || "(no prompt)"}</span>
                        <span className="text-micro text-faint">{t.files.length} file{t.files.length === 1 ? "" : "s"}</span>
                        <span className="font-mono text-micro tabular-nums"><span className="text-ok">+{t.added}</span> <span className="text-danger">-{t.removed}</span></span>
                        <span className="w-8 text-right text-micro tabular-nums text-faint">{ago(t.created)}</span>
                        <button
                          data-testid="rewind-turn"
                          onClick={(e) => { e.preventDefault(); ask("Rewind files to before this turn?", { turn: t.turn }); }}
                          className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-caption text-muted hover:bg-hover hover:text-fg"
                          title="Put files back as they were before this turn"
                        >
                          <RotateCcw className="size-3.5" /> Rewind
                        </button>
                      </summary>
                      <div className="border-t border-line p-3">
                        {turnDiff[t.turn] ? <DiffView files={turnDiff[t.turn]!.files} patch={turnDiff[t.turn]!.diff} empty="This turn changed no files." /> : <p className="text-caption text-faint">Loading…</p>}
                      </div>
                    </details>
                  </li>
                ))}
              </ol>
            </Tabs.Panel>
            {extraTabs?.map((t) => (
              <Tabs.Panel key={t.id} value={t.id} className="min-h-0 flex-1 overflow-y-auto p-4">{t.panel}</Tabs.Panel>
            ))}
          </Tabs.Root>
          <AlertDialog.Root open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
            <AlertDialog.Portal>
              <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/20" />
              <AlertDialog.Popup data-testid="rewind-confirm" className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-raised p-5 shadow-2">
                <AlertDialog.Title className="font-semibold">{pending?.title}</AlertDialog.Title>
                <AlertDialog.Description className="mt-1 text-ui text-muted">
                  {pending && pending.preview.files.length + (includeOutside ? pending.preview.skipped.length : 0) === 0
                    ? "Nothing to restore: the files already match."
                    : "These files go back. An undo point is saved first."}
                </AlertDialog.Description>
                {pending && (
                  <ul className="mt-3 max-h-56 overflow-y-auto rounded-lg bg-code p-2 font-mono text-caption">
                    {pending.preview.files.map((f) => <li key={f} className="flex gap-2"><FileDiff className="mt-0.5 size-3.5 shrink-0 text-accent" />{f}</li>)}
                    {pending.preview.skipped.map((f) => (
                      <li key={f} className={cn("flex gap-2", !includeOutside && "text-faint line-through")}>
                        <FileDiff className="mt-0.5 size-3.5 shrink-0 text-warn" />{f}
                      </li>
                    ))}
                  </ul>
                )}
                {pending && pending.preview.skipped.length > 0 && (
                  <label className="mt-3 flex items-start gap-2 text-ui">
                    <input type="checkbox" checked={includeOutside} onChange={(e) => setIncludeOutside(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" data-testid="include-outside" />
                    <span>
                      Also restore {pending.preview.skipped.length} file{pending.preview.skipped.length === 1 ? "" : "s"} changed outside the session
                      <span className="block text-caption text-muted">Kept by default: someone else (you, or another session) edited them since.</span>
                    </span>
                  </label>
                )}
                <div className="mt-4 flex justify-end gap-2">
                  <AlertDialog.Close className="h-8 rounded-lg px-3 text-ui text-muted hover:bg-hover">Cancel</AlertDialog.Close>
                  <button
                    data-testid="rewind-go"
                    onClick={() => pending && run({ ...pending.body, include_outside: includeOutside })}
                    className="h-8 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:opacity-90"
                  >
                    Restore
                  </button>
                </div>
              </AlertDialog.Popup>
            </AlertDialog.Portal>
          </AlertDialog.Root>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// The header button that opens the panel.
export function ChangesButton({ sessionId, extraTabs }: { sessionId: string; extraTabs?: { id: string; label: string; panel: ReactNode }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        data-testid="open-changes"
        onClick={() => setOpen(true)}
        className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-caption text-muted hover:bg-hover hover:text-fg"
        title="What this session changed"
      >
        <FileDiff className="size-3.5" /> Changes
      </button>
      <ChangesPanel sessionId={sessionId} open={open} onOpenChange={setOpen} extraTabs={extraTabs} />
    </>
  );
}
