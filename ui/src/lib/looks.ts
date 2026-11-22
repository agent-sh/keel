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
import { getStations, stations, target } from "./stations.ts";
import { getUI, navigate } from "./ui.ts";

export type PaneSwap = { session: string; slot: number; state: "covered" | "restored" | "left" };
export const tellSwap = (detail: PaneSwap): void => { dispatchEvent(new CustomEvent<PaneSwap>("keel:pane-swap", { detail })); };

const helm = () => { const r = getUI().route; return r.name === "session" ? r.id : null; };
const BOX = '[data-testid="composer"]';
// Not under a view that lies over it (those are inert).
const live = (el: Element | null | undefined): el is HTMLElement => el instanceof HTMLElement && el.isConnected && !el.closest("[inert]") && el.getClientRects().length > 0;

// Where the keyboard last was in each session on screen.
const last = new Map<string, Element>();
// Looks opened from the start page (a row of what needs the owner): one that is answered leads back to its list.
const fromHome = new Set<string>();
if (typeof window !== "undefined") {
  addEventListener("focusin", (e) => {
    const el = e.target as Element;
    const id = el.closest<HTMLElement>("[data-station]")?.dataset.station;
    if (id) last.set(id, el);
  }, true);
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
  if (getUI().route.name !== "new" || st.slots.length < 2 || !matchMedia("(min-width: 768px)").matches) return null;
  const at = target(st);
  return st.over[at] ?? st.slots[at] ?? null;
}
// Said by the page as a look is opened: whether the start page was what the owner looked from.
export const noteLook = (id: string, home: boolean) => { if (home) fromHome.add(id); else fromHome.delete(id); };

// The owner went to a pane themselves (a press in it, Tab into it, the keys that step
// through the panes): they are there to work, not to answer and leave.
let moved: { id: string; at: number } | null = null;
export const paneMove = (id: string) => { moved = { id, at: performance.now() }; };
export const movedTo = (id: string) => !!moved && moved.id === id && performance.now() - moved.at < 1000;

// The keyboard goes back to where it last was in the session's pane, else to its
// message box: two frames on, when the pane shows the session again. Never onto
// an answer of a card (its own rule brings the keyboard there), and only from
// nothing or from a pane: a field elsewhere (the list's filter, a dialog) keeps it.
export function focusBack(session: string) {
  const pane = () => document.querySelector<HTMLElement>(`[data-station="${CSS.escape(session)}"]`);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const at = document.activeElement;
    if (!matchMedia("(min-width: 768px)").matches) return;
    if (at && at !== document.body && !at.closest("[data-station]")) return;
    const was = last.get(session);
    const to = live(was) && pane()?.contains(was) && !was.closest("[data-ask-card]") ? was : [...(pane()?.querySelectorAll<HTMLElement>(BOX) ?? [])].find(live);
    if (to && to !== at) to.focus({ preventScroll: true });
  }));
}

// Leaves a look: its pane shows the session it holds again. When the owner was
// in the look, they are in that session now, the keyboard where it was; the
// browser's Back does not lead to the look again. `answered`: it is left
// because what it asked was answered; one opened from the start page's list
// then leads back to that list, where the next one is.
export function leaveLook(id: string, answered = false): boolean {
  const st = getStations();
  const slot = st.over.indexOf(id);
  if (slot < 0) return false;
  const own = st.slots[slot] ?? null;
  const was = helm() === id;
  const home = fromHome.delete(id) && answered;
  const at = document.activeElement;
  const mine = !at || at === document.body || !!at.closest(`[data-station="${CSS.escape(id)}"]`);
  stations.uncover(slot);
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
