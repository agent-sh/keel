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

// OpenAI's Responses usage splits writes by lifetime: 30 minutes at 1.25x the
// input rate, 12 hours at 2.5x; the aggregate is never counted twice.
test("Responses cache writes are priced by their lifetime", () => {
  const p = { input: 1, output: 0, cache_read: 0.1 };
  const w = (m30: number, h12: number) => priceOf({ input: 0, output: 0, cache_read: 0, cache_write: 7000, cache_write_30m: m30, cache_write_12h: h12 }, p);
  expect(w(7000, 0)).toBeCloseTo(0.00875, 10);
  expect(w(0, 7000)).toBeCloseTo(0.0175, 10);
  expect(w(3000, 4000)).toBeCloseTo(0.01375, 10);
});
