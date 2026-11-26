// The sessions whose work boards the landing cards are read from (src/integrations/mobile/landings.ts), on the
// read thread (src/server/read-tasks.ts): the trees whose agents made branches lately, and every tree, however old,
// with a finished agent's branch a reviewer approved that the landing queue has not landed, whose worktree was
// not removed and that no board read settled (`landing_settled`: found landed, gone or past its board's rows, for
// as long as its agent has not ended again). The second is bounded by branches, never by trees: an old tree with
// one approved branch is not pushed out by newer trees with nothing to land. The approved and the landed branches
// are each one set, made once, and the agents are walked once against them, so the read grows with the rows, not
// with their product. A table another module makes and has not made yet reads as empty.
import type { Database } from "bun:sqlite";

// A finished agent's branch with an approving review: its agent's parent session and when it ended.
export type ApprovedBranch = { id: string; parent_id: string; branch: string; ended: number | null };
// `cut`: approved branches a board read left out by its row cap (said on the list, never a card); `reads`: when each
// tree read only for an approved branch was read last, so the rotation goes on where it was across restarts.
export type ReadyRoots = { recent: string[]; approved: ApprovedBranch[]; cut: ApprovedBranch[]; reads: { root: string; at: number }[] };

// What a board read settles an approved branch with, kept across restarts: by agent and when it ended.
export const SETTLED_TABLE = "CREATE TABLE IF NOT EXISTS landing_settled (agent_id TEXT PRIMARY KEY, ended INTEGER, why TEXT NOT NULL, at INTEGER NOT NULL)";

// When a tree read only for an approved branch was last read (src/integrations/mobile/landings.ts).
export const READS_TABLE = "CREATE TABLE IF NOT EXISTS landing_reads (root TEXT PRIMARY KEY, at INTEGER NOT NULL)";
export const CUT_WHY = "past its board's rows";

const tried = <T>(f: () => T[]): T[] => { try { return f(); } catch { return []; } };
const table = (db: Database, name: string) => tried(() => db.query<{ n: number }, [string]>("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = ?").all(name)).length > 0;
const column = (db: Database, t: string, col: string) => tried(() => db.query<{ name: string }, []>(`PRAGMA table_info(${t})`).all()).some((c) => c.name === col);

export function readyRoots(db: Database, a: { since: number; recent: number; branches: number }): ReadyRoots {
  const recent = tried(() => db.query<{ parent_id: string }, [number, number]>(
    "SELECT parent_id, MAX(created) AS at FROM agents WHERE branch IS NOT NULL AND created > ? GROUP BY parent_id ORDER BY at DESC LIMIT ?",
  ).all(a.since, a.recent)).map((r) => r.parent_id);

  // What approves a branch: a reviewer's structured verdict naming it (or naming only a commit, from a reviewer
  // named for the branch), the owner's Review panel saying correct, or a finished reviewer named for it (its
  // report's LAND line is read by the board). The board then says what the head is ready for; this only says
  // which trees can hold a card.
  const reviewers = column(db, "agents", "reviews");
  const says: string[] = [];
  if (table(db, "review_verdicts")) {
    says.push("SELECT j.value FROM review_verdicts v, json_each(v.branches) j WHERE v.land = 'yes'");
    if (reviewers) says.push("SELECT json_extract(n.value, '$.branch') FROM review_verdicts v JOIN agents b ON b.id = v.agent_id, json_each(b.reviews) n WHERE v.land = 'yes' AND json_array_length(v.branches) = 0 AND b.reviews IS NOT NULL");
  }
  if (table(db, "reviews")) says.push("SELECT json_extract(r.data, '$.agent_branch') FROM reviews r WHERE json_extract(r.data, '$.verdict') = 'correct'");
  if (reviewers) says.push("SELECT json_extract(j.value, '$.branch') FROM agents b, json_each(b.reviews) j WHERE b.reviews IS NOT NULL AND b.status = 'completed'");
  const reads = table(db, "landing_reads") ? tried(() => db.query<{ root: string; at: number }, []>("SELECT root, at FROM landing_reads").all()) : [];
  if (!says.length) return { recent, approved: [], cut: [], reads };
  const sets = [`ok(branch) AS (${says.join(" UNION ")})`];
  const left: string[] = [];
  if (table(db, "landing_queue")) {
    sets.push("landed(branch) AS (SELECT DISTINCT branch FROM landing_queue WHERE state = 'landed')");
    left.push("a.branch NOT IN (SELECT branch FROM landed)");
  }
  if (table(db, "worktrees")) left.push("NOT EXISTS (SELECT 1 FROM worktrees w WHERE w.session_id = a.session_id AND w.state = 'removed')");
  const settled = table(db, "landing_settled");
  const of = (extra: string, args: (number | string)[]) => tried(() => db.query<ApprovedBranch, (number | string)[]>(`WITH ${sets.join(", ")}
    SELECT a.id, a.parent_id, a.branch, a.ended FROM agents a
    WHERE a.branch IN (SELECT branch FROM ok) AND a.status NOT IN ('running', 'waiting') ${[...left, extra].filter(Boolean).map((x) => `AND ${x}`).join(" ")}
    ORDER BY a.created DESC LIMIT ?`).all(...args));
  const approved = of(settled ? "NOT EXISTS (SELECT 1 FROM landing_settled s WHERE s.agent_id = a.id AND s.ended IS a.ended)" : "", [a.branches]);
  const cut = settled ? of("EXISTS (SELECT 1 FROM landing_settled s WHERE s.agent_id = a.id AND s.ended IS a.ended AND s.why = ?)", [CUT_WHY, a.branches]) : [];
  return { recent, approved, cut, reads };
}
