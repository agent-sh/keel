import { Suspense, useRef, useSyncExternalStore } from "react";
import { chunked, preloadSettled } from "../lib/preload.ts";

const dialog = chunked(() => import("./ConfirmDialog.tsx").then((m) => m.ConfirmDialog));
const ConfirmDialog = dialog.View;
preloadSettled(dialog.start);

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
export type Ask = { title: string; body?: string; action: string; danger?: boolean; careful?: boolean; alt?: string; code?: string[]; after?: string[]; recheck?: () => Promise<Partial<Omit<Ask, "recheck">> | null> };
let current: (Ask & { resolve: (ok: boolean | "alt") => void }) | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function askFor(ask: Ask): Promise<boolean | "alt"> {
  current?.resolve(false);
  return new Promise((resolve) => {
    current = { ...ask, resolve };
    emit();
  });
}

export function confirmAction(ask: Ask): Promise<boolean> {
  return askFor(ask).then((v) => v === true);
}

// The same dialog with a second action: "ok", "alt", or false for Cancel.
export function choose(ask: Ask & { alt: string }): Promise<"ok" | "alt" | false> {
  return askFor(ask).then((v) => v === true ? "ok" : v);
}

function close(ok: boolean | "alt") {
  current?.resolve(ok);
  current = null;
  emit();
}

// A second question after a recheck is a new request. The view starts its settle time
// when it draws that request, including the first one while its chunk is still loading.
async function act(was: Ask): Promise<boolean> {
  if (current !== was) return false;
  if (!current.recheck) { close(true); return false; }
  const again = await current.recheck().catch(() => null);
  if (current !== was) return false;
  if (!again) { close(true); return false; }
  current = { ...current, ...again, careful: true };
  emit();
  return true;
}

const listen = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const read = () => current;

export function ConfirmHost() {
  const ask = useSyncExternalStore(listen, read);
  // After the first request the view stays mounted for the close animation.
  const shown = useRef(false);
  if (ask) shown.current = true;
  return shown.current ? <Suspense fallback={null}><ConfirmDialog ask={ask} act={act} close={close} /></Suspense> : null;
}
