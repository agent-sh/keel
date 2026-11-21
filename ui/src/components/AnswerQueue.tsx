// What waits on the owner across sessions, answered in sequence from one
// place. The order is lib/waiting.ts's: the longest wait first. One key goes
// to the next session that waits and puts the keyboard on what it asks, above
// that session's message box; that starts a sequence. While it is on, each
// answer moves on by itself: to what else waits in the same session, then to
// the next session, until nothing waits. So four things that wait cost five
// key presses: the one that starts, and one answer each.
//
// The sequence is the owner's, and ends as soon as they do something else: go
// to another session or page, press outside the cards, type into a field that
// is not a card's, or press Escape outside a card.
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { announce } from "../lib/announce.ts";
import { registerCommand } from "../lib/keys.ts";
import { useSafety } from "../lib/safety.ts";
import { unsentOf, useShelfVersion } from "../lib/send-drafts.ts";
import { useStore } from "../lib/store.ts";
import { tipSay } from "../lib/tips.ts";
import { getUI, navigate, useUI } from "../lib/ui.ts";
import { focusAsk, focusPane } from "../lib/utils.ts";
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

// The sequence goes to a session: its pane takes the helm and what it asks takes the keyboard.
function go(id: string) {
  // Where it goes is known before the page moves: the move is the sequence's own.
  state = { ...state, on: true, at: id };
  if (here() !== id) navigate({ name: "session", id });
  set({});
  focusAsk(id);
}

// Goes to the next session that waits on the owner, and starts the sequence
// there. From the only one that waits, the keyboard goes to what it asks.
// With nothing waiting, it says so.
export function goNextWaiting() {
  const cur = here();
  const next = nextWaiting(state.order, cur) ?? (cur && state.order.includes(cur) ? cur : null);
  if (next) go(next);
  else say("Nothing waits for you.");
}

registerCommand({
  id: "next-waiting", label: "Go to the next session that needs you", group: "Sessions", keys: KEYS, inInput: true,
  words: "answer approval question plan waiting attention jump needs sequence", run: goNextWaiting,
});

// Mounted once by the app: reads every session's word, keeps the order, and runs the sequence.
export function AnswerQueue() {
  const sessions = useStore((s) => s.sessions);
  const list = useMemo(() => Object.values(sessions).filter((s) => !s.archived), [sessions]);
  const words = useWatches(list);
  const approvals = useSafety((s) => s.approvals);
  const questions = useStore((s) => s.questionCalls);
  useShelfVersion();
  const order = waitingOrder(list, (id) => words[id], (id) => !!(approvals[id]?.length || questions[id]?.length || unsentOf(id)));
  const key = order.join();
  useEffect(() => set({ order }), [key]);

  const cur = useUI((s) => (s.route.name === "session" ? s.route.id : null));
  const on = useQueue((s) => s.on);
  // How much the session on screen asks: when it gets less, an answer was given.
  const asks = cur ? (approvals[cur]?.length ?? 0) + (questions[cur]?.length ?? 0) : 0;
  const was = useRef({ cur, asks });
  useEffect(() => {
    const before = was.current;
    was.current = { cur, asks };
    if (!on) return;
    // The owner went somewhere the sequence did not take them.
    if (cur !== state.at) return set({ on: false, at: null });
    if (cur && order.includes(cur)) {
      // One of several was answered here: the keyboard goes to the next of them.
      // (One that arrives meanwhile moves nothing under the owner's hands.)
      if (before.cur === cur && asks < before.asks) focusAsk(cur);
      return;
    }
    const next = order[0];
    if (next) return go(next);
    set({ on: false, at: null });
    say("Nothing else waits for you.");
  }, [on, cur, key, asks]);

  // Anything else the owner does ends the sequence.
  useEffect(() => {
    if (!on) return;
    const end = (e: Event) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.closest('[data-testid="composer-asks"]')) return;
      if (e.type === "keydown") {
        const k = e as KeyboardEvent;
        const field = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
        const typed = field && k.key.length === 1 && !k.altKey && !k.ctrlKey && !k.metaKey;
        if (k.key !== "Escape" && !typed) return;
      }
      set({ on: false, at: null });
    };
    addEventListener("pointerdown", end, true);
    addEventListener("keydown", end, true);
    return () => { removeEventListener("pointerdown", end, true); removeEventListener("keydown", end, true); };
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
  return (
    <p className="mb-1.5 flex flex-wrap items-center gap-x-1.5 pl-0.5 text-micro text-faint" data-testid="waiting-elsewhere" data-on={on || undefined} role="status">
      <span className="size-1.5 shrink-0 rotate-45 bg-st-need" aria-hidden="true" />
      {on ? <span><span className="text-muted">Answering in sequence.</span> {n}: the next opens when this is answered.</span>
        : <><span>{n}.</span><Kbd keys={KEYS} /><span>goes to the next.</span></>}
    </p>
  );
}
