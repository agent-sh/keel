import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { resultOf } from "./results.ts";

test("a coordinator's result follows its own checks and its tree's landing queue, not its agents' checks", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE check_runs (id INTEGER PRIMARY KEY, name TEXT, session_id TEXT, by TEXT, result TEXT, ended INTEGER)");
  db.run("CREATE INDEX check_runs_session ON check_runs(session_id, ended, id)");
  db.run("CREATE TABLE agents (session_id TEXT, parent_id TEXT)");
  db.run("CREATE INDEX agents_parent ON agents(parent_id)");
  db.run("CREATE INDEX agents_session ON agents(session_id)");
  db.run("CREATE TABLE landing_queue (queued_by TEXT, branch TEXT, state TEXT, landed TEXT, updated INTEGER)");
  const store = { db } as unknown as Store;
  const top = { id: "top" } as Session;
  const run = (name: string, session: string, result: string, ended: number, by = "agent") =>
    db.query("INSERT INTO check_runs (name, session_id, by, result, ended) VALUES (?, ?, ?, ?, ?)").run(name, session, by, result, ended);
  db.run("INSERT INTO agents VALUES ('a1', 'top'), ('a2', 'top'), ('x1', 'other')");
  for (let i = 0; i < 50; i++) run(`old-${i}`, i % 2 ? "a1" : "a2", "pass", 1_000 + i);
  expect(resultOf(store, top)).toBeUndefined();
  run("unit", "top", "fail", 2_000);
  expect(resultOf(store, top)).toEqual({ kind: "check", what: "unit", ok: false, at: 2_000 });
  // Other sessions, beside runs and incomplete runs do not replace the coordinator's result.
  run("theirs", "x1", "fail", 5_000);
  run("beside", "top", "fail", 5_001, "beside");
  run("running", "top", "error", 5_002);
  run("typecheck", "a2", "pass", 6_000);
  expect(resultOf(store, top)?.what).toBe("unit");
  run("typecheck", "top", "pass", 7_000, "owner");
  expect(resultOf(store, top)).toEqual({ kind: "check", what: "typecheck", ok: true, at: 7_000 });
  db.run("INSERT INTO agents VALUES ('a3', 'top')");
  run("e2e", "a3", "pass", 8_000);
  expect(resultOf(store, top)?.what).toBe("typecheck");
  db.run("INSERT INTO landing_queue VALUES ('a3', 'keel/fix', 'landed', 'aaaaaaaaaaaaaaaa', 9_000), ('x1', 'keel/other', 'landed', 'bbbbbbbbbbbbbbbb', 10_000)");
  expect(resultOf(store, top)).toEqual({ kind: "landed", what: "keel/fix", ok: true, head: "aaaaaaaaa", at: 9_000 });
  run("e2e", "a3", "fail", 11_000);
  expect(resultOf(store, top)?.kind).toBe("landed");
  // An agent is no top session: it has no line of its own.
  expect(resultOf(store, { id: "a1", parent_id: "top" } as Session)).toBeUndefined();
});
