// Which sessions have a station on the bridge, in what order, and whether
// the helm is focused to the full width. Pinned stations stay where the
// owner put them; the rest come and go by attention (needs you and working
// first). A closed station stays closed until its session needs him or
// starts working again.
import { useSyncExternalStore } from "react";
import type { Session } from "../../../src/core/types.ts";
import { WATCH_RANK, type Watch } from "./watch.ts";

type State = { pinned: string[]; closed: Record<string, number>; focus: boolean; shown: string[] };

const load = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? d : (JSON.parse(v) as T);
  } catch {
    return d;
  }
};

let state: State = {
  pinned: load("keel.stations.pinned", []),
  closed: load("keel.stations.closed", {}),
  focus: load("keel.focus", false),
  shown: [],
};
const subs = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  localStorage.setItem("keel.stations.pinned", JSON.stringify(state.pinned));
  localStorage.setItem("keel.stations.closed", JSON.stringify(state.closed));
  localStorage.setItem("keel.focus", JSON.stringify(state.focus));
  subs.forEach((f) => f());
}
export const getStations = () => state;
export function useStations<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => sel(state));
}

export const stations = {
  pin(id: string) {
    if (!state.pinned.includes(id)) set({ pinned: [...state.pinned, id], closed: without(state.closed, id) });
  },
  unpin: (id: string) => set({ pinned: state.pinned.filter((p) => p !== id) }),
  close: (id: string) => set({ pinned: state.pinned.filter((p) => p !== id), closed: { ...state.closed, [id]: Date.now() } }),
  reopen(id: string) {
    if (state.closed[id]) set({ closed: without(state.closed, id) });
  },
  // Moves a station one place left (-1) or right (+1). A move sticks: the
  // stations up to the moved one become pinned in the new order.
  move(id: string, shown: string[], by: -1 | 1) {
    const order = [...shown];
    const i = order.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    // Pins the stations up to the moved one; pinned ones further right stay pinned.
    const head = order.slice(0, Math.max(i, j) + 1);
    set({ pinned: [...head, ...state.pinned.filter((p) => !head.includes(p))] });
  },
  toggleFocus: () => set({ focus: !state.focus }),
  setFocus: (focus: boolean) => set({ focus }),
  // The stations on screen now (the rail marks them); not kept.
  setShown(ids: string[]) {
    if (ids.join() !== state.shown.join()) set({ shown: ids });
  },
};

function without(r: Record<string, number>, id: string) {
  const { [id]: _, ...rest } = r;
  return rest;
}

// The stations to show: the helm, the pinned ones, then by attention up to
// `room`. Pinned keep their order and lead; the others follow in the order
// they started, so a station never jumps when its state changes.
export function pickStations(live: Session[], watches: Record<string, Watch>, helm: string | null, room: number, s: State): Session[] {
  const by = new Map(live.map((x) => [x.id, x]));
  const closedNow = (x: Session) => {
    const at = s.closed[x.id];
    if (!at) return false;
    // Something new that needs him brings it back.
    return !(x.updated > at && (watches[x.id] === "need" || watches[x.id] === "work"));
  };
  const pinned = s.pinned.map((id) => by.get(id)).filter((x): x is Session => !!x);
  const chosen = new Set(pinned.map((x) => x.id));
  if (helm && by.has(helm)) chosen.add(helm);
  const rest = live
    .filter((x) => !chosen.has(x.id) && !closedNow(x) && !x.parent_id)
    .sort((a, b) => WATCH_RANK[watches[a.id]!] - WATCH_RANK[watches[b.id]!] || b.updated - a.updated);
  for (const x of rest) {
    if (chosen.size >= room) break;
    chosen.add(x.id);
  }
  const loose = [...chosen].filter((id) => !s.pinned.includes(id)).map((id) => by.get(id)!).sort((a, b) => a.created - b.created);
  return [...pinned, ...loose];
}
