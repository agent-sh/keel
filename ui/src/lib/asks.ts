// The one rule for every card that waits on the owner above a message box
// (an approval, a question, a plan, a secret) and for every way the keyboard
// gets to it (the card appearing, the key that goes to what waits, a step of
// the answering sequence, a link, a row of a list, a restart): an answer is
// given only for what the owner could read, by a key the owner meant.
//
// - A card is a unit (`data-ask-card`). Code puts the keyboard on a region of
//   it (`data-ask`, or any part with tabIndex -1: its text or frame), never
//   on a control that answers. The control is one deliberate key away (Tab
//   or an arrow).
// - Every focus that lands in a unit and was not made by the owner's own Tab,
//   or by their press on the unit, is an arrival by code, whoever made it. A
//   key answers nothing within the settle time of it, in any pane layout.
// - A key repeat never answers, and nothing answers under a dialog or a menu.
// - What is typed while a card holds the keyboard goes to the message box of
//   the card's pane, whole and in order. A card's own typing keys (a number
//   that picks an option) act only once the owner put the keyboard there.
// - A card takes the keyboard only in the pane worked in, from that pane's
//   empty message box or from nothing.
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { SETTLE_MS } from "./approvals.ts";
import { overlayOver } from "./overlay.ts";

const UNIT = "[data-ask-card]";
const REGION = "[data-ask]";
// How long after a Tab or a press a focus is still that key's or press's own.
const ACT_MS = 100;

// How a unit got the keyboard: when, whether code moved it there, whether that
// was a move to the card as a thing to answer next (`take`: takeKeys that did
// not ask to rest on the region, not a control handing the focus back), and
// whether the owner put it there (their own Tab, arrow or press, or a key or
// link that goes to what waits).
type Hold = { at: number; code: boolean; take: boolean; own: boolean };
const holds = new WeakMap<Element, Hold>();
let current: Element | null = null; // the unit the keyboard is in
let moving: { own: boolean; take: boolean } | null = null; // set while takeKeys moves the focus
let tabbed = -Infinity; // the owner's last Tab
let pressed: { at: number; unit: Element | null } = { at: -Infinity, unit: null }; // their last press, and the unit it was on
let last: Element | null = null; // the unit the focus was last given to (null: something that is no card)
let version = 0;
const subs = new Set<() => void>();
const changed = () => { version++; subs.forEach((f) => f()); };
const unitOf = (el: Element | null | undefined) => el?.closest(UNIT) ?? null;
const settledAt = (h: Hold | undefined | null) => !h || !h.code || performance.now() - h.at >= SETTLE_MS;

if (typeof window !== "undefined") {
  addEventListener("focusin", (e) => {
    const unit = unitOf(e.target as Element);
    const from = (e as FocusEvent).relatedTarget as Node | null;
    const was = last;
    last = current = unit;
    // The focus moved inside the card: no arrival.
    if (!unit || (!moving && from && unit.contains(from))) return changed();
    const now = performance.now();
    if (moving) holds.set(unit, { at: now, code: true, take: moving.take, own: moving.own });
    // The owner's own Tab, or their press on the card, brought it.
    else if (now - tabbed <= ACT_MS || (pressed.unit === unit && now - pressed.at <= ACT_MS)) holds.set(unit, { at: now, code: false, take: false, own: true });
    // Back from nothing in the card the keyboard was last in (the part that held it went away: a
    // field the owner closed, an answer they gave, the window they came back to): the same stay.
    else if (!from && was === unit && holds.has(unit)) return changed();
    else holds.set(unit, { at: now, code: true, take: false, own: holds.get(unit)?.own ?? false });
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
    pressed = { at: performance.now(), unit };
    // A press on the card the keyboard is in makes it the owner's, as if their press had brought it.
    if (unit?.contains(document.activeElement)) { holds.set(unit, { at: pressed.at, code: false, take: false, own: true }); changed(); }
  }, true);
}

// The keyboard has been in the element's card for the settle time, or the owner brought it there themselves.
export const keysSettled = (el: Element | null): boolean => settledAt(holds.get(unitOf(el)!));
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
    if (own) { holds.set(unit, { at: performance.now(), code: true, take: advance, own: true }); changed(); }
    if (named && named !== document.activeElement) named.focus({ preventScroll: true });
    return true;
  }
  moving = { own, take: advance };
  try { region.focus({ preventScroll: true }); } finally { moving = null; }
  return document.activeElement === region;
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
  if (!keysSettled(control)) return "Not yet: the keyboard has only just arrived";
  return "";
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
// while the card holds the keyboard by itself (once the owner put it there,
// Space presses the control it is on). Returns whether the key was sent on.
export function typeToBox(e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; target: EventTarget | null; currentTarget: EventTarget | null }): boolean {
  const t = e.target as HTMLElement;
  if (e.altKey || e.ctrlKey || e.metaKey || e.key.length !== 1) return false;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return false;
  if (e.key === " " && owned(t)) return false;
  const box = (e.currentTarget as HTMLElement).closest(".k-session")?.querySelector<HTMLElement>('[data-testid="composer"]');
  if (!box) return false;
  box.focus({ preventScroll: true });
  return true;
}

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
export function useHold(unit: RefObject<Element | null>): { keys: "" | "wait" | "ready"; own: boolean; take: boolean; at: number } {
  useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => version);
  const el = unit.current;
  const h = el ? holds.get(el) : undefined;
  const held = !!el && el === current && el.contains(document.activeElement);
  const wait = held && h?.code ? h.at + SETTLE_MS - performance.now() : 0;
  useEffect(() => {
    if (wait <= 0) return;
    const t = window.setTimeout(changed, wait + 1);
    return () => window.clearTimeout(t);
  }, [wait > 0, h?.at]);
  return { keys: !held ? "" : settledAt(h) ? "ready" : "wait", own: held && !!h?.own, take: held && !!h?.take, at: h?.at ?? 0 };
}

// A card that takes the keyboard as it appears (`take`: it is the first of
// its kind in the pane), onto its region, when mayTake allows. When the card
// leaves while it held the keyboard, the pane's message box gets it (at a
// desk; on a phone that would raise the keyboard). An answer disables the
// card's controls and the browser then takes the focus off them: set `held`
// as the answer is sent.
export function useAskKeys(unit: RefObject<HTMLElement | null>, take = true) {
  const held = useRef(false);
  useEffect(() => {
    if (take && mayTake(unit.current)) takeKeys(unit.current, false);
  }, [take]);
  useLayoutEffect(() => () => {
    const a = document.activeElement;
    if (!unit.current?.contains(a) && !(held.current && (!a || a === document.body))) return;
    const box = unit.current?.closest(".k-session")?.querySelector<HTMLElement>('[data-testid="composer"]');
    queueMicrotask(() => {
      const now = document.activeElement;
      if ((!now || now === document.body || !now.isConnected) && matchMedia("(min-width: 768px)").matches) box?.focus({ preventScroll: true });
    });
  }, []);
  return held;
}

// The keyboard goes to what `find` returns once the page shows it and nothing
// lies over it (a few seconds at most: a pane may still be drawing, a dialog
// closing). Two frames after it shows, so that of several cards drawn one
// after another the first in the pane is the one found. The wait ends when the
// owner's hands go elsewhere meanwhile: a key or a press.
export function keysWhenShown(find: () => Element | null, own: boolean) {
  let raf = 0, seen = 0, taken: Element | null = null, at = 0;
  const stop = () => { cancelAnimationFrame(raf); clearTimeout(t); removeEventListener("keydown", stop, true); removeEventListener("pointerdown", stop, true); };
  const look = () => {
    const el = find();
    seen = el ? seen + 1 : 0;
    // Taken: watched for the settle time more, in case a card that stands before it is drawn late.
    if (taken && performance.now() - at > SETTLE_MS) return stop();
    if (el && seen > 2 && unitOf(el) !== taken && takeKeys(el, own)) { taken = unitOf(el); at = performance.now(); }
    raf = requestAnimationFrame(look);
  };
  const t = setTimeout(stop, 4000);
  addEventListener("keydown", stop, true);
  addEventListener("pointerdown", stop, true);
  raf = requestAnimationFrame(look);
}
// The first thing that waits above a session's message box.
export const askIn = (session: string) => document.querySelector<HTMLElement>(`[data-station="${CSS.escape(session)}"] [data-testid="composer-asks"] ${REGION}`);
// The keyboard goes to it (the owner asked: `own`), once it shows.
export const focusAsk = (session: string) => keysWhenShown(() => askIn(session), true);
