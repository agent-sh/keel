// A reviewer's structured verdicts (keel__verdict): one row per reviewer and commit, the newest call
// replacing an earlier one, gone with the reviewer's agent row. The work board (src/board/facts.ts) says
// approved or refused from these, an output_schema answer or the Review panel, never from a report's words.
import type { Database } from "bun:sqlite";

const TABLE = `CREATE TABLE IF NOT EXISTS review_verdicts (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  branches TEXT NOT NULL,
  land TEXT NOT NULL,
  why TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, commit_sha)
)`;

const ready = new WeakSet<Database>();

// The table, made once the agents table it hangs on is there (false: not yet). A table made before its
// rows went with their agent is made again, keeping the rows whose agent is still there.
export function ensureVerdicts(db: Database): boolean {
  if (ready.has(db)) return true;
  const has = (name: string) => !!db.query<{ n: number }, [string]>("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  if (!has("agents")) return false;
  db.transaction(() => {
    if (has("review_verdicts") && !db.query<{ table: string }, []>("PRAGMA foreign_key_list(review_verdicts)").all().some((f) => f.table === "agents")) {
      db.run("ALTER TABLE review_verdicts RENAME TO review_verdicts_old");
      db.run(TABLE);
      db.run("INSERT INTO review_verdicts SELECT * FROM review_verdicts_old WHERE agent_id IN (SELECT id FROM agents)");
      db.run("DROP TABLE review_verdicts_old");
    } else db.run(TABLE);
  })();
  ready.add(db);
  return true;
}

export function recordVerdict(db: Database, v: { agent: string; commit: string; branches: string[]; land: "yes" | "no"; why: string; at?: number }) {
  ensureVerdicts(db);
  db.query("INSERT OR REPLACE INTO review_verdicts (agent_id, commit_sha, branches, land, why, at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(v.agent, v.commit, JSON.stringify(v.branches), v.land, v.why, v.at ?? Date.now());
}

// What a reviewer's `land` says, in the forms models send it: yes or no, true or false (a boolean or its text),
// approve or refuse. Anything else says nothing.
const YES = new Set(["yes", "y", "true", "approve", "approved", "land", "lgtm"]);
const NO = new Set(["no", "n", "false", "refuse", "refused", "reject", "rejected", "block", "blocked"]);
export function landOf(v: unknown): "yes" | "no" | undefined {
  if (v === true) return "yes";
  if (v === false) return "no";
  if (typeof v !== "string") return undefined;
  const w = v.trim().toLowerCase();
  return YES.has(w) ? "yes" : NO.has(w) ? "no" : undefined;
}
