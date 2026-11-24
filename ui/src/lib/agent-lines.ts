// A parent's agents as lines: under the step that started them, one line per
// agent of the whole tree below it (its own agents, theirs, and so on), and up
// the tree from an agent's own page (its root, the agents between, itself).
// Pure: what the page holds (the agent records, the states the daemon told,
// the agents' "now" lines) in, the lines out.
//
// Every line's state is read through `lineState`, the one place that says how
// an agent stands for these lines; it is the state every other surface reads
// (src/core/state-words.ts agentState over the daemon's served state).
import { rootOf, treeRows, type TreeAgent } from "../../../src/core/agent-tree.ts";
import { agentState, type AgentLike } from "../../../src/core/state-words.ts";
import type { SessionState } from "../../../src/core/watch.ts";

type Agent = TreeAgent & AgentLike & { title: string; ended?: number | null; task_at?: number | null };

// How an agent stands, for every line here. (The one read: a change of where the state comes from is this line.)
export const lineState = (a: AgentLike, told: SessionState | undefined): SessionState => agentState(a, told);

export type AgentLine<T extends Agent> = { agent: T; depth: number; below: number; state: SessionState };

// The lines under a step: each agent it started, followed by every agent below it, oldest first at
// each level. `depth` is 1 for the step's own agents. `from`: the agents the step started, in the
// step's order; `all`: every agent the page holds (a live one under an old one is reached through it).
export function treeLines<T extends Agent>(all: Iterable<T>, from: readonly T[], told: Readonly<Record<string, SessionState | undefined>>): AgentLine<T>[] {
  const list = [...all];
  const out: AgentLine<T>[] = [];
  const seen = new Set<string>();
  for (const a of from) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const rows = treeRows(list, a.session_id);
    out.push({ agent: a, depth: 1, below: rows.length, state: lineState(a, told[a.session_id]) });
    for (const r of rows) {
      if (seen.has(r.agent.id)) continue;
      seen.add(r.agent.id);
      out.push({ agent: r.agent, depth: r.depth + 1, below: r.below, state: lineState(r.agent, told[r.agent.session_id]) });
    }
  }
  return out;
}

// The session at the top of an agent's tree, by the records the page holds: the feed of the tree's lines is named by it.
export function treeRoot(all: Iterable<TreeAgent>, sessionId: string): string {
  const up = new Map<string, string>();
  for (const a of all) up.set(a.session_id, a.parent_id);
  return rootOf((id) => up.get(id), sessionId);
}

// The way up from a session to its tree's root: the root first, then each agent between, the session
// itself last. Each step is the session's id and the title the page knows it by (the session's own
// title where the page holds it, else its agent's). A session that is nobody's agent has one step.
export type Crumb = { session_id: string; title: string; agent_id?: string };
export function crumbsOf(all: Iterable<Agent>, titleOf: (sessionId: string) => string | undefined, sessionId: string, parentOf?: (sessionId: string) => string | null | undefined): Crumb[] {
  const bySession = new Map<string, Agent>();
  for (const a of all) bySession.set(a.session_id, a);
  const out: Crumb[] = [];
  const seen = new Set<string>();
  for (let at: string | null | undefined = sessionId; at && !seen.has(at) && out.length < 33; ) {
    seen.add(at);
    const a = bySession.get(at);
    out.push({ session_id: at, title: titleOf(at) || a?.title || "Session", ...(a ? { agent_id: a.id } : {}) });
    at = a?.parent_id ?? parentOf?.(at);
  }
  return out.reverse();
}
