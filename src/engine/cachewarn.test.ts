// The switch warning lasts as long as the request that wrote the prefix keeps
// it, by what that route documents, and says "may" past a documented lifetime.
import { expect, test } from "bun:test";
import type { StoredEvent } from "../core/types.ts";
import type { ModelInfo } from "../providers/types.ts";
import { switchWarning } from "./cachewarn.ts";

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
