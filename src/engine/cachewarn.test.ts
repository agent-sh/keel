// The switch warning lasts as long as the request that wrote the prefix keeps
// it, by what that route documents, and says "may" past a documented lifetime.
import { expect, test } from "bun:test";
import type { StoredEvent } from "../core/types.ts";
import type { ModelInfo } from "../providers/types.ts";
import { longestSure, retention, switchWarning } from "./cachewarn.ts";

const MIN = 60_000;
const to = { id: "b:m", name: "B", efforts: [], price: { input: 1, output: 1 } } as unknown as ModelInfo;
const history = (usage: Record<string, number>): StoredEvent[] => [
  { kind: "user", ts: 0, data: {} } as any,
  { kind: "assistant", ts: 1000, data: { model: "a:m", usage: { input: 10, output: 1, cache_read: 0, cache_write: 0, ...usage } } } as any,
];
const at = (min: number, fromWire: any, usage: Record<string, number>) =>
  switchWarning({ lineage: history(usage), now: min * MIN, to, toWire: "openai_responses", fromWire }).warning;

test("a 30-minute Responses prefix still warns at six minutes; an undocumented one is uncertain", () => {
  expect(at(6, "openai_responses", { cache_write: 4096 })).toMatchObject({ certain: true, uncached_tokens: 4096 });
  expect(at(31, "openai_responses", { cache_write: 4096 })).toBeNull();
  // An older model that reports reads only: typical retention, reuse uncertain.
  expect(at(6, "openai_responses", { cache_read: 4096 })).toMatchObject({ certain: false });
  // Anthropic: 1-hour writes reported, sure for the hour; else sure for five minutes.
  expect(at(20, "anthropic_messages", { cache_write: 4096, cache_write_1h: 4096 })).toMatchObject({ certain: true });
  expect(at(4, "anthropic_messages", { cache_write: 4096 })).toMatchObject({ certain: true });
  expect(at(20, "anthropic_messages", { cache_write: 4096 })).toMatchObject({ certain: false });
  // A route that documents nothing: maybe, for five minutes.
  expect(at(6, "chat_completions", { cache_read: 4096 })).toBeNull();
});

test("the cost of losing a prefix past a context tier is priced at that tier", () => {
  const tiered = { ...to, price: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125, tiers: [{ above: 100_000, input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0.625 }] } } as unknown as ModelInfo;
  const w = (n: number) => switchWarning({ lineage: history({ cache_write: n }), now: 2 * MIN, from: tiered, to: tiered, toWire: "anthropic_messages", fromWire: "anthropic_messages", toEffort: "max" }).warning;
  const big = w(200_000)!, small = w(50_000)!;
  expect([big.cost_usd, big.cached_cost_usd]).toEqual([(200_000 * 0.625) / 1e6, (200_000 * 0.05) / 1e6]);
  expect(small.cost_usd).toBe((50_000 * 0.125) / 1e6);
});

// The warning follows the prefix of the model the last request ran on, as the
// newest reply with cache activity left it.
test("only a reply that used the cache keeps the prefix warm", () => {
  const usage = (u: Record<string, number>) => ({ input: 10, output: 1, cache_read: 0, cache_write: 0, ...u });
  const line = (...later: [number, string, Record<string, number>][]): StoredEvent[] => [
    { kind: "user", ts: 0, data: {} } as any,
    { kind: "assistant", ts: 1000, data: { model: "a:m", usage: usage({ cache_write: 4096, cache_write_1h: 4096 }) } } as any,
    ...later.flatMap(([min, model, u]) => [{ kind: "user", ts: min * MIN, data: {} }, { kind: "assistant", ts: min * MIN + 1000, data: { model, usage: usage(u) } }] as any[]),
  ];
  const warn = (lineage: StoredEvent[], min: number) => switchWarning({ lineage, now: min * MIN, to, toWire: "openai_responses", fromWire: "anthropic_messages" });
  // A reply at minute 50 that reported no cache activity: the prefix is the
  // one written at minute 0, warm until minute 60 and not a minute longer.
  const silent = line([50, "a:m", {}]);
  expect(warn(silent, 55)).toMatchObject({ warm_until: 60 * MIN, warning: { cause: "model", uncached_tokens: 4096 } });
  expect(warn(silent, 65).warning).toBeNull();
  // A cache hit on the same prefix at minute 50 keeps it for another hour.
  const hit = line([50, "a:m", { cache_read: 4096 }]);
  expect(warn(hit, 65)).toMatchObject({ warm_until: 110 * MIN, warning: { certain: true, uncached_tokens: 4096 } });
  // The last request ran on another model that reported no cache: nothing of
  // its prefix is there to lose, whatever the first model's cache still holds.
  expect(warn(line([50, "c:x", {}]), 55).warning).toBeNull();
  // A 1-hour write before a checkpoint says nothing about the prefix written after it.
  const after = [...line(), { kind: "compaction", ts: 2 * MIN, data: { mode: "summary", summary: "s" } }, { kind: "user", ts: 3 * MIN, data: {} }, { kind: "assistant", ts: 3 * MIN + 1000, data: { model: "a:m", usage: usage({ cache_write: 900 }) } }] as any[];
  expect(warn(after, 20).warning).toMatchObject({ certain: false, uncached_tokens: 900 });
});

// A start skips a session whose route can never show a lifetime long enough
// (longestSure) without reading its events: no evidence gives more than that.
test("no evidence shows a longer sure lifetime than the wire's longest", () => {
  const usages: Record<string, number>[] = [{}, { cache_read: 100 }, { cache_write: 100 }, { cache_write: 100, cache_write_1h: 100 }];
  for (const wire of ["anthropic_messages", "openai_responses", "openai_chat", "gemini", undefined] as any[]) {
    for (const u of usages) expect(retention(wire, history(u), "a:m").sure).toBeLessThanOrEqual(longestSure(wire));
  }
  expect(longestSure("anthropic_messages")).toBe(60 * MIN);
  expect(longestSure("openai_chat" as any)).toBe(0);
});
