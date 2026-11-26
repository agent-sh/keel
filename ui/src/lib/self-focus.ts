// The one rule for a focus that code makes by itself, in both directions.
//
// Taking the keyboard: the message box as its page or its session opens, the
// button of a view that failed. Such a focus belongs to an act (the page
// loading, the navigation that opened the session) and may arrive long after
// it: the box is drawn when its session and its chunks are in. It takes the
// keyboard from nothing, and from the control the act was made on (the row
// pressed, the link). It never takes it from a control the owner went to
// after that act (their Tab, arrow or press, or a focus that came with no key
// or press at all, as a screen reader gives one), or used after it: typed in,
// or pressed a key the control answered. The key that opened a box is spent:
// what it would do by itself (Enter's new line) does not land in the box.
//
// Giving it back: when what held the keyboard goes away under the owner's
// hand (a pane closed, a session archived from its row, a panel or the
// palette closed) and nothing else takes it, it goes to the message box of
// the pane worked in, so that what is typed next goes somewhere. Not on a
// phone (no keyboard is raised unasked), not after a press on blank space
// (the owner put it nowhere), not under a dialog or a menu, and not where a
// card waits on the owner or an answering sequence is on: the cards have a
// rule of their own for the keyboard, and whoever keeps it can refuse the
// box here (`keepBoxOut`).
//
// A focus this rule made itself is never the owner's. A card that took the
// keyboard holds it here like a control the owner went to, so a message box
// drawn after it does not take it back.

import { DESK_QUERY } from "./phone.ts";
import { modalOpen, popupShown } from "./overlay.ts";

// How long after a key or a press a focus is still that key's or press's own.
const ACT_MS = 100;
// How long after a press on blank space a control going away is still that press's doing (a menu it dismissed).
const BLANK_MS = 600;
// How many frames a closing dialog or menu is waited for before the keyboard is left where it fell.
const CLOSE_FRAMES = 40;
const DESK = DESK_QUERY;
const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const CONTROL = 'a[href], button, input, textarea, select, summary, label, [tabindex], [contenteditable], [role="button"], [role="link"], [role="option"], [role="menuitem"], [role="tab"], [role="separator"]';
const POPUP = '[role="dialog"], [role="alertdialog"], [role="menu"]';
// Where the cards that wait on the owner stand, and a card itself.
const CARDS = '[data-testid="composer-asks"]';
const CARD = `${CARDS}, [data-ask-card]`;

type Hold = { el: Element; seq: number };
let seq = 0; // counts the owner's acts; 0 is the page loading
let input = -Infinity; // when their last key or press was
let blank = -Infinity; // when their last press on no control was
let key: KeyboardEvent | null = null; // their last key press (on its way while its eventPhase is not 0)
let held: Hold | null = null; // where the owner last put or used the keyboard, and in which act
let at: { el: Element; card: boolean } | null = null; // what has the keyboard, and whether it is part of a card
let self = false; // set while this rule moves the focus
let nav = 0; // the act that last opened a page or a session
let opener: Element | null = null; // the control that act was made on, while the keyboard has not left it
let check = 0; // the frame in which a fall of the keyboard is looked at
const vetoes = new Set<(pane: Element) => boolean>();

// The pane's message box is kept out of the keyboard: an answering sequence is on (its line
// above a box says so), or whoever asked to be asked says no.
const keptOut = (pane: Element) => !!document.querySelector('[data-testid="waiting-elsewhere"][data-on]') || [...vetoes].some((no) => no(pane));
const body = (el: Element | null) => !el || el === document.body || el === document.documentElement;
const take = (el: HTMLElement) => {
  self = true;
  try { el.focus(); } finally { self = false; }
  return document.activeElement === el;
};

// The fallback when a popup closes with no control to return to.
export function boxAfterClose(): HTMLElement | undefined {
  if (performance.now() - blank < BLANK_MS || !matchMedia(DESK).matches) return;
  const pane = document.querySelector(".k-station[data-helm]");
  const box = pane?.querySelector<HTMLElement>('[data-testid="composer"]:not([inert] *)');
  if (!pane || !box) return;
  const cards = pane.querySelector<HTMLElement>(CARDS);
  if ((cards && cards.childElementCount > 0 && cards.offsetHeight > 0) || keptOut(pane)) return;
  return box;
}

// The keyboard fell from `el` to nothing. Two frames later (whatever takes it by its own
// rule has done so by then), and once a closing dialog or menu is gone, the message box
// of the pane worked in takes it, if `el` went away and nothing above forbids it.
function fell(el: Element, card: boolean) {
  if (check) return;
  let frames = 0;
  const look = () => {
    check = 0;
    if (!body(document.activeElement)) return;
    // It is still there and can be used: the owner left it (a press on blank space), and it is not watched any more.
    if (el.isConnected && el.getClientRects().length > 0 && !(el as HTMLButtonElement).disabled) { watch(null); return; }
    if (card || performance.now() - blank < BLANK_MS || !matchMedia(DESK).matches) return;
    if ([...document.querySelectorAll(POPUP)].some(popupShown)) {
      if (++frames < CLOSE_FRAMES) check = requestAnimationFrame(look);
      return;
    }
    const box = boxAfterClose();
    if (box) take(box);
  };
  check = requestAnimationFrame(() => { check = requestAnimationFrame(look); });
}

// A focused element taken out of the page sends no event: the nodes above it are watched for it.
const gone = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
  if (at && !at.el.isConnected) fell(at.el, at.card);
});

// The panel and its focused control can be removed in the same render that makes
// the pane's composer interactive again. Use the closing control, not a transient
// focus event from the browser while the DOM is being changed.
export function panelClosing() {
  const el = document.activeElement;
  if (!el?.closest('[data-testid="side-panel"]')) return;
  requestAnimationFrame(() => {
    if (el.isConnected || !body(document.activeElement) || modalOpen()) return;
    const box = boxAfterClose();
    if (box) take(box);
  });
}
function watch(el: Element | null) {
  gone?.disconnect();
  for (let n = el?.parentNode; n && n !== document; n = n.parentNode) gone?.observe(n, { childList: true });
}

if (typeof window !== "undefined") {
  const act = () => { seq++; input = performance.now(); };
  const use = (el: Element) => { held = { el, seq }; };
  addEventListener("keydown", (e) => {
    act();
    key = e as KeyboardEvent;
    // A key in a control that takes typing is the owner using it.
    const t = e.target as Element | null;
    if (t?.matches?.(TYPING)) use(t);
  }, true);
  // So is a key the control answered (a key that did nothing there is on its way somewhere else).
  addEventListener("keydown", (e) => {
    const t = e.target as Element | null;
    if (e.defaultPrevented && t && !body(t) && t === document.activeElement) use(t);
  });
  addEventListener("pointerdown", (e) => {
    act();
    if (!(e.target as Element | null)?.closest?.(CONTROL)) blank = performance.now();
  }, true);
  addEventListener("focusin", (e) => {
    const el = e.target as Element;
    at = { el, card: !!el.closest(CARD) };
    watch(el);
    if (self) return;
    // With no key or press just before it, the focus is an act of its own.
    if (performance.now() - input > ACT_MS) seq++;
    use(el);
    if (el !== opener) opener = null;
  }, true);
  addEventListener("focusout", (e) => {
    if (!(e as FocusEvent).relatedTarget && at?.el === e.target) fell(at.el, at.card);
  }, true);
}

// The owner's act opens a page or a session (ui.ts calls it for every route change):
// what that page focuses by itself belongs to this act, and the control it was made on
// does not hold the keyboard against it.
export const opened = () => {
  nav = seq;
  opener = body(document.activeElement) ? null : document.activeElement;
};

// The owner has the keyboard on a control they went to, or used, after the act `since`
// (by default: at any time).
export function ownerHolds(since = -1): boolean {
  const on = document.activeElement;
  return !body(on) && !!held && held.el === on && held.seq > since;
}

// What shows by itself takes the keyboard, unless the owner has it on a control. Says whether it did.
export function selfFocus(el: HTMLElement | null | undefined): boolean {
  return !!el && !ownerHolds() && take(el);
}

// The box of the page or session the owner's last act opened takes the keyboard, unless
// they went to another control, or used one, since that act. Says whether it did.
export function openFocus(el: HTMLElement | null | undefined): boolean {
  if (!el || (document.activeElement !== opener && ownerHolds(nav))) return false;
  // A session an answering sequence opened: its card gets the keyboard, by the cards' rule.
  const pane = el.closest(".k-station");
  if (pane && keptOut(pane)) return false;
  // The key that opened it is spent (Enter on a row would leave a new line in the box).
  if (key && key.eventPhase !== 0 && !key.defaultPrevented) key.preventDefault();
  return take(el);
}

// Whoever keeps the keyboard out of a pane's message box for a time (an answering sequence)
// says so here: while `no(pane)` is true, the box takes the keyboard neither as its session
// opens nor when the keyboard falls to nothing.
export function keepBoxOut(no: (pane: Element) => boolean): () => void {
  vetoes.add(no);
  return () => { vetoes.delete(no); };
}
