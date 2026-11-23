// The work board's reads of the database, on the read thread (src/server/read-tasks.ts): the agents of a
// session's tree with their worktrees, the latest review of each branch and its verdict line, the
// branches' landing queue entries, the repositories' last passed after-land step, and the check runs on
// a list of trees. Each is a few indexed statements over the tree's rows, never a scan of a whole table
// of events. A table another module makes and has not made yet reads as empty.
import type { Database } from "bun:sqlite";
import { MAX_ROWS, readReport, type ReviewFact } from "./rules.ts";

export type AgentFact = {
  id: string; parent_id: string; session_id: string; depth: number; title: string; type: string; model: string;
  status: string; created: number; ended: number | null; branch: string | null; worktree: string | null; machine: string | null;
  reviews: string | null; // JSON: [{ branch, tip, how }]
  repo_root: string | null; base: string | null; base_commit: string | null; wt_state: string | null; wt_path: string | null;
};
export type { ReviewFact };
export type QueueRow = { id: string; repo: string; branch: string; tip: string; state: string; why: string | null; landed: string | null; updated: number };
export type DeployRow = { repo: string; to_sha: string; ended: number };
export type Facts = { total: number; agents: AgentFact[]; reviews: ReviewFact[]; queue: QueueRow[]; deploys: DeployRow[] };

const tried = <T>(f: () => T[]): T[] => { try { return f(); } catch { return []; } };
const has = (db: Database, table: string, col: string) => tried(() => db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()).some((c) => c.name === col);

// The tree under `root`, to the depth agents can reach and a little past it.
const TREE = "WITH RECURSIVE t(s, d) AS (SELECT ?1, 0 UNION SELECT a.session_id, t.d + 1 FROM agents a JOIN t ON a.parent_id = t.s WHERE t.d < 12)";
// The longest part of a report a verdict is read from: a verdict is said near its start or its end.
const REPORT_HEAD = 16_000, REPORT_TAIL = 4_000;

export function boardFacts(db: Database, a: { root: string }): Facts {
  const reviewsCol = has(db, "agents", "reviews") ? "a.reviews" : "NULL";
  const total = tried(() => db.query<{ n: number }, [string]>(`${TREE} SELECT COUNT(*) AS n FROM agents a JOIN t ON a.parent_id = t.s`).all(a.root))[0]?.n ?? 0;
  const wt = tried(() => db.query<{ n: number }, []>("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'worktrees'").all()).length > 0;
  const agents = tried(() => db.query<AgentFact, [string, number]>(`${TREE}
    SELECT a.id, a.parent_id, a.session_id, t.d + 1 AS depth, a.title, a.type, a.model, a.status, a.created, a.ended, a.branch, a.worktree, a.machine, ${reviewsCol} AS reviews,
      ${wt ? "w.repo_root, w.base, w.base_commit, w.state AS wt_state, w.path AS wt_path" : "NULL AS repo_root, NULL AS base, NULL AS base_commit, NULL AS wt_state, NULL AS wt_path"}
    FROM agents a JOIN t ON a.parent_id = t.s ${wt ? "LEFT JOIN worktrees w ON w.session_id = a.session_id" : ""}
    ORDER BY a.created DESC LIMIT ?2`).all(a.root, MAX_ROWS));
  const branches = new Set(agents.map((x) => x.branch).filter((b): b is string => !!b));

  // Reviews by agents of the tree: each one's report read here into its marks, so only those leave the thread.
  const reviews: ReviewFact[] = [];
  const reviewers = agents.filter((x) => x.reviews);
  const reportOf = db.prepare<{ head: string | null; tail: string | null; n: number }, [string]>(`SELECT substr(result, 1, ${REPORT_HEAD}) AS head, CASE WHEN length(result) > ${REPORT_HEAD} THEN substr(result, -${REPORT_TAIL}) END AS tail, length(result) AS n FROM agents WHERE id = ?`);
  try {
    for (const r of reviewers) {
      let named: { branch: string; tip: string | null; how: "named" | "task" }[] = [];
      try { named = JSON.parse(r.reviews!); } catch { continue; }
      const live = r.status === "running" || r.status === "waiting";
      const rep = live ? undefined : reportOf.get(r.id);
      const read = readReport(live ? "" : rep?.tail ? `${rep.head}\n${rep.tail}` : rep?.head);
      for (const n of named) if (branches.has(n.branch)) reviews.push({ by: r.id, title: r.title, how: n.how, state: r.status, branch: n.branch, tip: n.tip, own: !!r.branch, read, at: r.ended ?? r.created });
    }
  } finally { reportOf.finalize(); }

  // Reviews the owner ran from the Review panel on an agent's branch (src/safety/review.ts), each with its structured verdict.
  const sessions = [a.root, ...agents.map((x) => x.session_id)];
  type PanelRow = { id: string; state: string; created: number; branch: string | null; agent_title: string | null; verdict: string | null; summary: string | null; head: string | null; findings: number | null };
  for (let i = 0; i < sessions.length; i += 100) {
    const part = sessions.slice(i, i + 100);
    const rows = tried(() => db.query<PanelRow, string[]>(`SELECT id, state, created, json_extract(data, '$.agent_branch') AS branch, json_extract(data, '$.agent_title') AS agent_title, json_extract(data, '$.verdict') AS verdict,
      json_extract(data, '$.summary') AS summary, json_extract(data, '$.head') AS head, json_array_length(json_extract(data, '$.findings')) AS findings
      FROM reviews WHERE session_id IN (${part.map(() => "?").join(", ")}) AND json_extract(data, '$.agent_branch') IS NOT NULL ORDER BY created DESC LIMIT 200`).all(...part));
    for (const p of rows) {
      if (!p.branch || !branches.has(p.branch)) continue;
      const verdict = p.verdict === "correct" ? "approved" : p.verdict === "incorrect" ? "refused" : "unclear";
      const line = [p.verdict ? `verdict: ${p.verdict}` : p.state, p.findings ? `${p.findings} ${p.findings === 1 ? "finding" : "findings"}` : "", p.summary ?? ""].filter(Boolean).join(" · ").slice(0, 160);
      reviews.push({ by: p.id, title: p.agent_title ?? "Review", how: "panel", state: p.state, branch: p.branch, tip: typeof p.head === "string" ? p.head : null, own: false, read: { marks: [], verdict, line }, at: p.created });
    }
  }

  // The newest landing queue entry of each branch, and each repository's last after-land step that passed.
  const list = [...branches];
  const queue: QueueRow[] = [];
  for (let i = 0; i < list.length; i += 100) {
    const part = list.slice(i, i + 100);
    queue.push(...tried(() => db.query<QueueRow, string[]>(`SELECT id, repo, branch, tip, state, why, landed, updated FROM landing_queue WHERE branch IN (${part.map(() => "?").join(", ")}) ORDER BY updated DESC LIMIT 400`).all(...part)));
  }
  const repos = [...new Set(agents.map((x) => x.repo_root).filter((r): r is string => !!r))];
  const deploys: DeployRow[] = [];
  for (const repo of repos.slice(0, 20)) {
    deploys.push(...tried(() => db.query<DeployRow, [string]>("SELECT repo, to_sha, ended FROM landing_batches WHERE repo = ? AND to_sha IS NOT NULL AND after IS NOT NULL AND after_exit = 0 ORDER BY ended DESC LIMIT 1").all(repo)));
  }
  return { total, agents, reviews, queue, deploys };
}

export type TreeRun = { tree: string; name: string; command: string; dir: string; result: string; ended: number };

// The passes and failures of every check on each tree given (an index on tree, src/checks/ledger.ts).
export function boardChecks(db: Database, a: { trees: string[] }): TreeRun[] {
  const out: TreeRun[] = [];
  const st = (() => { try { return db.prepare<TreeRun, [string]>("SELECT tree, name, command, dir, result, ended FROM check_runs WHERE tree = ? AND result IN ('pass', 'fail') ORDER BY ended DESC LIMIT 100"); } catch { return undefined; } })();
  if (!st) return out;
  try { for (const t of a.trees.slice(0, MAX_ROWS)) out.push(...st.all(t)); } finally { st.finalize(); }
  return out;
}
