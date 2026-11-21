import { expect, test } from "bun:test";
import { fitBands } from "./rail-fit.ts";

test("every band of the folded rail gets a row; the room left goes to the bands in their order", () => {
  // Room for all: nothing is cut.
  expect(fitBands([3, 1, 2, 3, 1, 2], 12)).toEqual([3, 1, 2, 3, 1, 2]);
  expect(fitBands([3, 1, 2], null)).toEqual([3, 1, 2]);
  // Room for nine of twelve: the last bands keep one row each (a count of what they hold).
  expect(fitBands([3, 1, 2, 3, 1, 2], 9)).toEqual([3, 1, 2, 1, 1, 1]);
  // Never fewer rows than bands, however small the room.
  expect(fitBands([5, 4, 3], 3)).toEqual([1, 1, 1]);
  expect(fitBands([5, 4, 3], 6)).toEqual([4, 1, 1]);
});
