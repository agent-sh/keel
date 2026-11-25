// The hand on the session list, and what the owner did to a session from
// this page. While the pointer is in the list or the keyboard is on one of
// its entries the list is held still (lib/list-order.ts says how); it lets go
// a moment after both have left, so a pointer that crosses the edge and comes
// back finds the rows where they were. A pointer that only lies in the list
// (it has not moved for a few seconds, and the keyboard is elsewhere) holds
// nothing: the owner is typing in a pane, not aiming at a row. A session the
// owner acted on (archived from its row, pinned, jumped to from the line
// above the list) is drawn as it is now, held or not.
//
// What does move, moves around the hand: the row the pointer is on (else the
// row the keyboard was last on) stays where it is on the screen while the
// rows around it take their places, when the list lets go and for as long as
// the pointer lies in it (useAnchor).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FocusEvent } from "react";
import { after } from "./list-order.ts";
import { getState } from "./store.ts";
import { navigate, phone } from "./ui.ts";
import { PHONE_QUERY } from "./phone.ts";

// How long after the hand left the list lets go.
const LEAVE_MS = 400;
// How long a pointer that does not move still counts as a hand on the list.
export const IDLE_MS = 5000;
// How long the row a count went to stays marked.
const JUMP_MS = 1600;

// How long after the owner's own act on the hand's row the row is let go where the act puts it.
const OWN_MS = 1500;
let ownMove = -Infinity;
const own = new Set<string>();
let rev = 0;
const subs = new Set<() => void>();
export function listActed(id: string) {
  // The row the hand is on goes where the owner sent it (pinned, moved among the pinned): it is not held where it stood.
  if (anchor?.id === id) ownMove = performance.now();
  own.add(id);
  rev++;
  subs.forEach((f) => f());
}
export const actedOn = (id: string) => own.has(id);
// An act of the owner's that leaves the row where it is while the hand is on the list (a pin with the
// pointer): it is the owner's own act once the list lets go, so the row goes where the act puts it then,
// and the list is not held around where it stood.
const onLetGo = new Set<string>();
export const actWhenLetGo = (id: string) => void onLetGo.add(id);
export const waitsLetGo = (id: string) => onLetGo.has(id);
export function letGo() {
  for (const id of onLetGo) listActed(id);
  onLetGo.clear();
}
// The list let go: what the owner did is in it now, and a fold that opened for a session they went to closes.
export function forgetActed() {
  if (!own.size) return;
  own.clear();
  rev++;
  subs.forEach((f) => f());
}
export const useActed = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => rev);
// Which of the owner's acts on the list was the last one, for what is decided by their order (a fold after a move).
export const actedRev = () => rev;

// Whether the hand is on the list: `on` is bound to the list itself (its rows
// and what stands between them). The pointer on the tabs or the filter box
// over the list, or the keyboard in them, holds nothing.
export function useHand() {
  const [held, setHeld] = useState(false);
  const at = useRef({
    pointer: false, focus: false, rows: null as HTMLElement | null,
    list: null as HTMLElement | null, // the list the pointer is in
    kept: 0, // menus of the list's rows that are open over it
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
    if (a.pointer || a.focus || a.kept > 0) setHeld(true);
    // (What the owner did in place while the hand was there is their own act from the moment the list lets go.)
    else a.timer = setTimeout(() => { letGo(); setHeld(false); }, LEAVE_MS);
  }, []);
  // The pointer is a hand while it moves: at rest for IDLE_MS it holds nothing until it moves again.
  const stir = useCallback((e?: { currentTarget: EventTarget | null; pointerType?: string; buttons?: number }) => {
    // Touch has no hover. Opening the filter can move rows under a completed
    // tap; those pointer events must not pin the drawer's old contents.
    if (e?.pointerType === "touch" && !e.buttons) return;
    if (e && !e.buttons && matchMedia(PHONE_QUERY).matches && document.activeElement?.closest(".k-find")) return;
    const a = at.current;
    if (e?.currentTarget instanceof HTMLElement) a.list = e.currentTarget;
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
    // The pointer left: what it did in place is the owner's own act now, also while the keyboard holds the list.
    letGo();
    clearTimeout(at.current.idle);
    at.current.idle = undefined;
    set({ pointer: false });
  }, [set]);
  useEffect(() => {
    const look = (e: Event) => {
      // Focusing the filter can hide the tapped button above the list. The
      // row newly under that touch does not take over from the filter.
      if (e.target instanceof Element && e.target.closest(".k-find") && matchMedia(PHONE_QUERY).matches) rest();
      else if (at.current.focus) set({});
    };
    // The pointer is somewhere else now. The list's own leave can be lost: when what was under the pointer
    // is taken out of the page (a pin's icon drawn anew under it) the browser tells no one it left.
    const away = (e: PointerEvent) => { const l = at.current.list; if (at.current.pointer && l && !(e.target instanceof Node && l.contains(e.target))) rest(); };
    addEventListener("focusin", look);
    addEventListener("pointerover", away, true);
    return () => { removeEventListener("focusin", look); removeEventListener("pointerover", away, true); clearTimeout(at.current.timer); clearTimeout(at.current.idle); };
  }, [set, rest]);
  const on = useRef({
    onPointerEnter: stir,
    onPointerMove: stir,
    onPointerDown: stir,
    onPointerUp: (e: { pointerType: string }) => { if (e.pointerType === "touch") rest(); },
    onPointerCancel: (e: { pointerType: string }) => { if (e.pointerType === "touch") rest(); },
    onWheel: stir,
    onPointerLeave: rest,
    // On a phone the drawer puts the keyboard on the open session's row as it opens (App.tsx), with no
    // keyboard there: that is no hand, or the list and what it names at its foot would stand still for
    // as long as the drawer is open. Keys that move it there (a keyboard on the phone) are one.
    onFocus: (e: FocusEvent<HTMLElement>) => {
      if (matchMedia(PHONE_QUERY).matches && e.target instanceof Element && !e.target.matches(":focus-visible")) return;
      at.current.rows = e.currentTarget; set({ focus: true });
    },
    onBlur: (e: FocusEvent<HTMLElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) set({ focus: false }); },
  });
  // The list was drawn anew in another form (folded, unfolded): the hand is where the next event says.
  const reset = useCallback(() => { at.current.focus = false; at.current.kept = 0; rest(); }, [rest]);
  // A menu of a row is open (the hand is in it, over the list): the list is held for as long.
  const keep = useCallback((open: boolean) => { at.current.kept = Math.max(0, at.current.kept + (open ? 1 : -1)); set({}); }, [set]);
  // `touch`: the hand did something that is the list's (a press on the line at its foot): held as by a move of the pointer in it.
  return { held, on: on.current, reset, keep, touch: stir };
}
export type Hand = ReturnType<typeof useHand>;

// The row the hand is on, and where it stands on the screen. While there is one, every change
// of the list (rows that settle, arrive, leave, fold, sort) is followed by the list's own
// scroll, so that this row stays where it is: the rows around it move, it does not. Where the
// list cannot scroll that far (the row would have to stand above the first row's place, or the
// list is shorter than its box) the list is padded for as long as the hand is there. The order
// keeps the row's place among its neighbours too (`around` in lib/list-order.ts, read by the
// lists through `anchorRow`), so the scroll has little to make up.
const ROW = '[data-testid="session-row"]';
let anchor: { id: string; top: number } | null = null;
let within = false; // the pointer is over the list, moving or not
let anchored: HTMLElement | null = null; // the list the anchor is in
let padTop = 0, padBottom = 0; // what the list is padded by, to stand where it cannot scroll to
export const anchorRow = (): string | null => anchor?.id ?? null;
const ROW_IN = (nav: HTMLElement, id: string) => nav.querySelector<HTMLElement>(`${ROW}[data-session="${CSS.escape(id)}"]`);
const pad = (nav: HTMLElement, top: number, bottom: number) => {
  padTop = top; padBottom = bottom;
  nav.style.paddingTop = top > 0.01 ? `${top}px` : "";
  nav.style.paddingBottom = bottom > 0.5 ? `calc(0.75rem + ${bottom}px)` : "";
};
// The hand has been away through the settle: the list is its own again.
export function dropAnchor() {
  if (within || (anchored && anchored.contains(document.activeElement))) return;
  anchor = null;
  if (anchored) pad(anchored, 0, 0);
}
// The owner arranged the list anew (its tab, its filter, its order): it is drawn as they asked,
// and the row the hand is on is taken where it stands now.
export function reanchor() {
  if (!anchored) return;
  pad(anchored, 0, 0);
  const row = anchor ? ROW_IN(anchored, anchor.id) : null;
  anchor = row && anchor ? { id: anchor.id, top: row.getBoundingClientRect().top } : null;
}
// What the list scrolls in: the list itself, or on a phone the box above the list's foot, where the
// list scrolls with what stands above it (bridge.css, .k-list-scroll). Decided again when the screen
// crosses the phone's width (usePhoneWidth).
const PHONE = PHONE_QUERY;
export const scrollerOf = (nav: HTMLElement | null) => (nav && getComputedStyle(nav).overflowY === "visible" ? nav.closest<HTMLElement>(".k-list-scroll") ?? nav : nav);
export const usePhoneWidth = () => useSyncExternalStore(
  (f) => { const m = matchMedia(PHONE); m.addEventListener("change", f); return () => m.removeEventListener("change", f); },
  () => matchMedia(PHONE).matches,
);

// The rows stay where they are around the hand's row. What scrolls is what the list scrolls in (its own
// box at a desk, the box with the tabs and the find above it on a phone): its position, its box and its
// heights are read there, and its scroll is listened to there. The padding that makes up what it cannot
// scroll to stays on the list.
export function useAnchor(list: { current: HTMLElement | null }) {
  const narrow = usePhoneWidth();
  useEffect(() => {
    const nav = list.current;
    const sc = scrollerOf(nav);
    if (!nav || !sc) return;
    anchored = nav;
    let self = 0; // the scroll events this makes itself
    let aimed = 0;
    const rowAt = (id: string) => ROW_IN(nav, id);
    const take = (row: HTMLElement | null | undefined) => { const id = row?.getAttribute("data-session"); if (row && id) anchor = { id, top: row.getBoundingClientRect().top }; };
    const aim = (e: PointerEvent) => {
      within = true;
      const row = (e.target as Element | null)?.closest?.<HTMLElement>(ROW);
      if (row) return take(row);
      // Between rows (a folder's head, a gap): the row nearest the pointer, looked for a few times a second at most.
      if (performance.now() - aimed < 150) return;
      aimed = performance.now();
      let best: HTMLElement | null = null, d = Infinity;
      for (const r of nav.querySelectorAll<HTMLElement>(ROW)) { const b = r.getBoundingClientRect(); const far = Math.abs((b.top + b.bottom) / 2 - e.clientY); if (far < d) { d = far; best = r; } }
      take(best);
    };
    const leave = () => { within = false; };
    const focus = (e: Event) => { if (!within) take((e.target as Element | null)?.closest?.<HTMLElement>(ROW)); };
    const again = () => { if (self > 0) { self--; return; } if (anchor) take(rowAt(anchor.id)); };
    const settle = () => {
      if (!anchor) return;
      const row = rowAt(anchor.id);
      if (!row) { anchor = null; return pad(nav, 0, 0); }
      if (performance.now() - ownMove < OWN_MS) return take(row);
      const box = sc.getBoundingClientRect();
      // Where the row is in the scrolled content (the list's padding aside), and where it has to be in the box.
      const at = row.getBoundingClientRect().top - box.top + sc.scrollTop - padTop;
      const want = anchor.top - box.top;
      const k = at - want;
      // The box scrolls by whole pixels: what is left of a part of one is made up above the rows.
      const scroll = k < 0 ? 0 : Math.ceil(k - 0.01), top = scroll - k;
      const content = sc.scrollHeight - padTop - padBottom;
      const bottom = Math.max(0, scroll + sc.clientHeight - content - top);
      if (Math.abs(top - padTop) < 0.05 && Math.abs(bottom - padBottom) < 0.5 && scroll === Math.round(sc.scrollTop)) return;
      pad(nav, top, bottom);
      const was = sc.scrollTop;
      sc.scrollTop = scroll;
      if (sc.scrollTop !== was) self++;
    };
    const seen = new MutationObserver(settle);
    seen.observe(nav, { childList: true, subtree: true, characterData: true });
    nav.addEventListener("pointermove", aim, { passive: true });
    nav.addEventListener("pointerenter", aim, { passive: true });
    nav.addEventListener("pointerleave", leave);
    nav.addEventListener("focusin", focus);
    sc.addEventListener("scroll", again, { passive: true });
    addEventListener("resize", again);
    return () => {
      seen.disconnect();
      nav.removeEventListener("pointermove", aim);
      nav.removeEventListener("pointerenter", aim);
      nav.removeEventListener("pointerleave", leave);
      nav.removeEventListener("focusin", focus);
      sc.removeEventListener("scroll", again);
      removeEventListener("resize", again);
      if (anchored === nav) { anchored = null; anchor = null; within = false; pad(nav, 0, 0); }
    };
  }, [list, narrow]);
}

// Whom each count on the line above the list names (Sidebar.tsx keeps them, also
// while the list is folded); a press on a count, or the key, goes to the next of them.
export type Kind = "need" | "fail" | "work" | "wait" | "unread" | "offline";
export type Counts = Record<Kind, string[]>;
let named: Counts = { need: [], fail: [], work: [], wait: [], unread: [], offline: [] };
const last: Partial<Record<Kind, string>> = {};
const countSubs = new Set<() => void>();
export const nameCounts = (n: Counts) => { named = n; countSubs.forEach((f) => f()); };
export const useCounts = () => useSyncExternalStore((f) => (countSubs.add(f), () => countSubs.delete(f)), () => named);
// The rows that stand for a session that needs the owner under a look (its pane shows another
// session for now): marked, since what they need is on no screen.
let underLooks = "";
const underSubs = new Set<() => void>();
export const nameUnder = (ids: string[]) => { const next = [...ids].sort().join(" "); if (next !== underLooks) { underLooks = next; underSubs.forEach((f) => f()); } };
export const useUnderLook = (id: string) => useSyncExternalStore((f) => (underSubs.add(f), () => underSubs.delete(f)), () => underLooks.split(" ").includes(id));

// The list's own way to draw a row it does not draw now (its tab, its filter words and tag), while it is drawn.
let reveal: ((id: string) => void) | null = null;
export const onReveal = (f: ((id: string) => void) | null) => { reveal = f; };

const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-testid="session-list"] [data-testid="session-row"][data-session="${CSS.escape(id)}"]`);

// The keyboard goes back to a session's row once the list has drawn it in its new place (a row
// pinned or moved from the keyboard is drawn anew there): looked for on a few frames.
export function focusRow(id: string) {
  let tries = 0;
  const look = () => {
    const row = rowOf(id);
    if (row) return row.focus();
    if (++tries < 12) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

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
