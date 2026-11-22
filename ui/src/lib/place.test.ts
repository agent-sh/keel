import { expect, test } from "bun:test";
import { bound, isLater, merged, newAfter, offsetAt, type Place } from "./place.ts";

const ev = (...ids: string[]) => ids.map((id, i) => ({ id, seq: 10 + i }));

test("the newest places are kept when there are too many", () => {
  const places: Record<string, Place> = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`s${i}`, { end: true, at: i }]));
  expect(Object.keys(bound(places, 4)).sort()).toEqual(["s2", "s3", "s4", "s5"]);
  expect(bound(places, 10)).toBe(places);
});

test("a tab writes its own changes over what the storage holds, and nothing else", () => {
  const there: Record<string, Place> = { a: { end: true, at: 5 }, b: { ev: "x", at: 9 }, gone: { end: true, at: 1 } };
  // This tab read `b` long ago (an older copy), changed `a`, and removed `gone`.
  const mine: Record<string, Place> = { a: { ev: "y", at: 7 }, b: { ev: "old", at: 2 } };
  expect(merged(there, mine, ["a", "gone"])).toEqual({ a: { ev: "y", at: 7 }, b: { ev: "x", at: 9 } });
});

test("a place inside a tall row is the same share of it at another width", () => {
  expect(offsetAt({ off: -1000, h: 4000 }, 6000)).toBe(-1500);
  // A row that starts below the view's top, a row of the same height, a place with no height: as it was.
  expect([offsetAt({ off: 40, h: 300 }, 600), offsetAt({ off: -120, h: 300 }, 301), offsetAt({ off: -120 }, 600)]).toEqual([40, -120, -120]);
});

test("what is new is what comes after the read mark, and nothing when that cannot be told", () => {
  const events = ev("a", "b", "c", "d");
  const ids = (m: Parameters<typeof newAfter>[1]) => { const r = newAfter(events, m); return r === "before" ? r : r.map((e) => e.id); };
  expect([ids({ read: "b", readSeq: 11 }), ids({ read: "d", readSeq: 13 }), ids(undefined), ids({})]).toEqual([["c", "d"], [], [], []]);
  // A mark older than everything shown: what is new starts in a part that is not on the page.
  expect(ids({ read: "older", readSeq: 3 })).toBe("before");
  // A mark that is neither shown nor older (another branch), or one with no order: nothing is said to be new.
  expect([ids({ read: "elsewhere", readSeq: 12 }), ids({ read: "unknown" })]).toEqual([[], []]);
});

test("the read mark only moves forward", () => {
  const [a, , c] = ev("a", "b", "c");
  expect([isLater({ read: "a", readSeq: 10 }, c!), isLater({ read: "c", readSeq: 12 }, a!), isLater({ read: "a", readSeq: 10 }, a!), isLater(undefined, a!)]).toEqual([true, false, false, true]);
});
