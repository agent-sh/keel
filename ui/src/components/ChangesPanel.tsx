import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Tabs } from "@base-ui/react/tabs";
import { FileDiff, FolderX, History, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { api, onFeature, reportError, failed } from "../lib/store.ts";
import { stoppingShells } from "../lib/shells.ts";
import { ago, cn } from "../lib/utils.ts";
import { DiffView, RevertButton, type FileChange } from "./DiffView.tsx";

type Turn = { turn: number; prompt: string; created: number; files: FileChange[]; added: number; removed: number; scope: "tree" | "written"; incomplete?: boolean; elsewhere?: string; unavailable?: string };
type Diff = { files: FileChange[]; diff: string; truncated: boolean; partial?: string; scope: "tree" | "written"; incomplete?: boolean };
type RewindResult = {
  files: string[]; failed: { path: string; error: string }[]; skipped: string[]; outside: string[]; merged: string[]; conflicts: string[]; removes: string[]; uncaptured: string[];
  versions: Record<string, string>; incomplete: boolean; undo: string | null; scope: string;
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
type Pending = { title: string; body: { turn?: number; paths?: string[] }; preview: RewindResult };

// What the session changed, in the side panel: the whole session's diff with
// a revert per file, and each turn's diff with "rewind to before this turn".
export function ChangesPanel({ session }: { session: Session }) {
  const sessionId = session.id;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [scope, setScope] = useState<{ scope: string; reason: string | null; skipped?: string[]; skipped_count?: number; expired?: number }>({ scope: "tree", reason: null });
  const [all, setAll] = useState<Diff | null>(null);
  const [turnDiff, setTurnDiff] = useState<Record<number, Diff>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [includeOutside, setIncludeOutside] = useState(false);
  const [done, setDone] = useState<RewindResult | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<string>("session");
  // With the folder gone there is nothing to put files back into: the diffs
  // still read, the reverts are not offered.
  const gone = !!session.workspace_gone;
  // The session diff and its reverts start at the first turn in this folder
  // (turns from before a move to another folder belong to that folder).
  const here = turns.filter((t) => !t.elsewhere);
  const canRevert = here[0] !== undefined && !gone;

  const load = useCallback(async () => {
    try {
      const r = await api<{ turns: Turn[]; expired: number; scope: string; reason: string | null; skipped?: string[]; skipped_count?: number }>(`/api/sessions/${sessionId}/checkpoints`);
      setTurns(r.turns);
      setScope({ scope: r.scope, reason: r.reason, skipped: r.skipped, skipped_count: r.skipped_count, expired: r.expired });
      setTurnDiff({});
      const first = r.turns.find((t) => !t.elsewhere)?.turn;
      setAll(first === undefined ? { files: [], diff: "", truncated: false, scope: "tree" } : await api<Diff>(`/api/sessions/${sessionId}/checkpoints/diff?from=${first}`));
    } catch (e) {
      setErr((e as Error).message);
      reportError(e, { at: "changes load" });
    }
  }, [sessionId]);

  useEffect(() => {
    load();
    return onFeature({ frame: (f) => { if (f.name === "checkpoints" && f.session_id === sessionId) load(); }, reconnect: load });
  }, [load]);
  // A turn that ends may have changed files.
  useEffect(() => { if (session.phase === "idle") load(); }, [session.phase]);

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
      setErr(failed(e, { at: "ChangesPanel" }));
    }
  };

  // The files as they are now are read again after a restore, failed or not.
  const run = async (body: object) => {
    setErr("");
    try {
      // Background commands in the folder would write over the restore: the owner may stop them first.
      setPending(null);
      const r = await stoppingShells((stop) => api<RewindResult>(`/api/sessions/${sessionId}/rewind`, { method: "POST", body: JSON.stringify({ ...body, stop_shells: stop || undefined }) }), { verb: "Restore", where: "this folder" });
      if (r) setDone(r);
    } catch (e) {
      setErr(failed(e, { at: "ChangesPanel" }));
    }
    load();
  };
  // What the owner confirms is what the preview showed, at the versions it showed.
  const confirm = (p: Pending) => run({
    ...p.body, include_outside: includeOutside,
    confirm: { paths: [...p.preview.files, ...p.preview.merged, ...(includeOutside ? p.preview.skipped : [])], versions: p.preview.versions },
  });
  const fileDiff = (q: string) => async (path: string) => (await api<Diff>(`/api/sessions/${sessionId}/checkpoints/diff?${q}&path=${encodeURIComponent(path)}`)).diff;

  const firstTurn = here[0]?.turn;
  const tabCls = "h-8 rounded-md px-3 text-ui text-muted outline-none hover:text-fg data-[active]:bg-raised data-[active]:text-fg data-[active]:shadow-2 focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div data-testid="changes-panel" className="flex h-full min-h-0 flex-col">
      <Tabs.Root value={tab} onValueChange={(v) => setTab(String(v))} className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-line px-3 py-2">
          <Tabs.List className="flex gap-0.5 rounded-lg bg-panel p-0.5">
            <Tabs.Tab value="session" className={tabCls} data-testid="tab-session">Session</Tabs.Tab>
            <Tabs.Tab value="turns" className={tabCls} data-testid="tab-turns">By turn</Tabs.Tab>
          </Tabs.List>
          {scope.scope === "written" && (
            <span className="truncate text-caption text-warn" title={scope.reason ?? ""}>Only files the tools wrote are tracked: {scope.reason}</span>
          )}
          {!!scope.expired && (
            <span className="truncate text-caption text-faint" data-testid="checkpoint-expired" title="Only the newest checkpoints are kept">
              {plural(scope.expired, "older turn")} can no longer be rewound
            </span>
          )}
          {scope.scope !== "written" && !!scope.skipped_count && (
            <span className="truncate text-caption text-faint" data-testid="checkpoint-skipped" title={scope.skipped?.join("\n")}>
              {scope.skipped_count} large file{scope.skipped_count === 1 ? "" : "s"} left out of checkpoints
            </span>
          )}
        </div>
        {(done || err) && (
          <div className={cn("flex items-center gap-3 border-b border-line px-4 py-2 text-ui", err ? "bg-danger-soft text-danger" : "bg-accent-soft/50")} data-testid="rewind-done">
            {err ? err : (
              <>
                <span className={cn(done!.failed.length > 0 && "text-danger")}>
                  {done!.failed.length ? `Restored ${done!.files.length} of ${done!.files.length + done!.failed.length} files` : `Restored ${plural(done!.files.length, "file")}`}
                  {done!.merged.length ? ` (in ${done!.merged.length} only the session's change, around later edits)` : ""}
                  {done!.skipped.length ? `, kept ${done!.skipped.length} changed outside the session` : ""}
                  {done!.uncaptured.length ? `, kept ${done!.uncaptured.length} too large to have been captured` : ""}.
                  {done!.failed.length > 0 && <span className="block text-caption" data-testid="rewind-failed">Not restored: {done!.failed.map((f) => `${f.path} (${f.error})`).join("; ")}</span>}
                </span>
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
          {all && all.files.length > 0 && gone && (
            <p className="mb-3 flex items-start gap-2 rounded-md border border-line border-l-[3px] border-l-st-fail bg-raised px-3 py-2 text-caption text-muted" data-testid="revert-gone" role="note">
              <FolderX className="mt-px size-3.5 shrink-0 text-st-fail" aria-hidden="true" />
              <span><span className="text-fg">Revert is off: the folder is gone.</span> These diffs still read; move the session to a folder that exists to put files back.</span>
            </p>
          )}
          {all && all.files.length > 0 && canRevert && (
            <div className="mb-3 flex items-center gap-2">
              <span className="text-ui text-muted">
                {all.files.length} file{all.files.length === 1 ? "" : "s"} changed since the session's first change
              </span>
              <button
                data-testid="revert-all"
                onClick={() => ask("Revert all file changes from this session?", { turn: firstTurn })}
                className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-ui hover:bg-hover"
              >
                <RotateCcw className="size-3.5" /> Revert all
              </button>
            </div>
          )}
          {all && (
            <DiffView
              files={all.files}
              patch={all.diff}
              empty="The session has not changed any files yet."
              truncated={all.truncated}
              partial={all.partial}
              loadFile={firstTurn === undefined ? undefined : fileDiff(`from=${firstTurn}`)}
              actions={(f) => canRevert && <RevertButton onClick={() => ask(`Revert ${f.path}?`, { turn: firstTurn, paths: [f.path] })} />}
              onHunk={!canRevert ? undefined : async (h) => {
                setErr("");
                try {
                  const r = await stoppingShells((stop) => api<RewindResult>(`/api/sessions/${sessionId}/changes/revert`, { method: "POST", body: JSON.stringify({ path: h.path, hunk: { index: h.index, header: h.header, body: h.body }, from: firstTurn, stop_shells: stop || undefined }) }), { verb: "Revert", where: "this folder" });
                  if (r) setDone(r);
                } catch (e) { setErr(failed(e, { at: "ChangesPanel" })); }
                load();
              }}
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
                    {t.elsewhere && <span className="max-w-40 truncate rounded-full bg-sunken px-1.5 font-mono text-micro text-muted" data-testid="turn-elsewhere" title={`This turn ran in ${t.elsewhere}, before the session moved; its files there are not put back from here`}>in {t.elsewhere.split("/").filter(Boolean).pop()}</span>}
                    {t.unavailable && <span className="rounded-full bg-danger-soft px-1.5 text-micro text-danger" title={t.unavailable}>history unreadable</span>}
                    {t.incomplete && <span className="rounded-full bg-warn/15 px-1.5 text-micro text-warn" title="No snapshot was taken when this turn ended (the daemon stopped during it?): its diff is its start against the files now, which may hold later edits">incomplete</span>}
                    <span className="text-micro text-faint">{t.files.length} file{t.files.length === 1 ? "" : "s"}</span>
                    <span className="font-mono text-micro tabular-nums"><span className="text-ok">+{t.added}</span> <span className="text-danger">-{t.removed}</span></span>
                    <span className="w-8 text-right text-micro tabular-nums text-faint">{ago(t.created)}</span>
                    {!gone && !t.elsewhere && !t.unavailable && <button
                      data-testid="rewind-turn"
                      onClick={(e) => { e.preventDefault(); ask("Rewind files to before this turn?", { turn: t.turn }); }}
                      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-caption text-muted hover:bg-hover hover:text-fg"
                      title="Put files back as they were before this turn"
                    >
                      <RotateCcw className="size-3.5" /> Rewind files
                    </button>}
                  </summary>
                  <div className="border-t border-line p-3">
                    {turnDiff[t.turn]?.incomplete && <p className="mb-2 text-caption text-warn" data-testid="turn-incomplete">This turn has no end snapshot: shown is its start against the files now, which may include edits made after it.</p>}
                    {turnDiff[t.turn] ? <DiffView files={turnDiff[t.turn]!.files} patch={turnDiff[t.turn]!.diff} truncated={turnDiff[t.turn]!.truncated} partial={turnDiff[t.turn]!.partial} loadFile={fileDiff(`turn=${t.turn}`)} empty="This turn changed no files." /> : <p className="text-caption text-faint">Loading…</p>}
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </Tabs.Panel>
      </Tabs.Root>
      <AlertDialog.Root open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/20" />
          <AlertDialog.Popup data-testid="rewind-confirm" className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-raised p-5 shadow-2">
            <AlertDialog.Title className="font-semibold">{pending?.title}</AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-ui text-muted">
              {pending?.preview.incomplete
                ? "The restore this undoes was cut before its result was recorded, so what it changed is not known. Nothing goes back unless you pick it below."
                : pending && pending.preview.files.length + (includeOutside ? pending.preview.skipped.length : 0) === 0
                ? "Nothing to restore: the files already match."
                : "These files go back as they were. An undo point is saved first."}
              {" This does not rewind chat history for this session or its child sessions."}
            </AlertDialog.Description>
            {pending && (
              <ul className="mt-3 max-h-56 overflow-y-auto rounded-lg bg-code p-2 font-mono text-caption" data-testid="rewind-list">
                {pending.preview.files.map((f) => <PreviewRow key={f} path={f} remove={pending.preview.removes.includes(f)} />)}
                {pending.preview.merged.map((f) => <PreviewRow key={f} path={f} remove={false} outside merged={!includeOutside} />)}
                {pending.preview.skipped.map((f) => (
                  <PreviewRow key={f} path={f} remove={pending.preview.removes.includes(f)} outside off={!includeOutside} conflict={pending.preview.conflicts.includes(f)} />
                ))}
                {pending.preview.uncaptured.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-faint" data-testid="rewind-uncaptured">
                    <FileDiff className="size-3.5 shrink-0" /><span className="min-w-0 truncate">{f}</span>
                    <span className="ml-auto shrink-0 font-sans text-micro">kept: too large to have been captured</span>
                  </li>
                ))}
              </ul>
            )}
            {pending && pending.preview.skipped.length > 0 && (
              <label className="mt-3 flex items-start gap-2 text-ui">
                <input type="checkbox" checked={includeOutside} onChange={(e) => setIncludeOutside(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" data-testid="include-outside" />
                <span>
                  {pending.preview.incomplete ? `Restore these ${plural(pending.preview.skipped.length, "file")} too` : `Also restore ${plural(pending.preview.skipped.length, "file")} changed outside the session`}
                  <span className="block text-caption text-muted">{pending.preview.incomplete ? "Each one differs from the undo point; you, another session or the cut restore changed it." : "Kept by default: someone else (you, or another session) edited them since."}</span>
                </span>
              </label>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Close className="h-8 rounded-lg px-3 text-ui text-muted hover:bg-hover">Cancel</AlertDialog.Close>
              <button
                data-testid="rewind-go"
                onClick={() => pending && confirm(pending)}
                className="h-8 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:opacity-90"
              >
                Restore files
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

// One path in the restore preview: what happens to it.
function PreviewRow({ path, remove, outside, off, merged, conflict }: { path: string; remove: boolean; outside?: boolean; off?: boolean; merged?: boolean; conflict?: boolean }) {
  return (
    <li className={cn("flex items-center gap-2", off && "text-faint")}>
      <FileDiff className={cn("size-3.5 shrink-0", outside ? "text-warn" : "text-accent")} />
      <span className={cn("min-w-0 truncate", off && "line-through")}>{path}</span>
      <span className={cn("ml-auto shrink-0 font-sans text-micro", remove ? "text-danger" : "text-faint")}>
        {merged ? "the turn's change taken back, the later edit kept" : off ? (conflict ? "kept: a later edit overlaps the turn's change" : "kept: changed outside") : remove ? "removed: not there before" : "restored"}
      </span>
    </li>
  );
}
