// Which of a session's agents its counts name, said once for every place that
// counts them: the head of its row ("Working · 3 of 12 agents"), the agents
// line under the row, the Overview's "Your agents" and the list the page loads.
//
// An agent is counted while it is live (running, or waiting on a wake of its
// own) and for a day after it started or ended: a session that has run agents
// for a week is not said to have hundreds when the owner sees a dozen. The
// whole tree is counted, its agents' agents too, as the agents line shows it.
// A failure is news until the owner has looked at the session after it: the
// count of failed agents is of those that ended after that look, so one new
// failure reads "1 of its agents failed", not every failure the day held.

export const AGENTS_RECENT_MS = 86_400_000;

// The time from which an ended agent is no longer counted.
export const countedSince = (now = Date.now()) => now - AGENTS_RECENT_MS;

type Counted = { status: string; created: number; ended?: number | null };
// Pure: the page's side of the rule, for the agents it holds.
export const isCounted = (a: Counted, since = countedSince()) =>
  a.status === "running" || a.status === "waiting" || a.created > since || (a.ended ?? 0) > since;

// Pure: a failure the owner has not seen yet (`seen`: the time of the last failure they looked at).
export const failedUnseen = (a: Counted, seen = 0) => a.status === "failed" && (a.ended ?? 0) > seen;

// The same rule in SQL, over the agents table (or an alias of it), with `since` bound at the
// numbered parameter `p` (one value for both of its uses).
export const countedSql = (t: string, p: string) => `(${t}.status IN ('running', 'waiting') OR ${t}.created > ${p} OR ${t}.ended > ${p})`;

// The agents of the tree under the session at `root` that its counts name, as a common table
// `counted(id, status, ended)` for the statement that follows it. Walked down through the counted agents (an
// agent of more than a day ago is not followed: the walk stays on the day's agents however long
// the session ran), and up from each live agent (the partial index agents_live holds only those),
// so a live agent under one that ended long ago is counted too. Each seek is on an index.
export const countedTree = (root: string, since: string) => `WITH RECURSIVE
  down(id, sid, status, ended) AS (
    SELECT id, session_id, status, ended FROM agents WHERE parent_id = ${root} AND ${countedSql("agents", since)}
    UNION
    SELECT a.id, a.session_id, a.status, a.ended FROM agents a JOIN down ON a.parent_id = down.sid WHERE ${countedSql("a", since)}
  ),
  up(id, status, ended, top, n) AS (
    SELECT id, status, ended, parent_id, 0 FROM agents WHERE status IN ('running', 'waiting')
    UNION ALL
    SELECT up.id, up.status, up.ended, a.parent_id, up.n + 1 FROM up JOIN agents a ON a.session_id = up.top WHERE up.n < 32
  ),
  counted(id, status, ended) AS (SELECT id, status, ended FROM down UNION SELECT id, status, ended FROM up WHERE top = ${root})`;
// (A statement that needs more of each agent joins the table after the walk, in that order:
// `FROM counted c CROSS JOIN agents a ON a.id = c.id`, a seek by id for each counted agent.)
