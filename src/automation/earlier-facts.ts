// The facts the earlier-attempts lookup reads (src/automation/earlier.ts), on the read thread
// (src/server/read-tasks.ts): the agents of one repository with their task words and the first
// words of their reports, and for a few of them the review and landing rows of their branches.
// A few indexed statements, never a scan of all events: the task of an agent is the message its session
// began with. Imports nothing of the daemon.
import type { Database } from "bun:sqlite";

export const CANDIDATES = 400;   // the repository's newest agents read
export const TASK_CHARS = 1_500; // of an agent's task, from where its parent's own words start
export const HEAD_CHARS = 300;   // of its report that rank it (four times that are read, for its first line)

export type Candidate = {
  id: string; session_id: string; title: string; type: string; status: string; created: number; ended: number | null;
  branch: string | null; stopped_by: string | null; end_reason: string | null; machine: string | null;
  base_commit: string | null; repo_root: string | null;
  task: string; head: string;
};

const tried = <T>(f: () => T[]): T[] => { try { return f(); } catch { return []; } };

// The agents whose work was in this repository: they had a worktree of it, or their folder is in it (or in a
// worktree an agent of it made). Reviewers a spawn named a branch for are left out: their verdicts are read
// with the branch they judged. `skip`: sessions that are not candidates (the asking agent's own).
export function earlierCandidates(db: Database, a: { repo: string; skip?: string[] }): Candidate[] {
  const own = (col: string) => `(${col} = ?1 OR substr(${col}, 1, length(?1) + 1) = ?1 || '/')`;
  const rows = tried(() => db.query<Omit<Candidate, "task" | "head"> & { text: string | null; report: string | null }, [string, number]>(
    `SELECT a.id, a.session_id, a.title, a.type, a.status, a.created, a.ended, a.branch, a.stopped_by, a.end_reason, a.machine,
       w.base_commit, COALESCE(w.repo_root, wp.repo_root) AS repo_root,
       (SELECT substr(json_extract(e.data, '$.text'), COALESCE(json_extract(e.data, '$.task_at'), 0) + 1, ${TASK_CHARS}) FROM events e WHERE e.session_id = a.session_id AND e.kind = 'user' AND json_extract(e.data, '$.kind') = 'task' ORDER BY e.seq LIMIT 1) AS text,
       substr(a.result, 1, ${HEAD_CHARS * 4}) AS report
     FROM agents a JOIN sessions s ON s.id = a.session_id
       LEFT JOIN worktrees w ON w.session_id = a.session_id
       LEFT JOIN worktrees wp ON wp.session_id = a.parent_id
     WHERE (COALESCE(w.repo_root, wp.repo_root) = ?1 OR ${own("s.workspace")}) AND a.reviews IS NULL
     ORDER BY a.created DESC LIMIT ?2`).all(a.repo, CANDIDATES));
  const skip = new Set(a.skip ?? []);
  return rows.filter((r) => !skip.has(r.session_id)).map(({ text, report, ...r }) => ({ ...r, task: text ?? "", head: report ?? "" }));
}

// What the review and the landing rows say of some branches of one repository.
export type Outcome = {
  verdicts: { branch: string; land: string; why: string; at: number }[];
  panel: { branch: string; verdict: string | null; priority: number | null; title: string | null; at: number }[];
  landed: { branch: string; tip: string; at: number }[];
  reports: Record<string, string>; // an agent id to the start and the end of its report, for the commits it names
};

export function earlierOutcomes(db: Database, a: { repo: string; branches: string[]; agents: string[] }): Outcome {
  const out: Outcome = { verdicts: [], panel: [], landed: [], reports: {} };
  if (a.branches.length) {
    const list = JSON.stringify(a.branches);
    out.verdicts = tried(() => db.query<{ branches: string; land: string; why: string; at: number }, []>("SELECT branches, land, why, at FROM review_verdicts ORDER BY at DESC LIMIT 3000").all())
      .flatMap((v) => { try { return (JSON.parse(v.branches) as string[]).filter((b) => a.branches.includes(b)).map((branch) => ({ branch, land: v.land, why: v.why, at: v.at })); } catch { return []; } });
    out.panel = tried(() => db.query<{ branch: string; verdict: string | null; priority: number | null; title: string | null; at: number }, [string]>(
      `SELECT json_extract(data, '$.agent_branch') AS branch, json_extract(data, '$.verdict') AS verdict, json_extract(data, '$.findings[0].priority') AS priority,
         json_extract(data, '$.findings[0].title') AS title, created AS at
       FROM reviews WHERE json_extract(data, '$.agent_branch') IN (SELECT value FROM json_each(?1)) AND state = 'done' ORDER BY created DESC LIMIT 200`).all(list));
    out.landed = tried(() => db.query<{ branch: string; tip: string; at: number }, [string, string]>(
      "SELECT branch, tip, updated AS at FROM landing_queue WHERE repo = ?1 AND state = 'landed' AND branch IN (SELECT value FROM json_each(?2)) ORDER BY updated DESC LIMIT 200").all(a.repo, list));
  }
  for (const id of a.agents) {
    const r = tried(() => db.query<{ head: string | null; tail: string | null }, [string]>("SELECT substr(result, 1, 6000) AS head, CASE WHEN length(result) > 6000 THEN substr(result, -2000) END AS tail FROM agents WHERE id = ?").all(id))[0];
    if (r) out.reports[id] = `${r.head ?? ""}\n${r.tail ?? ""}`;
  }
  return out;
}
