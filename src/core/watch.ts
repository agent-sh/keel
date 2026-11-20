// What a session needs from the owner, in one word: needs you, working,
// failed, waiting to resume, stopped, done or not started. The page, the
// session tools, the helper, the phone and the alerts all read it from here.
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

// What the caller knows besides the session row: approvals, live questions
// (its own or an agent's), and the agents still at work.
export type WatchFacts = { approvals?: number; asking?: boolean; agents?: number };

// An agent still at work: running, or waiting on something it set up.
export const agentLive = (a: { status: string }) => a.status === "running" || a.status === "waiting";

// Live agents per parent session, from any list of agent records.
export function liveAgentCounts(agents: Iterable<{ parent_id: string; status: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of agents) if (agentLive(a)) out[a.parent_id] = (out[a.parent_id] ?? 0) + 1;
  return out;
}

// The session's own state, from its events when they are loaded, else from
// the marks the daemon keeps on it (failed_ms, last_end).
function own(s: Session, events: StoredEvent[] | undefined, f: WatchFacts): Watch {
  if ((f.approvals ?? 0) > 0 || f.asking) return "need";
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

export function watchOf(s: Session, events: StoredEvent[] | undefined, f: WatchFacts = {}): Watch {
  const w = own(s, events, f);
  return w !== "need" && (f.agents ?? 0) > 0 ? "work" : w;
}

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
