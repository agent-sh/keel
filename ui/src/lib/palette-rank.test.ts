import { expect, test } from "bun:test";
import { agentOf, groupIndex, ranked } from "./palette-rank.ts";

test("sessions that need the owner come first, then failed, then the newest", () => {
  const list = [{ id: "old-need", updated: 1 }, { id: "new-idle", updated: 9 }, { id: "failed", updated: 5 }, { id: "newer-need", updated: 2 }, { id: "mid", updated: 6 }];
  const watches = { "old-need": "need", failed: "fail", "newer-need": "need" } as const;
  expect(ranked(list, watches).map((s) => s.id)).toEqual(["newer-need", "old-need", "failed", "new-idle", "mid"]);
});

test("a machine's sessions follow this machine's, before the other groups", () => {
  const order = ["Sessions", "Actions", "In conversations"];
  expect(groupIndex(order, "Sessions on build-box")).toBeGreaterThan(groupIndex(order, "Sessions"));
  expect(groupIndex(order, "Sessions on build-box")).toBeLessThan(groupIndex(order, "Actions"));
});

test("an agent's row names its parent", () => {
  expect(agentOf("Refactor the billing parser")).toBe("agent of Refactor the billing parser");
  expect(agentOf("")).toBe("agent of New session");
  expect(agentOf(undefined)).toBe("agent");
});
