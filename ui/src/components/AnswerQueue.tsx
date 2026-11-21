// What waits on the owner across sessions, in the order it is answered
// (lib/waiting.ts), kept for the keys: one command goes to the next session
// that waits and puts the keyboard on what it asks.
import { useMemo } from "react";
import { announce } from "../lib/announce.ts";
import { registerCommand } from "../lib/keys.ts";
import { useSafety } from "../lib/safety.ts";
import { unsentOf, useShelfVersion } from "../lib/send-drafts.ts";
import { useStore } from "../lib/store.ts";
import { tipSay } from "../lib/tips.ts";
import { getUI, navigate } from "../lib/ui.ts";
import { focusAsk, focusPane } from "../lib/utils.ts";
import { nextWaiting, waitingOrder } from "../lib/waiting.ts";
import { useWatches } from "../lib/watch.ts";

let order: string[] = [];
const here = () => { const r = getUI().route; return r.name === "session" ? r.id : null; };

// Goes to the next session that waits on the owner. From the only one that
// waits, the keyboard goes to what it asks; with nothing waiting, it says so.
export function goNextWaiting() {
  const cur = here();
  const next = nextWaiting(order, cur);
  if (next) {
    navigate({ name: "session", id: next });
    return focusAsk(next);
  }
  if (cur && order.includes(cur)) return void focusPane(cur);
  const said = "Nothing waits for you.";
  tipSay(null, said, 2400);
  announce(said);
}

registerCommand({
  id: "next-waiting", label: "Go to the next session that needs you", group: "Sessions", keys: "alt+a", inInput: true,
  words: "answer approval question waiting attention jump needs", run: goNextWaiting,
});

// Mounted once by the app: reads every session's word and keeps the order.
export function AnswerQueue() {
  const sessions = useStore((s) => s.sessions);
  const list = useMemo(() => Object.values(sessions).filter((s) => !s.archived), [sessions]);
  const words = useWatches(list);
  const approvals = useSafety((s) => s.approvals);
  const questions = useStore((s) => s.questionCalls);
  useShelfVersion();
  order = waitingOrder(list, (id) => words[id], (id) => !!(approvals[id]?.length || questions[id]?.length || unsentOf(id)));
  return null;
}
