import { expect, test } from "bun:test";
import { Line, limitWords } from "./slots.ts";

test("a woken agent keeps its place ahead of agents asked for after it parked", () => {
  const line = new Line();
  const went: string[] = [];
  const go = (k: string) => () => went.push(k);
  line.join({ key: "block:later", at: 300, go: go("block:later") });
  line.join({ key: "wake:parked", at: 100, go: go("wake:parked") });
  line.join({ key: "block:same", at: 300, go: go("block:same") });
  expect(line.join({ key: "wake:parked", at: 50, go: go("again") })).toBe(false);
  expect(line.keys()).toEqual(["wake:parked", "block:later", "block:same"]);
  expect(line.ahead(300)).toBe(1);
  expect(line.ahead(100)).toBe(0);
  while (line.length) line.shift()!.go();
  expect(went).toEqual(["wake:parked", "block:later", "block:same"]);
});

test("a place can leave the line", () => {
  const line = new Line();
  line.join({ key: "a", at: 1, go: () => {} });
  expect(line.leave("a")).toBe(true);
  expect(line.leave("a")).toBe(false);
  expect(line.length).toBe(0);
});

test("the limit's words say how many work and how many wait", () => {
  expect(limitWords({ limit: 8, working: 8, reserved: 0, line: 0, waiting: 0 })).toBe("AGENT_LIMIT: 8 agent slots of this session are in use (8 work).");
  expect(limitWords({ limit: 2, working: 1, reserved: 1, line: 1, waiting: 3 }))
    .toBe("AGENT_LIMIT: 2 agent slots of this session are in use (2 work, 1 more waits for a slot; 3 agents wait on waits of their own and hold no slot).");
  expect(limitWords({ limit: 1, working: 1, reserved: 0, line: 0, waiting: 1 })).toContain("1 agent waits on a wait of its own and holds no slot");
});
