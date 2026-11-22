// A look: a session shown over a pane for now, while the pane still holds its
// own (lib/panes.ts has the rule). Here: leaving one, keeping one, and what
// leaving gives back. The pane shows its session again as it was left, and the
// keyboard goes back to where it last was in that pane.
//
// A pane's session going under something and coming back is told to the page
// as an event, for whoever keeps a place per session (the reading position):
//   keel:pane-swap  { session, slot, state: "covered" | "restored" | "left" }
// "covered": the pane's session went under a look or the start page and stays
// drawn there. "restored": it shows again. "left": it leaves the pane (sent
// while it is still in the page).
//
// Escape. In a pane that shows a look Escape always goes back and never stops
// a turn (Stop is a labeled button there); on a card of the look it is the
// card's own key. In a pane with no look Escape stops the working turn, as
// everywhere. Between the two: the press that follows a pane being uncovered
// (a look left, the start page left, the return after an answer) never stops
// that pane's turn, and no press does within the settle time of it. It says
// "Esc again stops the turn" at the box and does nothing else; anything else
// the owner does in between ends that, and Escape is Stop again.
import { useSyncExternalStore } from "react";
import { announce } from "./announce.ts";
import { SETTLE_MS } from "./approvals.ts";
import { getStations, paneOf, stations, target, useStations } from "./stations.ts";
import { getState, useStore } from "./store.ts";
import { tipSay } from "./tips.ts";
import { getUI, navigate } from "./ui.ts";
import { useSessionStates } from "./watch.ts";

export type PaneSwap = { session: string; slot: number; state: "covered" | "restored" | "left" };
export const tellSwap = (detail: PaneSwap): void => {
  if (detail.state === "restored") uncovered(detail.session);
  dispatchEvent(new CustomEvent<PaneSwap>("keel:pane-swap", { detail }));
};

const helm = () => { const r = getUI().route; return r.name === "session" ? r.id : null; };
const DESK = "(min-width: 768px)";
const BOX = '[data-testid="composer"]';
// Not under a view that lies over it (those are inert).
const live = (el: Element | null | undefined): el is HTMLElement => el instanceof HTMLElement && el.isConnected && !el.closest("[inert]") && el.getClientRects().length > 0;
const paneEl = (session: string) => document.querySelector<HTMLElement>(`[data-station="${CSS.escape(session)}"]`);
const boxIn = (session: string) => [...(paneEl(session)?.querySelectorAll<HTMLElement>(BOX) ?? [])].find(live);
const titleOf = (id: string) => getState().sessions[id]?.title || "New session";

// Where the keyboard last was in each session on screen.
const last = new Map<string, Element>();
// Looks opened from the start page (a row of what needs the owner): one that is answered leads back to its list.
const fromHome = new Set<string>();
// The panes' sessions that were uncovered, until the owner's next act that is not Escape.
const bare = new Map<string, { at: number; told: boolean }>();
if (typeof window !== "undefined") {
  addEventListener("focusin", (e) => {
    const el = e.target as Element;
    const id = el.closest<HTMLElement>("[data-station]")?.dataset.station;
    if (id) last.set(id, el);
  }, true);
  addEventListener("pointerdown", () => bare.clear(), true);
  addEventListener("keydown", (e) => { const k = (e as KeyboardEvent).key; if (k !== "Escape" && !["Shift", "Control", "Alt", "Meta"].includes(k)) bare.clear(); }, true);
}
// A pane's session shows again (said as it happens, and again when the page has drawn it).
export const uncovered = (session: string) => { if (!bare.has(session)) bare.set(session, { at: performance.now(), told: false }); };
// Escape was pressed to stop this session's turn: whether it is held (see the head of the
// file). A held press says how to stop, at the session's message box.
export function stopHeld(session: string): boolean {
  const b = bare.get(session);
  if (!b) return false;
  if (b.told && performance.now() - b.at >= SETTLE_MS) { bare.delete(session); return false; }
  b.told = true;
  tipSay(boxIn(session), "Esc again stops the turn", 2400);
  announce("Esc again stops the turn");
  return true;
}

// The look the owner is in: the session worked in, when it lies over a pane's own.
export function lookNow(): { id: string; slot: number; own: string } | null {
  const id = helm();
  const st = getStations();
  const slot = id ? st.over.indexOf(id) : -1;
  const own = st.slots[slot];
  return id && own ? { id, slot, own } : null;
}
// The session a pane shows again when the start page over it is left, when the owner is on that page.
export function underHome(): string | null {
  const st = getStations();
  if (getUI().route.name !== "new" || st.slots.length < 2 || !matchMedia(DESK).matches) return null;
  const at = target(st);
  return st.over[at] ?? st.slots[at] ?? null;
}
// The start page over a pane is left: the pane shows what it showed.
export function leaveHome(): boolean {
  const id = underHome();
  if (!id) return false;
  uncovered(id);
  navigate({ name: "session", id });
  return true;
}
// Said by the page as a look is opened: whether the start page was what the owner looked from.
export const noteLook = (id: string, home: boolean) => { if (home) fromHome.add(id); else fromHome.delete(id); };

// The owner went to a pane themselves (a press in it, Tab into it, the keys that step
// through the panes): they are there to work, not to answer and leave.
let moved: { id: string; at: number } | null = null;
export const paneMove = (id: string) => { moved = { id, at: performance.now() }; };
export const movedTo = (id: string) => !!moved && moved.id === id && performance.now() - moved.at < 1000;

// The keyboard goes back to where it last was in the session's pane, else to its
// message box, as soon as the pane shows the session again (looked for on each
// frame, a few at most). Never onto an answer of a card (its own rule brings the
// keyboard there), and only from nothing or from a pane: a field elsewhere (the
// list's filter, a dialog) keeps it.
export function focusBack(session: string) {
  let frames = 0;
  const look = () => {
    const at = document.activeElement;
    if (!matchMedia(DESK).matches) return;
    if (at && at !== document.body && !at.closest("[data-station]")) return;
    const pane = paneEl(session);
    const was = last.get(session);
    const to = live(was) && pane?.contains(was) && !was.closest("[data-ask-card]") ? was : boxIn(session);
    if (!to) { if (++frames < 6) requestAnimationFrame(look); return; }
    if (to !== at) to.focus({ preventScroll: true });
  };
  look();
}

// A line said at a pane's foot for a few seconds, and to assistive technology in its turn.
type Note = { text: string; n: number };
let notes: Record<number, Note> = {};
const noteSubs = new Set<() => void>();
let said = 0;
export function paneSay(slot: number, text: string, ms = 4500) {
  const n = ++said;
  notes = { ...notes, [slot]: { text, n } };
  noteSubs.forEach((f) => f());
  announce(text);
  setTimeout(() => {
    if (notes[slot]?.n !== n) return;
    const { [slot]: _, ...rest } = notes;
    notes = rest;
    noteSubs.forEach((f) => f());
  }, ms);
}
export const usePaneNote = (slot: number | undefined): string | null =>
  useSyncExternalStore((f) => (noteSubs.add(f), () => void noteSubs.delete(f)), () => (slot === undefined ? null : notes[slot]?.text ?? null));

// Leaves a look: its pane shows the session it holds again. When the owner was
// in the look, they are in that session now, the keyboard where it was; the
// browser's Back does not lead to the look again. `answered`: it is left
// because what it asked was answered; one opened from the start page's list
// then leads back to that list, where the next one is. A look whose turn is
// still running says where it went.
export function leaveLook(id: string, answered = false): boolean {
  const st = getStations();
  const slot = st.over.indexOf(id);
  if (slot < 0) return false;
  const own = st.slots[slot] ?? null;
  const was = helm() === id;
  const home = fromHome.delete(id) && answered;
  const at = document.activeElement;
  const mine = !at || at === document.body || !!at.closest(`[data-station="${CSS.escape(id)}"]`);
  if (own) uncovered(own);
  stations.uncover(slot);
  if (getState().sessions[id]?.phase === "working") paneSay(slot, `${titleOf(id)} keeps working, in the list`);
  if (!was) return true;
  navigate(own && !home ? { name: "session", id: own } : { name: "new" }, true);
  if (own && !home && mine) focusBack(own);
  return true;
}
// Keeps a look: it is the pane's session from now on, in place of the one it lay over.
export function keepLook(id: string): boolean {
  const slot = getStations().over.indexOf(id);
  if (slot < 0) return false;
  fromHome.delete(id);
  stations.place(id, slot);
  return true;
}
// Opens a session the owner just made (started from the start page, forked, cloned) where
// they made it: it is that pane's session, since they mean to work in it. `from`: the
// session it was made from, whose pane it takes; else the pane the start page showed in.
// The pane's former session goes back to the list, as it always did, and the pane says so
// once. A layout of one pane turns the page, and a phone has pages.
export function openPlaced(id: string, from?: string) {
  const st = getStations();
  if (st.slots.length > 1 && matchMedia(DESK).matches) {
    const at = from ? paneOf(st, from) : -1;
    const slot = at >= 0 ? at : target(st);
    const was = st.slots[slot];
    stations.place(id, slot);
    if (was && was !== id) paneSay(slot, `${titleOf(was)} is in the list`);
  }
  navigate({ name: "session", id });
}

// What a click on the row the pointer or the keys are on will do to a pane: said on that
// pane, in a store of its own so that moving over the list draws nothing but the tab.
export type Aim = "here" | "back" | "fill" | "look";
export const AIMS: Record<Aim, string> = { here: "Is here", back: "Comes back here", fill: "Opens here", look: "Opens here for a look" };
let aim: { slot: number; how: Aim } | null = null;
const aimSubs = new Set<() => void>();
export function setAim(next: { slot: number; how: Aim } | null) {
  if (aim?.slot === next?.slot && aim?.how === next?.how) return;
  aim = next;
  aimSubs.forEach((f) => f());
}
const onAim = (f: () => void) => (aimSubs.add(f), () => void aimSubs.delete(f));
export const useAim = (slot: number | undefined): Aim | null => useSyncExternalStore(onAim, () => (slot !== undefined && aim?.slot === slot ? aim.how : null));
export const useAimed = () => useSyncExternalStore(onAim, () => aim);

// The sessions that need the owner while they are under a look (their pane shows
// another session for now): for whoever sums up what waits, so that none of it is
// counted as on screen.
export function useNeedUnderLooks(): string[] {
  const slots = useStations((s) => s.slots);
  const over = useStations((s) => s.over);
  const sessions = useStore((s) => s.sessions);
  const under = slots.filter((id, i): id is string => !!id && !!over[i] && !!sessions[id]);
  const states = useSessionStates(under.map((id) => sessions[id]!));
  return under.filter((id) => states[id]?.watch === "need");
}
