import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useRef, useSyncExternalStore } from "react";
import { SETTLE_MS } from "../lib/approvals.ts";
import { cn } from "../lib/utils.ts";

// A confirmation for actions that cannot be undone: `await confirmAction({...})`.
// A long body scrolls between the title and the actions (.k-dialog in styles.css).
// `alt`: a second way to go on, beside the main action (choose() answers "alt").
//
// An answer is given by a key the owner meant. A dialog that deletes, writes
// outside Keel or cannot be undone (`danger`, or `careful` for one that is
// not drawn as danger) opens with the keyboard on Cancel, never on its
// action: an Enter typed for whatever was under the hand when it opened
// cancels. Its action also takes no key press for the settle time after the
// dialog opened (the time an approval's button is held for), so Tab and Enter
// already on their way do not answer it either. A pointer press is aimed, and
// acts at once. A dialog that only informs or switches something that can be
// switched back keeps the keyboard on its action.
//
// `code`: a command or a text shown exactly as it will be used, in a box of
// its own under the body. `after`: lines under the box, a paragraph each.
type Ask = { title: string; body?: string; action: string; danger?: boolean; careful?: boolean; alt?: string; code?: string; after?: string[] };
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

export function ConfirmHost() {
  const ask = useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => current);
  const cancel = useRef<HTMLButtonElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const guarded = !!ask && (!!ask.danger || !!ask.careful);
  // A click with no pointer behind it is a key press (Enter or Space on the button).
  const held = (e: React.MouseEvent) => guarded && e.detail === 0 && performance.now() - ask!.at < SETTLE_MS;
  return (
    <AlertDialog.Root open={!!ask} onOpenChange={(o) => !o && close(false)}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-overlay transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <AlertDialog.Popup
          data-testid="confirm"
          data-guarded={guarded || undefined}
          initialFocus={guarded ? cancel : action}
          style={{ "--k-dialog-w": ask?.code ? "34rem" : "26rem" } as React.CSSProperties}
          className="k-dialog rounded-xl border border-line bg-raised shadow-3 transition-[opacity,scale] duration-150 data-starting-style:scale-[0.97] data-starting-style:opacity-0 data-ending-style:opacity-0"
        >
          <AlertDialog.Title className="k-dialog-title px-[var(--k-dialog-pad)] pt-[var(--k-dialog-pad)] text-read font-semibold">{ask?.title}</AlertDialog.Title>
          {ask?.code ? (
            // The details as a group: the words, the box, the lines after it. They scroll together.
            <AlertDialog.Description render={<div />} className="k-dialog-body mt-1.5 px-[var(--k-dialog-pad)] text-ui text-muted">
              {ask.body && <span className="block whitespace-pre-line">{ask.body}</span>}
              <pre data-testid="confirm-code" className="mt-2 whitespace-pre-wrap rounded-md border border-line bg-sunken px-2.5 py-2 font-mono text-caption text-fg [overflow-wrap:anywhere]">{ask.code}</pre>
              {ask.after?.map((line) => <span key={line} className="mt-2 block">{line}</span>)}
            </AlertDialog.Description>
          ) : ask?.body ? (
            <AlertDialog.Description className="k-dialog-body mt-1.5 whitespace-pre-line px-[var(--k-dialog-pad)] text-ui text-muted">{ask.body}</AlertDialog.Description>
          ) : null}
          <div className="k-dialog-foot p-[var(--k-dialog-pad)]">
            <AlertDialog.Close ref={cancel} className="h-8 rounded-md border border-line-strong px-3 text-ui font-medium hover:bg-hover">Cancel</AlertDialog.Close>
            {ask?.alt && (
              <button type="button" data-testid="confirm-alt" onClick={(e) => { if (!held(e)) close("alt"); }} className="h-8 rounded-md border border-line-strong px-3 text-ui font-medium hover:bg-hover">
                {ask.alt}
              </button>
            )}
            <button
              ref={action}
              type="button"
              data-testid="confirm-action"
              onClick={(e) => { if (!held(e)) close(true); }}
              className={cn("h-8 rounded-md px-3 text-ui font-medium", ask?.danger ? "bg-danger text-accent-fg hover:opacity-90" : "bg-accent text-accent-fg hover:bg-accent-hover")}
            >
              {ask?.action}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
