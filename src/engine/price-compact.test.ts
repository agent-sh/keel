import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIN_COMPARABLE, priceCompaction, residual, type AgentLife, type PriceAsk } from "./price-compact.ts";
import { priceFactsRead } from "./price-facts.ts";

const lives = (n: number, steps: number, type = "general-purpose", model = "m") => Array.from({ length: n }, (): AgentLife => ({ type, model, steps }));

test("the forecast reads the narrowest group with enough agents past this one's steps", () => {
  const pool = [...lives(MIN_COMPARABLE, 100), ...lives(MIN_COMPARABLE, 40, "Explore"), ...lives(5, 400, "general-purpose", "other")];
  // Of its own kind and model: every one took 100, so 100 - 30 done - 10 while the summary is written.
  expect(residual(30, 10, { type: "general-purpose", model: "m" }, pool)).toEqual({ after: 60, survive: 1, n: MIN_COMPARABLE, from: "kind" });
  // Past 40 steps the Explore agents are no help: the model's agents are (those that took 100).
  expect(residual(50, 0, { type: "Explore", model: "m" }, pool)).toMatchObject({ after: 50, from: "model", n: MIN_COMPARABLE });
  // Past 100 only the other model's five: too few, so all of them; still too few, so its own history.
  const own = residual(120, 20, { type: "general-purpose", model: "m" }, pool);
  expect(own.from).toBe("own");
  expect(own.after).toBe(100);
  expect(own.survive).toBeCloseTo(120 / 140);
  // Agents that end before the summary is ready count as no steps ahead, and as not surviving.
  const mixed = [...lives(10, 35), ...lives(10, 100)];
  expect(residual(30, 10, { model: "m" }, mixed)).toEqual({ after: 30, survive: 0.5, n: 20, from: "model" });
});

const price = { input: 8, output: 40, cache_read: 0.2, cache_write: 10 };
const ask = (over: Partial<PriceAsk> = {}): PriceAsk => ({
  used: 600_000, prefix: 80_000, keep: 110_000, growth: 1_000, summaryIn: 900, summaryOut: 8_000,
  ahead: { after: 30, survive: 1, n: 40, from: "kind" }, price, ...over,
});

test("a summary is priced against what the steps ahead read of the context above what it keeps", () => {
  const v = priceCompaction(ask())!;
  // 30 steps x 490K tokens x $0.2/M.
  expect(v.save).toBeCloseTo(30 * 490_000 * 0.2 / 1e6, 6);
  // The request: 600K read, its prompt written, 8K out; then 30K written once instead of read.
  expect(v.cost).toBeCloseTo((600_000 * 0.2 + 900 * 10 + 8_000 * 40) / 1e6 + 30_000 * (10 - 0.2) / 1e6, 6);
  expect(v.compact).toBe(true);
  // Few steps ahead: the summary does not pay.
  expect(priceCompaction(ask({ ahead: { after: 3, survive: 1, n: 40, from: "kind" } }))!.compact).toBe(false);
  // The rewrite is paid only as often as the agent is still there for it.
  const half = priceCompaction(ask({ ahead: { after: 30, survive: 0.5, n: 40, from: "kind" } }))!;
  expect(v.cost - half.cost).toBeCloseTo(0.5 * 30_000 * (10 - 0.2) / 1e6, 6);
  // A context no larger than what a summary keeps, or a model with no cache read price: nothing to gain, or nothing to price.
  expect(priceCompaction(ask({ used: 100_000 }))!.compact).toBe(false);
  expect(priceCompaction(ask({ price: { input: 8, output: 40 } }))).toBeUndefined();
});

test("a growing context waits for the gap that is cheapest to compact at", () => {
  // 30K over what a summary keeps pays over 300 steps, but at 2K a step it is compacted again soon:
  // the cheapest gap is sqrt(2 x cost x growth / read price), about 115K here (the summary reads a larger context at a little more).
  const early = priceCompaction(ask({ used: 140_000, keep: 110_000, growth: 2_000, ahead: { after: 300, survive: 1, n: 40, from: "kind" } }))!;
  expect(early.save).toBeGreaterThan(early.cost);
  expect(early.best_gap).toBe(Math.round(Math.sqrt((2 * early.cost * 2_000) / (0.2 / 1e6))));
  expect(early.compact).toBe(false);
  expect(priceCompaction(ask({ used: 110_000 + early.best_gap! + 10_000, keep: 110_000, growth: 2_000, ahead: { after: 300, survive: 1, n: 40, from: "kind" } }))!.compact).toBe(true);
  // A context that does not grow has nothing to wait for.
  expect(priceCompaction(ask({ used: 140_000, keep: 110_000, growth: 0, ahead: { after: 300, survive: 1, n: 40, from: "kind" } }))!.compact).toBe(true);
});

test("a tiered price bills each step at the tier of its own size", () => {
  const tiered = { input: 1, output: 4, cache_read: 0.1, cache_write: 1, tiers: [{ above: 200_000, input: 2, output: 8, cache_read: 0.4, cache_write: 2 }] };
  const v = priceCompaction(ask({ used: 300_000, keep: 50_000, prefix: 20_000, growth: 0, price: tiered, ahead: { after: 10, survive: 1, n: 40, from: "kind" } }))!;
  // Above the tier the context is read at 0.4; the summary's context at 0.1.
  expect(v.save).toBeCloseTo(10 * (300_000 * 0.4 - 50_000 * 0.1) / 1e6, 6);
});

test("the ledger read gives finished agents' steps and each model's summaries", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE telemetry_calls (session_id TEXT, ts INTEGER, model TEXT, outcome TEXT, purpose TEXT, output INTEGER, latency_ms INTEGER);
    CREATE TABLE agents (session_id TEXT, type TEXT, model TEXT, status TEXT);`);
  const call = db.query("INSERT INTO telemetry_calls VALUES (?, ?, 'm', ?, ?, ?, ?)");
  for (let i = 0; i < 5; i++) call.run("a", 1_000 + i, "ok", "turn", 10, 100);
  call.run("a", 1_010, "error", "turn", 0, 100); // a failed attempt is not a step
  call.run("a", 1_011, "ok", "summary", 3_000, 40_000);
  call.run("a", 1_012, "ok", "summary", 5_000, 60_000);
  call.run("a", 1_013, "ok", "summary", 4_000, 50_000);
  for (let i = 0; i < 3; i++) call.run("b", 1_000 + i, "ok", "turn", 10, 100);
  call.run("c", 9_000, "ok", "turn", 10, 100); // still working at the quiet line
  db.exec(`INSERT INTO agents VALUES ('a', 'general-purpose', 'm', 'completed'), ('b', 'Explore', 'm', 'running'), ('c', 'general-purpose', 'm', 'completed')`);
  const r = priceFactsRead(db, { since: 0, quiet: 5_000 });
  expect(r.lives).toEqual([{ type: "general-purpose", model: "m", steps: 5 }]);
  expect(r.summaries).toEqual([{ model: "m", out: 4_000, ms: 50_000, n: 3 }]);
  // A store with no ledger (a test's): no facts.
  expect(priceFactsRead(new Database(":memory:"), { since: 0, quiet: 1 })).toEqual({ lives: [], summaries: [] });
});
