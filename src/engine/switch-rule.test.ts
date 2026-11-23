import { expect, test } from "bun:test";
import { ASK_USD_DEFAULT, asksFirst, switchCost } from "./switch-rule.ts";

// The catalog's shape of a per-token price: USD a million tokens.
const price = { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 };
const lost = (tokens: number, from = price, to = price) => {
  const c = switchCost(tokens, from, to);
  return { cost_usd: c.cost, cached_cost_usd: c.cached };
};

test("a switch costs the re-read at the new model's write rate past the read on the current one", () => {
  const c = switchCost(1000, price, price);
  expect(c.cost).toBeCloseTo(0.00125, 10);
  expect(c.cached).toBeCloseTo(0.0001, 10);
  expect(c.extra).toBeCloseTo(0.00115, 10);
  // No read rate on the current model: the whole re-read is what it can add.
  expect(switchCost(1000, { input: 1, output: 5 }, price).extra).toBeCloseTo(0.00125, 10);
  // No price on the new model: unknown, never zero.
  expect(switchCost(1000, price, undefined)).toEqual({ cost: undefined, cached: expect.any(Number), extra: undefined });
  expect(switchCost(0, price, price)).toEqual({ cost: 0, cached: 0, extra: 0 });
});

test("a switch asks only when it is material", () => {
  const ask = (o: Partial<Parameters<typeof asksFirst>[0]>) => asksFirst({ lost: null, over: false, askUsd: ASK_USD_DEFAULT, ...o });
  // A tenth of a cent to re-read a small context: no question.
  expect(ask({ lost: lost(1000) })).toMatchObject({ ask: false });
  // A long context re-read on a model of the same price: about twelve cents past the cache, under the default.
  expect(ask({ lost: lost(100_000) })).toMatchObject({ ask: false });
  expect(ask({ lost: lost(100_000) }).extra_usd).toBeCloseTo(0.115, 6);
  // Three times that: past it.
  expect(ask({ lost: lost(300_000) })).toMatchObject({ ask: true, why: "cost" });
  // Right at the owner's amount asks; just under it does not.
  const at = ASK_USD_DEFAULT / (1.25 - 0.1) * 1e6;
  expect(ask({ lost: lost(Math.ceil(at)) }).ask).toBe(true);
  expect(ask({ lost: lost(Math.floor(at) - 1) }).ask).toBe(false);
  // The owner's own amount: 0 asks before any lost cache, a higher one lets more through.
  expect(ask({ lost: lost(1000), askUsd: 0 }).ask).toBe(true);
  expect(ask({ lost: lost(300_000), askUsd: 1 }).ask).toBe(false);
  // Past the new model's compaction line it asks at any cost, cache or none.
  expect(ask({ over: true })).toMatchObject({ ask: true, why: "context" });
  expect(ask({ over: true, lost: lost(10), askUsd: 5 })).toMatchObject({ ask: true, why: "context" });
  // A lost cache whose cost nobody states: asked.
  expect(ask({ lost: { cost_usd: undefined, cached_cost_usd: undefined } })).toMatchObject({ ask: true, why: "unpriced" });
  // Nothing cached is lost: never asked.
  expect(ask({ askUsd: 0 })).toEqual({ ask: false });
});
