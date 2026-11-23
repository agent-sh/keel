// A reviewer's structured verdicts (keel__verdict): one row per reviewer and commit, the newest call
// replacing an earlier one. The work board (src/board/facts.ts) says approved or refused from these, an
// output_schema answer or the Review panel, never from a report's words.
import type { Database } from "bun:sqlite";

export function ensureVerdicts(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS review_verdicts (
    agent_id TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    branches TEXT NOT NULL,
    land TEXT NOT NULL,
    why TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, commit_sha)
  )`);
}

export function recordVerdict(db: Database, v: { agent: string; commit: string; branches: string[]; land: "yes" | "no"; why: string; at?: number }) {
  db.query("INSERT OR REPLACE INTO review_verdicts (agent_id, commit_sha, branches, land, why, at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(v.agent, v.commit, JSON.stringify(v.branches), v.land, v.why, v.at ?? Date.now());
}
