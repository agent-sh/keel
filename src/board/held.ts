// Whether a base holds a head: as an ancestor, else as the same patch for each of its commits (`git cherry`,
// which sees work a stack landed by cherry-picking its commits under new hashes). The one rule for the work
// board's landed fact and for the earlier attempts a spawn is told of. The caller says how to run git and
// keeps the answers it wants kept (the board keeps its pairs, src/automation/earlier.ts its own).
import { landedFrom, type Landed } from "./rules.ts";

export type RunGit = (args: string[]) => Promise<{ code: number; out: string; err?: string }>;

// `since`: when the agent started (ms), for a branch with no record of where it started.
export async function baseHolds(run: RunGit, head: string, into: string, o: { madeFrom?: string | null; since?: number | null } = {}): Promise<Landed> {
  const madeFrom = o.madeFrom ?? null;
  const since = o.since ?? null;
  if (madeFrom && head === madeFrom) return { state: "nothing" };
  const anc = await run(["merge-base", "--is-ancestor", head, into]);
  if (anc.err === "late") return { state: "unknown", why: "the board's time for git ran out" };
  const ancestor = anc.code === 0 ? true : anc.code === 1 ? false : null;
  if (ancestor === true && !madeFrom && since != null) {
    const t = await run(["log", "-1", "--format=%ct", head]);
    const headTime = t.code === 0 ? Number(t.out.trim()) || null : null;
    return headTime === null ? { state: "unknown", why: "its worktree keeps no start, and git did not say when its head was made" } : landedFrom({ head, madeFrom, ancestor, cherry: undefined, headTime, since: Math.floor(since / 1000) - 60 });
  }
  if (ancestor !== false) return landedFrom({ head, madeFrom, ancestor, cherry: undefined });
  const ch = await run(["cherry", into, head]);
  if (ch.err === "late") return { state: "unknown", why: "the board's time for git ran out" };
  return landedFrom({ head, madeFrom, ancestor, cherry: ch.code === 0 ? ch.out : undefined });
}
