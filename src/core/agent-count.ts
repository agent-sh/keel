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
