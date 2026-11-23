import { expect, test } from "bun:test";
import { BUDGET_BYTES, evictOf, foldersOf, MAX_AGE_MS, relinkOf } from "./package-cache.ts";

const GB = 1024 ** 3;
const day = 24 * 3600_000;

test("old entries go by age, and past the budget the ones used longest ago that do not fit", () => {
  const now = 100 * day;
  const e = (key: string, gb: number, daysAgo: number) => ({ key, bytes: gb * GB, used: now - daysAgo * day });
  // Within the budget and the age: nothing goes.
  expect(evictOf([e("a", 1, 0), e("b", 1, 1), e("c", 1, 2)], now, new Set())).toEqual([]);
  // Past the age: it goes, whatever room is left.
  expect(evictOf([e("a", 1, 0), e("old", 0.1, 4)], now, new Set())).toEqual(["old"]);
  // Over the budget: from the one used last down, an entry that does not fit with those kept goes.
  expect(evictOf([e("a", 1.5, 0), e("b", 1.5, 1), e("c", 1.5, 2), e("d", 0.5, 2.5)], now, new Set())).toEqual(["c"]);
  // One in use stays, and counts first.
  expect(evictOf([e("a", 1.5, 0), e("b", 1.5, 1), e("c", 1.5, 2)], now, new Set(["c"]))).toEqual(["b"]);
  expect(evictOf([e("a", 1, 0), e("held", 1, 5)], now, new Set(["held"]))).toEqual([]);
  // The one used last stays even alone over the budget (else it would install at every report), and old.
  expect(evictOf([e("huge", 9, 6), e("b", 1, 7)], now, new Set())).toEqual(["b"]);
  expect(BUDGET_BYTES).toBe(4 * GB);
  expect(MAX_AGE_MS).toBe(3 * day);
});

test("the packages folders an install made are the top ones of what git lists as untracked", () => {
  const listed = ["node_modules/", "packages/a/node_modules/", "a.test.ts", "packages/a/node_modules/x/node_modules/", "dist/", ""].join("\0");
  expect(foldersOf(listed)).toEqual(["node_modules", "packages/a/node_modules"]);
  expect(foldersOf("")).toEqual([]);
});

test("a link of the packages that leaves them points through the entry's root; one inside them stays", () => {
  const p = { folders: ["/s/w/node_modules", "/s/w/packages/a/node_modules"], lockDir: "/s/w", scratch: "/s", entry: "/c/k" };
  // A workspace package: through root, to the checkout that uses the entry now.
  expect(relinkOf("/s/w/node_modules/a", "../packages/a", p)).toBe("/c/k/root/packages/a");
  expect(relinkOf("/s/w/node_modules/@x/b", "../../vendor/b", p)).toBe("/c/k/root/vendor/b");
  // Within the packages folders: the same relative link works in the entry.
  expect(relinkOf("/s/w/node_modules/.bin/tsc", "../typescript/bin/tsc", p)).toBeUndefined();
  expect(relinkOf("/s/w/packages/a/node_modules/y", "../../../node_modules/y", p)).toBeUndefined();
  // Absolute: into the checkout's packages goes to the entry's copy, elsewhere in the checkout through root,
  // out of the checkout (a global store) stays.
  expect(relinkOf("/s/w/node_modules/y", "/s/w/node_modules/.store/y", p)).toBe("/c/k/tree/node_modules/.store/y");
  expect(relinkOf("/s/w/node_modules/a", "/s/w/packages/a", p)).toBe("/c/k/root/packages/a");
  expect(relinkOf("/s/w/node_modules/z", "/home/u/.store/z", p)).toBeUndefined();
});
