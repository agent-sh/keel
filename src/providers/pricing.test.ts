import { expect, test } from "bun:test";
import { priceOf } from "./pricing.ts";

test("an hour-long cache write is priced at twice the input rate", () => {
  const p = { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 };
  const u = { input: 0, output: 0, cache_read: 0, cache_write: 1_000_000, cache_write_1h: 400_000 };
  expect(priceOf(u, p)).toBeCloseTo(600_000 * 1.25 / 1e6 + 400_000 * 2 / 1e6);
});
