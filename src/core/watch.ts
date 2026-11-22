// The state of a session, one fact: what it needs from the owner in one word
// (needs you, working, waiting, failed, declined, waiting to resume, stopped,
// done or not started), why, and since when. It is worked out here and nowhere
// else: the daemon gathers what it knows of a session
// (src/automation/state.ts) and sends the answer to every page, and the
// session tools, the helper, the phone, the command line, the timeline and
// the alerts read the same answer.
//
// The order the facts are read in, first match wins:
//   1. something waits on the owner (an approval, a question, a plan, a secret
//      to give, a turn a restart cut and Keel did not continue, a message that
//      did not go, a running turn whose every call waits on them): needs you;
//   2. its own turn runs: working, with the step;
//   3. an agent it started runs: working;
//   4. its last turn failed and the provider's wait is the reason: waiting,
//      until the time it continues by itself;
//   5. its last turn failed, was declined, was stopped or was cut: that word.
//      A wait still armed does not hide a failure;
//   6. its turn ended and something it set up will start the next one (a
//      timer or another wait, a command left running, an agent that waits):
//      waiting;
//   7. done, or not started.
// A scheduled loop is not a wait: the session is at rest between runs (a
// loop can run for months), and the loop is said beside the state.
// An agent's own session keeps its own state.
// The words are the vocabulary's (ui/src/lib/state-words.ts): one word per
// state, for a session and an agent alike, on the page and in a tool's answer.
import type { Session, StoredEvent, TurnStatus } from "./types.ts";
import { COMMAND_IN_BACKGROUND, STATE_WORD, WAITS_FOR, failWord, stateLabel, waitsFor } from "../../ui/src/lib/state-words.ts";

// `stop`: the owner (or a parent) stopped the last turn, or it stopped at its
// step budget; `resume`: a daemon restart cut it and Keel is about to continue
// it; `declined`: the model refused the last turn. None of them is done.
// `wait`: nothing runs, and something will start the next turn by itself.
export type Watch = "need" | "work" | "wait" | "fail" | "declined" | "resume" | "stop" | "done" | "idle";

// The word of each state as a label: the vocabulary's word, and a turn a restart cut says what it waits to do.
export const WATCH_LABEL: Record<Watch, string> = { ...STATE_WORD, resume: stateLabel({ watch: "resume" }) };
// Order of attention: what needs the owner first, quiet work last.
export const WATCH_RANK: Record<Watch, number> = { need: 0, work: 1, wait: 2, fail: 3, declined: 4, resume: 5, stop: 6, done: 7, idle: 8 };
// The order of a list a person watches: what needs them, what went wrong,
// what waits, what works, then what is at rest. Within a tier the list keeps
// the order the owner arranged.
export const LIST_TIER: Record<Watch, number> = { need: 0, fail: 1, declined: 1, resume: 2, wait: 2, work: 3, stop: 4, done: 4, idle: 4 };
// A state that goes on without the owner or waits on them: never folded away, and timed.
export const AT_REST: readonly Watch[] = ["done", "idle", "stop"];

// How a turn's end reads. A turn the model declined, one cut at the output
// limit and one stopped at its step budget did not do the work: not done.
const ENDED: Record<string, Watch> = { error: "fail", max_tokens: "fail", refusal: "declined", max_steps: "stop", interrupted: "stop", restart: "resume" };
const END_TEXT: Record<string, string> = {
  refusal: "The model declined the turn", max_tokens: "Cut at the output limit", max_steps: "Stopped at the step budget",
};

// One thing that waits on the owner. `text` is what it asks, in its own
// words: the command of an approval, the question, a plan's title. `child`:
// the agent's session it waits in, when it is not the session's own.
// `resume`: a turn a daemon restart cut that Keel did not continue by itself.
// `secret`: a secret the model asked the owner to type into a card.
export type AskKind = "approval" | "question" | "plan" | "secret" | "resume" | "unsent";
export type Ask = { kind: AskKind; text?: string; since?: number; child?: string; agent?: string };

// A running step that has made no progress for too long (src/core/stuck.ts).
// `since`: its last progress, or its start when the step gives no sign of any.
export type StuckMark = { what: "stream" | "model" | "tool" | "step"; text: string; since: number };

// The fact. `why` and `text` say what the word stands on (`why` for code,
// `text` for a reader), `since` when that began.
export type SessionState = {
  watch: Watch;
  agents: number;   // agents of the session still at work
  // Every agent the session started, and of them the ones that failed and the ones that wait
  // on a wake of their own (absent when none): a row can say "12 agents, 4 failed, 1 waiting".
  agents_total?: number;
  agents_failed?: number;
  agents_waiting?: number;
  // need: the kind of the first thing that waits (approval, question, plan, secret, resume, unsent, owner);
  // work: tool, model, stalled (a stream that went silent), retry, compacting, turn, agents;
  // work: also command (its turn ended and a command it left in the background still runs);
  // wait: timer, wait, agent, resume (the turn continues by itself), send (a message waits for the daemon);
  // fail: the failure's class, or max_tokens; declined: refusal; stop: max_steps, held.
  why?: string;
  on?: string;      // wait: the kind of the thing waited for (file, log, http, process, session, ...), when `why` is wait
  parked?: number;  // how many of `agents` wait on something they set up: the rest work
  text?: string;    // the reason in words: "Approve Bash: rm -rf dist", "Plan to approve", "Timer: check the deploy"
  since?: number;   // when the reason began (ms)
  until?: number;   // when what it waits for is due: a timer's wake, a retry, a turn that continues by itself
  cls?: string;     // fail: the failure's class (rate_limit, quota, auth, ...: src/admin/classes.ts), when it has one
  asks?: number;    // how many things wait on the owner here, each counted once
  child?: string;   // the agent session the first of them waits in
  stuck?: StuckMark; // the daemon's word that the running step is stuck
};

// Something the session set up that will start its next turn. `kind`: a
// wait's own kind (timer, file, log, http, process, pr_checks, session, ...),
// `command` for one left running in the background. `agent`: the title of
// the agent of the session that waits on it. `until`: a timer's wake time.
export type Pending = { kind: string; text?: string; since?: number; until?: number; agent?: string };

// What the caller knows besides the session row: what waits on the owner
// (its own or an agent's), the agents still at work, and what the session
// waits on (its own waits and background commands, and those of its agents
// that wait: `parked` is how many of `agents` those are). `approvals` and
// `asking` are `asks` in short, for a caller that has only counts.
// `status`, `turn` and `output`: what the running turn waits on now, when it
// started, and when the reply being streamed last gave output.
export type WatchFacts = {
  asks?: Ask[]; approvals?: number; asking?: boolean; agents?: number; parked?: number; pending?: Pending[];
  // `asking` comes from the engine: the running turn does nothing but wait on the owner (Engine.waitsOnOwner).
  owner?: boolean;
  status?: TurnStatus; turn?: number; output?: number;
  // The tool step in words, when the caller can read the call ("Running bun test").
  step?: string;
  // What the agents that run are, when the session's own turn ended: "Agent Scout", "Checking that the goal is met".
  running?: string;
  // The failure the last turn ended in: its class, its first line, when.
  failure?: { cls?: string; text?: string; at?: number };
  // A turn a restart cut that was not continued: it waits for the owner to continue it.
  held?: { text?: string; since?: number };
  // The queue of a stopped session: prompts that wait until the owner resumes.
  queue?: { held: boolean; queued: number };
};

// An agent still at work: running, or waiting on something it set up.
export const agentLive = (a: { status: string }) => a.status === "running" || a.status === "waiting";

// Live agents per parent session, from any list of agent records.
export function liveAgentCounts(agents: Iterable<{ parent_id: string; status: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of agents) if (agentLive(a)) out[a.parent_id] = (out[a.parent_id] ?? 0) + 1;
  return out;
}

// One line of at most `max` characters.
export const oneLine = (t: unknown, max = 160) => {
  const line = String(t ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

// Why a session needs the owner, in one form for every kind: what is asked
// of them, then the thing itself.
// What stands before the thing itself, by kind. A reader that says the kind in
// its own place (a row with a kind word) shows the text without it (`askThing`).
export const ASK_LEAD: Partial<Record<AskKind, string>> = { approval: "Approve ", question: "Question: ", plan: "Plan to approve: ", secret: "Secret to give: " };
export function askText(a: Ask): string {
  const t = oneLine(a.text);
  const said =
    a.kind === "approval" ? (t ? `${ASK_LEAD.approval}${t}` : "An approval waits")
    : a.kind === "question" ? (t ? `${ASK_LEAD.question}${t}` : "A question waits")
    : a.kind === "plan" ? (t ? `${ASK_LEAD.plan}${t}` : "Plan to approve")
    : a.kind === "secret" ? (t ? `${ASK_LEAD.secret}${t}` : "A secret is asked for")
    : a.kind === "resume" ? "Resume the turn a restart cut"
    : t || "A message was not sent";
  return a.child ? `Agent ${oneLine(a.agent, 40) || "of this session"}: ${said}` : said;
}

// The thing a session's first ask is about, without the words that say its kind:
// "Bash: rm -rf dist" of "Approve Bash: rm -rf dist", "Scout: Bash: ls" of
// "Agent Scout: Approve Bash: ls". Any other text is given as it is.
export function askThing(st: Pick<SessionState, "watch" | "why" | "text" | "child">): string {
  const t = st.text ?? "";
  const lead = st.watch === "need" ? ASK_LEAD[st.why as AskKind] : undefined;
  if (!lead) return t;
  if (t.startsWith(lead)) return t.slice(lead.length);
  const at = st.child && t.startsWith("Agent ") ? t.indexOf(`: ${lead}`) : -1;
  return at > 0 ? `${t.slice(6, at)}: ${t.slice(at + 2 + lead.length)}` : t;
}

// What a wait is on, by its kind (the vocabulary's words). A command left running is not a wait
// of the session's own; an agent that waits on one is said to wait on it.
export function waitWords(kind: unknown) { return kind === "command" ? "a background command" : waitsFor(kind); }
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

// What a session waits for, in one form: the thing, then what the session
// said of it. "Timer: check the deploy", "Command: make test", "Agent Scout: timer".
export function pendingText(p: Pending): string {
  const thing = p.kind === "command" ? "Command" : cap(waitWords(p.kind).replace(/^an? /, ""));
  const t = oneLine(p.text, 120);
  const said = t ? `${thing}: ${t}` : thing;
  return p.agent !== undefined ? `Agent ${oneLine(p.agent, 40) || "of this session"}: ${said.charAt(0).toLowerCase()}${said.slice(1)}` : said;
}
const whyOf = (p: Pending) => (p.agent !== undefined ? "agent" : p.kind === "timer" ? p.kind : "wait");
// A command the session itself left running after its turn: the session works, it does not wait.
const ownCommand = (p: Pending) => p.kind === "command" && p.agent === undefined;

// A span in a few characters: 42s, 4m, 1h 05m, 3d. Minutes are rounded the
// way the timeline says them (90 s is 2 min in both), so one timer has one
// clock wherever it is shown.
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d`;
}

// What a running turn does now, and since when that step began.
function doing(f: WatchFacts): Pick<SessionState, "why" | "text" | "since" | "until"> {
  const st = f.status;
  const since = (t: number | undefined) => (t ? { since: t } : {});
  if (st?.kind === "tool") return { why: "tool", text: f.step || `Running ${st.names.slice(0, 3).join(", ")}${st.names.length > 3 ? ` and ${st.names.length - 3} more` : ""}`, ...since(st.since) };
  if (st?.kind === "model") {
    if (st.quiet) return { why: "stalled", text: "The model is answering, no output", ...since(st.quiet) };
    // The provider answered and the model has said nothing yet: it is answering. Before that the request is on its way
    // (the session works: it is not said to wait, which is the word of a session at rest until something wakes it).
    return { why: "model", text: st.preparing ? "Scaling images for the model" : st.connected ? "The model is answering" : "Calling the model", ...since(st.since) };
  }
  // A retry says when the request goes again: the provider asked for the wait.
  if (st?.kind === "retry") return { why: "retry", text: `Retry ${st.attempt} of ${st.max} of the model request`, ...since(f.turn), ...(st.at ? { until: st.at } : {}) };
  if (st?.kind === "compacting") return { why: "compacting", text: "Compacting the context", ...since(f.turn) };
  return { why: "turn", ...(f.output ? { text: "The model is answering" } : {}), ...since(f.turn) };
}

// The time of day on the reader's 24-hour clock: 09:51.
const hhmm = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// The reason as one sentence part: a silence says how long it has lasted, a
// turn that resumes by itself at what time (worked out where it is read, so
// in the reader's own time zone).
export function whyText(st: SessionState, now = Date.now()): string {
  if (st.why === "stalled" && st.since) return `${st.text} for ${span(now - st.since)}`;
  if (st.why === "resume" && st.watch === "wait" && st.until) return `${st.text} at ${hhmm(st.until)}`;
  return st.text ?? "";
}

// A failure's class in a reader's words: the vocabulary's one fixed set.
export { failWord };

// How long a state has held, or when what it waits for is due: "4m", "due in 14m".
export function clockText(st: SessionState, now = Date.now()): string {
  if (st.until) return st.until > now ? `due in ${span(st.until - now)}` : "due now";
  return st.since ? span(now - st.since) : "";
}

// The state as one line of text, for a terminal: the word, why, and since
// when or until when. "needs you: Approve Bash: rm -rf dist, for 4m".
export function stateLine(st: SessionState, now = Date.now()): string {
  const why = whyText(st, now);
  const time = st.until ? clockText(st, now) : st.since && st.why !== "stalled" ? `for ${span(now - st.since)}` : "";
  const cls = st.watch === "fail" && failWord(st.cls) ? ` (${failWord(st.cls)})` : "";
  return [`${stateLabel(why ? { watch: st.watch } : st).toLowerCase()}${cls}${why ? `: ${why}` : ""}`, time].filter(Boolean).join(", ");
}

// The session's own state and how its last turn ended, from its events when
// they are loaded, else from the marks the daemon keeps on it (failed_ms, last_end).
function own(s: Session, events: StoredEvent[] | undefined): { watch: Watch; end?: string } {
  if (s.phase === "working") return { watch: "work" };
  if (s.phase === "error") return { watch: "fail" };
  if (events) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind === "error") return { watch: "fail" };
      if (e.kind === "turn_end") return { watch: ENDED[e.data.reason] ?? "done", end: String(e.data.reason ?? "") };
      if (e.kind === "user") break;
    }
    // A turn that started and never ended (the daemon stopped under it) failed.
    if (events.some((e) => e.kind === "turn_start")) return { watch: "fail" };
    return { watch: "idle" };
  }
  if (s.settings.failed_ms) return { watch: "fail", end: s.settings.last_end };
  if (s.settings.last_end) return { watch: ENDED[s.settings.last_end] ?? "done", end: s.settings.last_end };
  return { watch: s.usage.output > 0 ? "done" : "idle" };
}

const queued = (n: number) => `${n} queued prompt${n === 1 ? "" : "s"} wait${n === 1 ? "s" : ""} until you resume`;

export function stateOf(s: Session, events: StoredEvent[] | undefined, f: WatchFacts = {}): SessionState {
  const agents = f.agents ?? 0;
  // What waits on the owner comes first, oldest first: nothing else moves until they answer.
  // A turn a restart cut that Keel did not continue is one of those things.
  const asks = [...(f.asks ?? []), ...(f.held ? [{ kind: "resume" as const, ...f.held }] : [])].sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity));
  if (asks.length) {
    const first = asks[0]!;
    const more = asks.length - 1;
    return {
      watch: "need", agents, why: first.kind, text: `${askText(first)}${more ? `, and ${more} more` : ""}`, asks: asks.length,
      ...(first.since ? { since: first.since } : {}), ...(first.child ? { child: first.child } : {}),
    };
  }
  // The caller knows only that it waits on the owner (a count, or a running turn whose every call does): said without the thing.
  if ((f.approvals ?? 0) > 0 || f.asking) return { watch: "need", agents, why: f.approvals ? "approval" : f.owner ? "owner" : "question", ...(f.owner ? { text: "Waits for your answer" } : {}), asks: Math.max(1, f.approvals ?? 0) };
  const { watch: w, end } = own(s, events);
  // How many of its agents wait: the rest work, and a head counts those.
  const parked = f.parked ? { parked: Math.min(agents, f.parked) } : {};
  if (w === "work") return { watch: "work", agents, ...parked, ...(f.status || f.turn ? doing(f) : {}) };
  // Agents that run keep it working, whatever its own last turn came to.
  if (agents - (f.parked ?? 0) > 0) return { watch: "work", agents, ...parked, ...(f.running ? { why: "agents", text: f.running } : {}) };
  // A failure says what kind it was and what the provider said.
  const cls = f.failure?.cls ?? (end === "max_tokens" ? "max_tokens" : undefined);
  const failed = { ...(cls ? { why: cls, cls } : {}), ...(f.failure?.text ? { text: oneLine(f.failure.text, 200) } : END_TEXT[end ?? ""] ? { text: END_TEXT[end!] } : {}), ...(f.failure?.at ? { since: f.failure.at } : {}) };
  // The provider asked for a wait longer than a turn waits, and the session resumes by itself then
  // (settings.continue_at, kept while that failure is the last thing in it): waiting, until that time.
  // Once it gave up after its rounds, or the owner called it off, the mark is gone and it reads Failed.
  const again = s.settings.continue_at?.at;
  if (again && w === "fail") return { watch: "wait", agents, why: "resume", text: "Resumes by itself", until: again, ...(f.failure?.at ? { since: f.failure.at } : {}), ...(cls ? { cls } : {}) };
  // A failure is not hidden by a wait still armed: what went wrong is said first.
  if (w === "fail") return { watch: "fail", agents, ...failed };
  if (w === "declined") return { watch: "declined", agents, why: "refusal", text: END_TEXT.refusal! };
  // A turn the owner stopped, or a restart cut, waits on them, not on a timer.
  if (w === "stop") {
    const text = end === "max_steps" ? END_TEXT.max_steps! : f.queue?.held && f.queue.queued ? queued(f.queue.queued) : undefined;
    return { watch: "stop", agents, ...(text ? { why: end === "max_steps" ? "max_steps" : "held", text } : {}) };
  }
  if (w === "resume" || !f.pending?.length) return { watch: w, agents };
  // A command it left running in the background is work that goes on: working, with the command.
  const commands = f.pending.filter(ownCommand).sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity));
  if (commands.length) {
    const t = oneLine(commands[0]!.text, 120);
    const lead = cap(COMMAND_IN_BACKGROUND);
    return {
      watch: "work", agents, ...parked, why: "command", text: `${t ? `${lead}: ${t}` : lead}${commands.length > 1 ? `, and ${commands.length - 1} more` : ""}`,
      ...(commands[0]!.since ? { since: commands[0]!.since } : {}),
    };
  }
  // What is due first leads; without a due time, what has waited longest.
  const pending = [...f.pending].sort((a, b) => (a.until ?? Infinity) - (b.until ?? Infinity) || (a.since ?? Infinity) - (b.since ?? Infinity));
  const first = pending[0]!;
  const more = pending.length - 1;
  return {
    watch: "wait", agents, ...parked, why: whyOf(first), ...(whyOf(first) === "wait" && first.kind in WAITS_FOR ? { on: first.kind } : {}), text: `${pendingText(first)}${more ? `, and ${more} more` : ""}`,
    ...(first.since ? { since: first.since } : {}), ...(first.until ? { until: first.until } : {}),
  };
}

export const watchOf = (s: Session, events: StoredEvent[] | undefined, f: WatchFacts = {}): Watch => stateOf(s, events, f).watch;

const plural = (n: number) => `${n} agent${n === 1 ? "" : "s"}`;

// The word with what keeps it working: "Working · 2 agents". `agents`: the ones that work.
export function watchLabel(w: Watch, agents = 0): string {
  return stateLabel({ watch: w, agents });
}

// The same in a tool's plain words: "working, 2 agents are still at work".
// `own`: a closer word for the session's own state ("working (tool)").
export function watchWord(w: Watch, agents = 0, own?: string): string {
  const word = own ?? WATCH_LABEL[w].toLowerCase();
  return agents > 0 ? `${word}, ${plural(agents)} ${agents === 1 ? "is" : "are"} still at work` : word;
}
