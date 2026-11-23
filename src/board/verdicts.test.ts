// The table of reviewers' structured verdicts: its rows go with their agent's row.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ensureVerdicts, recordVerdict } from "./verdicts.ts";

const fresh = () => {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run("CREATE TABLE agents (id TEXT PRIMARY KEY)");
  db.run("INSERT INTO agents (id) VALUES ('a1'), ('a2')");
  return db;
};
const count = (db: Database) => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM review_verdicts").get()!.n;

test("a verdict goes with its reviewer's agent row", () => {
  const db = fresh();
  expect(ensureVerdicts(db)).toBe(true);
  recordVerdict(db, { agent: "a1", commit: "c".repeat(40), branches: ["keel/x"], land: "yes", why: "ok" });
  recordVerdict(db, { agent: "a2", commit: "c".repeat(40), branches: ["keel/x"], land: "no", why: "P1" });
  db.run("DELETE FROM agents WHERE id = 'a1'");
  expect(db.query<{ agent_id: string }, []>("SELECT agent_id FROM review_verdicts").all().map((r) => r.agent_id)).toEqual(["a2"]);
});

test("a table made before that is made again, keeping the rows whose agent is there", () => {
  const db = fresh();
  db.run("CREATE TABLE review_verdicts (agent_id TEXT NOT NULL, commit_sha TEXT NOT NULL, branches TEXT NOT NULL, land TEXT NOT NULL, why TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (agent_id, commit_sha))");
  db.run("INSERT INTO review_verdicts VALUES ('a1', 'c', '[]', 'yes', 'ok', 1), ('gone', 'c', '[]', 'no', 'x', 1)");
  ensureVerdicts(db);
  expect(count(db)).toBe(1);
  db.run("DELETE FROM agents");
  expect(count(db)).toBe(0);
});

test("not made before the agents table is there", () => {
  const db = new Database(":memory:");
  expect(ensureVerdicts(db)).toBe(false);
});
