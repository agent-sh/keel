// The state of a session, one fact: what it needs from the owner in one word
// (needs you, working, failed, waiting to resume, stopped, done or not
// started), why, and since when. It is worked out here and nowhere else: the
// daemon gathers what it knows of a session (src/automation/state.ts) and
// sends the answer to every page, and the session tools, the helper, the
// phone, the command line and the alerts read the same answer.
//
// A session is working while its own turn runs or while any agent it started
// still runs or waits: a parent whose turn ended with agents at work is not
// done. An agent's own session keeps its own state.
import type { Session, StoredEvent } from "./types.ts";

// `stop`: the owner (or a parent) stopped the last turn; `resume`: a daemon
// restart cut it and it waits to go on. Neither is done.
export type Watch = "need" | "work" | "fail" | "resume" | "stop" | "done" | "idle";

export const WATCH_LABEL: Record<Watch, string> = {
  need: "Needs you", work: "Working", fail: "Failed", resume: "Waiting to resume", stop: "Stopped", done: "Done", idle: "Not started",
};
// Order of attention: what needs the owner first, quiet work last.
export const WATCH_RANK: Record<Watch, number> = { need: 0, work: 1, fail: 2, resume: 3, stop: 4, done: 5, idle: 6 };
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
  why?: string;     // need: the kind of the first thing that waits (approval, question, plan, unsent)
  text?: string;    // the reason in words: "Approve Bash: rm -rf dist", "Plan to approve"
  since?: number;   // when the reason began (ms)
  asks?: number;    // how many things wait on the owner here, each counted once
  child?: string;   // the agent session the first of them waits in
};

// What the caller knows besides the session row: what waits on the owner
// (its own or an agent's), and the agents still at work. `approvals` and
// `asking` are the same in short, for a caller that has only counts.
export type WatchFacts = { asks?: Ask[]; approvals?: number; asking?: boolean; agents?: number };

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
  return { watch: agents > 0 ? "work" : w, agents };
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
