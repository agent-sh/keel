import { expect, test } from "bun:test";
import type { Watch } from "../../../src/core/watch.ts";
import { after, around, DEFAULT, folders, held, keep, order, pinMark, pinMove, pinnedOrder, readArrange, tally } from "./list-order.ts";

const s = (id: string, created: number, more: Partial<{ title: string; updated: number; workspace: string; machine: string }> = {}) =>
  ({ id, title: more.title ?? id, created, updated: more.updated ?? created, workspace: more.workspace ?? "/w/app", machine: more.machine });
const ids = (l: { id: string }[]) => l.map((x) => x.id).join(" ");

test("the default order is by creation, and no state or activity moves a row in it", () => {
  const list = [s("old", 1), s("mid", 2), s("new", 3)];
  const quiet: Record<string, Watch> = { old: "done", mid: "done", new: "done" };
  const first = ids([...list].sort(order(DEFAULT, quiet)));
  expect(first).toBe("new mid old");
  // The oldest now needs the owner and was the last to work: it stays where it was.
  const busy: Record<string, Watch> = { old: "need", mid: "work", new: "fail" };
  const moved = list.map((x) => (x.id === "old" ? { ...x, updated: 99 } : x));
  expect(ids([...moved].sort(order(DEFAULT, busy)))).toBe(first);
  expect(ids([...moved].sort(order({ sort: "name" }, busy)))).toBe("mid new old");
});

test("the orders that move rows are still there: recent activity and state put what needs the owner first", () => {
  const list = [s("a", 1, { updated: 5 }), s("b", 2, { updated: 9 }), s("c", 3, { updated: 7 })];
  const w: Record<string, Watch> = { a: "need", b: "done", c: "work" };
  expect(ids([...list].sort(order({ sort: "recent" }, w)))).toBe("a c b");
  expect(ids([...list].sort(order({ sort: "recent" }, { a: "done", b: "done", c: "done" })))).toBe("b c a");
  expect(ids([...list].sort(order({ sort: "state" }, { a: "done", b: "fail", c: "work" })))).toBe("b c a");
});

test("folders stand by name where rows keep their place, by their newest work where rows move", () => {
  const list = [s("z1", 1, { workspace: "/w/zeta", updated: 50 }), s("a1", 2, { workspace: "/w/alpha" }), s("a2", 3, { workspace: "/w/alpha" }), s("r1", 4, { workspace: "/w/alpha", machine: "m1" })];
  const w: Record<string, Watch> = {};
  expect(folders(list, DEFAULT, w).map((g) => `${g.machine ?? "here"}:${g.ws.split("/").pop()}:${ids(g.list)}`)).toEqual(["here:alpha:a2 a1", "m1:alpha:r1", "here:zeta:z1"]);
  expect(folders(list, { sort: "recent" }, w)[0]!.ws).toBe("/w/zeta");
});

test("under the hand the list is the one the hand found: what left stays, what came waits, the owner's own acts show", () => {
  const was = [s("a", 1), s("b", 2), s("c", 3)];
  const b2 = { ...was[1]!, updated: 77 };
  const now = [was[0]!, b2, s("d", 4), s("e", 5)]; // c was archived elsewhere, d and e were made
  const r = held(was, now, (id) => id === "e");
  expect(ids(r.list)).toBe("a b c e");
  expect(r.list[1]).toBe(was[1]!); // ordered by what it was: its new activity does not move it
  expect([...r.gone]).toEqual(["c"]);
  expect(ids(r.late)).toBe("d");
  // A session the owner made from this page while their pointer rested in the list takes its place at once.
  const mine = held(was, [...was, s("made", 9)], () => false, (id) => id === "made");
  expect([ids(mine.list), ids(mine.late)]).toEqual(["a b c made", ""]);
  // The owner archived b themselves: it is gone at once.
  expect(ids(held(was, [was[0]!, was[2]!], (id) => id === "b").list)).toBe("a c");
});

test("the counts name the longest wait first, and unread only what no other count has", () => {
  const list = [s("a", 1), s("b", 2), s("c", 3), s("d", 4), s("e", 5)];
  const t = tally(list, { a: { watch: "need", since: 30 }, b: { watch: "need", since: 10 }, c: { watch: "declined" }, d: { watch: "work" }, e: { watch: "done" } }, { a: 2, e: 1 });
  expect(t).toEqual({ need: ["b", "a"], fail: ["c"], work: ["d"], unread: ["e"] });
  expect(after(t.need, null)).toBe("b");
  expect(after(t.need, "b")).toBe("a");
  expect(after(t.need, "a")).toBe("b");
  expect(after([], null)).toBeUndefined();
});

test("an arrangement kept before the default changed moves to it once, and says so", () => {
  // Kept by the version before: sorted by recent activity, whether chosen or not.
  expect(readArrange(JSON.stringify({ group: "flat", sort: "recent", hideDone: true }), true)).toEqual({ arrange: { group: "flat", sort: "created", hideDone: true, lines: "one" }, note: true });
  // Another order was their choice: kept, and nothing changed for them, so nothing is said.
  expect(readArrange(JSON.stringify({ group: "folder", sort: "state", hideDone: false }), true)).toEqual({ arrange: { group: "folder", sort: "state", hideDone: false, lines: "one" }, note: false });
  expect(readArrange(JSON.stringify({ group: "flat", sort: "name", hideDone: false }), true).note).toBe(false);
  // Two lines a row is a choice that is kept.
  expect(readArrange(keep({ arrange: { ...DEFAULT, lines: "two" }, note: false }), true).arrange.lines).toBe("two");
  // Nothing kept: the default; a browser that ran Keel before is told, a first visit is not.
  expect(readArrange(null, true)).toEqual({ arrange: DEFAULT, note: true });
  expect(readArrange(null, false)).toEqual({ arrange: DEFAULT, note: false });
  // Once on this version a choice of recent activity is theirs, and the note is read once.
  const chosen = keep({ arrange: { ...DEFAULT, sort: "recent" }, note: false });
  expect(readArrange(chosen, true)).toEqual({ arrange: { ...DEFAULT, sort: "recent" }, note: false });
  expect(readArrange(keep({ arrange: DEFAULT, note: true }), true).note).toBe(true);
  expect(readArrange("not json", false).arrange).toEqual(DEFAULT);
});

test("what settles, settles around the row the hand is on", () => {
  const key = (x: string) => x;
  // c moved to the top of the order (its session took a turn): it stays third, the others around it.
  expect(around(["c", "a", "b", "d"], ["a", "b", "c", "d"], "c", key)).toEqual(["a", "b", "c", "d"]);
  // Others moved: they take their places, c keeps its own.
  expect(around(["d", "b", "c", "a"], ["a", "b", "c", "d"], "c", key)).toEqual(["d", "b", "c", "a"]);
  expect(around(["d", "c", "b", "a"], ["a", "b", "c", "d"], "c", key)).toEqual(["d", "b", "c", "a"]);
  // A list that got shorter: as near its place as there is.
  expect(around(["c", "a"], ["a", "b", "x", "c"], "c", key)).toEqual(["a", "c"]);
  // No hand, or a row that was not there: the order as it is.
  expect(around(["b", "a"], ["a", "b"], null, key)).toEqual(["b", "a"]);
  expect(around(["b", "a"], ["a"], "b", key)).toEqual(["b", "a"]);
});

test("a pinned row moved among the pinned takes a mark between its new neighbours", () => {
  const p = (id: string, pinned_ms?: number) => ({ id, settings: { pinned_ms } });
  const list = pinnedOrder([p("c", 300), p("x"), p("a", 100), p("b", 200)]);
  expect(list.map((s) => s.id)).toEqual(["a", "b", "c"]);
  const moved = (id: string, to: number) => { const m = pinMove(list, id, to, 5000); return m === null ? null : pinnedOrder(list.map((s) => (s.id === id ? p(id, m) : s))).map((s) => s.id).join(""); };
  expect(moved("c", 0)).toBe("cab");
  expect(moved("c", 1)).toBe("acb");
  expect(moved("a", 2)).toBe("bca");
  expect(moved("a", 1)).toBe("bac");
  expect(moved("b", 1)).toBeNull();
  expect(moved("a", -3)).toBeNull();
  expect(pinMark(undefined, undefined, 7)).toBe(7);
  expect(pinMark(100, undefined, 7)).toBe(1100);
});
