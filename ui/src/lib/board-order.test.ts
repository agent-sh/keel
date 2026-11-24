import { expect, test } from "bun:test";
import type { Watch } from "../../../src/core/watch.ts";
import { treeOrder } from "./board-order.ts";

const r = (id: string, parent: string, created: number) => ({ id, session_id: `s-${id}`, parent_id: parent, created });
const line = (list: { row: { id: string }; indent: number }[]) => list.map((x) => `${"-".repeat(x.indent)}${x.row.id}`).join(" ");

test("an agent's own agents follow it, indented, whatever order the rows came in", () => {
  const rows = [r("worker", "s-coord", 3), r("coord", "root", 1), r("peer", "root", 2)];
  expect(line(treeOrder(rows, "root", {}))).toBe("peer coord -worker");
});

test("among the agents of one parent: needs the owner, failed, working, then at rest", () => {
  const rows = [r("done", "root", 4), r("work", "root", 3), r("fail", "root", 2), r("need", "root", 1)];
  const w: Record<string, Watch> = { "s-done": "done", "s-work": "work", "s-fail": "fail", "s-need": "need" };
  expect(line(treeOrder(rows, "root", w))).toBe("need fail work done");
});

test("a row whose parent is not on the board stands at the top, and every row comes out once", () => {
  const rows = [r("a", "gone", 1), r("b", "s-a", 2), r("c", "s-c", 3)];
  expect(line(treeOrder(rows, "root", {}))).toBe("a -b c");
});
