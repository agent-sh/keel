import { expect, test } from "bun:test";
import { nextWaiting, waitingOrder } from "./waiting.ts";

const row = (id: string, updated: number, o: { parent_id?: string; archived?: boolean } = {}) => ({ id, updated, ...o });

test("the order is the sessions that need the owner, the longest wait first", () => {
  const list = [row("new", 30), row("old", 10), row("busy", 5), row("gone", 1, { archived: true }), row("mid", 20)];
  const word = (id: string) => (id === "busy" ? "work" : "need");
  expect(waitingOrder(list, word, () => true)).toEqual(["old", "mid", "new"]);
});

test("a session that needs the owner only through its agent gives way to the agent's session", () => {
  const list = [row("parent", 10), row("agent", 20, { parent_id: "parent" }), row("both", 30), row("kid", 40, { parent_id: "both" })];
  const own = (id: string) => id !== "parent";
  expect(waitingOrder(list, () => "need", own)).toEqual(["agent", "both", "kid"]);
  // With the agent answered the parent is in the order again if it still reads "needs you".
  expect(waitingOrder(list.filter((s) => s.id !== "agent"), () => "need", own)).toEqual(["parent", "both", "kid"]);
});

test("the next one follows the session the owner is in, around the end", () => {
  const order = ["a", "b", "c"];
  expect(nextWaiting(order, null)).toBe("a");
  expect(nextWaiting(order, "elsewhere")).toBe("a");
  expect(nextWaiting(order, "a")).toBe("b");
  expect(nextWaiting(order, "c")).toBe("a");
  expect(nextWaiting(["a"], "a")).toBe(null);
  expect(nextWaiting([], "a")).toBe(null);
});
