import { expect, test } from "bun:test";
import { awayOf } from "./later-rules.ts";

const pile = { ids: new Set(["a"]), known: new Set(["a", "b"]) };

test("what was put away stays away; the rest of what waits shows", () => {
  expect([...awayOf(pile, ["a", "b"])]).toEqual(["a"]);
  expect([...awayOf(undefined, ["a", "b"])]).toEqual([]);
});

test("a request that came after the pile was put away brings the pile back", () => {
  expect([...awayOf(pile, ["a", "b", "c"])]).toEqual([]);
});

test("an answered request leaves the count, and the rest stays away", () => {
  expect([...awayOf({ ids: new Set(["a", "b"]), known: new Set(["a", "b", "c"]) }, ["b", "c"])]).toEqual(["b"]);
  expect([...awayOf(pile, ["b"])]).toEqual([]);
});
