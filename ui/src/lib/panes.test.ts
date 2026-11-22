// Where an opened session goes, and what placing one does: the rule at the head of stations.ts.
import { expect, test } from "bun:test";
import { opened, placed, paneOf, restore, uncovered, type Panes } from "./panes.ts";

const panes = (slots: (string | null)[], active = 0, over: (string | null)[] = slots.map(() => null)): Panes => ({ slots, over, active, keys: slots.map((_, i) => `k${i}`) });
const view = (p: Panes) => ({ slots: p.slots, over: p.over, active: p.active });

test("an opened session never takes a pane's session away", () => {
  // Two panes, both held: it lies over the pane worked in, and the pane still holds its own.
  const two = opened(panes(["reader", "coord"], 0), "x");
  expect(view(two)).toEqual({ slots: ["reader", "coord"], over: ["x", null], active: 0 });
  // The next one opened takes the look's place, not the pane's session.
  expect(view(opened(two, "y"))).toEqual({ slots: ["reader", "coord"], over: ["y", null], active: 0 });
  // From the other pane, it lies over that one; the first look stays where it was left.
  expect(view(opened({ ...two, active: 1 }, "y"))).toEqual({ slots: ["reader", "coord"], over: ["x", "y"], active: 1 });
});

test("a session that is on screen, or has a pane, is gone to, not opened again", () => {
  const two = panes(["reader", "coord"], 0, ["x", null]);
  expect(view(opened(two, "coord"))).toEqual({ slots: ["reader", "coord"], over: ["x", null], active: 1 });
  expect(opened(two, "x")).toBe(two);
  // The pane's own session, under a look: the look is put away.
  expect(view(opened({ ...two, active: 1 }, "reader"))).toEqual({ slots: ["reader", "coord"], over: [null, null], active: 0 });
});

test("an empty pane is filled, and one pane is a page that is turned", () => {
  expect(view(opened(panes(["reader", null], 0), "x"))).toEqual({ slots: ["reader", "x"], over: [null, null], active: 1 });
  expect(view(opened(panes([null, "coord"], 0), "x"))).toEqual({ slots: ["x", "coord"], over: [null, null], active: 0 });
  expect(view(opened(panes(["reader"], 0), "x"))).toEqual({ slots: ["x"], over: [null], active: 0 });
});

test("placing makes it the pane's session", () => {
  const looking = panes(["reader", "coord"], 0, ["x", null]);
  // Keep here: the look takes the place of the session it lay over, in the same pane.
  const kept = placed(looking, "x", 0);
  expect(view(kept)).toEqual({ slots: ["x", "coord"], over: [null, null], active: 0 });
  expect(kept.keys).toEqual(looking.keys);
  // Placed in another pane: it leaves the pane it lay over, which shows its own again.
  expect(view(placed(looking, "x", 1))).toEqual({ slots: ["reader", "x"], over: [null, null], active: 1 });
  // Two sessions with panes trade places, and the panes' names go with them.
  const traded = placed(panes(["a", "b", "c"], 0), "a", 2);
  expect(view(traded)).toEqual({ slots: ["c", "b", "a"], over: [null, null, null], active: 2 });
  expect(traded.keys).toEqual(["k2", "k1", "k0"]);
  // A session under a look moves out: the look stays in that pane as its session.
  expect(view(placed(panes(["reader", "coord", null], 0, ["x", null, null]), "reader", 2))).toEqual({ slots: ["x", "coord", "reader"], over: [null, null, null], active: 2 });
  // A session from nowhere takes the place of what the pane held, and of what lay over it.
  expect(view(placed(looking, "z", 0))).toEqual({ slots: ["z", "coord"], over: [null, null], active: 0 });
});

test("a look that is left shows the pane's session again", () => {
  const looking = panes(["reader", "coord"], 1, ["x", null]);
  expect(view(uncovered(looking, 0))).toEqual({ slots: ["reader", "coord"], over: [null, null], active: 0 });
  expect(uncovered(looking, 1)).toBe(looking);
  expect(paneOf(looking, "x")).toBe(0);
  expect(paneOf(looking, "reader")).toBe(-1);
});

test("a kept layout comes back with its looks and without its empty panes", () => {
  expect(restore({ count: 3, slots: ["a", null, "c"], over: ["x", null, null], sizes: {}, active: 2 })).toEqual({ count: 2, slots: ["a", "c"], over: ["x", null], sizes: {}, active: 1 });
  // A layout kept before looks existed.
  expect(restore({ count: 2, slots: ["a", "b"], sizes: {}, active: 0 })).toEqual({ count: 2, slots: ["a", "b"], over: [null, null], sizes: {}, active: 0 });
  expect(restore(null)).toEqual({ count: 1, slots: [null], over: [null], sizes: {}, active: 0 });
});
