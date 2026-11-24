import { expect, test } from "bun:test";
import { crumbsOf, treeLines } from "./agent-lines.ts";

// What the e2e (test/e2e/agent-lines.spec.ts) cannot reach: a parent with two steps of agents, and damaged records.
const agent = (id: string, parent: string, created: number, status = "running") => ({ id, session_id: `s-${id}`, parent_id: parent, created, status, title: id.toUpperCase() });

test("a step's lines hold its own agents and theirs, not another step's", () => {
  const coord = agent("coord", "root", 1), worker = agent("worker", "s-coord", 3), other = agent("other", "root", 4);
  const lines = treeLines([worker, other, coord], [coord], {});
  expect(lines.map((l) => `${l.agent.id}:${l.depth}:${l.below}`)).toEqual(["coord:1:1", "worker:2:0"]);
});

test("the way up ends on a loop in damaged records", () => {
  const a = agent("a", "s-b", 1), b = agent("b", "s-a", 2);
  expect(crumbsOf([a, b], () => undefined, "s-a").length).toBe(2);
});
