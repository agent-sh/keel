// The one rule for every card that waits on the owner above a message box
// (an approval, a question, a plan, a secret) and for every way the keyboard
// gets to it (the card appearing, the key that goes to what waits, a step of
// the answering sequence, a link, a row of a list, a restart): an answer is
// given only for what the owner could read, by a key the owner meant.
//
// - A card is a unit (`data-ask-card`). Code puts the keyboard on a region of
//   it (`data-ask`, or any part with tabIndex -1: its text or frame), never
//   on a control that answers. The control is one deliberate key away (Tab
//   or an arrow), or the page brings the keyboard there itself once the card
//   was read (pageFocus): that is an arrival too, with its own settle time.
// - Every focus that lands in a unit and was not made by the owner's own Tab,
//   or by their press on the unit, is an arrival by code, whoever made it. A
//   key answers nothing within the settle time of it, in any pane layout.
// - A key repeat never answers, and nothing answers under a dialog or a menu.
// - What the owner was typing in a message box when a card took the keyboard
//   goes on into that box, whole and in order. Any other key the card does not
//   take types nothing: a key meant for a card never becomes a message. A
//   card's own typing keys (a number that picks an option) act only once the
//   owner put the keyboard there.
// - A card takes the keyboard only in the pane worked in, from that pane's
//   empty message box or from nothing.
// - A message box is held to the same rule from the other side: Enter sends
//   nothing from a box that code moved the keyboard to from a card (the card
//   left, it was answered elsewhere, the keys went on to another pane) within
//   the settle time, until the owner types in it or presses it: an Enter
//   meant for the card's answer does not send what the box holds. And a move
//   the answering sequence makes never puts the keyboard in a message box.
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { KEY_MS, SETTLE_MS } from "./approvals.ts";
import { inPopup, overlayOver } from "./overlay.ts";
import { tipSay } from "./tips.ts";

const UNIT = "[data-ask-card]";
const REGION = "[data-ask]";
// A popup that is a card's own, drawn outside it (the grant of an approval).
const PART = "[data-ask-part]";
// How long after a Tab or a press a focus is still that key's or press's own.
const ACT_MS = 100;

// How a unit got the keyboard: when, whether code moved it there, whether that
// was a move to the card as a thing to answer next (`take`: takeKeys that did
// not ask to rest on the region, not a control handing the focus back), and
// whether the owner put it there (their own Tab, arrow or press, or a key or
// link that goes to what waits).
// `painted`: when the frame that showed the arrival was painted (0: not yet). A key answers only once
// it went down KEY_MS after that (lib/approvals.ts): sooner, it may have been on its way before.
// `key`: when a key last pressed on the unit was refused. The key settle time runs again from it: a
// press sooner than KEY_MS after one that was refused is part of the same run of presses, which began
// before the owner saw what is there now (a hand that hammers Enter as cards come never answers one;
// a press after a pause does).
type Hold = { at: number; code: boolean; take: boolean; own: boolean; painted?: number; key?: number };
const holds = new WeakMap<Element, Hold>();
let current: Element | null = null; // the unit the keyboard is in
let moving: { own: boolean; take: boolean; painted?: number } | null = null; // set while takeKeys moves the focus
let tabbed = -Infinity; // the owner's last Tab
let pressed: { at: number; unit: Element | null; box: Element | null } = { at: -Infinity, unit: null, box: null }; // their last press, and the unit or the message box it was on
let last: Element | null = null; // the unit the focus was last given to (null: something that is no card)
let version = 0;
const subs = new Set<() => void>();
const changed = () => { version++; subs.forEach((f) => f()); };
const unitOf = (el: Element | null | undefined) => el?.closest(UNIT) ?? null;
// `run`: the key settle time runs again from a key refused (Hold.key). Not for a key that only opens
// a way to answer (Escape opens the denial's reason): there the arrival alone counts.
const settledAt = (h: Hold | undefined | null, run = true) => !h || ((!h.code || (!!h.painted && performance.now() - h.painted >= KEY_MS)) && (!run || !h.key || performance.now() - h.key >= KEY_MS));
// When the key settle time of a hold ends (0: it has not begun, the arrival is not painted yet).
const readyAt = (h: Hold) => (h.code && !h.painted ? 0 : Math.max(h.code ? h.painted! + KEY_MS : 0, h.key ? h.key + KEY_MS : 0));
// Stamps a hold with the paint of the frame that showed it: from a task posted in the frame's
// callback, which runs after that frame was painted.
const stamp = (h: Hold) => {
  if (typeof requestAnimationFrame === "undefined") { h.painted = h.at; return; }
  requestAnimationFrame(() => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); if (!h.painted) { h.painted = performance.now(); changed(); } };
    ch.port2.postMessage(0);
  });
};
const hold = (unit: Element, h: Hold) => { holds.set(unit, h); if (h.code) stamp(h); return h; };
// The message boxes the keyboard was moved to by code from a card, and when (boxRefused).
const BOX = '[data-testid="composer"]';
// Of what a pane draws, only what is on top: a session under a look or the start page stays drawn, out of reach (components/Bridge.tsx).
const ON_TOP = ":not([inert] *)";
const isBox = (el: EventTarget | null): el is HTMLTextAreaElement => el instanceof HTMLTextAreaElement && el.matches(BOX);
const boxes = new WeakMap<Element, number>();
let place: Element | null = null; // where in the page the keyboard last was: a message box, a card, or another element (not a popup)
let theirs = false; // set while a key of the owner's that names a box moves the keyboard to it (ownFocus)
// The session whose card the answering sequence is moving the keyboard to, or is on (setSequence).
let bound: string | null = null;

if (typeof window !== "undefined") {
  addEventListener("focusin", (e) => {
    // A message box: code moved the keyboard to it from a card (where it last was in the page), or
    // the owner's own Tab, press on it or key that names it brought it there.
    if (isBox(e.target)) {
      const now = performance.now();
      if (!place?.matches(UNIT) || theirs || now - tabbed <= ACT_MS || (pressed.box === e.target && now - pressed.at <= ACT_MS)) boxes.delete(e.target);
      else boxes.set(e.target, now);
    }
    const unit = unitOf(e.target as Element);
    if (!inPopup(e.target as Element)) place = isBox(e.target) ? e.target : unit ?? (e.target as Element);
    const from = (e as FocusEvent).relatedTarget as Node | null;
    // In a popup that is the card's own the keyboard is still with that card: it has not left
    // it, and coming back from the popup (the owner closed it) is no arrival.
    if (!unit && last && (e.target as Element).closest?.(PART)) { current = null; return changed(); }
    const was = last;
    last = current = unit;
    // The focus moved inside the card: no arrival.
    if (!unit || (!moving && from && unit.contains(from))) return changed();
    const now = performance.now();
    if (moving) hold(unit, { at: now, code: true, take: moving.take, own: moving.own, ...(moving.painted ? { painted: moving.painted } : {}) });
    // The owner's own Tab, or their press on the card, brought it.
    else if (now - tabbed <= ACT_MS || (pressed.unit === unit && now - pressed.at <= ACT_MS)) holds.set(unit, { at: now, code: false, take: false, own: true });
    // Back from nothing in the card the keyboard was last in (the part that held it went away: a
    // field the owner closed, an answer they gave, the window they came back to): the same stay.
    else if ((!from || (from as Element).closest?.(PART)) && was === unit && holds.has(unit)) return changed();
    else hold(unit, { at: now, code: true, take: false, own: holds.get(unit)?.own ?? false });
    changed();
  }, true);
  addEventListener("focusout", (e) => {
    if (!current || current.contains((e as FocusEvent).relatedTarget as Node | null)) return;
    current = null;
    changed();
  }, true);
  addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Tab") tabbed = performance.now();
    // A key that moves through the card is the owner's: from then on the card is theirs.
    // (Not one pressed as the keyboard arrived: it was on its way somewhere else.)
    const unit = unitOf(e.target as Element);
    const h = unit && holds.get(unit);
    if (h && !h.own && (e.key === "Tab" || e.key.startsWith("Arrow")) && settledAt(h)) { h.own = true; changed(); }
  }, true);
  addEventListener("pointerdown", (e) => {
    const unit = unitOf(e.target as Element);
    const box = (e.target as Element).closest?.(".k-box")?.querySelector(BOX) ?? null;
    pressed = { at: performance.now(), unit, box };
    // A press on the message box makes the keyboard there the owner's.
    if (box) boxes.delete(box);
    // A press on the card the keyboard is in makes it the owner's, as if their press had brought it.
    if (unit?.contains(document.activeElement)) { holds.set(unit, { at: pressed.at, code: false, take: false, own: true }); changed(); }
  }, true);
  // What the owner types into a message box makes the keyboard there theirs.
  addEventListener("input", (e) => { if (isBox(e.target)) boxes.delete(e.target); }, true);
}

// The owner's own key names an element (the command that goes to the message
// box, Escape from a row of the conversation, a typed character on its way to
// the box): the keyboard goes there as theirs, with no settle time.
export function ownFocus(el: HTMLElement | null | undefined, scroll = false) {
  theirs = true;
  try { el?.focus({ preventScroll: !scroll }); } finally { theirs = false; }
}
// Why Enter in a message box sends nothing now, or "" when it may: not within
// the settle time of code moving the keyboard to the box from a card. (A held
// Enter sends nothing either: the box drops those itself.)
export const boxRefused = (box: Element | null): string => {
  const at = box ? boxes.get(box) : undefined;
  return at !== undefined && performance.now() - at < SETTLE_MS ? "Not yet: the keyboard has only just arrived" : "";
};
// The answering sequence (components/AnswerQueue.tsx) says which session's
// card it is bringing the keyboard to, or is on. While it does, no message
// box takes the keyboard by code: not that session's as its pane opens or
// takes the helm, and none when a card that was answered leaves. The sequence
// puts the keyboard where it goes next, or in the box when it ends (restInBox).
export const setSequence = (session: string | null) => { bound = session; };
export const sequenceAt = (): string | null => bound;
// The keyboard goes to a session's message box when nothing holds it (at a
// desk; on a phone that would raise the keyboard).
export function restInBox(session: string) {
  const at = document.activeElement;
  if ((at && at !== document.body && at.isConnected) || !matchMedia("(min-width: 768px)").matches) return;
  document.querySelector<HTMLElement>(`[data-station="${CSS.escape(session)}"] ${BOX}${ON_TOP}`)?.focus({ preventScroll: true });
}

// The keyboard has been in the element's card for the settle time, or the owner brought it there themselves.
export const keysSettled = (el: Element | null): boolean => settledAt(holds.get(unitOf(el)!));
// The keyboard's arrival on the unit was painted a key's settle time ago, whatever keys were refused since.
export const keysArrived = (el: Element | null): boolean => settledAt(holds.get(unitOf(el)!), false);
// The owner put the keyboard on the element's card.
export const owned = (el: Element | null): boolean => !!holds.get(unitOf(el)!)?.own;

// Code moves the keyboard to a card: onto `target` when that is a part of the
// card that answers nothing (it carries tabIndex -1), else onto the card's
// region. `own`: the owner asked for it (the key that goes to what waits, a
// link, a row of a list); the settle time still runs from the arrival.
// `advance`: the card may move the keyboard on to its answer after the settle
// time (an approval's Allow once); false where the keyboard is to rest on the
// region, for a request that is to be read here first.
// Nothing moves under a dialog or a menu, or into a pane something covers.
export function takeKeys(target: Element | null, own: boolean, advance = true): boolean {
  const unit = unitOf(target);
  if (!unit) return false;
  const named = target instanceof HTMLElement && target.getAttribute("tabindex") === "-1" ? target : null;
  const region = named ?? (unit.matches(REGION) ? (unit as HTMLElement) : unit.querySelector<HTMLElement>(REGION));
  if (!region || overlayOver(region) || region.closest("[inert]")) return false;
  if (unit.contains(document.activeElement)) {
    // Already in the card. Asked for by the owner, it is an arrival all the same: the settle
    // time runs again. Only a part asked for by name takes the keyboard from another part.
    if (own) { hold(unit, { at: performance.now(), code: true, take: advance, own: true }); changed(); }
    if (named && named !== document.activeElement) named.focus({ preventScroll: true });
    return true;
  }
  moving = { own, take: advance };
  try { region.focus({ preventScroll: true }); } finally { moving = null; }
  return document.activeElement === region;
}

// The page moves the keyboard by itself onto a part of a card that answers (an approval's Allow
// once, once its text was read; a plan's Approve, once it stood whole): an arrival made by code, for
// what the owner did with the card (their own Tab or arrow is kept). It keeps the time the card's
// own arrival was painted: the move shows nothing new, and the card was on screen for a key's
// settle time from then before the move is made (no key that went down sooner answers it).
export function pageFocus(el: HTMLElement | null | undefined) {
  const unit = unitOf(el);
  if (!el || !unit) return;
  const was = holds.get(unit);
  moving = { own: was?.own ?? false, take: false, painted: was?.code ? was.painted : undefined };
  try { el.focus({ preventScroll: true }); } finally { moving = null; }
}

// May a card take the keyboard by itself as it appears? Only in the pane
// worked in, from that pane's empty message box or from nothing at all: never
// out of another pane, a field the owner types in, or a card they are on. A
// card that stands before one of its pane which took the keyboard a moment
// ago (and nothing was done there) takes it over: cards are drawn as their
// parts load, and the first of a pane is the one to answer.
export function mayTake(unit: Element | null): boolean {
  if (!unit || overlayOver(unit) || unit.closest("[inert]")) return false;
  const pane = unit.closest("[data-station]");
  if (pane && !pane.hasAttribute("data-helm")) return false;
  const at = document.activeElement;
  if (!at || at === document.body) return true;
  if (at instanceof HTMLTextAreaElement && at.dataset.testid === "composer") return at.value === "" && at.closest("[data-station]") === pane;
  const other = unitOf(at);
  if (!other || other === unit || !at.matches(REGION) || other.closest("[data-station]") !== pane) return false;
  const h = holds.get(other);
  return !!h && h.code && !h.own && !!(unit.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING);
}

// Why a key press on a control that answers does nothing now, or "" when it
// may answer. `repeat` is the key event's; a press that comes as a click
// (Enter or Space on a button) has none: the card drops those repeats on
// their way down (dropRepeats).
export function keyRefused(control: Element | null, repeat = false): string {
  if (repeat) return "A held key answers nothing";
  if (overlayOver(control)) return "Not while something lies over it";
  const h = holds.get(unitOf(control)!);
  if (!keysSettled(control)) { const soon = !!h?.key && performance.now() - h.key < KEY_MS; keyTried(control); return soon ? "Not yet: one key at a time" : "Not yet: the keyboard has only just arrived"; }
  return "";
}
// A key pressed on a card that the card refused (its text not read, its answer not standing yet, the
// keyboard only just arrived): the key settle time runs again from it (Hold.key).
export function keyTried(el: Element | null) {
  const h = holds.get(unitOf(el)!);
  if (!h) return;
  h.key = performance.now();
  changed();
}
// For a card's onKeyDownCapture: a held Enter presses nothing in it, and a held
// Space no control (in a field of the card a held Space still types).
export const dropRepeats = (e: { key: string; repeat: boolean; target: EventTarget | null; preventDefault: () => void; stopPropagation: () => void }) => {
  if (!e.repeat || (e.key !== "Enter" && e.key !== " ")) return;
  const t = e.target as HTMLElement;
  if (e.key === " " && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  e.preventDefault();
  e.stopPropagation();
};

// A typed key that is not the card's own goes to the message box of the
// card's pane: the box takes the keyboard as the key goes down, so the
// character lands in it and what follows is typed there, in order. Letters
// and digits always (a card with digits of its own takes them first); Space
// while the card holds the keyboard by itself, or within the settle time of
// its arrival (once the owner put it there and it has settled, Space presses
// the control it is on): a key that would be refused is typed on, so that
// either all of what is typed reaches the box or none. Returns whether the
// key was sent on.
// Only a run of typing goes on into the box: one the owner was making in a message box when the
// card took the keyboard (a key in it within the settle time before the arrival). Any other key
// the card does not take was pressed for the card (a number for a question, a key meant for the
// card before): it types nothing anywhere, so it can never become a message, and the card says so.
// Its settle time runs again from that key, and the page no longer moves the keyboard onto an answer
// for this arrival: an Enter behind it answers nothing until the owner goes to the answer themselves.
export function typeToBox(e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; target: EventTarget | null; currentTarget: EventTarget | null; preventDefault?: () => void }): boolean {
  const t = e.target as HTMLElement;
  if (e.altKey || e.ctrlKey || e.metaKey || e.key.length !== 1) return false;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return false;
  if (e.key === " " && owned(t) && keysSettled(t)) return false;
  const box = (e.currentTarget as HTMLElement).closest(".k-session")?.querySelector<HTMLElement>(BOX);
  if (!box) return false;
  const h = holds.get(unitOf(t)!);
  if (h && boxTyped < h.at - SETTLE_MS) {
    e.preventDefault?.();
    // The owner's hands are not on what is shown: the card's settle time runs again from this key,
    // and the page no longer brings the keyboard onto an answer by itself. One that has it gives it
    // back to the card's region: the owner goes to the answer themselves (Down, or Tab).
    const unit = unitOf(t)!;
    hold(unit, { ...h, at: performance.now(), code: true, take: false, painted: 0 });
    if (t.matches(ANSWER)) {
      const region = unit.matches(REGION) ? (unit as HTMLElement) : unit.querySelector<HTMLElement>(REGION);
      moving = { own: h.own, take: false };
      try { region?.focus({ preventScroll: true }); } finally { moving = null; }
    }
    changed();
    tipSay(unitOf(t) as HTMLElement | null, "Nothing typed: this request has the keyboard", SETTLE_MS * 2);
    return true;
  }
  ownFocus(box);
  return document.activeElement === box;
}
// The controls of a card that answer it.
const ANSWER = '[data-testid="allow-once"], [data-testid="allow-always"], [data-testid="plan-approve"]';
// When a key last typed into a message box (a run of typing a card may take on into the box).
let boxTyped = -Infinity;
if (typeof window !== "undefined") addEventListener("input", (e) => { if (isBox(e.target)) boxTyped = performance.now(); }, true);

// What the owner answered from this page, by the id of the request (an
// approval, a question's call, a plan): the answering sequence moves on only
// after one of these, never because a card left for another reason (an answer
// from another device, a stop, a grant).
const answered = new Set<string>();
export const noteAnswer = (...ids: string[]) => { for (const id of ids) answered.add(id); };
export const answeredHere = (id: string) => answered.has(id);

// For a card: how its unit holds the keyboard now ("" not at all, "wait"
// within the settle time of an arrival by code, "ready" after it), whether
// it was brought to the card to answer it (`take`), when it arrived (`at`) and
// whether the owner put it there. The card draws again when that changes and
// when the settle time runs out.
export function useHold(unit: RefObject<Element | null>): { keys: "" | "wait" | "ready"; own: boolean; take: boolean; at: number; key: number } {
  useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => version);
  const el = unit.current;
  const h = el ? holds.get(el) : undefined;
  const held = !!el && el === current && el.contains(document.activeElement);
  // (Not painted yet: the stamp itself draws the card again.)
  const wait = held && h ? readyAt(h) - performance.now() : 0;
  useEffect(() => {
    if (wait <= 0) return;
    const t = window.setTimeout(changed, wait + 1);
    return () => window.clearTimeout(t);
  }, [wait > 0, h?.at, h?.key]);
  return { keys: !held ? "" : settledAt(h) ? "ready" : "wait", own: held && !!h?.own, take: held && !!h?.take, at: h?.at ?? 0, key: h?.key ?? 0 };
}

// A card that takes the keyboard as it appears (`take`: it is the first of
// its kind in the pane), onto its region, when mayTake allows. When the card
// leaves while it held the keyboard, the pane's message box gets it (at a
// desk; on a phone that would raise the keyboard), unless the answering
// sequence is on: then the sequence moves the keyboard. An answer disables
// the card's controls and the browser then takes the focus off them: set
// `held` as the answer is sent.
export function useAskKeys(unit: RefObject<HTMLElement | null>, take = true) {
  const held = useRef(false);
  useEffect(() => {
    if (take && mayTake(unit.current)) takeKeys(unit.current, false);
  }, [take]);
  useLayoutEffect(() => () => {
    const a = document.activeElement;
    if (!unit.current?.contains(a) && !(held.current && (!a || a === document.body))) return;
    const box = unit.current?.closest(".k-session")?.querySelector<HTMLElement>(BOX);
    queueMicrotask(() => {
      const now = document.activeElement;
      if (!bound && (!now || now === document.body || !now.isConnected) && matchMedia("(min-width: 768px)").matches) box?.focus({ preventScroll: true });
    });
  }, []);
  return held;
}

// The keyboard goes to what `find` returns once the page shows it and nothing
// lies over it (a few seconds at most: a pane may still be drawing, a dialog
// closing). Two frames after it shows, so that of several cards drawn one
// after another the first in the pane is the one found. The wait ends when the
// owner's hands go elsewhere meanwhile: a press, a key in a field, a key that
// moves (Tab, Escape) or a command key. Not a plain key pressed on nothing: an
// Enter pressed again right after an answer was aimed at where the keyboard
// was, and the move goes on (the key answers nothing: the settle time runs
// from the arrival). `otherwise` is run when the time is up and nothing took
// the keyboard.
export function keysWhenShown(find: () => Element | null, own: boolean, otherwise?: () => void) {
  let raf = 0, seen = 0, taken: Element | null = null, at = 0;
  const stop = () => { cancelAnimationFrame(raf); clearTimeout(t); removeEventListener("keydown", key, true); removeEventListener("pointerdown", stop, true); };
  const key = (e: KeyboardEvent) => {
    const on = e.target as HTMLElement | null;
    const field = !!on && (on.tagName === "INPUT" || on.tagName === "TEXTAREA" || on.tagName === "SELECT" || on.isContentEditable);
    if (field || e.altKey || e.ctrlKey || e.metaKey || e.key === "Tab" || e.key === "Escape") stop();
  };
  const look = () => {
    const el = find();
    seen = el ? seen + 1 : 0;
    // Taken: watched for the settle time more, in case a card that stands before it is drawn late.
    if (taken && performance.now() - at > SETTLE_MS) return stop();
    if (el && seen > 2 && unitOf(el) !== taken && takeKeys(el, own)) { taken = unitOf(el); at = performance.now(); }
    raf = requestAnimationFrame(look);
  };
  const t = setTimeout(() => { stop(); if (!taken) otherwise?.(); }, 4000);
  addEventListener("keydown", key, true);
  addEventListener("pointerdown", stop, true);
  raf = requestAnimationFrame(look);
}
// The first thing that waits above a session's message box.
export const askIn = (session: string) => document.querySelector<HTMLElement>(`[data-station="${CSS.escape(session)}"] [data-testid="composer-asks"] ${REGION}${ON_TOP}`);
// The keyboard goes to it (the owner asked: `own`), once it shows. A session
// that shows nothing to answer in time gets the keyboard in its message box.
export const focusAsk = (session: string) => keysWhenShown(() => askIn(session), true, () => restInBox(session));
