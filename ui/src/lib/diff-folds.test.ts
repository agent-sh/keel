import { expect, test } from "bun:test";
import { foldOver, foldsOf } from "./diff-folds.ts";

const lines = (s: string) => [...s].map((c) => ({ kind: c === "+" ? "add" : c === "-" ? "del" : c === "@" ? "hunk" : "ctx" }));

test("a long run of unchanged lines keeps three at each end and folds the rest", () => {
  // Twenty unchanged lines, then a change.
  const f = foldsOf(lines(" ".repeat(20) + "-+"));
  expect([...f]).toEqual([[3, 17]]);
  expect(foldOver(f, 10)).toBe(3);
  expect(foldOver(f, 2)).toBeUndefined();
  expect(foldOver(f, 17)).toBeUndefined();
});

test("a short run is left whole, and runs are told apart by the changes between them", () => {
  expect([...foldsOf(lines(" ".repeat(8) + "+"))]).toEqual([]);
  expect([...foldsOf(lines("@" + " ".repeat(9) + "+" + " ".repeat(12)))]).toEqual([[4, 7], [14, 20]]);
});

test("a run that holds a line with a comment is not folded", () => {
  const all = lines(" ".repeat(20) + "+" + " ".repeat(20));
  expect([...foldsOf(all, new Set([10]))]).toEqual([[24, 38]]);
  // A comment on a line the fold would keep anyway changes nothing.
  expect([...foldsOf(all, new Set([1]))]).toEqual([[3, 17], [24, 38]]);
});
