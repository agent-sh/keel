import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { resultOf } from "./results.ts";

// The last result of a top session is the newest of its own runs and its agents' runs. After the first read a
// new run is read by itself: the answer follows each new run, an agent's included, and only runs of its tree.
test("a top session's last result follows each new run of its tree, read by itself after the first", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE check_runs (id INTEGER PRIMARY KEY, name TEXT, session_id TEXT, by TEXT, result TEXT, ended INTEGER)");
  db.run("CREATE INDEX check_runs_session ON check_runs(session_id, ended, id)");
  db.run("CREATE TABLE agents (session_id TEXT, parent_id TEXT)");
  db.run("CREATE INDEX agents_parent ON agents(parent_id)");
  db.run("CREATE INDEX agents_session ON agents(session_id)");
  const store = { db } as unknown as Store;
  const top = { id: "top" } as Session;
  const run = (name: string, session: string, result: string, ended: number, by = "agent") =>
    db.query("INSERT INTO check_runs (name, session_id, by, result, ended) VALUES (?, ?, ?, ?, ?)").run(name, session, by, result, ended);
  db.run("INSERT INTO agents VALUES ('a1', 'top'), ('a2', 'top'), ('x1', 'other')");
  for (let i = 0; i < 50; i++) run(`old-${i}`, i % 2 ? "a1" : "a2", "pass", 1_000 + i);
  expect(resultOf(store, top)).toEqual({ kind: "check", what: "old-49", ok: true, at: 1_049 });
  // Another tree's run, a beside run and a run with no result say nothing of this one.
  run("theirs", "x1", "fail", 5_000);
  run("beside", "a1", "fail", 5_001, "beside");
  run("running", "a1", "error", 5_002);
  expect(resultOf(store, top)?.what).toBe("old-49");
  // An agent's new red run, then the session's own green one.
  run("unit", "a2", "fail", 6_000);
  expect(resultOf(store, top)).toEqual({ kind: "check", what: "unit", ok: false, at: 6_000 });
  run("typecheck", "top", "pass", 7_000, "owner");
  expect(resultOf(store, top)).toEqual({ kind: "check", what: "typecheck", ok: true, at: 7_000 });
  // An agent started after the first read is the tree's too.
  db.run("INSERT INTO agents VALUES ('a3', 'top')");
  run("e2e", "a3", "pass", 8_000);
  expect(resultOf(store, top)?.what).toBe("e2e");
  // A run written later that ended earlier than the kept one does not take its place.
  run("late", "a1", "pass", 7_500);
  expect(resultOf(store, top)?.what).toBe("e2e");
  // An agent is no top session: it has no line of its own.
  expect(resultOf(store, { id: "a1", parent_id: "top" } as Session)).toBeUndefined();
});
