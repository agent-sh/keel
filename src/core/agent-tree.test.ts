import { expect, test } from "bun:test";
import { canStart, countBelow, depthOf, descendants, levelsLeft, maxDepth, nested, pathOf, rootOf, treeRows } from "./agent-tree.ts";
import { childMode, type Mode } from "../safety/policy.ts";

// root > a > a1 > a1x ; root > b ; a > a2
const parents: Record<string, string | null> = { root: null, a: "root", b: "root", a1: "a", a2: "a", a1x: "a1" };
const parentOf = (id: string) => parents[id];
const rec = (id: string, parent: string, created: number) => ({ id: `ag-${id}`, session_id: id, parent_id: parent, created, title: id.toUpperCase() });
const agents = [rec("b", "root", 2), rec("a", "root", 1), rec("a2", "a", 4), rec("a1", "a", 3), rec("a1x", "a1", 5)];

test("depth and root follow the parents", () => {
  expect(depthOf(parentOf, "root")).toBe(0);
  expect(depthOf(parentOf, "a")).toBe(1);
  expect(depthOf(parentOf, "a1x")).toBe(3);
  expect(rootOf(parentOf, "a1x")).toBe("root");
  expect(rootOf(parentOf, "root")).toBe("root");
  // A loop in damaged data ends.
  expect(depthOf((id) => (id === "x" ? "y" : "x"), "x")).toBe(32);
});

test("the depth limit: an agent at the limit starts none", () => {
  expect(canStart(0, 3)).toBe(true);
  expect(canStart(2, 3)).toBe(true);
  expect(canStart(3, 3)).toBe(false);
  expect(levelsLeft(1, 3)).toBe(2);
  expect(levelsLeft(3, 3)).toBe(0);
  expect(maxDepth(undefined)).toBe(3);
  expect(maxDepth("2")).toBe(2);
  for (const bad of ["0", "-1", "1.5", "x", ""]) expect(maxDepth(bad)).toBe(3);
});

test("the tree's rows: each agent followed by its own, oldest first, with depth and what is below", () => {
  const rows = treeRows(agents, "root");
  expect(rows.map((r) => [r.agent.session_id, r.depth, r.below])).toEqual([["a", 1, 3], ["a1", 2, 1], ["a1x", 3, 0], ["a2", 2, 0], ["b", 1, 0]]);
  expect(descendants(agents, "a").map((a) => a.session_id)).toEqual(["a1", "a1x", "a2"]);
  expect(descendants(agents, "b")).toEqual([]);
  expect(pathOf(agents, agents[4]!)).toBe("A > A1 > A1X");
});

test("live agents count for every session above them", () => {
  const live = [rec("a", "root", 1), rec("a1", "a", 3), rec("a1x", "a1", 5), rec("b", "root", 2)];
  const n = countBelow(live);
  expect(n.get("root")).toBe(4);
  expect(n.get("a")).toBe(2);
  expect(n.get("a1")).toBe(1);
  expect(n.get("b")).toBeUndefined();
});

test("a list of sessions nests each agent's session under its parent's", () => {
  const list = [{ id: "a1" , parent_id: "a" }, { id: "x", parent_id: null }, { id: "root", parent_id: null }, { id: "a", parent_id: "root" }, { id: "orphan", parent_id: "gone" }];
  expect(nested(list).map((r) => `${r.item.id}:${r.depth}`)).toEqual(["x:0", "root:0", "a:1", "a1:2", "orphan:0"]);
});

test("down a tree, a child's mode never asks less than its parent's", () => {
  // The chain a nested spawn makes: each child's mode from its parent's, the definition asking for less.
  const chain = (start: Mode, wants: (string | undefined)[]) => wants.reduce<Mode[]>((out, w) => [...out, childMode(out.at(-1)!, w)], [start]);
  expect(chain("ask", ["full-auto", "auto", "full-auto"])).toEqual(["ask", "ask", "ask", "ask"]);
  expect(chain("auto", ["read-only", "full-auto"])).toEqual(["auto", "read-only", "read-only"]);
});
