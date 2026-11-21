// The state of a session, one fact: what it needs from the owner in one word
// (needs you, working, waiting, failed, waiting to resume, stopped, done or
// not started), why, and since when. It is worked out here and nowhere else: the
// daemon gathers what it knows of a session (src/automation/state.ts) and
// sends the answer to every page, and the session tools, the helper, the
// phone, the command line and the alerts read the same answer.
//
// A session is working while its own turn runs or while any agent it started
// still runs: a parent whose turn ended with agents at work is not done. It
// is waiting when its turn ended and something it set up will wake it: a
// timer or another wait, a command left running in the background, an agent
// that itself waits. An agent's own session keeps its own state.
import type { Session, StoredEvent, TurnStatus } from "./types.ts";

// `stop`: the owner (or a parent) stopped the last turn; `resume`: a daemon
// restart cut it and it waits to go on. Neither is done. `wait`: nothing runs,
// and something the session set up will start its next turn.
export type Watch = "need" | "work" | "wait" | "fail" | "resume" | "stop" | "done" | "idle";

export const WATCH_LABEL: Record<Watch, string> = {
  need: "Needs you", work: "Working", wait: "Waiting", fail: "Failed", resume: "Waiting to resume", stop: "Stopped", done: "Done", idle: "Not started",
};
// Order of attention: what needs the owner first, quiet work last.
export const WATCH_RANK: Record<Watch, number> = { need: 0, work: 1, wait: 2, fail: 3, resume: 4, stop: 5, done: 6, idle: 7 };
const ENDED: Record<string, Watch> = { error: "fail", interrupted: "stop", restart: "resume" };

// One thing that waits on the owner. `text` is what it asks, in its own
// words: the command of an approval, the question, a plan's title. `child`:
// the agent's session it waits in, when it is not the session's own.
export type AskKind = "approval" | "question" | "plan" | "unsent";
export type Ask = { kind: AskKind; text?: string; since?: number; child?: string; agent?: string };

// The fact. `why` and `text` say what the word stands on (`why` for code,
// `text` for a reader), `since` when that began.
export type SessionState = {
  watch: Watch;
  agents: number;   // agents of the session still at work
  why?: string;     // need: the kind of the first thing that waits (approval, question, plan, unsent); wait: timer, wait, command, agent;
                    // work: tool, model, stalled (a stream that went silent), retry, compacting, turn
  text?: string;    // the reason in words: "Approve Bash: rm -rf dist", "Plan to approve", "Timer: check the deploy"
  since?: number;   // when the reason began (ms)
  until?: number;   // wait: when what it waits for is due (a timer's wake)
  cls?: string;     // fail: the failure's class (rate_limit, quota, auth, ...: src/admin/classes.ts), when it has one
  asks?: number;    // how many things wait on the owner here, each counted once
  child?: string;   // the agent session the first of them waits in
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
  status?: TurnStatus; turn?: number; output?: number;
  // The tool step in words, when the caller can read the call ("Running bun test").
  step?: string;
  // The failure the last turn ended in: its class, its first line, when.
  failure?: { cls?: string; text?: string; at?: number };
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
export function askText(a: Ask): string {
  const t = oneLine(a.text);
  const said =
    a.kind === "approval" ? (t ? `Approve ${t}` : "An approval waits")
    : a.kind === "question" ? (t ? `Question: ${t}` : "A question waits")
    : a.kind === "plan" ? (t ? `Plan to approve: ${t}` : "Plan to approve")
    : t || "A message was not sent";
  return a.child ? `Agent ${oneLine(a.agent, 40) || "of this session"}: ${said}` : said;
}

// What a wait is on, by its kind.
const WAIT_ON: Record<string, string> = {
  timer: "a timer", file: "a file", log: "a log line", http: "an HTTP check", process: "a process", monitor: "a monitor",
  websocket: "a WebSocket", pr_checks: "a pull request's checks", session: "another session", command: "a background command",
  wake: "a wake of its own",
};
export function waitWords(kind: unknown) { return WAIT_ON[String(kind)] ?? "a condition"; }
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

// What a session waits for, in one form: the thing, then what the session
// said of it. "Timer: check the deploy", "Command: make test", "Agent Scout: timer".
export function pendingText(p: Pending): string {
  const thing = p.kind === "command" ? "Command" : cap(waitWords(p.kind).replace(/^an? /, ""));
  const t = oneLine(p.text, 120);
  const said = t ? `${thing}: ${t}` : thing;
  return p.agent !== undefined ? `Agent ${oneLine(p.agent, 40) || "of this session"}: ${said.charAt(0).toLowerCase()}${said.slice(1)}` : said;
}
const whyOf = (p: Pending) => (p.agent !== undefined ? "agent" : p.kind === "timer" || p.kind === "command" ? p.kind : "wait");

// A span in a few characters: 42s, 4m, 1h 05m, 3d.
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 86400)}d`;
}

// What a running turn does now, and since when that step began.
function doing(f: WatchFacts): Pick<SessionState, "why" | "text" | "since"> {
  const st = f.status;
  const since = (t: number | undefined) => (t ? { since: t } : {});
  if (st?.kind === "tool") return { why: "tool", text: f.step || `Running ${st.names.slice(0, 3).join(", ")}${st.names.length > 3 ? ` and ${st.names.length - 3} more` : ""}`, ...since(st.since) };
  if (st?.kind === "model") {
    if (st.quiet) return { why: "stalled", text: "The model is answering, no output", ...since(st.quiet) };
    return { why: "model", text: st.preparing ? "Scaling images for the model" : "Waiting for the model", ...since(st.since) };
  }
  if (st?.kind === "retry") return { why: "retry", text: `Retrying the model request, attempt ${st.attempt} of ${st.max}`, ...since(f.turn) };
  if (st?.kind === "compacting") return { why: "compacting", text: "Compacting the context", ...since(f.turn) };
  return { why: "turn", ...(f.output ? { text: "The model is answering" } : {}), ...since(f.turn) };
}

// The reason as one sentence part: a silence says how long it has lasted.
export function whyText(st: SessionState, now = Date.now()): string {
  if (st.why === "stalled" && st.since) return `${st.text} for ${span(now - st.since)}`;
  return st.text ?? "";
}

// A failure's class in a reader's words. A class with no better word than
// the failure itself (other) has none.
const FAIL_WORD: Record<string, string> = {
  rate_limit: "rate limit", overloaded: "overloaded", server: "server error", stream_drop: "stream dropped", context_overflow: "context full",
  auth: "sign-in", quota: "billing", refusal: "declined", image: "image refused", invalid_request: "invalid request",
};
export const failWord = (cls: string | undefined) => (cls ? FAIL_WORD[cls] ?? "" : "");

// The state as one line of text, for a terminal: the word, why, and since
// when or until when. "needs you: Approve Bash: rm -rf dist, for 4m".
export function stateLine(st: SessionState, now = Date.now()): string {
  const why = whyText(st, now);
  const time = st.until ? (st.until > now ? `due in ${span(st.until - now)}` : "due now") : st.since && st.why !== "stalled" ? `for ${span(now - st.since)}` : "";
  const cls = st.watch === "fail" && failWord(st.cls) ? ` (${failWord(st.cls)})` : "";
  return [`${watchLabel(st.watch, why ? 0 : st.agents).toLowerCase()}${cls}${why ? `: ${why}` : ""}`, time].filter(Boolean).join(", ");
}

// The session's own state, from its events when they are loaded, else from
// the marks the daemon keeps on it (failed_ms, last_end).
function own(s: Session, events: StoredEvent[] | undefined): Watch {
  if (s.phase === "working") return "work";
  if (s.phase === "error") return "fail";
  if (events) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind === "error") return "fail";
      if (e.kind === "turn_end") return ENDED[e.data.reason] ?? "done";
      if (e.kind === "user") break;
    }
    // A turn that started and never ended (the daemon stopped under it) failed.
    if (events.some((e) => e.kind === "turn_start")) return "fail";
    return "idle";
  }
  if (s.settings.failed_ms) return "fail";
  if (s.settings.last_end) return ENDED[s.settings.last_end] ?? "done";
  return s.usage.output > 0 ? "done" : "idle";
}

export function stateOf(s: Session, events: StoredEvent[] | undefined, f: WatchFacts = {}): SessionState {
  const agents = f.agents ?? 0;
  // What waits on the owner comes first, oldest first: nothing else moves until they answer.
  const asks = [...(f.asks ?? [])].sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity));
  if (asks.length) {
    const first = asks[0]!;
    const more = asks.length - 1;
    return {
      watch: "need", agents, why: first.kind, text: `${askText(first)}${more ? `, and ${more} more` : ""}`, asks: asks.length,
      ...(first.since ? { since: first.since } : {}), ...(first.child ? { child: first.child } : {}),
    };
  }
  if ((f.approvals ?? 0) > 0 || f.asking) return { watch: "need", agents, why: f.approvals ? "approval" : "question", asks: Math.max(1, f.approvals ?? 0) };
  const w = own(s, events);
  // Agents that run keep it working, whatever its own last turn came to.
  if (w === "work") return { watch: "work", agents, ...(f.status || f.turn ? doing(f) : {}) };
  if (agents - (f.parked ?? 0) > 0) return { watch: "work", agents };
  // A turn the owner stopped, or a restart cut, waits on them, not on a timer.
  // A failure says what kind it was and what the provider said.
  const failed = w === "fail" && f.failure ? { why: f.failure.cls ?? "error", ...(f.failure.cls ? { cls: f.failure.cls } : {}), ...(f.failure.text ? { text: oneLine(f.failure.text, 200) } : {}), ...(f.failure.at ? { since: f.failure.at } : {}) } : {};
  if (w === "stop" || w === "resume" || !f.pending?.length) return { watch: w, agents, ...failed };
  // What is due first leads; without a due time, what has waited longest.
  const pending = [...f.pending].sort((a, b) => (a.until ?? Infinity) - (b.until ?? Infinity) || (a.since ?? Infinity) - (b.since ?? Infinity));
  const first = pending[0]!;
  const more = pending.length - 1;
  return {
    watch: "wait", agents, why: whyOf(first), text: `${pendingText(first)}${more ? `, and ${more} more` : ""}`,
    ...(first.since ? { since: first.since } : {}), ...(first.until ? { until: first.until } : {}),
  };
}

export const watchOf = (s: Session, events: StoredEvent[] | undefined, f: WatchFacts = {}): Watch => stateOf(s, events, f).watch;

const plural = (n: number) => `${n} agent${n === 1 ? "" : "s"}`;

// The word with what keeps it working: "Working · 2 agents".
export function watchLabel(w: Watch, agents = 0): string {
  return w === "work" && agents > 0 ? `${WATCH_LABEL.work} · ${plural(agents)}` : WATCH_LABEL[w];
}

// The same in a tool's plain words: "working, 2 agents are still at work".
// `own`: a closer word for the session's own state ("working (tool)").
export function watchWord(w: Watch, agents = 0, own?: string): string {
  const word = own ?? WATCH_LABEL[w].toLowerCase();
  return agents > 0 ? `${word}, ${plural(agents)} ${agents === 1 ? "is" : "are"} still at work` : word;
}
