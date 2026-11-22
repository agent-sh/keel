// The panes on the bridge, as the page keeps them: the rules are in panes.ts
// (which session each pane holds, where an opened one goes, what placing one
// does); here is the state itself, kept across reloads, and the owner's acts on it.
import { useSyncExternalStore } from "react";
import type { Session } from "../../../src/core/types.ts";
import { MAX_PANES, opened, paneKey, paneOf, placed, put, restore, uncovered, type Kept, type Panes } from "./panes.ts";
import { WATCH_RANK, type Watch } from "./watch.ts";
import { soloWindow } from "./shell.ts";

export { MAX_PANES, opened, paneOf, shownIn, target, type Panes } from "./panes.ts";

type State = Omit<Kept, "over"> & Panes & { seeded: boolean; focus: boolean; shown: string[] };

const load = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? d : (JSON.parse(v) as T);
  } catch {
    return d;
  }
};

// A session's own window of the desktop shell shows that session alone: it
// neither reads nor writes the layout the main window keeps.
const kept = soloWindow ? null : load<Partial<Kept> | null>("keel.panes", null);
const first = restore(kept);
let state: State = {
  seeded: !!kept,
  ...first,
  keys: first.slots.map(paneKey),
  focus: soloWindow || load("keel.focus", false),
  shown: [],
};
const subs = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  if (!soloWindow) {
    if (state.seeded) localStorage.setItem("keel.panes", JSON.stringify({ count: state.count, slots: state.slots, over: state.over, sizes: state.sizes, active: state.active } satisfies Kept));
    localStorage.setItem("keel.focus", JSON.stringify(state.focus));
  }
  subs.forEach((f) => f());
}
export const getStations = () => state;
export function useStations<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => sel(state));
}

// Each pane's share at the current count.
export const shares = (s: Pick<State, "count" | "sizes">): number[] => {
  const w = s.sizes[s.count];
  return w?.length === s.count && w.every((x) => x > 0) ? w : Array.from({ length: s.count }, () => 1);
};

export const stations = {
  // The first layout, once: one pane, with the session open.
  seed(id: string | null) {
    // (The pane keeps its name: what it shows is drawn once, not again as the layout is first kept.)
    if (!state.seeded) set({ seeded: true, count: 1, slots: [id], over: [null], keys: [state.keys[0] ?? paneKey()], active: 0 });
  },
  // The owner's number. Fewer panes: empty ones go first, then the rightmost; the pane worked in stays.
  setCount(count: number) {
    const n = Math.min(MAX_PANES, Math.max(1, Math.round(count)));
    if (n === state.count) return;
    const keep = state.slots.map((id, i) => ({ id, over: state.over[i] ?? null, key: state.keys[i]!, on: i === state.active }));
    while (keep.length > n) {
      let i = keep.findLastIndex((x) => x.id == null && !x.on);
      if (i < 0) i = keep.findLastIndex((x) => !x.on);
      keep.splice(i, 1);
    }
    while (keep.length < n) keep.push({ id: null, over: null, key: paneKey(), on: false });
    set({ seeded: true, count: n, slots: keep.map((x) => x.id), over: keep.map((x) => x.over), keys: keep.map((x) => x.key), active: Math.max(0, keep.findIndex((x) => x.on)) });
  },
  open(id: string) {
    const next = opened(state, id);
    if (next !== state) set({ seeded: true, slots: next.slots, over: next.over, active: next.active });
  },
  // Puts a session in a pane (a drop, the menu of panes, "Keep here"): see `placed`.
  place(id: string, slot: number) {
    const next = placed(state, id, slot);
    if (next !== state) set({ seeded: true, slots: next.slots, over: next.over, keys: next.keys, active: next.active });
  },
  // The look over a pane is left: the pane shows the session it holds again.
  uncover(slot: number) {
    const next = uncovered(state, slot);
    if (next !== state) set({ over: next.over, active: next.active });
  },
  setActive(slot: number) {
    if (slot >= 0 && slot < state.count && slot !== state.active) set({ active: slot });
  },
  // Opens a session in a new pane beside one (the pane worked in by default):
  // its right, or its left. At `max` panes the neighbour on that side is used.
  beside(id: string, max: number, at = state.active, side: "left" | "right" = "right") {
    const from = state.slots.indexOf(id);
    // It has a pane already: that pane is the one worked in (a look over it is put away).
    if (from >= 0) return paneOf(state, id) === state.active ? undefined : set({ over: put(state.over, from, null), active: from });
    if (state.count >= Math.min(MAX_PANES, max)) {
      // No room for another pane: the neighbour on that side takes it.
      const j = side === "right" ? (at + 1 < state.count ? at + 1 : at - 1) : (at > 0 ? at - 1 : at + 1);
      if (j < 0 || j >= state.count) return stations.open(id);
      return stations.place(id, j);
    }
    // A look that is opened beside leaves the pane it lay over.
    const over = state.over.map((x) => (x === id ? null : x));
    const slots = [...state.slots], keys = [...state.keys];
    const i = side === "right" ? at + 1 : at;
    slots.splice(i, 0, id);
    over.splice(i, 0, null);
    keys.splice(i, 0, paneKey());
    set({ seeded: true, count: slots.length, slots, over, keys, active: i });
  },
  // Closes the session's pane; the last pane stays, empty.
  close(id: string) {
    const i = state.slots.indexOf(id);
    if (i >= 0) stations.closePane(i);
  },
  closePane(i: number) {
    if (i < 0 || i >= state.count) return;
    if (state.count === 1) return set({ slots: [null], over: [null] });
    const out = <T,>(l: T[]) => l.filter((_, j) => j !== i);
    const slots = out(state.slots);
    set({ count: slots.length, slots, over: out(state.over), keys: out(state.keys), active: Math.min(slots.length - 1, state.active > i ? state.active - 1 : state.active) });
  },
  // Sessions that are gone leave their panes: a look goes, and a pane whose
  // own session went keeps the look over it as its session, else stands empty.
  drop(gone: (id: string) => boolean) {
    if (![...state.slots, ...state.over].some((x) => x && gone(x))) return;
    const over = state.over.map((x) => (x && gone(x) ? null : x));
    const slots = state.slots.map((x, i) => (x && gone(x) ? over[i] ?? null : x));
    set({ slots, over: over.map((x, i) => (x && slots[i] === x ? null : x)) });
  },
  // The pane that shows the session trades places with the one to its left (-1) or right (+1).
  move(id: string, by: -1 | 1) {
    const i = paneOf(state, id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= state.count) return;
    const swap = <T,>(l: T[]) => { const n = [...l]; [n[i], n[j]] = [n[j]!, n[i]!]; return n; };
    set({ slots: swap(state.slots), over: swap(state.over), keys: swap(state.keys), active: state.active === i ? j : state.active === j ? i : state.active });
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

// Sessions in the order they ask for attention: what needs them, what works,
// a fresh failure, then the newest. It orders the first layout, an empty
// pane's suggestions and a phone's pages; it never fills a pane by itself.
export function byAttention(live: Session[], watches: Record<string, Watch>): Session[] {
  const now = Date.now();
  // A failure from days ago waits its turn with the finished work.
  const rank = (x: Session) => (watches[x.id] === "fail" && now - x.updated > STALE_FAIL_MS ? WATCH_RANK.done : WATCH_RANK[watches[x.id]!]);
  return live.filter((x) => !x.parent_id && !x.settings.done_ms).sort((a, b) => rank(a) - rank(b) || b.updated - a.updated);
}
