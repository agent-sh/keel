import { expect, test } from "bun:test";
import { badPace, decide, lifeMargin, paceMsOf, PACE_MAX_MIN } from "./pace-rules.ts";

const MIN = 60_000;
const base = { paceMs: 5 * MIN, lastEnd: 1_000_000, now: 1_000_000 + MIN };

test("an input within the pace of the last unattended end waits for the pace", () => {
  expect(decide({ ...base, parts: [{ paced: true }] })).toEqual({ go: false, at: base.lastEnd + 5 * MIN });
});

test("an input past the pace goes at once", () => {
  expect(decide({ ...base, now: base.lastEnd + 5 * MIN, parts: [{ paced: true }] })).toEqual({ go: true });
  expect(decide({ ...base, now: base.lastEnd + 9 * MIN, parts: [{ paced: true }] })).toEqual({ go: true });
});

test("no pace, no unattended end since the start, or nothing lined up: at once", () => {
  expect(decide({ ...base, paceMs: 0, parts: [{ paced: true }] })).toEqual({ go: true });
  expect(decide({ ...base, lastEnd: undefined, parts: [{ paced: true }] })).toEqual({ go: true });
  expect(decide({ ...base, parts: [] })).toEqual({ go: true });
});

test("an input that may not wait takes everything that waits with it", () => {
  expect(decide({ ...base, parts: [{ paced: true }, { paced: false }, { paced: true }] })).toEqual({ go: true });
});

test("nothing waits past its own deadline", () => {
  const by = base.lastEnd + 2 * MIN;
  expect(decide({ ...base, parts: [{ paced: true }, { paced: true, by }] })).toEqual({ go: false, at: by });
  // A deadline already passed: at once.
  expect(decide({ ...base, parts: [{ paced: true, by: base.now - 1 }] })).toEqual({ go: true });
});

test("the wait ends before the cache lapses", () => {
  // A five-minute cache: a pace of ten minutes goes a minute and a quarter of it before the cache's end.
  const life = 5 * MIN;
  expect(decide({ ...base, paceMs: 10 * MIN, life, parts: [{ paced: true }] })).toEqual({ go: false, at: base.lastEnd + life - lifeMargin(life) });
  // An hour's cache leaves the pace as it is.
  expect(decide({ ...base, life: 60 * MIN, parts: [{ paced: true }] })).toEqual({ go: false, at: base.lastEnd + 5 * MIN });
  // No cache to keep (0): the pace alone.
  expect(decide({ ...base, life: 0, parts: [{ paced: true }] })).toEqual({ go: false, at: base.lastEnd + 5 * MIN });
});

test("the cache's clock starts at its last request, not at the turn's end", () => {
  // A turn whose last request went three minutes before its end, on a five-minute cache.
  const life = 5 * MIN, cachedAt = base.lastEnd - 3 * MIN;
  expect(decide({ ...base, now: base.lastEnd, life, cachedAt, parts: [{ paced: true }] })).toEqual({ go: false, at: cachedAt + life - lifeMargin(life) });
  // Its bound already passed: at once.
  expect(decide({ ...base, life, cachedAt: base.now - life, parts: [{ paced: true }] })).toEqual({ go: true });
});

test("the session's own pace, else the default for a top session, else none for an agent", () => {
  expect(paceMsOf(undefined, 5, true)).toBe(5 * MIN);
  expect(paceMsOf(undefined, 5, false)).toBe(0);
  expect(paceMsOf(2, 5, false)).toBe(2 * MIN);
  expect(paceMsOf(0, 5, true)).toBe(0);
  expect(paceMsOf(PACE_MAX_MIN * 3, 5, true)).toBe(PACE_MAX_MIN * MIN);
});

test("a pace is minutes from 0 to the most", () => {
  expect(badPace(0)).toBeUndefined();
  expect(badPace(2.5)).toBeUndefined();
  expect(badPace(PACE_MAX_MIN)).toBeUndefined();
  expect(badPace(-1)).toBeString();
  expect(badPace(PACE_MAX_MIN + 1)).toBeString();
  expect(badPace("5")).toBeString();
  expect(badPace(Number.NaN)).toBeString();
});
