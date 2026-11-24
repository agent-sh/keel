// Rows of a review history, written into a running daemon's store: two builder models (the first with four
// lanes done, one refused and then fixed, one with a red check on its head, two clean; the second with two
// clean), and a reviewer model that refused one lane, saw it fixed and approved it, and approved another, at
// a known price. Usage: bun review-yield.ts <keel.db> <parent session id>
// The counts the view must show: build-a 50% of 4 (2 lanes); build-b 0% of 2; review-x 1 real refusal, $2.50, 0.40 a dollar, 1.5 rounds a lane.
import { Database } from "bun:sqlite";
import { ensureVerdicts } from "../../../src/board/verdicts.ts";

const [file, parent] = process.argv.slice(2);
const db = new Database(file!);
db.run("PRAGMA busy_timeout = 20000");
// (The verdicts table is made when the first verdict is written.)
ensureVerdicts(db);
const now = Date.now();
const agent = (id: string, model: string, o: { branch?: string; reviews?: string; ended?: number } = {}) =>
  db.query("INSERT INTO agents (id, parent_id, session_id, title, type, model, background, status, created, ended, branch, reviews) VALUES (?, ?, ?, ?, 'general-purpose', ?, 1, 'completed', ?, ?, ?, ?)")
    .run(id, parent!, `s-${id}`, id, model, now - 3_600_000, o.ended ?? now - 3_000_000, o.branch ?? null, o.reviews ?? null);
const verdict = (by: string, commit: string, branch: string, land: string, at: number) =>
  db.query("INSERT INTO review_verdicts (agent_id, commit_sha, branches, land, why, at) VALUES (?, ?, ?, ?, 'checked', ?)").run(by, commit, JSON.stringify([branch]), land, at);
const run = (session: string, head: string, result: string, ended: number, tree: string) =>
  db.query("INSERT INTO check_runs (key, name, command, dir, repo, tree, head, session_id, by, result, started, ended) VALUES ('unit', 'unit', 'bun test', '/x', '/x', ?, ?, ?, 'agent', ?, ?, ?)").run(tree, head, session, result, ended - 1000, ended);

db.transaction(() => {
  for (const [id, model] of [["a1", "scripted:build-a"], ["a2", "scripted:build-a"], ["a3", "scripted:build-a"], ["a4", "scripted:build-a"], ["b1", "scripted:build-b"], ["b2", "scripted:build-b"]] as const) agent(id, model, { branch: `keel/${id}` });
  agent("rev", "scripted:review-x", { reviews: JSON.stringify([{ branch: "keel/a1", how: "task" }]) });
  const t = now - 2_000_000;
  verdict("rev", "c1", "keel/a1", "no", t);
  verdict("rev", "c1b", "keel/a1", "yes", t + 60_000);
  verdict("rev", "c2", "keel/a2", "yes", t + 30_000);
  // a3's reported head failed in another session; nothing approved it.
  run("s-a3", "h3", "pass", now - 3_100_000, "own-tree");
  run("s-other", "h3", "fail", t, "other-tree");
  // The review session's spend: one request at $2.50.
  db.query("INSERT INTO telemetry_calls (session_id, ts, model, input, output, cost, unpriced, outcome, purpose) VALUES ('s-rev', ?, 'scripted:review-x', 1000, 100, 2.5, 0, 'ok', 'turn')").run(t);
})();
db.close();
