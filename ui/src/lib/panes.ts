// The panes on the bridge: how many there are (the owner's number), which
// session each holds, how wide each is, and whether the helm is focused to
// the full width. Nothing here changes by itself: a pane is added, removed,
// filled, moved or resized only by the owner.
//
// A pane holds the session the owner put in it. Opening a session (a row of
// the list, a link, the palette, a notification, the answering sequence)
// never takes that away. It goes, in this order:
//   - to the pane that shows it already, which becomes the pane worked in;
//   - to its own pane, when something lies over it there (that is put away);
//   - to a pane the owner added and left empty, which it fills;
//   - in a layout of one pane, into that pane, as a page that is turned;
//   - else over the pane worked in, as a look: the pane still holds its
//     session, which stays as it was under the look (its place in the
//     conversation, its draft), and comes back when the look is left.
// A look becomes the pane's session only when the owner places it: "Keep
// here", a double click on its row, a drop on the pane, the menu of panes.
// A look stays until it is left (Back, Escape, answering what it asks),
// replaced by another look in the same pane, or placed. A second pane opens
// only when asked for: the pane control, "open beside", or a drop on a
// pane's edge. Closing the session in a pane closes the pane (the last one
// stays), and an empty pane is not kept across a reload, so no empty pane
// waits for a session they did not ask to place.
export const MAX_PANES = 6;

export type Kept = {
  count: number; // panes on the bridge
  slots: (string | null)[]; // the session each holds, left to right; null is an empty pane
  over?: (string | null)[]; // the look over each: a session shown there for now, over the one the pane holds
  sizes: Record<number, number[]>; // per count: each pane's share of the width (1 is an equal share)
  active: number; // the pane worked in
};
// `keys`: a name for each pane that goes with it when panes trade places and
// stays when its session changes, so the page keeps what a pane shows mounted
// through both. Not kept: a reload names them again.
export type Panes = { slots: (string | null)[]; over: (string | null)[]; keys: string[]; active: number };
let named = 0;
export const paneKey = () => `pane-${++named}`;

// The kept layout without its empty panes: a pane they left empty is not forced on them again.
export function restore(kept: Partial<Kept> | null): Kept & { over: (string | null)[] } {
  const n = Math.min(MAX_PANES, Math.max(1, Math.floor(Number(kept?.count)) || 1));
  const all = Array.from({ length: n }, (_, i) => ({ id: kept?.slots?.[i] ?? null, over: kept?.over?.[i] ?? null }));
  const at = Math.min(n - 1, Math.max(0, Number(kept?.active) || 0));
  const filled = all.filter((x) => x.id);
  if (!filled.length) return { count: 1, slots: [null], over: [null], sizes: kept?.sizes ?? {}, active: 0 };
  // The pane worked in, else the nearest filled one left of it.
  const on = all[at]?.id ? all[at]! : all.slice(0, at).findLast((x) => x.id) ?? filled[0]!;
  return { count: filled.length, slots: filled.map((x) => x.id), over: filled.map((x) => x.over), sizes: kept?.sizes ?? {}, active: Math.max(0, filled.indexOf(on)) };
}
// What a pane shows: the look over it, else the session it holds.
export const shownIn = (s: Pick<Panes, "slots" | "over">, i: number): string | null => s.over[i] ?? s.slots[i] ?? null;
// The pane that shows a session, or -1.
export const paneOf = (s: Pick<Panes, "slots" | "over">, id: string): number => s.slots.findIndex((_, i) => shownIn(s, i) === id);
// Where a session being opened goes when no pane has it (see the head of the file).
export function target(s: Pick<Panes, "slots" | "active">): number {
  if (s.slots[s.active] == null) return s.active;
  const free = s.slots.indexOf(null);
  return free < 0 ? s.active : free;
}
export const put = <T,>(list: T[], i: number, v: T): T[] => list.map((x, j) => (j === i ? v : x));
// The panes with `id` opened, by the rule at the head of the file.
export function opened<T extends Panes>(s: T, id: string): T {
  const at = paneOf(s, id);
  if (at >= 0) return at === s.active ? s : { ...s, active: at };
  const own = s.slots.indexOf(id);
  if (own >= 0) return { ...s, over: put(s.over, own, null), active: own };
  const i = target(s);
  if (s.slots[i] == null || s.slots.length === 1) return { ...s, slots: put(s.slots, i, id), over: put(s.over, i, null), active: i };
  return { ...s, over: put(s.over, i, id), active: i };
}
// The panes with `id` placed in pane `slot`: it is that pane's session from now on.
// - A look over that pane is kept there, in place of the session it lay over.
// - A session that has a pane trades places with the one picked (a look over the
//   picked pane goes with its session). When a look lies over its own pane, the
//   look stays there as that pane's session.
// - Anything else takes the place of what the picked pane held.
export function placed<T extends Panes>(s: T, id: string, slot: number): T {
  if (slot < 0 || slot >= s.slots.length) return s;
  const slots = [...s.slots], over = [...s.over], keys = [...s.keys];
  const look = over.indexOf(id), from = slots.indexOf(id);
  if (look === slot) { slots[slot] = id; over[slot] = null; return { ...s, slots, over, active: slot }; }
  if (look >= 0) over[look] = null;
  if (from === slot) over[slot] = null;
  else if (from >= 0 && over[from]) { slots[from] = over[from]!; over[from] = null; slots[slot] = id; over[slot] = null; }
  else if (from >= 0) {
    [slots[from], slots[slot]] = [slots[slot] ?? null, id];
    [over[from], over[slot]] = [over[slot] ?? null, null];
    [keys[from], keys[slot]] = [keys[slot]!, keys[from]!];
  } else { slots[slot] = id; over[slot] = null; }
  return { ...s, slots, over, keys, active: slot };
}
// The panes without the look over pane `slot`: it shows the session it holds again.
export const uncovered = <T extends Panes>(s: T, slot: number): T => (s.over[slot] ? { ...s, over: put(s.over, slot, null), active: slot } : s);
