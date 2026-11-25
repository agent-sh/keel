// Which backups stay: the newest few, the newest of each recent day, and what they are read over.
import { expect, test } from "bun:test";
import { retained, type Retainable } from "./retain.ts";

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 25, 8, 0, 0);
// Newest first: a restart every four hours, a full backup after most.
const at = (hoursAgo: number, name: string, extra: Partial<Retainable> = {}): Retainable => ({ name, created_ms: NOW - hoursAgo * H, ...extra });

test("a day of restarts keeps the newest two and the newest of each day, with the full backup a delta is read over", () => {
  const list = [at(6, "d-newest", { base: "f-late" }), at(8, "f-late"), at(10, "f-mid"), at(14, "d-old", { base: "f-early" }), at(30, "f-early")];
  expect([...retained(list, NOW, { recent: 2, days: 7 })].sort()).toEqual(["d-newest", "f-early", "f-late"]);
});

test("one backup of each of the last days stays, and none older", () => {
  const list = [at(1, "a"), at(2, "b"), at(25, "c"), at(27, "d"), at(24 * 6 + 3, "e"), at(24 * 8, "old")];
  expect([...retained(list, NOW, { recent: 1, days: 7 })].sort()).toEqual(["a", "c", "e"]);
  expect([...retained(list, NOW, { recent: 1, days: 0 })]).toEqual(["a"]);
});

test("the newest backup stays whatever is set, and the newest known whole stays with its base", () => {
  const list = [at(1, "bad"), at(2, "bad2"), at(3, "whole-delta", { newest_whole: true, base: "base" }), at(4, "x"), at(5, "base")];
  expect([...retained(list, NOW, { recent: 0, days: 0 })].sort()).toEqual(["bad", "base", "whole-delta"]);
});

test("a backup with no known time is kept only by count", () => {
  const list = [{ name: "a", created_ms: null }, { name: "b", created_ms: null }];
  expect([...retained(list, NOW, { recent: 1, days: 7 })]).toEqual(["a"]);
});
