// The state vocabulary: one word per state, for a session and for an agent
// alike, on every surface. This file is the only place a state word is
// written. The page reads it from here (the lint in src/ui-conventions.test.ts
// holds it to that), as it reads src/core/command.ts, and the daemon's own
// texts (src/core/watch.ts, src/automation/state.ts) are built from the same
// tables. It imports nothing but types, so both sides may. The state itself is the daemon's: it serves what a session needs,
// does or waits for, with the reason (`why`), and this file says it.
//
//   State      Word          With what
//   need       Needs you     an approval, a question, a plan, a secret, an answer,
//                            a turn to resume, a message not sent
//   work       Working       the step, "N agents" (the ones that work, "3 of 5" when the rest wait),
//                            "command in background"
//   wait       Waiting       for a timer, a file, a log line, an HTTP check, a process,
//                            a monitor, a pull request's checks, another session,
//                            an agent, the provider (a wait it asked for, or it
//                            cannot be reached), Keel to be back
//   resume     Waiting       to resume (a restart cut the turn; Keel goes on with it)
//   (message)  Queued        held until its current step ends, until its turn ends,
//                            until it is resumed
//   done       Done
//   fail       Failed        one class: rate limit, overloaded, server error,
//                            stream dropped, provider unreachable, context full, sign-in, billing,
//                            image refused, invalid request, output limit
//   declined   Declined
//   stop       Stopped       at the step budget, by you, by its parent
//   idle       Not started
//   (machine)  Offline       as of HH:MM (the last its machine told)
//
// Counts say the state in the same words ("2 need you", "1 failed"). What
// waits on the owner is counted as things, each once, by one function
// (waitsOnOwner): the tab's title, the home headline, the list's line and the
// phone's dock show that one number.
//
// Sentence case everywhere. Retired: Running, Asks you, Finished, quota,
// Steer as a state, Idle, "Waiting" for a command left in the background (it works).
import type { SessionState, Watch } from "./watch.ts";

export const STATE_WORD: Record<Watch, string> = {
  need: "Needs you", work: "Working", wait: "Waiting", fail: "Failed", declined: "Declined", resume: "Waiting", stop: "Stopped", done: "Done", idle: "Not started",
};
// A message that waits for its session, and a machine that does not answer.
export const QUEUED = "Queued";
export const OFFLINE = "Offline";
// A machine that does not answer says nothing new: its sessions read Offline, with when they last told.
export const asOf = (hhmm: string) => `as of ${hhmm}`;
// How many messages of the owner's wait in a session's queue, and the mark of what came since they looked.
export const queuedWord = (n: number) => `${n} ${QUEUED.toLowerCase()}`;
export const NEW = "New";
// A session with alerts the owner has not read (the tray's list names it so).
export const UNREAD_WORD = "Unread";
// Who a row that needs the owner waits on, where its time would be.
export const WAITS_ON_YOU = "you";
// What a failed row says in the same place: its class (failWord), how many of its agents failed, else this.
export const FAILED_WORD = STATE_WORD.fail.toLowerCase();
export const DECLINED_WORD = STATE_WORD.declined.toLowerCase();
export const agentsFailedWord = (n: number) => `${n} ${FAILED_WORD}`;
export const NEW_SINCE = "New since you looked";
// In a conversation, on the rule above the first line the owner has not read: since when.
export const newSinceAt = (hhmm: string) => `${NEW} since ${hhmm}`;
// On the way to that rule: the owner says they have read what is new.
export const MARK_READ = "Mark as read";

// What a session needs from the owner, by the daemon's reason.
export const NEEDS: Record<string, string> = {
  approval: "an approval", question: "a question", plan: "a plan", secret: "a secret", owner: "an answer", resume: "a turn to resume", unsent: "a message not sent",
};
// What a wait is on, by its kind.
export const WAITS_FOR: Record<string, string> = {
  timer: "a timer", file: "a file", log: "a log line", http: "an HTTP check", process: "a process", monitor: "a monitor",
  websocket: "a WebSocket", pr_checks: "a pull request's checks", session: "another session", wake: "a wake of its own",
  agent: "an agent", slot: "a free agent slot", resume: "the provider", unreachable: "the provider", send: "Keel to be back",
};
export const waitsFor = (kind: unknown) => WAITS_FOR[String(kind)] ?? "a condition";
// A command the session left running after its turn: the session works.
export const COMMAND_IN_BACKGROUND = "command in background";
// The same command when it has written nothing for the tool's stuck limit (src/core/stuck.ts): it still works.
export const COMMAND_RUNNING_LONG = "command running long";
const commandWhat = (st: Stated) => (st.stuck ? COMMAND_RUNNING_LONG : COMMAND_IN_BACKGROUND);

// A failure's class: one fixed word each. A class with no better word than
// the failure itself (other) has none.
export const FAIL_WORD: Record<string, string> = {
  rate_limit: "rate limit", overloaded: "overloaded", server: "server error", stream_drop: "stream dropped", unreachable: "provider unreachable", context_overflow: "context full",
  auth: "sign-in", quota: "billing", refusal: "declined", image: "image refused", invalid_request: "invalid request", max_tokens: "output limit",
};
export const failWord = (cls: string | undefined) => (cls ? FAIL_WORD[cls] ?? "" : "");
// A turn that failed on a limit of the provider's, by the limit's class: a rate limit is not a usage limit.
const LIMIT_WORD: Record<string, string> = { rate_limit: "Rate limited", overloaded: "Overloaded", quota: "Usage limit", cap: "Cap reached" };
export const limitWord = (cls: unknown) => LIMIT_WORD[String(cls ?? "")] ?? "Usage limit";

const plural = (n: number) => `${n} agent${n === 1 ? "" : "s"}`;
// A session counted as Failed for agents of it that failed, until the owner looks at it.
// A retry's count: "attempt 3 of 9", or "attempt 3" for a model at capacity, which is tried
// until it has room (max 0: src/engine/retry.ts overloaded).
export const attemptWords = (attempt: number, max: number, word = "attempt") => max > 0 ? `${word} ${attempt} of ${max}` : `${word} ${attempt}, until the model has room`;
export const agentsFailedText = (n: number) => `${n} of its agents failed`;

// ---- A provider that cannot be reached. The turn waits and tries again by
// itself (src/providers/outage.ts); every surface says it in these words.
// `since`: the time of day the outage began, as the reader's clock says it.
export const UNREACHABLE = "The provider cannot be reached";
export const unreachableSince = (since: string) => `${UNREACHABLE} since ${since}; trying again`;
// In a tool's answer about a session or an agent.
export const UNREACHABLE_WORD = "waiting: the provider cannot be reached";
// What a parent is told of its agents, once when the outage is known and once when it is over.
export const agentsWait = (n: number) => `${n} ${n === 1 ? "agent waits" : "agents wait"}: the provider cannot be reached`;
export const agentsWaitLine = (n: number, since: string) => `${agentsWait(n)} since ${since}`;
export const agentsWentOnLine = (n: number, lasted: string) => `The provider answers again after ${lasted}: ${n === 1 ? "the agent that waited for it went on" : `the ${n} agents that waited for it went on`}`;
// The Activity list's two lines of an outage.
export const outageBegan = (provider: string, since: string, sessions: number) => `${provider} cannot be reached since ${since}: ${sessions === 1 ? "1 session waits" : `${sessions} sessions wait`} and ${sessions === 1 ? "goes" : "go"} on when it answers`;
export const outageEnded = (provider: string, lasted: string, answered: boolean) => (answered ? `${provider} answers again: it could not be reached for ${lasted}` : `${provider} could not be reached for ${lasted}: no session waits for it any more`);

// The fields of the served state the words are read from.
export type Stated = Pick<SessionState, "watch"> & Partial<Pick<SessionState, "why" | "on" | "cls" | "agents" | "parked" | "agents_total" | "stuck">>;

// The agents of a session that work now: those still out, less the ones that wait.
export const agentsWorking = (st: Stated) => Math.max(0, (st.agents ?? 0) - (st.parked ?? 0));

// The state said: its one word, what it is with (never the word again), and
// the two together as a phrase for a place with room.
//   { word: "Needs you", what: "an approval", phrase: "Needs you: an approval" }
//   { word: "Waiting", what: "for a timer", phrase: "Waiting for a timer" }
//   { word: "Working", what: "command in background", phrase: "Working: command in background" }
//   { word: "Failed", what: "billing", phrase: "Failed: billing" }
export type Said = { watch: Watch; word: string; what: string; phrase: string };
// A session another harness runs that worked or waited and has written nothing for a while
// (src/integrations/outside/settings.ts, stale_minutes): at rest as far as its records tell, not done.
export const STALE_WORD = "Stale";
export function stateWords(st: Stated): Said {
  const w = st.watch;
  const word = w === "idle" && st.why === "outside" ? STALE_WORD : STATE_WORD[w];
  const out = (what: string, join = ": "): Said => ({ watch: w, word, what, phrase: what ? `${word}${join}${what}` : word });
  if (w === "need") return out(NEEDS[st.why ?? ""] ?? "");
  if (w === "work") return out(st.why === "command" ? commandWhat(st) : agentsWorking(st) > 0 ? plural(agentsWorking(st)) : "");
  if (w === "wait") { const on = st.why === "wait" ? st.on : st.why; return out(on ? `for ${waitsFor(on)}` : "", " "); }
  if (w === "resume") return out("to resume", " ");
  if (w === "fail") return out(failWord(st.cls));
  if (w === "stop") return out(st.why === "max_steps" ? "at the step budget" : st.why === "budget" ? "at its budget" : "", " ");
  return out("");
}

// The word as a head shows it, with the agents that keep it working: "Working · 2 agents".
// The count is the agents that work, which is the "working" of the session's agent summary;
// when it started others too it says of how many: "Working · 3 of 12 agents", so the total
// is the one the agents' line under the row starts with (src/core/agent-count.ts), never another.
export function stateLabel(st: Stated): string {
  const s = stateWords(st);
  if (st.watch === "work") {
    const n = agentsWorking(st), all = Math.max(st.agents_total ?? 0, st.agents ?? 0);
    return n > 0 ? `${s.word} · ${all > n ? `${n} of ${plural(all)}` : plural(n)}` : s.word;
  }
  return st.watch === "resume" ? s.phrase : s.word;
}
// The same for a place that shows the word with no reason beside it (a mark's tooltip, a
// recent row, a phone's dock): a session that only keeps a command going says so, since
// "Working" alone would read as a turn that runs.
export function stateAlone(st: Stated): string {
  return st.watch === "work" && st.why === "command" ? cap(commandWhat(st)) : stateLabel(st);
}
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
// What a group of sessions holds, where one head stands for more than one state (a band of the
// folded list): the words of the states in it, each once. "Failed or declined", "Done or not
// started", "Stopped or waiting to resume".
export function holdsWords(watches: readonly Watch[]): string {
  const words = [...new Set(watches.map((w) => stateLabel({ watch: w })))];
  return words.map((t, i) => (i ? t.charAt(0).toLowerCase() + t.slice(1) : t)).join(" or ");
}
// A turn a restart cut that Keel does not go on with (it is no longer waiting to resume): Stopped, with by what.
export const CUT_BY_RESTART = `${STATE_WORD.stop} by a restart`;
// What a session on a machine that does not answer last told, beside its Offline.
export const lastTold = (label: string, text?: string) => `It last told: ${label}${text ? `, ${text}` : ""}`;
// Sessions that came to the list while the owner's hand was on it: they wait at its end.
export const JUST_ARRIVED = "Just arrived";

// A check's level, where Keel checks its own installation (Settings > Health, `keel doctor`) and
// wherever a settings page says a part is well, needs a look or does not work: one word each.
export type Level = "ok" | "warning" | "broken";
export const LEVEL_WORD: Record<Level, string> = { ok: "Well", warning: "Warning", broken: "Broken" };
// A session whose only work is a command it left running. It is working, and is counted with every
// session that works: "in background" is a detail of how it works, never a count of its own.
export const inBackground = (st: Stated | undefined) => st?.watch === "work" && st.why === "command";
// A turn that ended while a command of the session still runs: its alert says so, and is not Done
// (the session is not finished: the command's end starts its next turn, whose end is the finish).
export const TURN_ENDED = "Turn ended";
export const stillRuns = (commands: number) => `${TURN_ENDED}, ${commands === 1 ? "1 command still runs" : `${commands} commands still run`}`;

// The count in a session's head of the requests the owner put away with Later (they still wait on the owner).
export const putAwayCount = (n: number) => `${n} waiting`;

// How many things wait on the owner in these sessions, each once: an approval, a question, a plan,
// a secret to give, a turn to resume, a message not sent. A session with three requests is three.
// The one count behind the tab's title, the home headline, the list's line, the phone's dock and
// the digest's headline. Give it top-level sessions: an agent's request is in its parent's state.
// A session whose machine does not answer is not counted in it (`countsNow`).
export function waitsOnOwner(states: Iterable<Pick<SessionState, "watch" | "asks" | "offline"> | undefined>): number {
  let n = 0;
  for (const st of states) if (st?.watch === "need" && countsNow(st)) n += st.asks ?? 1;
  return n;
}
// Whether a session is counted by its state. One whose machine does not answer is counted as
// Offline and as nothing else: what it last told is not what it is now, and nothing can be
// answered there. Every count of states leaves it out (the tab's title, the headline, the list's line).
export const countsNow = (st: { offline?: boolean } | undefined): boolean => !!st && !st.offline;

// ---- Agents. An agent is a session: its word is its session's.
// The agent's record says how it stands with its parent (running, waiting on
// something it set up, ended and how); its session's served state says what
// it needs or does. One state from both, so the tree, the card, the list of
// background work and the agent's own pane say the same word.
// `slot_wait`: it waits for a free slot of its parent (its wake came, or it was never started).
export type AgentLike = { status: string; stopped_by?: string | null; end_reason?: string | null; slot_wait?: boolean };
const LIVE: readonly Watch[] = ["need", "work", "wait", "resume"];
export function agentState(a: AgentLike, told?: SessionState): SessionState {
  const base = { agents: told?.agents ?? 0 };
  if (a.status === "running" || a.status === "waiting") {
    // In line for a slot: its session's own words (a wait that fired, a task not sent yet) say nothing of that.
    if (a.status === "waiting" && a.slot_wait) return { ...base, watch: "wait", why: "wait", on: "slot", text: "Its parent's agent slots all work: it goes on, first in line, when one frees" };
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
    return { ...base, watch: "stop", ...(a.end_reason === "max_steps" || a.end_reason === "budget" ? { why: a.end_reason } : {}) };
  }
  return { ...base, watch: "stop" };
}

// Who stopped an agent, and why one did not finish, as the owner reads it.
const STOPPED_BY: Record<string, string> = {
  owner: "You stopped this agent", parent: "Its parent agent stopped it", ancestor: "An agent above it was stopped", parent_turn: "Stopped with its parent's turn",
  time_limit: "Its time limit passed", parent_archived: "Its parent session was archived",
  hook: "A hook stopped its turn", supervisor: "The supervisor stopped its turn", api: "Its turn was stopped through the API",
  handoff: "Its turn was stopped to move its session", unknown: "Its turn was stopped",
};
const PARTIAL: Record<string, string> = {
  refusal: "The model declined; the report is partial", max_tokens: "Output limit reached; the report is partial", max_steps: "Step budget spent; the report is partial",
  budget: "Out of its budget; the report is partial, and a message continues it",
};
export const agentWhy = (a: AgentLike) =>
  a.status === "stopped" ? (a.stopped_by ? STOPPED_BY[a.stopped_by] : undefined) : a.status === "incomplete" ? (a.end_reason ? PARTIAL[a.end_reason] : undefined) : undefined;

// ---- Counts. A count says its state in the same words.
export type Counted = "need" | "fail" | "declined" | "work" | "wait" | "stop" | "done" | "idle";
// The order a summary is read in: what needs the owner and what went wrong first, so a line cut short never hides them.
export const COUNT_ORDER: readonly Counted[] = ["need", "fail", "declined", "work", "wait", "stop", "done", "idle"];
export const counted = (w: Watch): Counted => (w === "resume" ? "wait" : w);
// The words of a count without its number ("needs you", "need you", "failed"), and with it.
export const countName = (w: Counted, n: number) => (w === "need" ? `${n === 1 ? "needs" : "need"} you` : STATE_WORD[w].toLowerCase());
export const countWord = (w: Counted, n: number) => `${n} ${countName(w, n)}`;

// A parent's agents by state. Every agent is in exactly one part, so the parts add up to the total;
// a state with none is left out. "8 agents: 1 needs you, 1 failed, 3 working, 2 waiting, 1 done".
export type AgentTally = { total: number; parts: { w: Counted; n: number; text: string }[]; text: string };
export function agentTally(states: readonly Watch[]): AgentTally {
  const n = new Map<Counted, number>();
  for (const w of states) n.set(counted(w), (n.get(counted(w)) ?? 0) + 1);
  const parts = COUNT_ORDER.filter((w) => n.get(w)).map((w) => ({ w, n: n.get(w)!, text: countWord(w, n.get(w)!) }));
  const total = states.length;
  return { total, parts, text: total ? `${plural(total)}: ${parts.map((p) => p.text).join(", ")}` : "" };
}

// Sessions that went wrong, in one count: failed, declined by the model, or both.
export function wentWrongWord(failed: number, declined: number): string {
  if (!declined) return STATE_WORD.fail.toLowerCase();
  return failed ? `${STATE_WORD.fail.toLowerCase()} or ${STATE_WORD.declined.toLowerCase()}` : STATE_WORD.declined.toLowerCase();
}

// ---- A message that waits for its session: the word, and when it is taken.
// `steer`: it joins the running turn; `held`: the session is stopped and its queue waits for the owner.
export function heldWords(m: { steer?: boolean; held?: boolean }): { word: string; when: string } {
  return { word: QUEUED, when: m.held ? "held until it is resumed" : m.steer ? "held until its current step ends" : "held until its turn ends" };
}

// ---- The counters. Each counts one thing and says which.
export const COUNTERS = {
  // With nothing that waits and nothing that went wrong.
  calm: "Nothing needs you",
  // The tab's title, the app's badge and the home headline: things that wait on the owner.
  waiting: (n: number) => (n ? `${n} ${n === 1 ? "thing waits" : "things wait"} on you: approvals, questions, plans and secrets` : "Nothing waits on you"),
  // The bell: alerts that are new since the owner last looked.
  unread: (n: number) => (n ? `${n} unread: new since you last looked` : "Nothing new since you last looked"),
  // The bug: failures of Keel itself the owner has not looked at.
  errors: (n: number) => (n ? `${n} ${n === 1 ? "error" : "errors"} in Keel you have not looked at` : "No new errors in Keel"),
} as const;

// ---- The Inbox. The bell counts what is unread; its panel puts what waits on the owner first,
// then what else is new, then what they have seen. Nothing that waits is ever below a finish.
// An ask is under "Needs you" while its card still waits (`open`, the daemon's word), read or
// not: looking at a request does not answer it. It leaves when it is answered.
export type AlertGroup = "need" | "new" | "seen";
// `live`: a finish raised while something of the session still runs (its commands): a turn that ended, not Done.
export type AlertLike = { kind: string; read: boolean; open?: boolean; data?: { plan_id?: string; secret_id?: string; end?: string; live?: { commands?: number } } | null };
// A finish alert that says the session is done: none raised while something of it still ran.
export const doneAlert = (a: AlertLike) => a.kind === "finished" && !a.data?.live;
export const alertGroup = (a: AlertLike): AlertGroup => (a.open ? "need" : a.read ? "seen" : "new");
export const ALERT_GROUPS: readonly AlertGroup[] = ["need", "new", "seen"];
export const ALERT_GROUP_WORD: Record<AlertGroup, string> = { need: STATE_WORD.need, new: NEW_SINCE, seen: "Earlier" };
// The kinds that wait on the owner (a plan and a secret are raised as questions that name them),
// and the ones that say something went wrong: neither is read because its session is on screen.
export const ASK_KINDS: readonly string[] = ["approval", "question"];
export const WRONG_KINDS: readonly string[] = ["failed", "limit", "loop_failed", "regression", "declined"];
// An alert's kind in the vocabulary: a finish is Done, a failure Failed.
export const ALERT_WORD: Record<string, string> = {
  approval: "Approval", question: "Question", finished: STATE_WORD.done, failed: STATE_WORD.fail, declined: STATE_WORD.declined, limit: "Usage limit", loop_failed: "Loop failed",
  agent: "From the agent", snooze_over: "Snooze over", regression: "Regression", refused: "Refused call", machine: "Machine", outage: "Keel incident", review: "Pull request review", mcp: "MCP server change",
};
// The word of one alert: a question that carries a plan is a Plan, one that asks for a secret a Secret,
// and a turn the model declined is Declined, not Done (`declined`: its session reads so now and this is its newest word).
export function alertWord(a: AlertLike, declined = false): string {
  if (a.kind === "limit" && (a.data as { cls?: string } | null | undefined)?.cls) return limitWord((a.data as { cls?: string }).cls);
  if (a.kind === "question") return a.data?.plan_id ? "Plan" : a.data?.secret_id ? "Secret" : ALERT_WORD.question!;
  if (a.kind === "finished" && (declined || a.data?.end === "refusal")) return STATE_WORD.declined;
  if (a.kind === "finished" && a.data?.live) return TURN_ENDED;
  return ALERT_WORD[a.kind] ?? a.kind;
}
// What the row of an ask offers: the card it opens.
export const askAction = (a: AlertLike) => (a.kind === "approval" || a.data?.plan_id ? "Review" : a.data?.secret_id ? "Open" : "Answer");
