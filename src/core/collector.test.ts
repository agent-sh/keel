import { expect, test } from "bun:test";
import { WHOLE_GAP_MS, wholeDue } from "./collector.ts";

const MB = 1e6;

test("a whole collection is asked for once the heap is well past what the last one left, not more often than the gap", () => {
  const last = { left: 200 * MB, at: 0 };
  // The young collections' sawtooth over a live heap: nothing more is asked.
  expect(wholeDue(330 * MB, last, 60_000)).toBe(false);
  // The climb of old objects: past twice what was left and the bytes, a whole collection.
  expect(wholeDue(401 * MB, last, 60_000)).toBe(true);
  // Twice a small heap is not reason enough: the bytes are.
  expect(wholeDue(150 * MB, { left: 60 * MB, at: 0 }, 60_000)).toBe(false);
  expect(wholeDue(260 * MB, { left: 60 * MB, at: 0 }, 60_000)).toBe(true);
  // Not again within the gap, however large.
  expect(wholeDue(900 * MB, { left: 200 * MB, at: 60_000 }, 60_000 + WHOLE_GAP_MS - 1)).toBe(false);
  expect(wholeDue(900 * MB, { left: 200 * MB, at: 60_000 }, 60_000 + WHOLE_GAP_MS)).toBe(true);
});
