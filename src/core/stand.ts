// Where a session stands, in one line made of facts: what runs now and for how long, what it waits on
// (an agent, a command and when its wait gives up, a card, a provider), and its last result (a landing,
// a named check). No model is asked and no model's claim is said: the words are the state's
// (src/core/watch.ts, src/automation/state.ts) and the result's (src/automation/results.ts). A row says
// `brief`, cut to its room; its tooltip, and the head's, say `full`. Pure.
import { asOf, briefText, hhmm, span, whyText, type SessionState, type StandResult } from "./watch.ts";

const agentsWord = (n: number) => `${n} agent${n === 1 ? "" : "s"}`;

// The result in a few words: "landed keel/fix-x", "unit failed".
export function resultText(r: StandResult): string {
  if (r.kind === "landed") return `landed ${r.what}${r.head ? ` (${r.head.slice(0, 7)})` : ""}`;
  if (r.kind === "left") return `${r.what} left the landing queue`;
  return `${r.what} ${r.ok ? "passed" : "failed"}`;
}

export type Stand = { brief: string; full: string };

export function standLine(st: SessionState, at = Date.now()): Stand {
  const now = asOf(st, at);
  const rest = st.watch === "done" || st.watch === "idle";
  const parts: string[] = [];
  const full: string[] = [];
  // What runs or waits now: the reason, as the row and the head already word it.
  if (!rest && st.text && st.why !== "send") {
    parts.push(briefText(st, at));
    const when = st.until
      ? (st.until > now ? `due ${hhmm(st.until)}` : "due now")
      : st.since && st.why !== "stalled" && st.why !== "unreachable" ? `for ${span(now - st.since)}` : "";
    // (As the reason is worded: a command keeps its own first letter.)
    full.push([whyText(st, at), when].filter(Boolean).join(", "));
  }
  // A wait of its own on a condition gives up at its deadline: when it hears by then at the latest.
  if (!rest && st.deadline && st.deadline > now) full.push(`Its wait gives up at ${hhmm(st.deadline)}`);
  // Its agents, unless the reason already is them.
  const working = Math.max(0, st.agents - (st.parked ?? 0));
  if (st.why !== "agents" && st.why !== "unreachable") {
    const a = [working ? `${agentsWord(working)} at work` : "", st.parked ? `${st.parked} waiting` : ""].filter(Boolean).join(", ");
    if (a) { full.push(a); if (!parts.length) parts.push(a); }
  } else if (st.why === "agents" && st.parked) full.push(`${st.parked} waiting`);
  // Its last result: the row's line at rest, the tail of the tooltip always.
  if (st.result) {
    const r = resultText(st.result);
    if (!parts.length) parts.push(r);
    full.push(`Last: ${r} at ${hhmm(st.result.at)}`);
  }
  return { brief: parts.join(" · "), full: full.join(". ") };
}
