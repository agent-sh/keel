import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { HOOK_RUNS_SQL, type HookRuns } from "./hook-runs.ts";

test("a hook's runs add up: count, 95th percentile, failures and the last run, one row a hook and event", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE spans (span_id TEXT, kind TEXT, name TEXT, start_ms INTEGER, end_ms INTEGER, status TEXT, attrs TEXT)");
  const add = (hook: string, ms: number, at: number, outcome: string, status = "ok", event = "PreToolUse", kind = "wait", name = "hook") =>
    db.run("INSERT INTO spans VALUES (?, ?, ?, ?, ?, ?, ?)", [crypto.randomUUID(), kind, name, at, at + ms, status, JSON.stringify({ hook, event, file: "/h.json", outcome })]);
  // Twenty runs of 1..20 ms: the 95th percentile is the 19th, 19 ms. The last one timed out.
  for (let i = 1; i <= 20; i++) add("check.sh", i, 1000 + i, i === 20 ? "timed out" : "ok", i === 20 ? "error" : "ok");
  add("check.sh", 5, 2000, "failed", "error", "PostToolUse");
  add("other.sh", 7, 1500, "blocked");
  add("check.sh", 900, 1700, "ok", "ok", "PreToolUse", "tool", "Bash"); // not a hook
  add("old.sh", 3, 10, "ok");                                          // before the window
  const rows = db.query<HookRuns, [number]>(HOOK_RUNS_SQL).all(500);
  const row = (hook: string, event: string) => rows.find((r) => r.hook === hook && r.event === event)!;
  expect(rows.map((r) => `${r.hook}/${r.event}`).sort()).toEqual(["check.sh/PostToolUse", "check.sh/PreToolUse", "other.sh/PreToolUse"]);
  expect(row("check.sh", "PreToolUse")).toMatchObject({ runs: 20, p95_ms: 19, failures: 1, last_ms: 1020, last_outcome: "timed out", file: "/h.json" });
  expect(row("check.sh", "PostToolUse")).toMatchObject({ runs: 1, p95_ms: 5, failures: 1, last_outcome: "failed" });
  expect(row("other.sh", "PreToolUse")).toMatchObject({ runs: 1, p95_ms: 7, failures: 0, last_outcome: "blocked" });
});
