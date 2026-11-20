// The panes on the bridge: how many there are (the owner's number), which
// session each holds, how wide each is, and whether the helm is focused to
// the full width. Nothing here changes by itself: a pane is added, removed,
// filled, emptied, moved or resized only by the owner. Opening a session
// never adds a pane: it goes to the pane worked in when that is empty, else
// to a free pane, else it replaces the session in the pane worked in.
import { useSyncExternalStore } from "react";
import type { Session } from "../../../src/core/types.ts";
import { WATCH_RANK, type Watch } from "./watch.ts";

export const MAX_PANES = 6;

type Kept = {
  count: number; // panes on the bridge
  slots: (string | null)[]; // the session in each, left to right; null is an empty pane
  sizes: Record<number, number[]>; // per count: each pane's share of the width (1 is an equal share)
  active: number; // the pane worked in
};
type State = Kept & { seeded: boolean; focus: boolean; shown: string[] };

const load = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? d : (JSON.parse(v) as T);
  } catch {
    return d;
  }
};

const kept = load<Partial<Kept> | null>("keel.panes", null);
const count0 = Math.min(MAX_PANES, Math.max(1, Math.floor(Number(kept?.count)) || 1));
let state: State = {
  seeded: !!kept,
  count: count0,
  slots: Array.from({ length: count0 }, (_, i) => kept?.slots?.[i] ?? null),
  sizes: kept?.sizes ?? {},
  active: Math.min(count0 - 1, Math.max(0, Number(kept?.active) || 0)),
  focus: load("keel.focus", false),
  shown: [],
};
const subs = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  if (state.seeded) localStorage.setItem("keel.panes", JSON.stringify({ count: state.count, slots: state.slots, sizes: state.sizes, active: state.active } satisfies Kept));
  localStorage.setItem("keel.focus", JSON.stringify(state.focus));
  subs.forEach((f) => f());
}
export const getStations = () => state;
export function useStations<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => sel(state));
}

// Where a session being opened goes (see the head of the file).
export function target(s: Pick<State, "slots" | "active">): number {
  if (s.slots[s.active] == null) return s.active;
  const free = s.slots.indexOf(null);
  return free < 0 ? s.active : free;
}
// The panes with `id` opened: its own pane when it has one.
export function opened<T extends Pick<State, "slots" | "active">>(s: T, id: string): T {
  const at = s.slots.indexOf(id);
  if (at >= 0) return at === s.active ? s : { ...s, active: at };
  const i = target(s);
  return { ...s, slots: s.slots.map((x, j) => (j === i ? id : x)), active: i };
}
// Each pane's share at the current count.
export const shares = (s: Pick<State, "count" | "sizes">): number[] => {
  const w = s.sizes[s.count];
  return w?.length === s.count && w.every((x) => x > 0) ? w : Array.from({ length: s.count }, () => 1);
};

export const stations = {
  // The first layout, once: the number of panes that fit and the sessions to start with.
  seed(count: number, ids: string[]) {
    if (state.seeded) return;
    const n = Math.min(MAX_PANES, Math.max(1, count));
    set({ seeded: true, count: n, slots: Array.from({ length: n }, (_, i) => ids[i] ?? null), active: 0 });
  },
  // The owner's number. Fewer panes: empty ones go first, then the rightmost; the pane worked in stays.
  setCount(count: number) {
    const n = Math.min(MAX_PANES, Math.max(1, Math.round(count)));
    if (n === state.count) return;
    const keep = state.slots.map((id, i) => ({ id, on: i === state.active }));
    while (keep.length > n) {
      let i = keep.findLastIndex((x) => x.id == null && !x.on);
      if (i < 0) i = keep.findLastIndex((x) => !x.on);
      keep.splice(i, 1);
    }
    while (keep.length < n) keep.push({ id: null, on: false });
    set({ seeded: true, count: n, slots: keep.map((x) => x.id), active: Math.max(0, keep.findIndex((x) => x.on)) });
  },
  open(id: string) {
    const next = opened(state, id);
    if (next !== state) set({ seeded: true, slots: next.slots, active: next.active });
  },
  // Puts a session in a pane (a drop). One that already has a pane trades places with it.
  place(id: string, slot: number) {
    if (slot < 0 || slot >= state.count) return;
    const from = state.slots.indexOf(id);
    const slots = [...state.slots];
    if (from >= 0) slots[from] = slots[slot] ?? null;
    slots[slot] = id;
    set({ seeded: true, slots, active: slot });
  },
  setActive(slot: number) {
    if (slot >= 0 && slot < state.count && slot !== state.active) set({ active: slot });
  },
  // Empties the session's pane; the pane stays.
  close(id: string) {
    if (state.slots.includes(id)) set({ slots: state.slots.map((x) => (x === id ? null : x)) });
  },
  // Sessions that are gone leave their panes empty.
  drop(gone: (id: string) => boolean) {
    if (state.slots.some((x) => x && gone(x))) set({ slots: state.slots.map((x) => (x && gone(x) ? null : x)) });
  },
  // Trades places with the pane to the left (-1) or right (+1).
  move(id: string, by: -1 | 1) {
    const i = state.slots.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= state.count) return;
    const slots = [...state.slots];
    [slots[i], slots[j]] = [slots[j]!, slots[i]!];
    set({ slots, active: state.active === i ? j : state.active === j ? i : state.active });
  },
  // The shares of the panes at this count (a dragged divider); none given puts them back to equal.
  resize(weights?: number[]) {
    const { [state.count]: _, ...rest } = state.sizes;
    set({ seeded: true, sizes: weights ? { ...rest, [state.count]: weights } : rest });
  },
  toggleFocus: () => set({ focus: !state.focus }),
  setFocus: (focus: boolean) => set({ focus }),
  // The sessions on screen now (the rail marks them); not kept.
  setShown(ids: string[]) {
    if (ids.join() !== state.shown.join()) set({ shown: ids });
  },
};

const STALE_FAIL_MS = 24 * 3600_000;

// Sessions in the order they ask for attention: what needs him, what works,
// a fresh failure, then the newest. It orders the first layout, an empty
// pane's suggestions and a phone's pages; it never fills a pane by itself.
export function byAttention(live: Session[], watches: Record<string, Watch>): Session[] {
  const now = Date.now();
  // A failure from days ago waits its turn with the finished work.
  const rank = (x: Session) => (watches[x.id] === "fail" && now - x.updated > STALE_FAIL_MS ? WATCH_RANK.done : WATCH_RANK[watches[x.id]!]);
  return live.filter((x) => !x.parent_id && !x.settings.done_ms).sort((a, b) => rank(a) - rank(b) || b.updated - a.updated);
}
