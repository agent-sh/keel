import { AlertDialog } from "@base-ui/react/alert-dialog";
import { FileDiff, FolderX, History, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { api, onFeature, readAtOpen, reportError, reportUnlessGone, failed } from "../lib/store.ts";
import { stoppingShells } from "../lib/shells.ts";
import { ago, cn, scrollMotion } from "../lib/utils.ts";
import { DiffView, FileList, RevertButton, type FileChange } from "./DiffView.tsx";
import { NotUndoneList, type NotUndone } from "./NotUndone.tsx";
import { Seg, tabId } from "./Seg.tsx";
import { useViewed } from "../lib/viewed.ts";

type Step = { id: string; call: string; label: string; created: number };
type Turn = { steps?: Step[]; turn: number; prompt: string; created: number; files: FileChange[]; added: number; removed: number; scope: "tree" | "written"; incomplete?: boolean; elsewhere?: string; unavailable?: string; not_undone?: NotUndone[] };
type Diff = { files: FileChange[]; diff: string; truncated: boolean; partial?: string; scope: "tree" | "written"; incomplete?: boolean };
type RewindResult = {
  files: string[]; failed: { path: string; error: string }[]; skipped: string[]; outside: string[]; merged: string[]; conflicts: string[]; removes: string[]; uncaptured: string[];
  blocked?: { path: string; uncaptured: string }[];
  versions: Record<string, string>; incomplete: boolean; undo: string | null; scope: string;
  not_undone?: NotUndone[];
};
const NO_FILES: FileChange[] = [];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
type Pending = { title: string; body: { turn?: number; step?: string; paths?: string[] }; preview: RewindResult };

// What the session changed, in the side panel: the list of the changed files
// and the whole session's diff, with a revert per file, and each turn's diff
// with a revert of the files to before it. One verb, Revert, for all of them.
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
  // Per-file "Viewed" marks of the session diff, kept in this browser (lib/viewed.ts).
  const viewed = useViewed(sessionId, "changes", all?.files ?? NO_FILES, all?.diff ?? "");
  const panel = useId();
  const sessionBox = useRef<HTMLDivElement>(null);
  // A path of the file list: its diff, at the top of the panel.
  const jump = (path: string) => sessionBox.current?.querySelector(`[data-testid="diff-file"][data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ behavior: scrollMotion(), block: "start" });
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
      // Read again on a reconnect: a session deleted while the page was cut off is a state, no failure.
      reportUnlessGone(e, { at: "changes load" });
    }
  }, [sessionId]);

  useEffect(() => {
    const again = readAtOpen(async () => load());
    return onFeature({ frame: (f) => { if (f.name === "checkpoints" && f.session_id === sessionId) load(); }, reconnect: again });
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

  // The files as they are now are read again after a revert, failed or not.
  const run = async (body: object) => {
    setErr("");
    try {
      // Background commands in the folder would write over the revert: the owner may stop them first.
      setPending(null);
      const r = await stoppingShells((stop) => api<RewindResult>(`/api/sessions/${sessionId}/rewind`, { method: "POST", body: JSON.stringify({ ...body, stop_shells: stop || undefined }) }), { verb: "Revert", where: "this folder" });
      if (r) setDone(r);
    } catch (e) {
      setErr(failed(e, { at: "ChangesPanel" }));
    }
    load();
  };
  // What the owner confirms is what the preview showed, at the versions it showed.
  const restorePaths = pending ? [...pending.preview.files, ...pending.preview.merged, ...(includeOutside ? pending.preview.skipped : [])] : [];
  const confirm = () => {
    if (!pending || !restorePaths.length) return;
    return run({
      ...pending.body, include_outside: includeOutside,
      confirm: { paths: restorePaths, versions: pending.preview.versions },
    });
  };
  const fileDiff = (q: string) => async (path: string) => (await api<Diff>(`/api/sessions/${sessionId}/checkpoints/diff?${q}&path=${encodeURIComponent(path)}`)).diff;

  const firstTurn = here[0]?.turn;

  return (
    <div data-testid="changes-panel" data-quote-from="the changes" className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-line px-3 py-2">
          <Seg kind="tabs" panel={panel} label="Which changes" value={tab} onChange={setTab} options={[{ value: "session", label: "Session", testid: "tab-session" }, { value: "turns", label: "By turn", testid: "tab-turns" }]} />
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
                  {done!.failed.length ? `Reverted ${done!.files.length} of ${done!.files.length + done!.failed.length} files` : `Reverted ${plural(done!.files.length, "file")}`}
                  {done!.merged.length ? ` (in ${done!.merged.length} only the session's change, around later edits)` : ""}
                  {done!.skipped.length ? `, kept ${done!.skipped.length} changed outside the session` : ""}
                  {done!.uncaptured.length ? `, kept ${done!.uncaptured.length} over the checkpoint size limit` : ""}
                  {done!.blocked?.length ? `, skipped ${plural(done!.blocked.length, "path")} to protect large files` : ""}.
                  {done!.failed.length > 0 && <span className="block text-caption" data-testid="rewind-failed">Not reverted: {done!.failed.map((f) => `${f.path} (${f.error})`).join("; ")}</span>}
                </span>
                {done!.undo && (
                  <button data-testid="rewind-undo" className="k-link font-medium text-accent hover:underline" onClick={() => { run({ checkpoint: done!.undo }); }}>
                    Undo
                  </button>
                )}
              </>
            )}
            <button className="ml-auto text-faint hover:text-fg" onClick={() => { setDone(null); setErr(""); }}><X className="size-3.5" /></button>
          </div>
        )}
        {tab === "session" && <div role="tabpanel" id={panel} aria-labelledby={tabId(panel, tab)} ref={sessionBox} className="min-h-0 flex-1 overflow-y-auto p-4">
          {all && all.files.length > 0 && gone && (
            <p className="k-notice mb-3 items-start text-caption text-muted" data-testid="revert-gone" role="note">
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
                className="k-btn k-btn-lg ml-auto"
              >
                <RotateCcw className="size-3.5" /> Revert all
              </button>
            </div>
          )}
          {all && all.files.length > 1 && (
            <FileList files={all.files} onJump={jump} viewed={viewed} actions={(f) => canRevert && <RevertButton path={f.path} onClick={() => ask(`Revert ${f.path}?`, { turn: firstTurn, paths: [f.path] })} />} />
          )}
          {all && (
            <DiffView
              files={all.files}
              patch={all.diff}
              empty="The session has not changed any files yet."
              truncated={all.truncated}
              partial={all.partial}
              viewed={viewed}
              loadFile={firstTurn === undefined ? undefined : fileDiff(`from=${firstTurn}`)}
              actions={(f) => canRevert && <RevertButton path={f.path} onClick={() => ask(`Revert ${f.path}?`, { turn: firstTurn, paths: [f.path] })} />}
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
        </div>}
        {tab === "turns" && <div role="tabpanel" id={panel} aria-labelledby={tabId(panel, tab)} className="min-h-0 flex-1 overflow-y-auto p-4">
          {turns.length === 0 && <p className="k-empty py-4">No turn has changed files yet.</p>}
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
                      onClick={(e) => { e.preventDefault(); ask("Revert the files to before this turn?", { turn: t.turn }); }}
                      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-caption text-muted hover:bg-hover hover:text-fg"
                      title="Put the files back as they were before this turn (this turn and the ones after it)"
                    >
                      <RotateCcw className="size-3.5" /> Revert from here
                    </button>}
                  </summary>
                  <div className="border-t border-line p-3">
                    {!!t.steps?.length && (
                      <ol className="mb-3 flex flex-col gap-0.5" data-testid="turn-steps" aria-label="The calls of this turn that changed files">
                        {t.steps.map((st, i) => (
                          <li key={st.id} className="group flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-hover" data-testid="turn-step">
                            <span className="w-6 shrink-0 text-right font-mono text-micro tabular-nums text-faint">{i + 1}</span>
                            <span className="min-w-0 flex-1 truncate font-mono text-caption" title={st.label}>{st.label || "(a call)"}</span>
                            {!gone && !t.elsewhere && <button
                              data-testid="rewind-step"
                              onClick={() => ask(`Revert the files to before step ${i + 1}?`, { step: st.id })}
                              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-caption text-muted hover:bg-sunken hover:text-fg"
                              title="Put the files back as they were before this call (this call and the ones after it)"
                            >
                              <RotateCcw className="size-3.5" /> Revert from here
                            </button>}
                          </li>
                        ))}
                      </ol>
                    )}
                    {turnDiff[t.turn]?.incomplete && <p className="mb-2 text-caption text-warn" data-testid="turn-incomplete">This turn has no end snapshot: shown is its start against the files now, which may include edits made after it.</p>}
                    {turnDiff[t.turn] ? <DiffView files={turnDiff[t.turn]!.files} patch={turnDiff[t.turn]!.diff} truncated={turnDiff[t.turn]!.truncated} partial={turnDiff[t.turn]!.partial} loadFile={fileDiff(`turn=${t.turn}`)} empty="This turn changed no files." /> : <p className="text-caption text-faint">Loading…</p>}
                  </div>
                </details>
                {!!t.not_undone?.length && <NotUndoneList bare items={t.not_undone} testid="turn-not-undone" className="border-t border-line px-3 py-2" />}
              </li>
            ))}
          </ol>
        </div>}
      </div>
      <AlertDialog.Root open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-overlay" />
          <AlertDialog.Popup data-testid="rewind-confirm" className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-raised p-5 shadow-2">
            <AlertDialog.Title className="font-semibold">{pending?.title}</AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-ui text-muted">
              {pending?.preview.incomplete
                ? "The revert this undoes was cut before its result was recorded, so what it changed is not known. Nothing goes back unless you pick it below."
                : !restorePaths.length
                ? "No files selected to revert."
                : restorePaths.length === 1 ? "The file goes back as it was. An undo point is saved first, so Undo brings it back." : "These files go back as they were. An undo point is saved first, so Undo brings them back."}
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
                    <span className="ml-auto shrink-0 font-sans text-micro">kept: over the checkpoint size limit</span>
                  </li>
                ))}
                {pending.preview.blocked?.map(({ path, uncaptured }) => (
                  <li key={path} className="flex items-start gap-2 text-faint" data-testid="rewind-blocked">
                    <FileDiff className="size-3.5 shrink-0" />
                    <span className="min-w-0 break-all">{path}<span className="block font-sans text-micro">Kept: protects {uncaptured}</span></span>
                  </li>
                ))}
              </ul>
            )}
            {pending && !!pending.preview.not_undone?.length && <NotUndoneList items={pending.preview.not_undone} testid="rewind-not-undone" className="mt-3" />}
            {pending && pending.preview.skipped.length > 0 && (
              <label className="mt-3 flex items-start gap-2 text-ui">
                <input type="checkbox" checked={includeOutside} onChange={(e) => setIncludeOutside(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" data-testid="include-outside" />
                <span>
                  {pending.preview.incomplete ? `Revert these ${plural(pending.preview.skipped.length, "file")} too` : `Also revert ${plural(pending.preview.skipped.length, "file")} changed outside the session`}
                  <span className="block text-caption text-muted">{pending.preview.incomplete ? "Each one differs from the undo point; you, another session or the cut revert changed it." : "Kept by default: someone else (you, or another session) edited them since."}</span>
                </span>
              </label>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Close className="h-8 rounded-lg px-3 text-ui text-muted hover:bg-hover">Cancel</AlertDialog.Close>
              <button
                data-testid="rewind-go"
                onClick={confirm}
                disabled={!restorePaths.length}
                data-ink=""
                className="k-btn k-btn-lg"
              >
                Revert
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

// One path in the revert preview: what will happen to it.
function PreviewRow({ path, remove, outside, off, merged, conflict }: { path: string; remove: boolean; outside?: boolean; off?: boolean; merged?: boolean; conflict?: boolean }) {
  return (
    <li className={cn("flex items-center gap-2", off && "text-faint")}>
      <FileDiff className={cn("size-3.5 shrink-0", outside ? "text-warn" : "text-accent")} />
      <span className={cn("min-w-0 truncate", off && "line-through")}>{path}</span>
      <span className={cn("ml-auto shrink-0 font-sans text-micro", remove ? "text-danger" : "text-faint")}>
        {merged ? "the turn's change taken back, the later edit kept" : off ? (conflict ? "kept: a later edit overlaps the turn's change" : "kept: changed outside") : remove ? "deleted: not there before" : "goes back"}
      </span>
    </li>
  );
}
