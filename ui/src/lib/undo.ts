// The last act on the panes or the list that a mis-click makes easy and that
// costs several steps to put back: keeping a look in its pane, closing a
// pane, archiving a session. It is offered back for a few seconds, in a tab
// at the top of the page (components/UndoToast.tsx) with its button and its
// key, Ctrl Z (Cmd Z on a Mac). Undo puts back what the act changed: the panes
// as they were, in their order, with the session that was worked in, and an
// archived session in the list. One act is offered at a time: a newer one
// takes its place. In a field the key stays the field's once something was
// typed there after the act (its own undo).
import { useSyncExternalStore } from "react";
import { announce } from "./announce.ts";
import { registerCommand } from "./keys.ts";

export const UNDO_MS = 6_000;
export type Undoable = { n: number; words: string; undo: () => void | Promise<void>; at: number };
let current: Undoable | null = null;
let made = 0;
let typed = -Infinity; // the last time something was typed into a field
let timer = 0;
const subs = new Set<() => void>();
const tell = () => subs.forEach((f) => f());

if (typeof window !== "undefined") addEventListener("input", () => { typed = performance.now(); }, true);

// Offers the act back: `words` say what was done, the act first ("Archived: Fix the flaky upload test").
export function offerUndo(words: string, undo: Undoable["undo"]) {
  clearTimeout(timer);
  current = { n: ++made, words, undo, at: performance.now() };
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
  void Promise.resolve(u.undo()).then(() => announce("Undone"), () => announce("Not undone"));
  return true;
}
export const useUndo = (): Undoable | null => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => current);

registerCommand({
  id: "undo-act", label: "Undo the last act on the panes or the list", group: "Bridge", keys: "mod+z", words: "undo back restore reopen unarchive",
  // In a field Ctrl Z is the field's own once it was typed in after the act.
  inInput: () => !!current && typed < current.at,
  when: () => !!current,
  run: () => void runUndo(),
});
