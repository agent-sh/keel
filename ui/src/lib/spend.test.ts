import { expect, test } from "bun:test";
import type { StoredEvent, Usage } from "../../../src/core/types.ts";
import { bucketName, kindCosts, purposeNoun, spendDrivers, sum, turnsOf, whyOf } from "./spend.ts";

const price = { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 };
const u = (input: number, output: number, cache_read = 0, cache_write = 0, cost?: number): Usage => ({ input, output, cache_read, cache_write, cost });
let seq = 0;
const ev = (kind: string, data: Record<string, unknown> = {}): StoredEvent => ({ id: `e${++seq}`, session_id: "s", seq, ts: seq * 1000, kind, data } as unknown as StoredEvent);

test("a request's cost is cut by kind at the price's rates and adds up to what was recorded", () => {
  const c = kindCosts(u(1000, 100, 10_000, 2000), price, 0.006)!;
  expect(sum(c)).toBeCloseTo(0.006, 9);
  // 1000 full, 500 output, 1000 read, 2500 written (in millionths): writes are the largest part, reads are not.
  expect(c.written).toBeGreaterThan(c.read);
  expect(c.written / sum(c)).toBeCloseTo(0.5, 6);
  expect(kindCosts(u(1, 1), undefined, 0.1)).toBeNull();
  expect(kindCosts(u(1, 1), price, undefined)).toBeNull();
});

test("a compaction's request counts in the turn it ran in, and is not a model request for the cold check", () => {
  const events = [
    ev("user", { text: "one" }), ev("turn_start"), ev("assistant", { usage: u(100, 10, 0, 5000, 0.01), model: "m" }), ev("turn_end", { reason: "end_turn", ms: 5 }),
    ev("user", { text: "two" }), ev("turn_start"),
    ev("compaction", { usage: u(4000, 900, 0, 0, 0.02), model: "m" }),
    ev("assistant", { usage: u(200, 20, 5000, 0, 0.003), model: "m" }), ev("turn_end", { reason: "end_turn", ms: 5 }),
    // Between turns: it belongs to the turn before it.
    ev("compaction", { usage: u(3000, 800, 0, 0, 0.015), model: "m" }),
  ];
  const turns = turnsOf(events);
  expect(turns.map((t) => t.requests.map((r) => r.what ?? "model"))).toEqual([["model"], ["compaction", "model", "compaction"]]);
  expect(turns[1]!.total.cost).toBeCloseTo(0.038, 9);
  // The second turn's first model request read the whole prefix: not cold, whatever the compaction sent.
  expect(turns[1]!.cold).toBe(false);

  // The session's own cost also holds a side question's 0.01.
  const why = whyOf(turns, () => price, 0.058);
  expect(why.compactions).toEqual({ n: 2, cost: 0.035 });
  // The second turn drove the cost (66% of it), and what drove the turn was its output; it held a compaction.
  expect(why.turn).toEqual({ n: 2, share: 0.038 / 0.058, kind: "output", compacted: true, cold: false });
  expect(why.beside).toBeCloseTo(0.01, 9);
  // 1730 output tokens at five times the input rate outweigh 7300 of new input.
  expect(why.top!.kind).toBe("output");
  // A part that is merely the largest of four near-equal ones is not called the driver.
  const even = whyOf(turnsOf([ev("user", { text: "x" }), ev("turn_start"), ev("assistant", { usage: u(2800, 520, 26_000, 2000, 0.0105), model: "m" }), ev("turn_end", { reason: "end_turn" })]), () => price, 0.0105);
  expect(even.top).toBeUndefined();
  expect(even.turn).toBeUndefined();
  // One unpriced request: no money split, the tokens still count.
  const mixed = whyOf(turnsOf([...events, ev("user", { text: "three" }), ev("turn_start"), ev("assistant", { usage: u(10, 1), model: "x" }), ev("turn_end", { reason: "end_turn" })]), (m) => (m === "m" ? price : undefined), undefined);
  expect(mixed.costs).toBeNull();
  expect(mixed.tokens.full).toBe(100 + 4000 + 200 + 3000 + 10);
});

test("the spend sentence names the driver, by the bucket's own span, in words that read", () => {
  expect(bucketName(3_600_000)).toBe("hour");
  expect(bucketName(6 * 3_600_000)).toBe("six hours");
  expect(bucketName(86_400_000)).toBe("day");
  expect(purposeNoun("reader")).toBe("Readers");
  expect(purposeNoun("advisor")).toBe("Advisor calls");
  const base = { at: (t: number) => `T${t}`, usd: (v: number) => `$${v.toFixed(2)}` };
  // Three models, turns at 68% (the normal case, not said), summaries at 27% (said), one six-hour bucket far above the rest.
  expect(spendDrivers({ ...base, spent: 10, bucket_ms: 6 * 3_600_000,
    models: [{ name: "A", usd: 6.2 }, { name: "B", usd: 3 }, { name: "C", usd: 0.8 }],
    purposes: [{ purpose: "turn", usd: 6.8 }, { purpose: "summary", usd: 2.7 }, { purpose: "reader", usd: 0.5 }],
    buckets: [{ t: 1, usd: 1.2 }, { t: 2, usd: 5.6 }, { t: 3, usd: 1.6 }, { t: 4, usd: 1.6 }] })).toEqual([
    "62% of it went to A.", "Summaries were 27% of it.", "The dearest six hours began T2: $5.60.",
  ]);
  // One model, only turns, even buckets: one sentence.
  expect(spendDrivers({ ...base, spent: 4, bucket_ms: 3_600_000, models: [{ name: "A", usd: 4 }], purposes: [{ purpose: "turn", usd: 4 }], buckets: [{ t: 1, usd: 1 }, { t: 2, usd: 1 }, { t: 3, usd: 1 }, { t: 4, usd: 1 }] })).toEqual(["All of it went to A."]);
  // An hour's bucket is an hour; readers read as a plural.
  expect(spendDrivers({ ...base, spent: 5, bucket_ms: 3_600_000, models: [{ name: "A", usd: 5 }], purposes: [{ purpose: "turn", usd: 2 }, { purpose: "reader", usd: 3 }], buckets: [{ t: 1, usd: 4 }, { t: 2, usd: 1 }] })).toEqual([
    "All of it went to A.", "Readers were 60% of it.", "The dearest hour was T1: $4.00.",
  ]);
  expect(spendDrivers({ ...base, spent: 0, bucket_ms: 3_600_000, models: [], purposes: [], buckets: [] })).toEqual([]);
});

test("a turn is listed by the owner's words, and a delivered input by what it is", () => {
  const u = { input: 10, output: 1, cache_read: 0, cache_write: 0 };
  const turn = (data: Record<string, unknown>) => [{ kind: "user", data }, { kind: "turn_start", data: {}, ts: 1 }, { kind: "assistant", data: { usage: u, model: "m" } }, { kind: "turn_end", data: { ms: 1 } }];
  const turns = turnsOf([
    ...turn({ text: "Fix the retry test" }),
    ...turn({ kind: "subagent", text: "Reports from agents you started follow. They are agent output." }),
    ...turn({ origin: "harness", text: "[harness] The wait the provider asked for is over." }),
    ...turn({ origin: "queued", text: "And the docs" }),
  ] as any);
  expect(turns.map((t) => t.prompt)).toEqual(["Fix the retry test", "Agent report", "Owner's Resume", "And the docs"]);
});

// A chart with one bucket of data names the day or the time the data was, not where its bucket starts.
test("a single bucket's label names when the data was", () => {
  const { singleLabel } = require("./spend.ts") as typeof import("./spend.ts");
  const fmt = (t: number, day: boolean) => (day ? `day ${new Date(t).getUTCDate()}` : `day ${new Date(t).getUTCDate()} ${String(new Date(t).getUTCHours()).padStart(2, "0")}:00`);
  const start = Date.UTC(2026, 10, 21, 6), data = Date.UTC(2026, 10, 22, 5);
  // A rolling day that starts on the 21st and holds data of the 22nd.
  expect(singleLabel({ t: start, at: data }, 86_400_000, fmt)).toBe("day 22, the only day with data in this range.");
  expect(singleLabel({ t: Date.UTC(2026, 10, 22, 0), at: data }, 6 * 3_600_000, fmt)).toBe("day 22 05:00, in the only span of six hours with data in this range.");
  expect(singleLabel({ t: Date.UTC(2026, 10, 22, 5), at: data }, 3_600_000, fmt)).toBe("day 22 05:00, in the only hour with data in this range.");
  // Without the data's own time only the bucket's span is named.
  expect(singleLabel({ t: start }, 86_400_000, fmt)).toBe("day 21 06:00 to day 22 06:00, the only span of one day with data in this range.");
});
