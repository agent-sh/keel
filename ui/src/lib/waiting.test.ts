import { expect, test } from "bun:test";
import { nextWaiting, waitingOrder } from "./waiting.ts";

const row = (id: string, updated: number, archived = false) => ({ id, updated, archived });
const need = (since?: number, child?: string) => ({ watch: "need", since, child });

test("the order is the sessions that need the owner, the longest wait first", () => {
  const list = [row("new", 1), row("old", 2), row("busy", 3), row("gone", 4, true), row("mid", 5), row("untimed", 15)];
  const states: Record<string, { watch: string; since?: number }> = { new: need(30), old: need(10), busy: { watch: "work", since: 5 }, gone: need(1), mid: need(20), untimed: need() };
  // (A state with no time of its own is placed by the session's last change.)
  expect(waitingOrder(list, (id) => states[id], () => true)).toEqual(["old", "untimed", "mid", "new"]);
});

test("a session that needs the owner only through its agent gives way to the agent's session", () => {
  const list = [row("parent", 1), row("agent", 2), row("both", 3), row("kid", 4), row("far", 5)];
  const states: Record<string, ReturnType<typeof need>> = { parent: need(10, "agent"), agent: need(20), both: need(30, "kid"), kid: need(40), far: need(50, "elsewhere") };
  const own = (id: string) => id === "both";
  // "both" holds a request of its own too; "far" names an agent this page has no session of, so it stays.
  expect(waitingOrder(list, (id) => states[id], own)).toEqual(["agent", "both", "kid", "far"]);
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
