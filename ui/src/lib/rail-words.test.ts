import { expect, test } from "bun:test";
import { railShown, railWords } from "./rail-words.ts";

test("a session goes by a word of its title, and no two by the same", () => {
  const s = (id: string, title: string, created: number) => ({ id, title, created });
  // The title's first word as typed, an article aside; a question keeps its first word, as the list shows it.
  expect(railWords([s("1", "Keel bun edge", 1), s("2", "The pricing page", 2), s("3", "Where the pane head reads", 3), s("4", "", 4)])).toEqual({ "1": "Keel", "2": "pricing", "3": "Where", "4": "New" });
  // The older keeps the word; the newer takes its next telling word, then its first with a number.
  expect(railWords([s("b", "Fix the bridge", 2), s("a", "Fix the build", 1), s("c", "fix", 3), s("d", "Fix", 4)])).toEqual({ a: "Fix", b: "bridge", c: "fix2", d: "Fix3" });
  // The same sessions again (the store hands out new objects with every event): the answer already made.
  const list = [s("1", "Ship it", 1), s("2", "Ship it twice", 2)];
  const words = railWords(list);
  expect(railWords(list.map((x) => ({ ...x, updated: 9 })))).toBe(words);
  expect(words).toEqual({ "1": "Ship", "2": "twice" });
});

test("the folded rail draws what is kept and counts the rest", () => {
  const list = ["need", "work1", "work2", "open", "new", "rest1", "rest2"].map((id) => ({ id }));
  const keeps = (s: { id: string }) => !s.id.startsWith("rest");
  const calls = (s: { id: string }) => s.id === "need";
  const ids = (r: { shown: { id: string }[]; rest: { id: string }[] }) => [r.shown.map((s) => s.id).join(" "), r.rest.map((s) => s.id).join(" ")];
  // Room for all: every kept one is a row, the others are the count.
  expect(ids(railShown(list, keeps, calls, "open", null))).toEqual(["need work1 work2 open new", "rest1 rest2"]);
  expect(ids(railShown(list, keeps, calls, "open", 6))).toEqual(["need work1 work2 open new", "rest1 rest2"]);
  // Less room: a row is the count's, the rows are cut from the end, and the open session takes the last row.
  expect(ids(railShown(list, keeps, calls, "open", 5))).toEqual(["need work1 work2 open", "new rest1 rest2"]);
  expect(ids(railShown(list, keeps, calls, "open", 3))).toEqual(["need open", "work1 work2 new rest1 rest2"]);
  // Never the row of a session that calls the owner.
  expect(ids(railShown(list, keeps, calls, "open", 2))).toEqual(["need", "work1 work2 open new rest1 rest2"]);
  // Nothing at rest and room for every row: no count.
  expect(ids(railShown(list.slice(0, 3), keeps, calls, null, 3))).toEqual(["need work1 work2", ""]);
});
