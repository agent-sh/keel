// The hand on the session list, and what the owner did to a session from
// this page. While the pointer is in the list or the keyboard is on one of
// its entries the list is held still (lib/list-order.ts says how); it lets go
// a moment after both have left, so a pointer that crosses the edge and comes
// back finds the rows where they were. A pointer that only lies in the list
// (it has not moved for a few seconds, and the keyboard is elsewhere) holds
// nothing: the owner is typing in a pane, not aiming at a row. A session the
// owner acted on (archived from its row, pinned, jumped to from the line
// above the list) is drawn as it is now, held or not.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FocusEvent } from "react";
import { after } from "./list-order.ts";
import { getState } from "./store.ts";
import { navigate, phone } from "./ui.ts";

// How long after the hand left the list lets go.
const LEAVE_MS = 400;
// How long a pointer that does not move still counts as a hand on the list.
export const IDLE_MS = 5000;
// How long the row a count went to stays marked.
const JUMP_MS = 1600;

const own = new Set<string>();
let rev = 0;
const subs = new Set<() => void>();
export function listActed(id: string) {
  own.add(id);
  rev++;
  subs.forEach((f) => f());
}
export const actedOn = (id: string) => own.has(id);
// The list let go: what the owner did is in it now, and a fold that opened for a session they went to closes.
export function forgetActed() {
  if (!own.size) return;
  own.clear();
  rev++;
  subs.forEach((f) => f());
}
export const useActed = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => rev);

// Whether the hand is on the list: `on` is bound to the list itself (its rows
// and what stands between them). The pointer on the tabs or the filter box
// over the list, or the keyboard in them, holds nothing.
export function useHand() {
  const [held, setHeld] = useState(false);
  const at = useRef({
    pointer: false, focus: false, rows: null as HTMLElement | null,
    moved: 0, // when the pointer last moved, pressed or scrolled in the list
    idle: undefined as ReturnType<typeof setTimeout> | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  });
  const set = useCallback((patch: { pointer?: boolean; focus?: boolean }) => {
    const a = at.current;
    Object.assign(a, patch);
    // A focused row taken out of the page sends no blur: the keyboard is on the rows only while it is in them.
    if (a.focus && !(a.rows?.isConnected && a.rows.contains(document.activeElement))) a.focus = false;
    clearTimeout(a.timer);
    if (a.pointer || a.focus) setHeld(true);
    else a.timer = setTimeout(() => setHeld(false), LEAVE_MS);
  }, []);
  // The pointer is a hand while it moves: at rest for IDLE_MS it holds nothing until it moves again.
  const stir = useCallback(() => {
    const a = at.current;
    a.moved = performance.now();
    if (!a.pointer) set({ pointer: true });
    if (a.idle !== undefined) return;
    const look = () => {
      const left = a.moved + IDLE_MS - performance.now();
      if (left > 0) { a.idle = setTimeout(look, left); return; }
      a.idle = undefined;
      set({ pointer: false });
    };
    a.idle = setTimeout(look, IDLE_MS);
  }, [set]);
  const rest = useCallback(() => {
    clearTimeout(at.current.idle);
    at.current.idle = undefined;
    set({ pointer: false });
  }, [set]);
  useEffect(() => {
    const look = () => { if (at.current.focus) set({}); };
    addEventListener("focusin", look);
    return () => { removeEventListener("focusin", look); clearTimeout(at.current.timer); clearTimeout(at.current.idle); };
  }, [set]);
  const on = useRef({
    onPointerEnter: stir,
    onPointerMove: stir,
    onPointerDown: stir,
    onWheel: stir,
    onPointerLeave: rest,
    onFocus: (e: FocusEvent<HTMLElement>) => { at.current.rows = e.currentTarget; set({ focus: true }); },
    onBlur: (e: FocusEvent<HTMLElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) set({ focus: false }); },
  });
  // The list was drawn anew in another form (folded, unfolded): the hand is where the next event says.
  const reset = useCallback(() => { at.current.focus = false; rest(); }, [rest]);
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
// The list's own way to draw a row it does not draw now (its tab, its filter words and tag), while it is drawn.
let reveal: ((id: string) => void) | null = null;
export const onReveal = (f: ((id: string) => void) | null) => { reveal = f; };

const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-testid="session-list"] [data-testid="session-row"][data-session="${CSS.escape(id)}"]`);

// To a session's row: scrolled to the middle of the list, the keyboard on it
// (Enter opens it), and marked for a moment, so it is found among rows that
// look alike also after a press of the pointer. A row the list does not draw
// (another tab, filtered out, in a folded folder, behind "N more") is drawn
// first: the session is the owner's own now (listActed), which unfolds what
// hides it, and the list is asked for the rest. Nothing is opened and no pane
// changes its session. On a phone the list is a drawer, and the session opens.
const marked = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
export function jumpTo(id: string) {
  if (!getState().sessions[id]) return;
  if (phone()) return navigate({ name: "session", id });
  listActed(id);
  let tries = 0;
  const look = () => {
    const row = rowOf(id);
    if (!row) {
      if (tries === 0) reveal?.(id);
      if (++tries < 12) requestAnimationFrame(look);
      return;
    }
    row.scrollIntoView({ block: "center" });
    row.focus({ preventScroll: true });
    clearTimeout(marked.get(row));
    row.setAttribute("data-jump", "");
    marked.set(row, setTimeout(() => row.removeAttribute("data-jump"), JUMP_MS));
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
