import { expect, test } from "bun:test";
import type { Store } from "../core/store.ts";
import { WorkBoard } from "./board.ts";
import type { BoardRow } from "./rules.ts";

const BASE = "f".repeat(40);
const head = (i: number) => i.toString(16).padStart(40, "0");
const row = (i: number, state: string): BoardRow => ({
  id: `ag${i}`, session_id: `s${i}`, parent_id: "root", depth: 1, title: `t${i}`, type: "general-purpose", model: "m", state,
  created: i, ended: state === "completed" ? i : null, machine: null, branch: `keel/b${i}`, repo: "/r", base: "main", head: head(i), ahead: 1, behind: 0,
  worktree: "here", checks: null, review: null, reviews: [], landed: { state: "no", missing: 1 }, queue: null, live: null, work: null, together: null,
});

test("a busy repository's ended rows all get a forecast within a few reads: the caps count merges not made yet", async () => {
  const board = new WorkBoard({} as Store, {} as never);
  let merged = 0;
  // A merge that conflicts only between b3 and b27 (both ended).
  (board as any).ovOf = () => ({ mergeTips: async (_repo: string, a: string, b: string) => {
    merged++;
    const two = [a, b].sort().join(" ");
    return { conflict: two === [head(3), head(27)].sort().join(" "), files: ["x.ts"] };
  } });
  // 30 unlanded branches; nine of the first ten in the board's order are live.
  const fresh = () => Array.from({ length: 30 }, (_, i) => row(i, i < 10 && i !== 3 ? "running" : "completed"));
  let rows = fresh();
  let reads = 0;
  for (; reads < 6; reads++) {
    rows = fresh();
    await (board as any).forecast("/r", "refs/heads/main", BASE, rows, performance.now() + 60_000);
    if (rows.every((r) => r.state !== "completed" || !r.forecast_unknown)) break;
  }
  expect(reads + 1).toBeLessThanOrEqual(6);
  const ended = rows.filter((r) => r.state === "completed");
  expect(ended.length).toBe(21);
  expect(ended.filter((r) => r.forecast_unknown)).toEqual([]);
  expect(rows.find((r) => r.id === "ag27")!.forecast!.map((f) => f.with)).toEqual(["keel/b3"]);
  // A read after it merges nothing again.
  const before = merged;
  await (board as any).forecast("/r", "refs/heads/main", BASE, fresh(), performance.now() + 60_000);
  expect(merged).toBe(before);
});
