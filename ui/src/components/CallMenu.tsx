// A call of the transcript has a quiet menu of its own (right click, or the Menu key on its line): "Revert from
// here" puts the files back as they were before that call, when it changed files. It is the by-turn list's step
// revert (src/safety/checkpoints.ts) reached from the line itself: the same preview, protection of edits made
// outside and Undo. The chat stays: a call is not a prompt. A call that changed no files says so, and offers nothing.
import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { FileDiff, RotateCcw } from "lucide-react";
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { stoppingShells } from "../lib/shells.ts";
import { api, failed } from "../lib/store.ts";
import { itemClass, popupClass } from "./ui.tsx";

type Ask = { sessionId: string; callId: string; x: number; y: number };
type Result = { files: string[]; skipped: string[]; merged: string[]; removes: string[]; versions: Record<string, string>; undo: string | null };

let current: Ask | null = null;
const subs = new Set<() => void>();
const set = (a: Ask | null) => { current = a; subs.forEach((f) => f()); };

let mounted = false;
export function openCallMenu(a: Ask) {
  if (!mounted) {
    mounted = true;
    const el = document.createElement("div");
    document.body.append(el);
    createRoot(el).render(<Host />);
  }
  set(a);
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const SHOWN = 6;

function Host() {
  const ask = useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => current);
  return ask ? <CallMenu key={`${ask.sessionId}:${ask.callId}:${ask.x}:${ask.y}`} ask={ask} onClose={() => set(null)} /> : null;
}

function CallMenu({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const { sessionId: sid, callId } = ask;
  const [phase, setPhase] = useState<"menu" | "ask" | "done">("menu");
  // What the files would do from this call on: null while it is read, "none" when the call changed no files.
  const [preview, setPreview] = useState<Result | "none" | null>(null);
  const [error, setError] = useState("");
  const [outside, setOutside] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Result | null>(null);
  // (The menu closes itself when its item is chosen: that is the dialog's turn, not the end.)
  const chosen = useRef(false);

  useEffect(() => {
    let live = true;
    api<Result>(`/api/sessions/${sid}/rewind`, { method: "POST", body: JSON.stringify({ call: callId, preview: true }) })
      .then((p) => live && setPreview(p), (e) => {
        if (!live) return;
        if ((e as { status?: number }).status === 404) setPreview("none");
        else { setPreview("none"); setError(failed(e, { at: "call restore point" })); }
      });
    return () => { live = false; };
  }, [sid, callId]);

  const files = preview && preview !== "none" ? [...preview.files, ...preview.merged, ...(outside ? preview.skipped : [])] : [];
  const anchor = { getBoundingClientRect: () => DOMRect.fromRect({ x: ask.x, y: ask.y, width: 0, height: 0 }) };

  const go = async () => {
    if (busy || !preview || preview === "none") return;
    setBusy(true);
    setError("");
    try {
      const body = (stop: boolean) => JSON.stringify({ call: callId, include_outside: outside, stop_shells: stop || undefined, confirm: { paths: files, versions: preview.versions } });
      const r = await stoppingShells((stop) => api<Result>(`/api/sessions/${sid}/rewind`, { method: "POST", body: body(stop) }), { verb: "Revert", where: "this folder" });
      setBusy(false);
      if (r) { setDone(r); setPhase("done"); }
    } catch (e) {
      setBusy(false);
      setError(failed(e, { at: "revert from a call" }));
    }
  };
  const undo = async () => {
    if (busy || !done?.undo) return;
    setBusy(true);
    try {
      await stoppingShells((stop) => api<Result>(`/api/sessions/${sid}/rewind`, { method: "POST", body: JSON.stringify({ checkpoint: done.undo, stop_shells: stop || undefined }) }), { verb: "Undo", where: "this folder" });
      onClose();
    } catch (e) {
      setBusy(false);
      setError(failed(e, { at: "undo a revert from a call" }));
    }
  };

  if (phase === "menu") {
    const count = preview && preview !== "none" ? preview.files.length + preview.merged.length + preview.skipped.length : 0;
    return (
      <Menu.Root open onOpenChange={(o) => { if (!o && !chosen.current) onClose(); }} modal={false}>
        <Menu.Portal>
          <Menu.Positioner anchor={anchor} side="bottom" align="start" sideOffset={2} className="z-50 outline-none">
            <Menu.Popup className={`${popupClass} min-w-48`} data-testid="call-menu">
              <Menu.Item className={itemClass} data-testid="call-revert" disabled={!preview || preview === "none"} onClick={() => { chosen.current = true; setPhase("ask"); }}>
                <span className="grid w-3.5 shrink-0 place-items-center [&>svg]:size-3.5"><RotateCcw /></span>
                <span className="min-w-0 flex-1 truncate">Revert from here</span>
                {count > 0 && <span className="shrink-0 text-micro tabular-nums text-faint">{plural(count, "file")}</span>}
              </Menu.Item>
              {preview === "none" && <p className="px-2.5 pb-1.5 pt-0.5 text-caption text-faint" data-testid="call-revert-none">{error || "This call changed no files."}</p>}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    );
  }

  const shown = phase === "done" && done ? [...done.files] : [...(preview !== "none" && preview ? [...preview.files, ...preview.merged] : [])];
  return (
    <Dialog.Root open onOpenChange={(o) => !o && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup data-testid="call-revert-dialog" className="k-dialog rounded-xl border border-line bg-raised shadow-3" style={{ "--k-dialog-w": "30rem" } as React.CSSProperties}>
          <Dialog.Title className="k-dialog-title px-[var(--k-dialog-pad)] pt-[var(--k-dialog-pad)] text-read font-semibold">{phase === "done" ? `Reverted ${plural(done?.files.length ?? 0, "file")}` : "Revert from here"}</Dialog.Title>
          <div className="k-dialog-body mt-1.5 px-[var(--k-dialog-pad)] pb-1">
            <Dialog.Description className="text-ui text-muted">
              {phase === "done" ? "The files are as they were before that call. The conversation is unchanged, and the model is told." : "The files go back to as they were before this call, and the changes of the calls after it go too. The conversation stays."}
            </Dialog.Description>
            <ul className="mt-3 flex flex-col gap-1 px-1 font-mono text-caption" data-testid="call-revert-files">
              {shown.slice(0, SHOWN).map((f) => (
                <li key={f} className="flex items-center gap-2">
                  <FileDiff className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
                  <span className="min-w-0 truncate">{f}</span>
                  {preview && preview !== "none" && preview.removes.includes(f) && <span className="ml-auto shrink-0 font-sans text-micro text-danger">deleted: not there before</span>}
                </li>
              ))}
              {shown.length > SHOWN && <li className="font-sans text-micro text-faint">and {shown.length - SHOWN} more</li>}
            </ul>
            {phase === "ask" && preview && preview !== "none" && preview.skipped.length > 0 && (
              <label className="mt-2 flex items-start gap-2 px-1 text-ui">
                <input type="checkbox" checked={outside} onChange={(e) => setOutside(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" data-testid="call-revert-outside" />
                <span>
                  Also put back {plural(preview.skipped.length, "file")} changed outside the session
                  <span className="block text-caption text-muted">Kept by default: someone else (you, or another session) edited them since.</span>
                </span>
              </label>
            )}
            {error && <p className="mt-2 text-caption text-danger" role="alert" data-testid="call-revert-error">{error}</p>}
          </div>
          <div className="k-dialog-foot px-[var(--k-dialog-pad)] pb-[var(--k-dialog-pad)] pt-3">
            <Dialog.Close disabled={busy} className="k-btn k-btn-lg">{phase === "done" ? "Close" : "Cancel"}</Dialog.Close>
            {phase === "done"
              ? done?.undo && <button type="button" data-testid="call-revert-undo" onClick={undo} disabled={busy} className="k-btn k-btn-lg">Undo</button>
              : <button type="button" data-testid="call-revert-go" onClick={go} disabled={busy} aria-busy={busy || undefined} data-ink="" className="k-btn k-btn-lg">
                  {busy ? "Reverting" : "Revert the files"}
                </button>}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
