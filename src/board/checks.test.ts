// The runs the work board reads for a branch's head: those on its tree, and its own session's runs made with
// the head checked out on other files (uncommitted). Another session's run at the same head is not the agent's.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bindLedger, record, unbindLedger } from "../checks/ledger.ts";
import { Store } from "../core/store.ts";
import { boardChecks } from "./facts.ts";

const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `board-checks-${process.pid}`);
mkdirSync(root, { recursive: true });
afterAll(() => { unbindLedger(); rmSync(root, { recursive: true, force: true }); });

test("only the row's own session's runs on its head count as uncommitted", () => {
  const store = new Store(join(root, "state"));
  bindLedger(store);
  const run = (session_id: string, tree: string, head: string, result: "pass" | "fail" = "pass") =>
    record({ name: "notes", command: "sh check.sh", dir: ".", repo: "/r", tree, head, session_id, call_id: null, by: "agent", result, exit: 0, pass: null, fail: null, started: 1, ended: 2, log: null, from_run: null });
  run("agent-1", "tree-wip-1", "head-a");
  run("owner-or-other", "tree-wip-2", "head-a");
  run("agent-2", "tree-wip-3", "head-b");
  const got = boardChecks(store.db, { trees: ["tree-head-a"], heads: [{ head: "head-a", session: "agent-1" }] });
  expect(got.map((r) => [r.session_id, r.tree])).toEqual([["agent-1", "tree-wip-1"]]);
  // The head is read through its own index, not a scan of the table.
  const plan = store.db.query<{ detail: string }, [string, string]>("EXPLAIN QUERY PLAN SELECT tree FROM check_runs INDEXED BY check_runs_head WHERE head = ? AND session_id = ? ORDER BY ended DESC").all("h", "s");
  expect(plan.map((p) => p.detail).join(" ")).toContain("check_runs_head");
});
