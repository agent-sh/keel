// What stood open while it ran stays open when it ends, as it was, until it has
// left the view: a command's card with the tail of its output, a program with
// its calls, what the model thought. Folding it at its end would make the
// conversation shorter above the lines being read, and every one of them would
// drop. It folds once it is off the screen, where nothing that is seen moves;
// after a reload everything is folded as stored.
//
// Kept here, by the call's id or the thought's words, and not in a component:
// the same call is drawn by more than one (a streamed reply, then its stored
// row; a step of one call, then of several).
import { useEffect, useSyncExternalStore, type RefObject } from "react";

const ran = new Set<string>(); // calls seen running on this page
const held = new Set<string>();
const thought = new Map<string, number>(); // what was thought as it streamed, by its words: when it was last seen
let version = 0;
const subs = new Set<() => void>();
const changed = () => { version++; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => void subs.delete(f); };

// A component that reads what is held renders again when something is let go.
export const useHeld = (): number => useSyncExternalStore(subscribe, () => version);

// Whether a call is held open. `runs`: it is open now because it runs. Called
// while rendering, by whoever draws the call: the first render after it ended
// finds it held, so there is no frame in which it is folded.
export function callHeld(id: string, runs: boolean): boolean {
  if (runs) { ran.add(id); return false; }
  if (ran.delete(id)) held.add(`c:${id}`);
  return held.has(`c:${id}`);
}

const wordsOf = (text: string) => { const t = text.trim(); return `t:${t.length}:${t.slice(0, 48)}:${t.slice(-48)}`; };
// A thought is streaming, open: its words are remembered for the row that takes its place.
export function thoughtLive(text: string) {
  if (thought.size > 16) thought.clear();
  thought.set(wordsOf(text), Date.now());
}
// Whether a stored thought is held open: it was open, streaming, a moment ago.
export function thoughtHeld(text: string): boolean {
  const k = wordsOf(text);
  const at = thought.get(k);
  if (at !== undefined) { thought.delete(k); if (Date.now() - at < 5000) held.add(k); }
  return held.has(k);
}
export const thoughtKey = wordsOf;
export const callKey = (id: string) => `c:${id}`;

// It is let go: by leaving the view, or by the owner folding it themselves.
export function letGo(key: string) {
  if (held.delete(key)) changed();
}

// The same, said to no one: for whoever lets it go while drawing, and draws without it at once.
export const drop = (key: string) => void held.delete(key);

// What is held is let go when it has left the view (of the conversation it is in).
export function useLetGoUnseen(ref: RefObject<HTMLElement | null>, key: string, on: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    const io = new IntersectionObserver((seen) => { if (!seen.at(-1)!.isIntersecting) letGo(key); }, { root: el.closest(".k-reading") });
    io.observe(el);
    return () => io.disconnect();
  }, [on, key]);
}
