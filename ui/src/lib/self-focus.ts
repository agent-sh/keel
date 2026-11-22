// The one rule for a focus that code makes by itself: the message box as its
// page or its session opens, the button of a view that failed. Such a focus
// belongs to an act (the page loading, the navigation that opened the
// session) and may arrive long after it: the box is drawn when its session
// and its chunks are in. It takes the keyboard from nothing, and from where
// that act left it. It never takes it from a control the owner went to or
// used after that act: by their Tab, arrow or press, by a key typed there,
// or by a focus that came with no key or press at all (a screen reader's, a
// script's). A focus this rule made itself is never the owner's.
//
// The cards that wait on the owner above a message box have their own,
// stricter rule for arriving (they take the keyboard only from nothing or
// from their pane's empty message box, never from another control); a card
// that took the keyboard holds it here like a control the owner went to, so
// a message box drawn after it does not take it back.

// How long after a key or a press a focus is still that key's or press's own.
const ACT_MS = 100;
let seq = 0; // counts the owner's acts; 0 is the page loading
let input = -Infinity; // when their last key or press was
let held: { el: Element; seq: number } | null = null; // where the owner last put or used the keyboard, and in which act
let self = false; // set while this rule moves the focus
let nav = 0; // the act that last opened a page or a session

if (typeof window !== "undefined") {
  const act = () => { seq++; input = performance.now(); };
  addEventListener("keydown", (e) => {
    act();
    // A key pressed on a control is the owner using it.
    const t = e.target as Element | null;
    if (t && t !== document.body) held = { el: t, seq };
  }, true);
  addEventListener("pointerdown", act, true);
  addEventListener("focusin", (e) => {
    if (self) return;
    // With no key or press just before it, the focus is an act of its own.
    if (performance.now() - input > ACT_MS) seq++;
    held = { el: e.target as Element, seq };
  }, true);
}

// The owner's act opens a page or a session (ui.ts calls it for every route change):
// what that page focuses by itself belongs to this act.
export const opened = () => { nav = seq; };
export const openedAt = () => nav;

// The owner has the keyboard on a control they went to, or used, after the act `since`
// (by default: at any time).
export function ownerHolds(since = -1): boolean {
  const at = document.activeElement;
  return !!at && at !== document.body && !!held && held.el === at && held.seq > since;
}

// The element takes the keyboard by itself, unless the owner holds it elsewhere since the
// act this focus belongs to. Says whether it did.
export function selfFocus(el: HTMLElement | null | undefined, since = -1): boolean {
  if (!el || ownerHolds(since)) return false;
  self = true;
  try { el.focus(); } finally { self = false; }
  return document.activeElement === el;
}
