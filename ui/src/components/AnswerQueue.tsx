// What waits on the owner across sessions, answered in sequence from one
// place. The order is every session whose state, as the daemon serves it,
// reads "needs you" (an approval, a question, a plan, a secret, a message
// that did not go), and every session a failure stopped that the owner has
// not looked at, in the order of the next-look queue: the costliest wait
// first, then the longest (lib/waiting.ts, lib/next-look.ts). One key goes
// to what waits: first to what the session on screen asks, then to the next
// session that waits, with the keyboard on its card above that session's
// message box (on the card, not on an answer: lib/asks.ts). That starts a
// sequence. While it is on, each answer the owner gives from this page moves
// on by itself: to what else waits in the same session, then to the next
// session, until nothing waits.
//
// The sequence is the owner's. It moves only after their own answer: a card
// that leaves because it was answered elsewhere or stopped ends it where it
// is. And it ends as soon as they do something else: go to another session or
// page, press outside the cards, type into a field that is not a card's,
// press Escape outside a card, or leave the window; and by itself after a
// quiet minute, saying so.
//
// A move the sequence makes never puts the keyboard in a message box, not for
// a frame: a key pressed again right after an answer would send what that box
// holds. The pane it moves to opens without its box taking the keyboard, and
// a card that was answered hands it to none (lib/asks.ts: setSequence). Where
// the sequence ends because nothing is left to answer here, the keyboard goes
// to the session's message box, as a move by code.
//
// Answering changes no pane. A session that waits and has no pane is shown as
// a look over the pane the sequence began in (lib/panes.ts), each in the place
// of the one before it, and when nothing is left the owner is back where they
// began: the same panes with the same sessions, the pane they were in, the
// keyboard where it was. The same holds without the sequence: a session that
// waits and that the owner went to from a list, a link or the palette (a look,
// or the pane beside that holds it) is one to answer and leave. Once they have
// answered all it asked they are back where they came from. Not when they went
// to its pane themselves (a press in it, the keys that step through the panes),
// and not once they began to read or work there: a press in that pane outside
// what it asks, a scroll of its conversation by the wheel or the keys, a
// selection in it, typing in its message box, or ten seconds spent there after
// the cards could be answered. Then they stay. And not in a layout of one pane,
// where opening a session turns the page: they turn it back.
//
// A phone is where the owner answers on the way: there an answer given in a
// session they came to goes on to the next session that waits, as a sequence
// would, and the last answer leads back where they came from. Time spent on a
// card does not make it reading there (a phone has no pane to read beside);
// a press outside what it asks, typing or a selection still does.
import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { announce } from "../lib/announce.ts";
import { SETTLE_MS } from "../lib/approvals.ts";
import { answeredByOneKey, answeredHere, askIn, focusAsk, restInBox, sequenceAt, setSequence } from "../lib/asks.ts";
import { isMac, registerCommand } from "../lib/keys.ts";
import { focusBack, leaveLook, movedTo } from "../lib/looks.ts";
import { getStations, opened, paneOf, stations } from "../lib/stations.ts";
import { usePlans } from "../lib/plans.ts";
import { useSafety } from "../lib/safety.ts";
import { useSecrets } from "../lib/secrets.ts";
import { unsentOf, useShelfVersion } from "../lib/send-drafts.ts";
import { getState, useStore } from "../lib/store.ts";
import { tipSay } from "../lib/tips.ts";
import { getUI, navigate, useUI, type Route } from "../lib/ui.ts";
import { keepBoxOut } from "../lib/self-focus.ts";
import { nextWaiting, waitingOrder } from "../lib/waiting.ts";
import { useSessionStates, useToldStates } from "../lib/watch.ts";
import { useAuto } from "../lib/automation.ts";
import { sessionCosts } from "../lib/next-look.ts";
import { cn } from "../lib/utils.ts";
import { Kbd } from "./Kbd.tsx";
import { Mark } from "./Mark.tsx";

const KEYS = "alt+a";
// A phone: one page at a time, answered on the way (see the head of the file).
const phone = () => matchMedia("(max-width: 767px)").matches;
// How long in a session that waits, once its cards can be answered, before the owner is taken to be reading it.
const READING_MS = 10_000;
// What a session asks: a press or a key there is on the way to an answer, not reading.
const ASKS = '[data-testid="composer-asks"], [data-ask-part]';
// The keys that scroll a conversation (from its rows, or from an empty message box).
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);
// How long the sequence stays on with nothing answered and no key or press on the cards.
const QUIET_MS = 60_000;
// What a session that needs the owner shows as a card above its message box (the daemon's `why`).
const CARDS = new Set(["approval", "question", "plan", "secret"]);
type State = {
  order: string[]; // the sessions that wait, the longest wait first
  above: Record<string, string[]>; // of those, the agents' sessions: the sessions above each, up to the one at the top of its tree
  card: Record<string, boolean>; // of those, the ones that wait with a card (not with a message that did not go)
  on: boolean; // a sequence is being answered
  at: string | null; // the session the sequence is on
};
let state: State = { order: [], above: {}, card: {}, on: false, at: null };
const subs = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; subs.forEach((f) => f()); };
const useQueue = <T,>(sel: (s: State) => T): T => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => sel(state));
const here = () => { const r = getUI().route; return r.name === "session" ? r.id : null; };
const say = (text: string) => { tipSay(null, text, 2400); announce(text); };
// Where the owner was when the sequence began: the page, and the pane worked in.
let origin: { route: Route; slot: number } | null = null;
// The session the owner went to because it waits, and where they came from (the page, and the
// pane worked in): answering what it asks leads back there.
let visit: { id: string; from: Route; slot: number } | null = null;
// The owner is back on a page they were on: a session that is still there, or the start page in the pane it was in.
function backTo(to: Route, slot: number): boolean {
  if (to.name === "session") {
    const s = getState().sessions[to.id];
    if (!s || s.archived) return false;
    navigate(to, true);
    focusBack(to.id);
    return true;
  }
  if (to.name !== "new") return false;
  stations.setActive(slot);
  navigate(to, true);
  return true;
}
// The look over a pane is put away without moving the owner: the sequence says where they go next.
const putAway = (id: string) => { const st = getStations(); const i = st.over.indexOf(id); if (i >= 0) stations.uncover(i); };

// The sequence goes to a session: its pane takes the helm and its card the
// keyboard, once it shows and nothing lies over it. Its message box takes
// none on the way (a session with no card to answer, only a message that did
// not go, is opened as any other: there the box is where the keyboard goes).
// `from`: where a sequence that begins here began, when that is not the page on screen.
// `gentle`: the step follows an answer one key gave by itself (lib/asks.ts, noteOneKey): an Enter
// pressed after it was meant for that answer, so the keyboard rests on the card, not on its Allow.
function go(id: string, from?: { route: Route; slot: number }, gentle = false) {
  const began = !state.on;
  if (began) origin = from ?? { route: getUI().route, slot: getStations().active };
  // Where it goes is known before the page moves: the move is the sequence's own.
  state = { ...state, on: true, at: id };
  setSequence(state.card[id] === false ? null : id);
  // A session with no pane is looked at over the pane the sequence began in, whichever pane it passed through since.
  const st = getStations();
  if (origin && paneOf(st, id) < 0 && !st.slots.includes(id) && st.slots[origin.slot]) stations.setActive(origin.slot);
  // One step back in the browser leaves the sequence, however many sessions it went through.
  if (here() !== id) navigate({ name: "session", id }, !began);
  set({});
  focusAsk(id, gentle);
}
// The owner goes to one session's card and answers it from there (a row's Answer button): the sequence's own way,
// so the answer leads back to where the owner was.
export const goToAsk = (id: string) => go(id);
const end = () => { setSequence(null); origin = null; if (state.on) set({ on: false, at: null }); };
// Nothing is left to answer: the owner is back where the sequence began, the keyboard where it was there.
// A sequence that began inside a look and ended in it leaves that look: it was answered.
function done(cur: string) {
  const from = origin;
  end();
  if (from && from.route.name === "session" && from.route.id === cur) { if (!leaveLook(cur, true)) restInBox(cur); return; }
  putAway(cur);
  if (!from || !backTo(from.route, from.slot)) restInBox(cur);
}
// The page's own rule for a focus it makes by itself (lib/self-focus.ts) is told the same: the
// message box of the session the sequence brings the keyboard to takes none, neither as its
// pane opens nor when what held the keyboard goes away.
keepBoxOut((pane) => sequenceAt() === (pane as HTMLElement).dataset.station);

// Goes to what waits on the owner and starts the sequence there: to what the
// session on screen asks when the keyboard is not on it yet, else to the next
// session that waits. With nothing waiting, it says so.
export function goNextWaiting() {
  const cur = here();
  const mine = cur ? askIn(cur) : null;
  if (cur && mine && !mine.closest("[data-ask-card]")?.contains(document.activeElement)) return go(cur);
  const next = nextWaiting(state.order, cur);
  if (next) return go(next);
  if (cur && mine) return go(cur);
  say("Nothing waits for you.");
}

// The next session that waits, from a session that waits itself (a finger's way: the line above its cards).
function goNextOther() {
  const next = nextWaiting(state.order, here());
  if (next) go(next);
  else say("Nothing else waits for you.");
}

// On a Mac, Option with a letter types a character (å, and on other layouts
// letters of the language): in a field the key stays the field's.
registerCommand({
  id: "next-waiting", label: "Go to the next session that needs you", group: "Sessions", keys: KEYS, inInput: () => !isMac,
  words: "answer approval question plan waiting attention jump needs sequence", run: goNextWaiting,
});

// Mounted once by the app: reads every session's word, keeps the order, and runs the sequence.
export function AnswerQueue() {
  const sessions = useStore((s) => s.sessions);
  const list = useMemo(() => Object.values(sessions).filter((s) => !s.archived), [sessions]);
  const states = useSessionStates(list);
  const approvals = useSafety((s) => s.approvals);
  const questions = useStore((s) => s.questionCalls);
  const plans = usePlans();
  const wanted = useSecrets((s) => s.requests);
  useShelfVersion();
  // What a session holds itself, by id (a request of its agent is the agent session's).
  const held = (id: string) => [...(approvals[id] ?? []).map((a) => a.id), ...(questions[id] ?? []), ...(plans[id] ?? []), ...(wanted[id] ?? []).map((r) => r.id)];
  // In the order of the next-look queue: the session whose wait costs most first (lib/next-look.ts).
  const alerts = useAuto((s) => s.alerts);
  const told = useToldStates();
  const costs = useMemo(() => sessionCosts(alerts, told), [alerts, told]);
  const order = waitingOrder(list, (id) => states[id], (id) => held(id).length > 0 || !!unsentOf(id), (id) => costs.get(id)?.key ?? 0, (id) => states[id]?.watch === "fail" && costs.has(id));
  const key = order.join();
  const cardKey = order.map((id) => (CARDS.has(states[id]?.why ?? "") || held(id).length > 0 ? 1 : 0)).join("");
  const ancestors = (id: string) => { const up: string[] = []; for (let p = sessions[id]?.parent_id; p && !up.includes(p) && up.length < 32; p = sessions[p]?.parent_id) up.push(p); return up; };
  useEffect(() => set({
    order,
    above: Object.fromEntries(order.flatMap((id) => (sessions[id]?.parent_id ? [[id, ancestors(id)]] : []))),
    card: Object.fromEntries(order.map((id, i) => [id, cardKey[i] === "1"])),
  }), [key, cardKey]);

  const cur = useUI((s) => (s.route.name === "session" ? s.route.id : null));
  const on = useQueue((s) => s.on);
  // What the session on screen asks, by id: one that is gone was answered, here or elsewhere.
  const ids = cur ? held(cur) : [];
  const idsKey = ids.join();
  const was = useRef({ cur, ids });
  useEffect(() => {
    const before = was.current;
    was.current = { cur, ids };
    const gone = before.cur === cur ? before.ids.filter((id) => !ids.includes(id)) : [];
    const gentle = gone.some(answeredByOneKey);
    if (!on) {
      // No sequence: the owner came to answer this one, and has answered all it asked. A look is
      // left; from the pane that holds it they are back in the pane they came from.
      if (cur && visit?.id === cur && gone.length && !ids.length && gone.every(answeredHere)) {
        const { from, slot } = visit;
        visit = null;
        // On a phone the answers go on: the next session that waits, as a sequence that began where they came from.
        const next = phone() ? order.find((id) => id !== cur) : undefined;
        if (next) { putAway(cur); return go(next, { route: from, slot }, gentle); }
        if (!leaveLook(cur, true)) backTo(from, slot);
      }
      return;
    }
    // The owner went somewhere the sequence did not take them.
    if (cur !== state.at) return end();
    // Nothing was answered: nothing moves (a card that arrives moves nothing under the owner's hands).
    if (!cur || !gone.length) return;
    // It left for another reason than the owner's answer from this page: the sequence ends where it
    // is, and the keyboard the card held goes to the message box (where Enter sends nothing yet).
    if (!gone.every(answeredHere)) { end(); return restInBox(cur); }
    // More waits here: the keyboard goes to it. Else on to the next session.
    if (ids.length) return focusAsk(cur, gentle);
    const next = order.find((id) => id !== cur);
    // The look that was answered is put away; the next one, if it is a look, takes its place in the same pane.
    if (next) { putAway(cur); return go(next, undefined, gentle); }
    done(cur);
    say("Nothing else waits for you.");
  }, [on, cur, idsKey, key]);
  // The owner went to a session that waits, from somewhere else and not by moving to its pane
  // themselves: one to answer and leave. Typing in its message box ends that: they work there now.
  const route = useUI((s) => s.route);
  const came = useRef(route);
  useEffect(() => {
    const from = came.current;
    came.current = route;
    if (!cur || state.on || !(from.name === "session" || from.name === "new")) { visit = null; return; }
    if (visit?.id === cur || (from.name === "session" && from.id === cur)) return;
    const st = opened(getStations(), cur);
    // A look, or a move between panes at a desk. (One pane is a page that is turned: the owner turns it back.)
    const leaves = st.over.includes(cur) || (st.slots.length > 1 && !movedTo(cur) && matchMedia("(min-width: 768px)").matches) || phone();
    visit = order.includes(cur) && leaves ? { id: cur, from, slot: getStations().active } : null;
  }, [route]);
  // The owner began to read or work in the session they went to: they stay (see the head of the file).
  useEffect(() => {
    const inVisit = (t: EventTarget | null) => !!visit && t instanceof Element && t.closest<HTMLElement>("[data-station]")?.dataset.station === visit.id;
    const stay = () => { visit = null; };
    const typed = (e: Event) => { if (inVisit(e.target) && (e.target as Element).matches('[data-testid="composer"]')) stay(); };
    const pressed = (e: Event) => { if (inVisit(e.target) && !(e.target as Element).closest(ASKS)) stay(); };
    const wheeled = (e: Event) => { if (inVisit(e.target)) stay(); };
    const keyed = (e: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey || !inVisit(e.target) || (e.target as Element).closest(ASKS)) return;
      // (Arrows and Space in a message box that holds text move its caret or type: only an empty box scrolls the conversation.)
      const t = e.target as HTMLElement;
      if ((t.tagName === "TEXTAREA" || t.tagName === "INPUT") && ((t as HTMLTextAreaElement).value !== "" || e.key.startsWith("Arrow") || e.key === " ")) return;
      stay();
    };
    const selected = () => { const sel = getSelection(); if (visit && sel && !sel.isCollapsed && inVisit(sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement ?? null)) stay(); };
    addEventListener("input", typed, true);
    addEventListener("pointerdown", pressed, true);
    addEventListener("wheel", wheeled, { capture: true, passive: true });
    addEventListener("keydown", keyed, true);
    document.addEventListener("selectionchange", selected);
    return () => {
      removeEventListener("input", typed, true); removeEventListener("pointerdown", pressed, true); removeEventListener("wheel", wheeled, true);
      removeEventListener("keydown", keyed, true); document.removeEventListener("selectionchange", selected);
    };
  }, []);
  // And so does time: ten seconds there once its cards could be answered.
  useEffect(() => {
    const v = visit;
    if (!v || v.id !== cur || phone()) return;
    const t = window.setTimeout(() => { if (visit === v) visit = null; }, SETTLE_MS + READING_MS);
    return () => window.clearTimeout(t);
  }, [route, cur]);

  // Anything else the owner does ends the sequence, and so does leaving the window. So does a
  // quiet minute: one with no answer and no key or press on the cards. (A sequence left on
  // would move the page, much later, at the next answer given for another reason.)
  useEffect(() => {
    if (!on) return;
    const quiet = () => { end(); say("The answering sequence ended after a quiet minute."); };
    let idle = window.setTimeout(quiet, QUIET_MS);
    const act = (e: Event) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      // On the cards, or in a popup that is a card's own (the grant of an approval): the sequence goes on.
      if (t?.closest('[data-testid="composer-asks"], [data-ask-part]')) { window.clearTimeout(idle); idle = window.setTimeout(quiet, QUIET_MS); return; }
      if (e.type === "keydown") {
        const k = e as KeyboardEvent;
        const field = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
        const typed = field && k.key.length === 1 && !k.altKey && !k.ctrlKey && !k.metaKey;
        if (k.key !== "Escape" && !typed) return;
      }
      end();
    };
    const hidden = () => { if (document.visibilityState !== "visible") end(); };
    addEventListener("pointerdown", act, true);
    addEventListener("keydown", act, true);
    addEventListener("blur", end);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.clearTimeout(idle);
      removeEventListener("pointerdown", act, true);
      removeEventListener("keydown", act, true);
      removeEventListener("blur", end);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [on, cur, idsKey]);
  return null;
}

// The place in a card's header where the count of the other sessions that wait stands, as a chip that goes to the
// next. The first card of a session's asks claims it; the count is drawn there while it is, and above the cards
// (one line) where no card has a header of its own to hold it.
const slots = new Map<string, HTMLElement>();
const slotSubs = new Set<() => void>();
const slotSub = (f: () => void) => { slotSubs.add(f); return () => { slotSubs.delete(f); }; };
export function WaitingSlot({ sessionId }: { sessionId: string }) {
  const ref = useMemo(() => {
    let mine: HTMLElement | null = null;
    return (el: HTMLElement | null) => {
      if (el) { mine = el; slots.set(sessionId, el); } else if (mine) { if (slots.get(sessionId) === mine) slots.delete(sessionId); mine = null; }
      slotSubs.forEach((f) => f());
    };
  }, [sessionId]);
  // (Where it holds the chip it takes the free room of the header's row, ahead of the answers' own; on a phone it is a row of
  // its own under them, the header wrapping for it, so it never takes the title's and Later's room at a large text size.)
  return <span ref={ref} data-waiting-slot="" className="[&:not(:empty)]:ml-auto [&:not(:empty)]:inline-flex max-md:[&:not(:empty)]:order-last max-md:[&:not(:empty)]:ml-0 max-md:[&:not(:empty)]:basis-full" />;
}

// Above what a session asks: how many other sessions wait, and how to get to
// them. In a sequence it says that the next one opens by itself. The session's
// own agents are not elsewhere: what they ask is reached from this page.
export function WaitingElsewhere({ sessionId }: { sessionId: string }) {
  const others = useQueue((s) => (s.order.includes(sessionId) ? s.order.filter((id) => id !== sessionId && !s.above[id]?.includes(sessionId)).length : 0));
  const on = useQueue((s) => s.on && s.at === sessionId);
  const helm = useUI((s) => s.route.name === "session" && s.route.id === sessionId);
  const slot = useSyncExternalStore(slotSub, () => slots.get(sessionId) ?? null);
  if (!others || !helm) return null;
  const said = `${others} other session${others === 1 ? " waits" : "s wait"}`;
  const n = `${said} for you`;
  const words = on ? `Answering in sequence. ${n}: the next opens when this is answered.` : `${n}.`;
  if (slot) {
    // In the card's header: a chip, not a line, with the state dot of what waits. In a sequence it is the status; else it is the link to the next.
    const chip = "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-accent-soft px-2.5 text-micro font-medium text-accent-ink pointer-coarse:h-tap";
    return createPortal(on
      ? <span role="status" className={chip} data-testid="waiting-elsewhere" data-on="true" title={words}><Mark w="need" className="!size-2" />{said} · next opens after this</span>
      : <button type="button" onClick={goNextOther} className={cn(chip, "hover:bg-accent-soft/70 hover:underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-accent/40 outline-none")} data-testid="waiting-elsewhere" aria-label={`${n}. Go to the next`} title={`${n}. Alt A goes to the next.`}><Mark w="need" className="!size-2" />{said}</button>, slot);
  }
  // One line of a fixed height, cut where the pane ends: its height never depends on the pane's width.
  // (A finger's screen has no key to name: there the row is one target, a finger's height at least, that goes
  // to the next, its words at the size of the page's captions and wrapped, not cut. The button lies over
  // the whole row, out of the words' live region: a screen reader tells the words as they change, and a
  // control read out inside a status is told as more of it.)
  return (
    <div className="k-waiting-elsewhere relative mb-1.5 flex h-ctl-sm items-center gap-x-1.5 overflow-hidden whitespace-nowrap pl-0.5 text-micro text-faint pointer-coarse:h-auto pointer-coarse:min-h-tap pointer-coarse:whitespace-normal pointer-coarse:rounded-lg pointer-coarse:bg-accent-soft pointer-coarse:py-1 pointer-coarse:pl-3 pointer-coarse:text-caption pointer-coarse:text-fg" data-testid="waiting-elsewhere" data-on={on || undefined} title={words}>
      <p className={cn("flex min-w-0 items-center gap-x-1.5", !on && "pointer-coarse:pr-[8.5rem]")} role="status">
        <Mark w="need" className="!size-2" />
        {on ? <span className="min-w-0 truncate pointer-coarse:overflow-visible pointer-coarse:whitespace-normal"><span className="text-muted">Answering in sequence.</span> {n}: the next opens when this is answered.</span>
          : <><span className="min-w-0 truncate pointer-coarse:overflow-visible pointer-coarse:whitespace-normal">{n}.</span><Kbd keys={KEYS} className="shrink-0 pointer-coarse:hidden" /><span className="shrink-0 pointer-coarse:hidden">goes to the next.</span></>}
      </p>
      {!on && <button type="button" data-testid="waiting-next" onClick={goNextOther} className="absolute inset-0 hidden items-center justify-end gap-0.5 rounded-lg pr-2.5 text-caption font-medium text-accent-ink pointer-coarse:flex">Go to the next<ChevronRight className="size-4" aria-hidden="true" /></button>}
    </div>
  );
}
