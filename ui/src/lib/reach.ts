// Which machines of the fleet this daemon does not hear, and since when: the
// one fact the session states, the list and the marks read. Kept apart from
// the fleet's own client state so the states can read it without a cycle
// (fleet.ts writes it with every list of machines it loads).
import { useSyncExternalStore } from "react";

// `since`: when the machine was last heard (ms). `back`: it is heard again since then, said for a moment.
export type Unheard = { id: string; name: string; since: number; reason?: string };
export type Back = { id: string; name: string; since: number; at: number };
type State = { unheard: Record<string, Unheard>; back: Record<string, Back> };

let state: State = { unheard: {}, back: {} };
const subs = new Set<() => void>();
const set = (next: State) => { state = next; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export const getReach = () => state;
export function useReach<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

const same = (a: Record<string, Unheard>, b: Record<string, Unheard>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] && a[k]!.since === b[k]!.since && a[k]!.name === b[k]!.name && a[k]!.reason === b[k]!.reason);
};
// The absence of each machine that the daemon said is over (by when it began): a
// list of machines read before that word and landing after it names the same
// absence, and must not bring it back. A new absence began at another time.
const over = new Map<string, number>();
// The machines not heard now, as the daemon's list of machines says.
export function setUnheard(list: Unheard[]) {
  const unheard = Object.fromEntries(list.filter((m) => over.get(m.id) !== m.since).map((m) => [m.id, m]));
  if (same(state.unheard, unheard)) return;
  // One that is listed again as out of reach is not back.
  const back = Object.fromEntries(Object.entries(state.back).filter(([id]) => !unheard[id]));
  set({ unheard, back });
}

// How long "is back" stays on the list's summary.
export const BACK_MS = 8_000;
export function setBack(b: Back) {
  over.set(b.id, b.since);
  const { [b.id]: _was, ...unheard } = state.unheard;
  set({ unheard, back: { ...state.back, [b.id]: b } });
  setTimeout(() => {
    if (state.back[b.id] !== b) return;
    const { [b.id]: _gone, ...back } = state.back;
    set({ ...state, back });
  }, BACK_MS);
}
