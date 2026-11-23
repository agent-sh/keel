import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SETTLE_MS } from "../lib/approvals.ts";
import { cn } from "../lib/utils.ts";
import { CommandWords } from "./CommandWords.tsx";

// A confirmation for actions that cannot be undone: `await confirmAction({...})`.
// A long body scrolls between the title and the actions (.k-dialog in styles.css).
// `alt`: a second way to go on, beside the main action (choose() answers "alt").
//
// An answer is given by a key the owner meant. A dialog that deletes, writes
// outside Keel, cannot be undone or costs something to take back (`danger`,
// or `careful` for one that is not drawn as danger) opens with the keyboard
// on Cancel, never on its action: an Enter typed for whatever was under the
// hand when it opened cancels. Its action also takes no key press for the
// settle time after the dialog opened (the time an approval's button is held
// for), so Tab and Enter already on their way do not answer it either; a
// press refused that way is shown on the button and said once, as a refused
// approval is. A key that is still held from before (its presses repeat)
// answers nothing, on any button of any dialog: not the action after the
// settle time, and not Cancel, so a held Enter does not open and close the
// dialog over and over. A pointer press is aimed, and acts at once. A dialog
// that only informs keeps the keyboard on its action.
//
// `code`: a command shown exactly as it will run, in a box of its own under
// the body (its arguments, so a line breaks between them). `after`: lines
// under the box, a paragraph each.
//
// `recheck`: read again what the answer is given for, as the action is pressed. A new question
// (what changed meanwhile made the action cost more) takes the dialog's place, with the keyboard
// on Cancel and the settle time begun again, and the press answers nothing.
type Ask = { title: string; body?: string; action: string; danger?: boolean; careful?: boolean; alt?: string; code?: string[]; after?: string[]; recheck?: () => Promise<Partial<Omit<Ask, "recheck">> | null> };
let current: (Ask & { resolve: (ok: any) => void; at: number }) | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function confirmAction(ask: Ask): Promise<boolean> {
  current?.resolve(false);
  return new Promise((resolve) => {
    current = { ...ask, resolve, at: performance.now() };
    emit();
  });
}

// The same dialog with a second action: "ok", "alt", or false for Cancel.
export function choose(ask: Ask & { alt: string }): Promise<"ok" | "alt" | false> {
  return confirmAction(ask).then((v) => (v === true ? "ok" : (v as unknown as "alt" | false)));
}

function close(ok: boolean | "alt") {
  current?.resolve(ok);
  current = null;
  emit();
}

const NOT_YET = "Not yet: the dialog has only just opened";

export function ConfirmHost() {
  const ask = useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => current);
  const cancel = useRef<HTMLButtonElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const guarded = !!ask && (!!ask.danger || !!ask.careful);
  // The last key that went down in the dialog was a repeat: the key is being held.
  const repeating = useRef(false);
  // A key press on an action that was refused: which button, marked for the settle time.
  const [refused, setRefused] = useState<"action" | "alt" | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => { repeating.current = false; setRefused(null); }, [ask]);
  // A click with no pointer behind it is a key press (Enter or Space on the button).
  const key = (e: React.MouseEvent) => e.detail === 0;
  // Whether a press on an action answers. A refusal within the settle time is shown; a held key is only ignored.
  const answers = (e: React.MouseEvent, which: "action" | "alt") => {
    if (!key(e)) return true;
    if (repeating.current) return false;
    if (!guarded || performance.now() - ask!.at >= SETTLE_MS) return true;
    window.clearTimeout(timer.current);
    setRefused(which);
    timer.current = window.setTimeout(() => setRefused(null), SETTLE_MS);
    return false;
  };
  // The action: answered, unless reading again what it is for asks a new question.
  const checking = useRef(false);
  const act = async () => {
    const was = current;
    if (!was?.recheck) return close(true);
    if (checking.current) return;
    checking.current = true;
    try {
      const again = await was.recheck().catch(() => null);
      if (current !== was) return; // answered or replaced meanwhile
      if (!again) return close(true);
      current = { ...was, ...again, careful: true, at: performance.now() };
      emit();
      cancel.current?.focus();
    } finally { checking.current = false; }
  };
  // The mark of a refused press, as on a refused approval: the warning outline, and one small move.
  const marked = (on: boolean): React.CSSProperties | undefined => (on ? { outline: "2px solid var(--warn)", outlineOffset: "1px", animation: "k-nudge 320ms var(--ease-out)" } : undefined);
  return (
    <AlertDialog.Root open={!!ask} onOpenChange={(o) => !o && close(false)}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <AlertDialog.Popup
          data-testid="confirm"
          data-guarded={guarded || undefined}
          initialFocus={guarded ? cancel : action}
          onKeyDownCapture={(e) => { repeating.current = e.repeat; }}
          onKeyUpCapture={() => { repeating.current = false; }}
          style={{ "--k-dialog-w": ask?.code ? "34rem" : "26rem" } as React.CSSProperties}
 className="k-dialog rounded-xl border border-line bg-raised shadow-3 transition-[opacity,scale] data-starting-style:scale-[0.97] data-starting-style:opacity-0 data-ending-style:opacity-0"
        >
          <AlertDialog.Title className="k-dialog-title px-[var(--k-dialog-pad)] pt-[var(--k-dialog-pad)] text-read font-semibold">{ask?.title}</AlertDialog.Title>
          {ask?.code ? (
            // The details as a group: the words, the box, the lines after it. They scroll together.
            <AlertDialog.Description render={<div />} className="k-dialog-body mt-1.5 px-[var(--k-dialog-pad)] text-ui text-muted">
              {ask.body && <span className="block whitespace-pre-line">{ask.body}</span>}
              <CommandWords words={ask.code} testid="confirm-code" className="mt-2 rounded-md border border-line bg-sunken px-2.5 py-2" />
              {ask.after?.map((line) => <span key={line} className="mt-2 block">{line}</span>)}
            </AlertDialog.Description>
          ) : ask?.body ? (
            <AlertDialog.Description className="k-dialog-body mt-1.5 whitespace-pre-line px-[var(--k-dialog-pad)] text-ui text-muted">{ask.body}</AlertDialog.Description>
          ) : null}
          <div className="k-dialog-foot p-[var(--k-dialog-pad)]">
            {/* A held key cancels nothing either: the dialog stays until the key was let go and pressed again. */}
            <AlertDialog.Close ref={cancel} onClick={(e) => { if (key(e) && repeating.current) e.preventBaseUIHandler(); }} className="k-btn k-btn-lg">Cancel</AlertDialog.Close>
            {ask?.alt && (
              <button type="button" data-testid="confirm-alt" data-nudge={refused === "alt" || undefined} style={marked(refused === "alt")} onClick={(e) => { if (answers(e, "alt")) close("alt"); }} className="k-btn k-btn-lg">
                {ask.alt}
              </button>
            )}
            <button
              ref={action}
              type="button"
              data-testid="confirm-action"
              data-nudge={refused === "action" || undefined}
              style={marked(refused === "action")}
              onClick={(e) => { if (answers(e, "action")) void act(); }}
              className={cn("h-8 rounded-md px-3 text-ui font-medium", ask?.danger ? "bg-danger text-accent-fg hover:opacity-90" : "bg-accent text-accent-fg hover:bg-accent-hover")}
            >
              {ask?.action}
            </button>
            <span className="sr-only" role="status" data-testid="confirm-refused">{refused ? NOT_YET : ""}</span>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
