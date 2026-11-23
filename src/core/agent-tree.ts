// Agents that start agents: the tree under one session, in pure functions the
// daemon and the page share. A session that is nobody's agent is a root; an
// agent's session has its parent's id. Depth counts the agents between a
// session and its root: the root is at 0, the agents it started at 1.
//
// The limits, and why:
// - Depth: agents start agents down to 3 levels below the root by default
//   (KEEL_MAX_AGENT_DEPTH). Claude Code's default is three layers; Codex and
//   OpenCode default to one (no nesting). Three lets a task split twice (a
//   coordinator, its workers, a checker per finding) and stops a runaway
//   chain early. An agent at the limit is told it cannot start agents, and a
//   start there is refused with a reason it can act on.
// - Budget: one count for the whole tree (the root's agent limit, 8 live at
//   once by default). Claude Code and Codex count every agent of a session the
//   same way. Nesting then never multiplies what one session may run.

// The parent of a session, or nothing for a root (and for a session the reader does not know).
export type ParentOf = (sessionId: string) => string | null | undefined;

// A chain longer than this is not followed (a loop in damaged data would never end).
const HOPS = 32;

export const DEFAULT_MAX_DEPTH = 3;

// A whole number of at least 1 from the environment, else the default (read at each use).
export function maxDepth(env: string | undefined = process.env.KEEL_MAX_AGENT_DEPTH): number {
  const n = Number(env);
  return env !== undefined && env !== "" && Number.isSafeInteger(n) && n >= 1 ? n : DEFAULT_MAX_DEPTH;
}

// How many agents lie between the session and its root (0 for a root).
export function depthOf(parentOf: ParentOf, sessionId: string): number {
  let n = 0;
  for (let p = parentOf(sessionId); p && n < HOPS; p = parentOf(p)) n++;
  return n;
}

// The session at the top of the tree the session is in (itself for a root).
export function rootOf(parentOf: ParentOf, sessionId: string): string {
  let at = sessionId;
  for (let n = 0, p = parentOf(at); p && n < HOPS; n++, p = parentOf(p)) at = p;
  return at;
}

// Whether a session at this depth may start an agent (one level deeper than itself).
export const canStart = (depth: number, max: number) => depth + 1 <= max;

// How many more levels a session at this depth may start below itself.
export const levelsLeft = (depth: number, max: number) => Math.max(0, max - depth);

// What the tree needs of an agent's record.
export type TreeAgent = { id: string; session_id: string; parent_id: string; created: number };
// One row of the tree as it is shown: the agent, how deep it is under the root
// (1 for the root's own agents) and how many agents are below it.
export type TreeRow<T extends TreeAgent> = { agent: T; depth: number; below: number };

// The agents under `root`, each followed by its own agents, oldest first at
// every level: the order a list shows them in.
export function treeRows<T extends TreeAgent>(agents: Iterable<T>, root: string): TreeRow<T>[] {
  const kids = new Map<string, T[]>();
  for (const a of agents) (kids.get(a.parent_id) ?? kids.set(a.parent_id, []).get(a.parent_id)!).push(a);
  for (const list of kids.values()) list.sort((x, y) => x.created - y.created || x.id.localeCompare(y.id));
  const out: TreeRow<T>[] = [];
  const seen = new Set<string>([root]);
  const walk = (parent: string, depth: number): number => {
    let total = 0;
    for (const a of kids.get(parent) ?? []) {
      if (seen.has(a.session_id) || depth > HOPS) continue;
      seen.add(a.session_id);
      const row: TreeRow<T> = { agent: a, depth, below: 0 };
      out.push(row);
      row.below = walk(a.session_id, depth + 1);
      total += 1 + row.below;
    }
    return total;
  };
  walk(root, 1);
  return out;
}

// The agents below one session: its own, theirs, and so on (the session itself not included).
export function descendants<T extends TreeAgent>(agents: Iterable<T>, sessionId: string): T[] {
  return treeRows(agents, sessionId).map((r) => r.agent);
}

// The agent's place as a path of titles from the root's agent down to it: "Coordinator > Checker".
export function pathOf<T extends TreeAgent & { title: string }>(agents: Iterable<T>, a: T): string {
  const bySession = new Map<string, T>();
  for (const x of agents) bySession.set(x.session_id, x);
  const names = [a.title];
  for (let p = bySession.get(a.parent_id), n = 0; p && n < HOPS; p = bySession.get(p.parent_id), n++) names.unshift(p.title);
  return names.join(" > ");
}

// How many of the given agents are below each session, at any depth: a
// session's count is its own agents and all of theirs. `agents`: live ones,
// as their parent and session.
export function countBelow(agents: Iterable<{ parent_id: string; session_id: string }>): Map<string, number> {
  const up = new Map<string, string>();
  const list = [...agents];
  for (const a of list) up.set(a.session_id, a.parent_id);
  // (An agent is live only while every agent above it is: a stop goes down
  // the tree, and an agent does not finish while its own agents work. So the
  // live ones alone hold every chain up to the root.)
  const out = new Map<string, number>();
  for (const a of list) {
    let at: string | undefined = a.parent_id;
    for (let n = 0; at && n < HOPS; n++, at = up.get(at)) out.set(at, (out.get(at) ?? 0) + 1);
  }
  return out;
}

// A list of sessions with each agent's session moved under the session that
// started it, in the list's own order at every level, and its depth there.
// One whose parent is not in the list stays where it is, at depth 0.
export function nested<T extends { id: string; parent_id?: string | null }>(list: readonly T[]): { item: T; depth: number }[] {
  const ids = new Set(list.map((s) => s.id));
  const kids = new Map<string, T[]>();
  for (const s of list) if (s.parent_id && ids.has(s.parent_id) && s.parent_id !== s.id) (kids.get(s.parent_id) ?? kids.set(s.parent_id, []).get(s.parent_id)!).push(s);
  const out: { item: T; depth: number }[] = [];
  const seen = new Set<string>();
  const put = (s: T, depth: number) => {
    if (seen.has(s.id) || depth > HOPS) return;
    seen.add(s.id);
    out.push({ item: s, depth });
    for (const k of kids.get(s.id) ?? []) put(k, depth + 1);
  };
  for (const s of list) if (!(s.parent_id && ids.has(s.parent_id))) put(s, 0);
  // (A loop in damaged data: what is left goes at the end, flat.)
  for (const s of list) put(s, 0);
  return out;
}
