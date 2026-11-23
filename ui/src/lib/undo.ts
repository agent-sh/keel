// The last act on the panes or the list that a mis-click makes easy and that
// costs several steps to put back: keeping a look in its pane, closing a
// pane, archiving a session. It is offered back for a few seconds
// (components/UndoToast.tsx) with its button and its key, Ctrl Z (Cmd Z on a
// Mac). Undo puts back that act only, never the panes wholesale: whatever the
// owner did since stays. An act that can no longer be put back (its pane was
// given another session since) is no longer offered (`can`). One act is
// offered at a time: a newer one takes its place.
//
// In a field Ctrl Z is the field's own typing undo first: the act takes the key
// there only while the field is empty and was not typed in since it got the
// keyboard (it has nothing of its own to undo). Out of a field, the act's.
import { useSyncExternalStore } from "react";
import { announce } from "./announce.ts";
import { registerCommand } from "./keys.ts";
import { tipSay } from "./tips.ts";

export const UNDO_MS = 6_000;
export type Undoable = { n: number; words: string; undo: () => void | Promise<void>; can: () => boolean; at: number };
let current: Undoable | null = null;
let made = 0;
let timer = 0;
const subs = new Set<() => void>();
const tell = () => subs.forEach((f) => f());

// The fields typed in since they last got the keyboard.
const typedIn = new WeakSet<EventTarget>();
if (typeof window !== "undefined") {
  addEventListener("input", (e) => { if (e.target) typedIn.add(e.target); }, true);
  addEventListener("focusin", (e) => { if (e.target) typedIn.delete(e.target); }, true);
}
const field = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
// A field with nothing of its own for Ctrl Z to undo.
const bare = (el: Element | null) => {
  if (!el) return true;
  if (field(el)) return el.value === "" && !typedIn.has(el);
  return !(el as HTMLElement).isContentEditable;
};

// Offers the act back: `words` say what was done, the act first ("Archived: Fix the flaky upload test");
// `can` says whether it can still be put back as it was.
export function offerUndo(words: string, undo: Undoable["undo"], can: Undoable["can"] = () => true) {
  clearTimeout(timer);
  current = { n: ++made, words, undo, can, at: performance.now() };
  const n = current.n;
  timer = window.setTimeout(() => { if (current?.n === n) { current = null; tell(); } }, UNDO_MS);
  tell();
}
export const dropUndo = () => { if (!current) return; clearTimeout(timer); current = null; tell(); };
// Puts the last act back, once.
export function runUndo(): boolean {
  const u = current;
  if (!u) return false;
  dropUndo();
  if (!u.can()) { const words = "Not undone: what it changed was changed again since"; tipSay(null, words, 2400); announce(words); return false; }
  void Promise.resolve(u.undo()).then(() => announce("Undone"), () => announce("Not undone"));
  return true;
}
export const useUndo = (): Undoable | null => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => current);

registerCommand({
  id: "undo-act", label: "Undo the last act on the panes or the list", group: "Bridge", keys: "mod+z", words: "undo back restore reopen unarchive",
  inInput: () => !!current && bare(document.activeElement),
  when: () => !!current && current.can(),
  run: () => void runUndo(),
});
