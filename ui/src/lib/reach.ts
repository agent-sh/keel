// Which machines of the fleet this daemon does not hear, and since when: the
// one fact the session states, the list's count and the marks read. A machine
// is in it from when it stopped answering until it has stayed heard a while
// (the daemon holds it so: src/fleet/fleet.ts, steadyMs), so one that comes
// and goes is out of reach once on screen, not on and off. Kept apart from
// the fleet's own client state so the states can read it without a cycle
// (fleet.ts writes it with every list of machines it loads).
import { useSyncExternalStore } from "react";

// `since`: when the machine was last heard (ms; 0: not known).
export type Unheard = { id: string; name: string; since: number; reason?: string };
type State = { unheard: Record<string, Unheard>; names: Record<string, string> };

let state: State = { unheard: {}, names: {} };
const subs = new Set<() => void>();
const set = (next: State) => { state = next; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export const getReach = () => state;
export function useReach<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}
// What a machine is called, for a line that names a session's place (undefined: not known here).
export const machineLabel = (id: string | undefined) => (id ? state.names[id] : undefined);

const same = (a: Record<string, Unheard>, b: Record<string, Unheard>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] && a[k]!.since === b[k]!.since && a[k]!.name === b[k]!.name && a[k]!.reason === b[k]!.reason);
};
// The machines as the daemon lists them: the ones not heard now, and every one's name.
export function setMachines(list: Unheard[], names: Record<string, string>) {
  const unheard = Object.fromEntries(list.map((m) => [m.id, m]));
  const ks = Object.keys(names);
  if (same(state.unheard, unheard) && ks.length === Object.keys(state.names).length && ks.every((k) => state.names[k] === names[k])) return;
  set({ unheard, names });
}
