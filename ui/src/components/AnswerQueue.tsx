// What waits on the owner across sessions, answered in sequence from one
// place. The order is lib/waiting.ts's: the longest wait first. One key goes
// to what waits: first to what the session on screen asks, then to the next
// session that waits, with the keyboard on its card above that session's
// message box (on the card, not on an answer: lib/asks.ts). That starts a
// sequence. While it is on, each answer the owner gives from this page moves
// on by itself: to what else waits in the same session, then to the next
// session, until nothing waits.
//
// The sequence is the owner's. It moves only after their own answer: a card
// that leaves because it was answered elsewhere, stopped or granted ends it
// where it is. And it ends as soon as they do something else: go to another
// session or page, press outside the cards, type into a field that is not a
// card's, press Escape outside a card, or leave the window.
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { announce } from "../lib/announce.ts";
import { answeredHere, askIn, focusAsk } from "../lib/asks.ts";
import { isMac, registerCommand } from "../lib/keys.ts";
import { usePlans } from "../lib/plans.ts";
import { useSafety } from "../lib/safety.ts";
import { unsentOf, useShelfVersion } from "../lib/send-drafts.ts";
import { useStore } from "../lib/store.ts";
import { tipSay } from "../lib/tips.ts";
import { getUI, navigate, useUI } from "../lib/ui.ts";
import { nextWaiting, waitingOrder } from "../lib/waiting.ts";
import { useWatches } from "../lib/watch.ts";
import { Kbd } from "./Kbd.tsx";

const KEYS = "alt+a";
type State = {
  order: string[]; // the sessions that wait, the longest wait first
  on: boolean; // a sequence is being answered
  at: string | null; // the session the sequence is on
};
let state: State = { order: [], on: false, at: null };
const subs = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; subs.forEach((f) => f()); };
const useQueue = <T,>(sel: (s: State) => T): T => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => sel(state));
const here = () => { const r = getUI().route; return r.name === "session" ? r.id : null; };
const say = (text: string) => { tipSay(null, text, 2400); announce(text); };

// The sequence goes to a session: its pane takes the helm and its card the
// keyboard, once it shows and nothing lies over it.
function go(id: string) {
  // Where it goes is known before the page moves: the move is the sequence's own.
  state = { ...state, on: true, at: id };
  if (here() !== id) navigate({ name: "session", id });
  set({});
  focusAsk(id);
}
const end = () => { if (state.on) set({ on: false, at: null }); };

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
  const words = useWatches(list);
  const approvals = useSafety((s) => s.approvals);
  const questions = useStore((s) => s.questionCalls);
  const plans = usePlans();
  useShelfVersion();
  // (A waiting plan this page knows of counts, whatever word its session reads.)
  const order = waitingOrder(list, (id) => (plans[id]?.length ? "need" : words[id]), (id) => !!(approvals[id]?.length || questions[id]?.length || plans[id]?.length || unsentOf(id)));
  const key = order.join();
  useEffect(() => set({ order }), [key]);

  const cur = useUI((s) => (s.route.name === "session" ? s.route.id : null));
  const on = useQueue((s) => s.on);
  // What the session on screen asks, by id: one that is gone was answered, here or elsewhere.
  const ids = cur ? [...(approvals[cur] ?? []).map((a) => a.id), ...(questions[cur] ?? []), ...(plans[cur] ?? [])] : [];
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
    // It left for another reason than the owner's answer from this page: the sequence ends where it is.
    if (!gone.every(answeredHere)) return end();
    // More waits here: the keyboard goes to it. Else on to the next session.
    if (ids.length) return focusAsk(cur);
    const next = order.find((id) => id !== cur);
    if (next) return go(next);
    end();
    say("Nothing else waits for you.");
  }, [on, cur, idsKey, key]);

  // Anything else the owner does ends the sequence, and so does leaving the window.
  useEffect(() => {
    if (!on) return;
    const act = (e: Event) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.closest('[data-testid="composer-asks"]')) return;
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
      removeEventListener("pointerdown", act, true);
      removeEventListener("keydown", act, true);
      removeEventListener("blur", end);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [on]);
  return null;
}

// Above what a session asks: how many other sessions wait, and how to get to
// them. In a sequence it says that the next one opens by itself.
export function WaitingElsewhere({ sessionId }: { sessionId: string }) {
  const others = useQueue((s) => (s.order.includes(sessionId) ? s.order.filter((id) => id !== sessionId).length : 0));
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
