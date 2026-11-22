// The hand on the session list, and what the owner did to a session from
// this page. While the pointer is in the list or the keyboard is on one of
// its entries the list is held still (lib/list-order.ts says how); it lets go
// a moment after both have left, so a pointer that crosses the edge and comes
// back finds the rows where they were. A session the owner acted on (archived
// from its row, pinned, jumped to from the line above the list) is drawn as
// it is now, held or not.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FocusEvent } from "react";
import { after } from "./list-order.ts";
import { getState } from "./store.ts";
import { navigate, phone } from "./ui.ts";

// How long after the hand left the list lets go.
const LEAVE_MS = 400;

const own = new Set<string>();
let rev = 0;
const subs = new Set<() => void>();
export function listActed(id: string) {
  own.add(id);
  rev++;
  subs.forEach((f) => f());
}
export const actedOn = (id: string) => own.has(id);
// The list let go: what the owner did is in it now.
export const forgetActed = () => own.clear();
export const useActed = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => rev);

// Whether the hand is on the list: `on` is bound to the list itself (its rows
// and what stands between them). The pointer on the tabs or the filter box
// over the list, or the keyboard in them, holds nothing.
export function useHand() {
  const [held, setHeld] = useState(false);
  const at = useRef({ pointer: false, focus: false, rows: null as HTMLElement | null, timer: undefined as ReturnType<typeof setTimeout> | undefined });
  const set = useCallback((patch: { pointer?: boolean; focus?: boolean }) => {
    Object.assign(at.current, patch);
    // A focused row taken out of the page sends no blur: the keyboard is on the rows only while it is in them.
    if (at.current.focus && !(at.current.rows?.isConnected && at.current.rows.contains(document.activeElement))) at.current.focus = false;
    clearTimeout(at.current.timer);
    if (at.current.pointer || at.current.focus) setHeld(true);
    else at.current.timer = setTimeout(() => setHeld(false), LEAVE_MS);
  }, []);
  useEffect(() => {
    const look = () => { if (at.current.focus) set({}); };
    addEventListener("focusin", look);
    return () => { removeEventListener("focusin", look); clearTimeout(at.current.timer); };
  }, [set]);
  const on = useRef({
    onPointerEnter: () => set({ pointer: true }),
    onPointerLeave: () => set({ pointer: false }),
    onFocus: (e: FocusEvent<HTMLElement>) => { at.current.rows = e.currentTarget; set({ focus: true }); },
    onBlur: (e: FocusEvent<HTMLElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) set({ focus: false }); },
  });
  // The list was drawn anew in another form (folded, unfolded): the hand is where the next event says.
  const reset = useCallback(() => set({ pointer: false, focus: false }), [set]);
  return { held, on: on.current, reset };
}
export type Hand = ReturnType<typeof useHand>;

// Whom each count on the line above the list names (Sidebar.tsx keeps them, also
// while the list is folded); a press on a count, or the key, goes to the next of them.
export type Kind = "need" | "fail" | "work" | "unread" | "offline";
export type Counts = Record<Kind, string[]>;
let named: Counts = { need: [], fail: [], work: [], unread: [], offline: [] };
const last: Partial<Record<Kind, string>> = {};
const countSubs = new Set<() => void>();
export const nameCounts = (n: Counts) => { named = n; countSubs.forEach((f) => f()); };
export const useCounts = () => useSyncExternalStore((f) => (countSubs.add(f), () => countSubs.delete(f)), () => named);
// The list's own way to show every session again (its filter words and tag), while it is drawn.
let unfilter: (() => void) | null = null;
export const onUnfilter = (f: (() => void) | null) => { unfilter = f; };

const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-testid="session-list"] [data-testid="session-row"][data-session="${CSS.escape(id)}"]`);

// To a session's row: scrolled into view, with the keyboard on it (Enter opens
// it). A row the list does not draw (filtered out, in a folded folder, the
// list a closed drawer) is opened instead.
export function jumpTo(id: string) {
  if (!getState().sessions[id]) return;
  if (phone()) return navigate({ name: "session", id });
  listActed(id);
  let tries = 0;
  const look = () => {
    const row = rowOf(id);
    if (row) { row.scrollIntoView({ block: "nearest" }); row.focus(); return; }
    if (tries === 0) unfilter?.();
    if (++tries < 6) requestAnimationFrame(look);
    else navigate({ name: "session", id });
  };
  requestAnimationFrame(look);
}

// The next session of a kind after the one last gone to, around the end. Says whether there was one.
export function jumpNext(kind: Kind): boolean {
  const ids = named[kind];
  if (!ids.length) return false;
  const id = after(ids, last[kind] ?? null)!;
  last[kind] = id;
  jumpTo(id);
  return true;
}
