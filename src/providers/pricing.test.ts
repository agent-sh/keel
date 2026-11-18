import { expect, test } from "bun:test";
import { priceOf } from "./pricing.ts";

test("an hour-long cache write is priced at twice the input rate", () => {
  const p = { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 };
  const u = { input: 0, output: 0, cache_read: 0, cache_write: 1_000_000, cache_write_1h: 400_000 };
  expect(priceOf(u, p)).toBeCloseTo(600_000 * 1.25 / 1e6 + 400_000 * 2 / 1e6);
});

// A context tier bills the whole request at its rates once the prompt is above it.
test("context tiers price a request by its prompt size", () => {
  const p = { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125, tiers: [{ above: 100_000, input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0.625 }] };
  const small = { input: 50_000, output: 1000, cache_read: 40_000, cache_write: 0 };
  expect(priceOf(small, p)).toBeCloseTo((50_000 * 0.1 + 1000 * 0.5 + 40_000 * 0.01) / 1e6, 10);
  const big = { input: 20_000, output: 1000, cache_read: 90_000, cache_write: 0 };
  expect(priceOf(big, p)).toBeCloseTo((20_000 * 0.5 + 1000 * 2.5 + 90_000 * 0.05) / 1e6, 10);
  // A tier without a cache-read rate leaves a cached request's cost unknown.
  expect(priceOf(big, { ...p, tiers: [{ above: 100_000, input: 0.5, output: 2.5 }] })).toBeUndefined();
});
