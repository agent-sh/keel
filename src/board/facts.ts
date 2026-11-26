// The work board's reads of the database, on the read thread (src/server/read-tasks.ts): the agents of a
// session's tree with their worktrees, the reviews of each branch with their structured verdicts and LAND lines, the
// branches' landing queue entries, the repositories' last passed after-land step, and the check runs on
// a list of trees. Each is a few indexed statements over the tree's rows, never a scan of a whole table
// of events. A table another module makes and has not made yet reads as empty.
import type { Database } from "bun:sqlite";
import { landLines, MAX_ROWS, outputVerdicts, type ReviewFact, type StructuredVerdict } from "./rules.ts";

export type AgentFact = {
  id: string; parent_id: string; session_id: string; depth: number; title: string; type: string; model: string;
  status: string; created: number; ended: number | null; branch: string | null; worktree: string | null; machine: string | null;
  reviews: string | null; // JSON: [{ branch, tip, how }]
  structured: number;     // its task was given an output_schema
  repo_root: string | null; base: string | null; base_commit: string | null; wt_state: string | null; wt_path: string | null;
};
export type { ReviewFact };
export type QueueRow = { id: string; repo: string; branch: string; tip: string; state: string; why: string | null; landed: string | null; updated: number };
export type VerdictRow = { agent_id: string; commit_sha: string; branches: string; land: string; why: string; at: number };
export type DeployRow = { repo: string; to_sha: string; ended: number; after_install?: string | null };
// A pair the branches were checked in (src/landing/together.ts), as its row keeps it.
export type PairCheckRow = { repo: string; tip1: string; tip2: string; branch1: string; branch2: string; base_tip: string | null; why: string; detail: string | null; state: string; checks: string | null; error: string | null; started: number; ended: number | null };
// live_cut: agents that work or wait and are still not among `agents` (only when more of them work than MAX_ROWS).
export type Facts = { total: number; live_cut: number; agents: AgentFact[]; reviews: ReviewFact[]; queue: QueueRow[]; deploys: DeployRow[]; pairs: PairCheckRow[] };

const tried = <T>(f: () => T[]): T[] => { try { return f(); } catch { return []; } };
const has = (db: Database, table: string, col: string) => tried(() => db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()).some((c) => c.name === col);

// The tree under `root`, to the depth agents can reach and a little past it.
const TREE = "WITH RECURSIVE t(s, d) AS (SELECT ?1, 0 UNION SELECT a.session_id, t.d + 1 FROM agents a JOIN t ON a.parent_id = t.s WHERE t.d < 12)";
// An agent that works or waits: it is on the board before any finished one, so the row cap never hides one behind
// newer finished siblings (newest first within each, and the rows still go newest first).
const LIVE = "(a.status IN ('running', 'waiting'))";
// The longest part of a report a verdict is read from: a verdict is said near its start or its end.
const REPORT_HEAD = 16_000, REPORT_TAIL = 4_000;
// The longest answer to an output_schema read for its verdicts.
const ANSWER_MAX = 64_000;

export function boardFacts(db: Database, a: { root: string }): Facts {
  const reviewsCol = has(db, "agents", "reviews") ? "a.reviews" : "NULL";
  const counted = tried(() => db.query<{ n: number; live: number | null }, [string]>(`${TREE} SELECT COUNT(*) AS n, SUM(${LIVE}) AS live FROM agents a JOIN t ON a.parent_id = t.s`).all(a.root))[0];
  const total = counted?.n ?? 0;
  const wt = tried(() => db.query<{ n: number }, []>("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'worktrees'").all()).length > 0;
  const agents = tried(() => db.query<AgentFact, [string, number]>(`${TREE}
    SELECT a.id, a.parent_id, a.session_id, t.d + 1 AS depth, a.title, a.type, a.model, a.status, a.created, a.ended, a.branch, a.worktree, a.machine, ${reviewsCol} AS reviews, a.output_schema IS NOT NULL AS structured,
      ${wt ? "w.repo_root, w.base, w.base_commit, w.state AS wt_state, w.path AS wt_path" : "NULL AS repo_root, NULL AS base, NULL AS base_commit, NULL AS wt_state, NULL AS wt_path"}
    FROM agents a JOIN t ON a.parent_id = t.s ${wt ? "LEFT JOIN worktrees w ON w.session_id = a.session_id" : ""}
    ORDER BY ${LIVE} DESC, a.created DESC LIMIT ?2`).all(a.root, MAX_ROWS)).sort((x, y) => y.created - x.created);
  const live_cut = Math.max(0, (counted?.live ?? 0) - agents.filter((x) => x.status === "running" || x.status === "waiting").length);
  const branches = new Set(agents.map((x) => x.branch).filter((b): b is string => !!b));

  // Reviews by agents of the tree: the branches each names (its spawn's `reviews` or its task), its
  // structured verdicts (keel__verdict calls, an output_schema answer) and its report's LAND lines, read
  // here so only those leave the thread.
  const reviews: ReviewFact[] = [];
  const given = new Map<string, VerdictRow[]>();
  const ids = agents.map((x) => x.id);
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    for (const v of tried(() => db.query<VerdictRow, [string]>("SELECT agent_id, commit_sha, branches, land, why, at FROM review_verdicts WHERE agent_id IN (SELECT value FROM json_each(?)) ORDER BY at DESC LIMIT 2000").all(JSON.stringify(part))))
      given.set(v.agent_id, [...(given.get(v.agent_id) ?? []), v]);
  }
  // Each reviewer's sessions up to the root, from the agents table (not the board's page of rows, which may
  // leave an agent between them out), so a review by an agent below a row's agent is known as its own.
  const chainOf = (() => { try { return db.prepare<{ s: string }, [string]>("WITH RECURSIVE up(s, d) AS (SELECT ?1, 0 UNION SELECT a.parent_id, up.d + 1 FROM agents a JOIN up ON a.session_id = up.s WHERE up.d < 32) SELECT s FROM up ORDER BY d"); } catch { return undefined; } })();
  const reportOf = db.prepare<{ head: string | null; tail: string | null; n: number }, [string]>(`SELECT substr(result, 1, ${REPORT_HEAD}) AS head, CASE WHEN length(result) > ${REPORT_HEAD} THEN substr(result, -${REPORT_TAIL}) END AS tail, length(result) AS n FROM agents WHERE id = ?`);
  const answerOf = db.prepare<{ result: string | null }, [string]>(`SELECT CASE WHEN length(result) <= ${ANSWER_MAX} THEN result END AS result FROM agents WHERE id = ?`);
  try {
    for (const r of agents) {
      let named: { branch: string; tip: string | null; how: "named" | "task" }[] = [];
      if (r.reviews) try { named = JSON.parse(r.reviews); } catch {}
      const live = r.status === "running" || r.status === "waiting";
      const verdicts: StructuredVerdict[] = (given.get(r.id) ?? []).map((v) => {
        let branches: string[] | null = null;
        try { branches = JSON.parse(v.branches); } catch {}
        return { sha: v.commit_sha, land: v.land === "yes" ? "yes" : "no", why: v.why, at: v.at, from: "verdict", branches };
      });
      if (r.structured && r.status === "completed") {
        let value: unknown;
        try { value = JSON.parse(answerOf.get(r.id)?.result ?? ""); } catch {}
        // (Its answer names commits only: they are of the branch it reviews when it reviews one.)
        const solo = named.length === 1 ? [named[0]!.branch] : null;
        verdicts.push(...outputVerdicts(value, r.ended ?? r.created).map((v) => ({ ...v, branches: solo })));
      }
      if (!named.length && !verdicts.length) continue;
      const rep = live ? undefined : reportOf.get(r.id);
      const lines = landLines(live ? "" : rep?.tail ? `${rep.head}\n${rep.tail}` : rep?.head);
      let chain: string[] | null = null;
      try { chain = chainOf ? chainOf.all(r.session_id).map((x) => x.s) : null; } catch {}
      const fact = (branch: string | null, how: ReviewFact["how"], tip: string | null): ReviewFact => ({ by: r.id, title: r.title, how, state: r.status, branch, tip, own: !!r.branch, chain, verdicts, lines, at: r.ended ?? r.created });
      const seen = new Set<string>();
      for (const n of named) if (branches.has(n.branch) && !seen.has(n.branch)) { seen.add(n.branch); reviews.push(fact(n.branch, n.how, n.tip)); }
      for (const v of verdicts) for (const b of v.branches ?? []) if (branches.has(b) && !seen.has(b)) { seen.add(b); reviews.push(fact(b, "verdict", null)); }
      // (Verdicts on commits no branch of the tree held when they were given: a row whose head one names.)
      if (verdicts.some((v) => !v.branches?.some((b) => branches.has(b)))) reviews.push({ ...fact(null, "verdict", null), lines: [] });
    }
  } finally { reportOf.finalize(); answerOf.finalize(); chainOf?.finalize(); }

  // Reviews the owner ran from the Review panel on an agent's branch (src/safety/review.ts), each with its structured verdict.
  const sessions = [a.root, ...agents.map((x) => x.session_id)];
  type PanelRow = { id: string; state: string; created: number; branch: string | null; agent_title: string | null; verdict: string | null; summary: string | null; head: string | null; findings: number | null };
  for (let i = 0; i < sessions.length; i += 100) {
    const part = sessions.slice(i, i + 100);
    const rows = tried(() => db.query<PanelRow, [string]>(`SELECT id, state, created, json_extract(data, '$.agent_branch') AS branch, json_extract(data, '$.agent_title') AS agent_title, json_extract(data, '$.verdict') AS verdict,
      json_extract(data, '$.summary') AS summary, json_extract(data, '$.head') AS head, json_array_length(json_extract(data, '$.findings')) AS findings
      FROM reviews WHERE session_id IN (SELECT value FROM json_each(?)) AND json_extract(data, '$.agent_branch') IS NOT NULL ORDER BY created DESC LIMIT 200`).all(JSON.stringify(part)));
    for (const p of rows) {
      if (!p.branch || !branches.has(p.branch)) continue;
      const land = p.verdict === "correct" ? "yes" : p.verdict === "incorrect" ? "no" : undefined;
      const head = typeof p.head === "string" && /^[0-9a-f]{7,40}$/.test(p.head) ? p.head : null;
      const line = [p.verdict ? `verdict: ${p.verdict}` : p.state, p.findings ? `${p.findings} ${p.findings === 1 ? "finding" : "findings"}` : "", p.summary ?? ""].filter(Boolean).join(" · ").slice(0, 160);
      reviews.push({
        by: p.id, title: p.agent_title ?? "Review", how: "panel", state: p.state, branch: p.branch, tip: head, own: false, chain: [], lines: [], panel: line, at: p.created,
        verdicts: land && head ? [{ sha: head, land, why: line, at: p.created, from: "panel", branches: [p.branch] }] : [],
        ...(land && !head ? { said: land === "yes" ? "approved" as const : "refused" as const } : {}),
      });
    }
  }

  // The newest landing queue entry of each branch, and each repository's last after-land step that passed.
  const list = [...branches];
  const queue: QueueRow[] = [];
  for (let i = 0; i < list.length; i += 100) {
    const part = list.slice(i, i + 100);
    queue.push(...tried(() => db.query<QueueRow, [string]>("SELECT id, repo, branch, tip, state, why, landed, updated FROM landing_queue WHERE branch IN (SELECT value FROM json_each(?)) ORDER BY updated DESC LIMIT 400").all(JSON.stringify(part))));
  }
  const repos = [...new Set(agents.map((x) => x.repo_root).filter((r): r is string => !!r))];
  const deploys: DeployRow[] = [];
  for (const repo of repos.slice(0, 20)) {
    deploys.push(...tried(() => db.query<DeployRow, [string]>("SELECT repo, to_sha, ended, after_install FROM landing_batches WHERE repo = ? AND to_sha IS NOT NULL AND after IS NOT NULL AND after_exit = 0 ORDER BY ended DESC LIMIT 1").all(repo)));
  }
  const pairs: PairCheckRow[] = [];
  for (const repo of repos.slice(0, 20)) {
    pairs.push(...tried(() => db.query<PairCheckRow, [string, string]>(`SELECT repo, tip1, tip2, branch1, branch2, base_tip, why, detail, state, checks, error, started, ended FROM pair_checks
      WHERE repo = ?1 AND (branch1 IN (SELECT value FROM json_each(?2)) OR branch2 IN (SELECT value FROM json_each(?2))) ORDER BY started DESC LIMIT 400`).all(repo, JSON.stringify(list))));
  }
  return { total, live_cut, agents, reviews, queue, deploys, pairs };
}

export type TreeRun = { tree: string; head: string | null; session_id: string; name: string; command: string; dir: string; result: string; ended: number };

// The passes and failures of every check on each tree given (an index on tree, src/checks/ledger.ts), and
// the runs a session made with one of its heads checked out: those on another tree ran on files that were not
// committed (the head's commit plus what the worktree changed). Only the row's own session's runs count: another
// session's run at the same head (the owner's checkout at the base tip, another agent) says nothing of this
// agent's files. Each pair is read through the index on head and session, at most 100 runs of it.
export function boardChecks(db: Database, a: { trees: string[]; heads?: { head: string; session: string }[] }): TreeRun[] {
  const out: TreeRun[] = [];
  const COLS = "tree, head, session_id, name, command, dir, result, ended";
  const st = (() => { try { return db.prepare<TreeRun, [string]>(`SELECT ${COLS} FROM check_runs WHERE tree = ? AND result IN ('pass', 'fail') ORDER BY ended DESC LIMIT 100`); } catch { return undefined; } })();
  if (!st) return out;
  try { for (const t of a.trees.slice(0, MAX_ROWS)) out.push(...st.all(t)); } finally { st.finalize(); }
  if (a.heads?.length) {
    const on = (() => { try { return db.prepare<TreeRun, [string, string]>(`SELECT ${COLS} FROM check_runs INDEXED BY check_runs_head WHERE head = ? AND session_id = ? AND result IN ('pass', 'fail') ORDER BY ended DESC LIMIT 100`); } catch { return undefined; } })();
    if (on) try { for (const h of a.heads.slice(0, MAX_ROWS)) out.push(...on.all(h.head, h.session)); } finally { on.finalize(); }
  }
  return out;
}

// The before and after pictures of each head given (src/pictures/run.ts), by the index on head.
export type PictureRow = { id: number; repo: string; common: string; head: string; merge_base: string | null; state: string; why: string | null; selection: string | null; sides: string; pairs: string | null; kept: number };
export function boardPictures(db: Database, a: { heads: string[] }): PictureRow[] {
  const out: PictureRow[] = [];
  const st = (() => { try { return db.prepare<PictureRow, [string]>("SELECT id, repo, common, head, merge_base, state, why, selection, sides, pairs, kept FROM pictures WHERE head = ? ORDER BY id DESC LIMIT 4"); } catch { return undefined; } })();
  if (!st) return out;
  try { for (const h of a.heads.slice(0, MAX_ROWS)) out.push(...st.all(h)); } finally { st.finalize(); }
  return out;
}
