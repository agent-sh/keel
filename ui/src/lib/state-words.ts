// The state vocabulary: one word per state, for a session and for an agent
// alike, on every surface. This file is the only place a state word is
// written; a component that needs one reads it from here (the lint in
// src/ui-conventions.test.ts holds the page to that), and the daemon's own
// texts (src/core/watch.ts, src/automation/state.ts) are built from the same
// tables. The state itself is the daemon's: it serves what a session needs,
// does or waits for, with the reason (`why`), and this file says it.
//
//   State      Word          With what
//   need       Needs you     an approval, a question, a plan, a secret, an answer,
//                            a turn to resume, a message not sent
//   work       Working       the step, "N agents", "command in background"
//   wait       Waiting       for a timer, a file, a log line, an HTTP check, a process,
//                            a monitor, a pull request's checks, another session,
//                            an agent, the provider, Keel to be back
//   resume     Waiting       to resume (a restart cut the turn; Keel goes on with it)
//   (message)  Queued        held until its current step ends, until its turn ends,
//                            until it is resumed
//   done       Done
//   fail       Failed        one class: rate limit, overloaded, server error,
//                            stream dropped, context full, sign-in, billing,
//                            image refused, invalid request, output limit
//   declined   Declined
//   stop       Stopped       at the step budget, by you, by its parent
//   idle       Not started
//   (machine)  Offline
//
// Sentence case everywhere. Retired: Running, Asks you, Finished, quota,
// Steer as a state, "Waiting" for a command left in the background (it works).
import type { SessionState, Watch } from "../../../src/core/watch.ts";

export const STATE_WORD: Record<Watch, string> = {
  need: "Needs you", work: "Working", wait: "Waiting", fail: "Failed", declined: "Declined", resume: "Waiting", stop: "Stopped", done: "Done", idle: "Not started",
};
// A message that waits for its session, and a machine that does not answer.
export const QUEUED = "Queued";
export const OFFLINE = "Offline";

// What a session needs from the owner, by the daemon's reason.
export const NEEDS: Record<string, string> = {
  approval: "an approval", question: "a question", plan: "a plan", secret: "a secret", owner: "an answer", resume: "a turn to resume", unsent: "a message not sent",
};
// What a wait is on, by its kind.
export const WAITS_FOR: Record<string, string> = {
  timer: "a timer", file: "a file", log: "a log line", http: "an HTTP check", process: "a process", monitor: "a monitor",
  websocket: "a WebSocket", pr_checks: "a pull request's checks", session: "another session", wake: "a wake of its own",
  agent: "an agent", resume: "the provider", send: "Keel to be back",
};
export const waitsFor = (kind: unknown) => WAITS_FOR[String(kind)] ?? "a condition";
// A command the session left running after its turn: the session works.
export const COMMAND_IN_BACKGROUND = "command in background";

// A failure's class: one fixed word each. A class with no better word than
// the failure itself (other) has none.
export const FAIL_WORD: Record<string, string> = {
  rate_limit: "rate limit", overloaded: "overloaded", server: "server error", stream_drop: "stream dropped", context_overflow: "context full",
  auth: "sign-in", quota: "billing", refusal: "declined", image: "image refused", invalid_request: "invalid request", max_tokens: "output limit",
};
export const failWord = (cls: string | undefined) => (cls ? FAIL_WORD[cls] ?? "" : "");

const plural = (n: number) => `${n} agent${n === 1 ? "" : "s"}`;

// The fields of the served state the words are read from.
export type Stated = Pick<SessionState, "watch"> & Partial<Pick<SessionState, "why" | "on" | "cls" | "agents" | "parked">>;

// The agents of a session that work now: those still out, less the ones that wait.
export const agentsWorking = (st: Stated) => Math.max(0, (st.agents ?? 0) - (st.parked ?? 0));

// The state said: its one word, what it is with (never the word again), and
// the two together as a phrase for a place with room.
//   { word: "Needs you", what: "an approval", phrase: "Needs you: an approval" }
//   { word: "Waiting", what: "for a timer", phrase: "Waiting for a timer" }
//   { word: "Working", what: "command in background", phrase: "Working: command in background" }
//   { word: "Failed", what: "billing", phrase: "Failed: billing" }
export type Said = { watch: Watch; word: string; what: string; phrase: string };
export function stateWords(st: Stated): Said {
  const w = st.watch;
  const word = STATE_WORD[w];
  const out = (what: string, join = ": "): Said => ({ watch: w, word, what, phrase: what ? `${word}${join}${what}` : word });
  if (w === "need") return out(NEEDS[st.why ?? ""] ?? "");
  if (w === "work") return out(st.why === "command" ? COMMAND_IN_BACKGROUND : agentsWorking(st) > 0 ? plural(agentsWorking(st)) : "");
  if (w === "wait") { const on = st.why === "wait" ? st.on : st.why; return out(on ? `for ${waitsFor(on)}` : "", " "); }
  if (w === "resume") return out("to resume", " ");
  if (w === "fail") return out(failWord(st.cls));
  if (w === "stop") return out(st.why === "max_steps" ? "at the step budget" : "", " ");
  return out("");
}

// The word as a head shows it, with the agents that keep it working: "Working · 2 agents".
// The count is the agents that work, which is the "working" of the session's agent summary.
export function stateLabel(st: Stated): string {
  const s = stateWords(st);
  if (st.watch === "work") return agentsWorking(st) > 0 ? `${s.word} · ${plural(agentsWorking(st))}` : s.word;
  return st.watch === "resume" ? s.phrase : s.word;
}

// ---- Agents. An agent is a session: its word is its session's.
// The agent's record says how it stands with its parent (running, waiting on
// something it set up, ended and how); its session's served state says what
// it needs or does. One state from both, so the tree, the card, the list of
// background work and the agent's own pane say the same word.
export type AgentLike = { status: string; stopped_by?: string | null; end_reason?: string | null };
const LIVE: readonly Watch[] = ["need", "work", "wait", "resume"];
export function agentState(a: AgentLike, told?: SessionState): SessionState {
  const base = { agents: told?.agents ?? 0 };
  if (a.status === "running" || a.status === "waiting") {
    // Its session says more while it is live: what it needs, the step, what it waits for.
    if (told && LIVE.includes(told.watch)) return told;
    return a.status === "running" ? { ...base, watch: "work" } : { ...base, watch: "wait", why: "wait" };
  }
  // Ended: the record is the word. Its session's failure says the class.
  if (a.status === "completed") return { ...base, watch: "done" };
  if (a.status === "failed") return told?.watch === "fail" ? told : { ...base, watch: "fail" };
  if (a.status === "incomplete") {
    if (a.end_reason === "refusal") return { ...base, watch: "declined", why: "refusal" };
    if (a.end_reason === "max_tokens") return { ...base, watch: "fail", why: "max_tokens", cls: "max_tokens" };
    return { ...base, watch: "stop", ...(a.end_reason === "max_steps" ? { why: "max_steps" } : {}) };
  }
  return { ...base, watch: "stop" };
}

// Who stopped an agent, and why one did not finish, as the owner reads it.
const STOPPED_BY: Record<string, string> = {
  owner: "You stopped this agent", parent: "Its parent agent stopped it", parent_turn: "Stopped with its parent's turn",
  time_limit: "Its time limit passed", parent_archived: "Its parent session was archived",
};
const PARTIAL: Record<string, string> = {
  refusal: "The model declined; the report is partial", max_tokens: "Output limit reached; the report is partial", max_steps: "Step budget spent; the report is partial",
};
export const agentWhy = (a: AgentLike) =>
  a.status === "stopped" ? (a.stopped_by ? STOPPED_BY[a.stopped_by] : undefined) : a.status === "incomplete" ? (a.end_reason ? PARTIAL[a.end_reason] : undefined) : undefined;

// ---- Counts. A count says its state in the same words.
export type Counted = "need" | "fail" | "declined" | "work" | "wait" | "stop" | "done" | "idle";
// The order a summary is read in: what needs the owner and what went wrong first, so a line cut short never hides them.
export const COUNT_ORDER: readonly Counted[] = ["need", "fail", "declined", "work", "wait", "stop", "done", "idle"];
export const counted = (w: Watch): Counted => (w === "resume" ? "wait" : w);
export const countWord = (w: Counted, n: number) =>
  w === "need" ? `${n} ${n === 1 ? "needs" : "need"} you` : `${n} ${STATE_WORD[w].toLowerCase()}`;

// A parent's agents by state. Every agent is in exactly one part, so the parts add up to the total;
// a state with none is left out. "8 agents: 1 needs you, 1 failed, 3 working, 2 waiting, 1 done".
export type Tally = { total: number; parts: { w: Counted; n: number; text: string }[]; text: string };
export function tally(states: readonly Watch[]): Tally {
  const n = new Map<Counted, number>();
  for (const w of states) n.set(counted(w), (n.get(counted(w)) ?? 0) + 1);
  const parts = COUNT_ORDER.filter((w) => n.get(w)).map((w) => ({ w, n: n.get(w)!, text: countWord(w, n.get(w)!) }));
  const total = states.length;
  return { total, parts, text: total ? `${plural(total)}: ${parts.map((p) => p.text).join(", ")}` : "" };
}

// ---- A message that waits for its session: the word, and when it is taken.
// `steer`: it joins the running turn; `held`: the session is stopped and its queue waits for the owner.
export function heldWords(m: { steer?: boolean; held?: boolean }): { word: string; when: string } {
  return { word: QUEUED, when: m.held ? "held until it is resumed" : m.steer ? "held until its current step ends" : "held until its turn ends" };
}

// ---- The counters. Each counts one thing and says which.
export const COUNTERS = {
  // The tab's title, the app's badge and the home headline: things that wait on the owner.
  waiting: (n: number) => (n ? `${n} ${n === 1 ? "thing waits" : "things wait"} on you: approvals, questions, plans and secrets` : "Nothing waits on you"),
  // The bell: alerts that are new since the owner last looked.
  unread: (n: number) => (n ? `${n} unread: new since you last looked` : "Nothing new since you last looked"),
  // The bug: failures of Keel itself the owner has not looked at.
  errors: (n: number) => (n ? `${n} ${n === 1 ? "error" : "errors"} in Keel you have not looked at` : "No new errors in Keel"),
} as const;

// ---- The Inbox. The bell counts what is unread; its panel puts what waits on the owner first,
// then what else is new, then what they have seen. Nothing that waits is ever below a finish.
export type AlertGroup = "need" | "new" | "seen";
const ASKING = new Set(["approval", "question"]);
export const alertGroup = (a: { kind: string; read: boolean }): AlertGroup => (a.read ? "seen" : ASKING.has(a.kind) ? "need" : "new");
export const ALERT_GROUPS: readonly AlertGroup[] = ["need", "new", "seen"];
export const ALERT_GROUP_WORD: Record<AlertGroup, string> = { need: STATE_WORD.need, new: "New since you looked", seen: "Earlier" };
// An alert's kind in the vocabulary: a finish is Done, a failure Failed.
export const ALERT_WORD: Record<string, string> = {
  approval: "Approval", question: "Question", finished: STATE_WORD.done, failed: STATE_WORD.fail, limit: "Usage limit", loop_failed: "Loop failed",
  agent: "From the agent", snooze_over: "Snooze over", regression: "Regression", refused: "Refused call",
};
