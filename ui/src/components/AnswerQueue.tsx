// What waits on the owner across sessions, answered in sequence from one
// place. The order is every session whose state, as the daemon serves it,
// reads "needs you" (an approval, a question, a plan, a secret, a message
// that did not go), the longest wait first (lib/waiting.ts). One key goes
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
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { announce } from "../lib/announce.ts";
import { answeredHere, askIn, focusAsk, restInBox, sequenceAt, setSequence } from "../lib/asks.ts";
import { isMac, registerCommand } from "../lib/keys.ts";
import { usePlans } from "../lib/plans.ts";
import { useSafety } from "../lib/safety.ts";
import { useSecrets } from "../lib/secrets.ts";
import { unsentOf, useShelfVersion } from "../lib/send-drafts.ts";
import { useStore } from "../lib/store.ts";
import { tipSay } from "../lib/tips.ts";
import { getUI, navigate, useUI } from "../lib/ui.ts";
import { keepBoxOut } from "../lib/self-focus.ts";
import { nextWaiting, waitingOrder } from "../lib/waiting.ts";
import { useSessionStates } from "../lib/watch.ts";
import { Kbd } from "./Kbd.tsx";

const KEYS = "alt+a";
// How long the sequence stays on with nothing answered and no key or press on the cards.
const QUIET_MS = 60_000;
// What a session that needs the owner shows as a card above its message box (the daemon's `why`).
const CARDS = new Set(["approval", "question", "plan", "secret"]);
type State = {
  order: string[]; // the sessions that wait, the longest wait first
  parent: Record<string, string>; // of those, the agents' sessions: the session that started each
  card: Record<string, boolean>; // of those, the ones that wait with a card (not with a message that did not go)
  on: boolean; // a sequence is being answered
  at: string | null; // the session the sequence is on
};
let state: State = { order: [], parent: {}, card: {}, on: false, at: null };
const subs = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; subs.forEach((f) => f()); };
const useQueue = <T,>(sel: (s: State) => T): T => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => sel(state));
const here = () => { const r = getUI().route; return r.name === "session" ? r.id : null; };
const say = (text: string) => { tipSay(null, text, 2400); announce(text); };

// The sequence goes to a session: its pane takes the helm and its card the
// keyboard, once it shows and nothing lies over it. Its message box takes
// none on the way (a session with no card to answer, only a message that did
// not go, is opened as any other: there the box is where the keyboard goes).
function go(id: string) {
  // Where it goes is known before the page moves: the move is the sequence's own.
  state = { ...state, on: true, at: id };
  setSequence(state.card[id] === false ? null : id);
  if (here() !== id) navigate({ name: "session", id });
  set({});
  focusAsk(id);
}
const end = () => { setSequence(null); if (state.on) set({ on: false, at: null }); };
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
  const order = waitingOrder(list, (id) => states[id], (id) => held(id).length > 0 || !!unsentOf(id));
  const key = order.join();
  const cardKey = order.map((id) => (CARDS.has(states[id]?.why ?? "") || held(id).length > 0 ? 1 : 0)).join("");
  useEffect(() => set({
    order,
    parent: Object.fromEntries(order.flatMap((id) => (sessions[id]?.parent_id ? [[id, sessions[id]!.parent_id!]] : []))),
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
    if (!on) return;
    // The owner went somewhere the sequence did not take them.
    if (cur !== state.at) return end();
    const gone = before.cur === cur ? before.ids.filter((id) => !ids.includes(id)) : [];
    // Nothing was answered: nothing moves (a card that arrives moves nothing under the owner's hands).
    if (!cur || !gone.length) return;
    // It left for another reason than the owner's answer from this page: the sequence ends where it
    // is, and the keyboard the card held goes to the message box (where Enter sends nothing yet).
    if (!gone.every(answeredHere)) { end(); return restInBox(cur); }
    // More waits here: the keyboard goes to it. Else on to the next session.
    if (ids.length) return focusAsk(cur);
    const next = order.find((id) => id !== cur);
    if (next) return go(next);
    end();
    restInBox(cur);
    say("Nothing else waits for you.");
  }, [on, cur, idsKey, key]);

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

// Above what a session asks: how many other sessions wait, and how to get to
// them. In a sequence it says that the next one opens by itself. The session's
// own agents are not elsewhere: what they ask is reached from this page.
export function WaitingElsewhere({ sessionId }: { sessionId: string }) {
  const others = useQueue((s) => (s.order.includes(sessionId) ? s.order.filter((id) => id !== sessionId && s.parent[id] !== sessionId).length : 0));
  const on = useQueue((s) => s.on && s.at === sessionId);
  const helm = useUI((s) => s.route.name === "session" && s.route.id === sessionId);
  if (!others || !helm) return null;
  const n = `${others} more session${others === 1 ? " waits" : "s wait"} for you`;
  const words = on ? `Answering in sequence. ${n}: the next opens when this is answered.` : `${n}.`;
  // One line of a fixed height, cut where the pane ends: its height never depends on the pane's width.
  return (
    <p className="mb-1.5 flex h-ctl-sm items-center gap-x-1.5 overflow-hidden whitespace-nowrap pl-0.5 text-micro text-faint" data-testid="waiting-elsewhere" data-on={on || undefined} role="status" title={words}>
      <span className="size-1.5 shrink-0 rotate-45 bg-st-need" aria-hidden="true" />
      {on ? <span className="min-w-0 truncate"><span className="text-muted">Answering in sequence.</span> {n}: the next opens when this is answered.</span>
        : <><span className="min-w-0 truncate">{n}.</span><Kbd keys={KEYS} className="shrink-0" /><span className="shrink-0">goes to the next.</span></>}
    </p>
  );
}
