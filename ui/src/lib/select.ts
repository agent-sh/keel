// The sessions the owner marked in the list to act on together (Ctrl or Shift click, Space on a focused row, a
// long press on a phone). The marks are the page's own and are never stored: Escape, an act or a session that
// left the list clears them. The list holds still under the hand (lib/list-order.ts), so a selection never
// reorders anything; a row only draws its mark.
import { useSyncExternalStore } from "react";

let chosen: ReadonlySet<string> = new Set();
// The row a range from Shift click starts at: the one marked last.
let anchor: string | null = null;
const subs = new Set<() => void>();
const set = (next: Set<string>, at: string | null = anchor) => {
  chosen = next;
  anchor = next.size ? at : null;
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

export const selected = (): ReadonlySet<string> => chosen;
export const selectedIds = (): string[] => [...chosen];
export const clearSelection = () => { if (chosen.size) set(new Set()); };
// One row marked or unmarked.
export function toggleSelected(id: string) {
  const next = new Set(chosen);
  if (next.has(id)) next.delete(id); else next.add(id);
  set(next, id);
}
// Shift click: every row from the one marked last to this one, in the order the list draws them.
export function selectRange(id: string, order: string[]) {
  const from = anchor && order.includes(anchor) ? order.indexOf(anchor) : -1;
  if (from < 0) return toggleSelected(id);
  const to = order.indexOf(id);
  const next = new Set(chosen);
  for (const x of order.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(x);
  set(next, id);
}
// Only those still in the list stay marked.
export function keepSelected(alive: (id: string) => boolean) {
  const next = new Set([...chosen].filter(alive));
  if (next.size !== chosen.size) set(next);
}

// Whether this one row is marked: a row draws again only when its own mark changes.
export const useIsSelected = (id: string) => useSyncExternalStore(subscribe, () => chosen.has(id));
export const useSelection = (): ReadonlySet<string> => useSyncExternalStore(subscribe, () => chosen);
