// Why one turn was dearer or slower than another, and spend ranked by agent tree.
import { expect, test } from "bun:test";
import { rankLines, rankTrees, turnDiff, turnFacts, type TurnFacts } from "./turn-compare.ts";

const turn = (n: number, p: Partial<TurnFacts>): TurnFacts => ({
  turn_event: `t${n}`, n, ts: n * 1000, ms: 4000, outcome: "ok", reason: "end_turn", model: "one:model-a", cost: 0.01, requests: 1, failed_attempts: 0, tool_calls: 0, tool_errors: 0,
  input: 1000, output: 200, cache_read: 9000, cache_write: 0, zones: { tools: 2000, system: 1000, history: 6000, tail: 1000 }, request_ms: 3000, tool_ms: 500, wait_ms: 500, ttft_ms: 400,
  cache_ms: null, compacted: false, prompt: "", ...p,
});

test("a dearer, slower turn is explained by what it sent, what the cache gave and where the time went", () => {
  const cold = turn(12, {
    cost: 0.052, ms: 45_000, input: 2000, cache_read: 0, cache_write: 46_000, output: 900, requests: 3, failed_attempts: 2, tool_calls: 2, tool_errors: 1,
    zones: { tools: 2000, system: 1000, history: 44_000, tail: 1000 }, request_ms: 9000, tool_ms: 30_500, wait_ms: 5500, compacted: true,
  });
  const d = turnDiff(cold, turn(11, {}));
  expect(d.cost).toBe("Turn 12 cost $0.04 more than turn 11 ($0.05 against $0.01): 46,000 more tokens written to the cache, 38,000 more prompt tokens sent (history +38,000), 1,000 more input tokens paid in full (not read from cache).");
  expect(d.time).toBe("Turn 12 took 41 s longer than turn 11 (45 s against 4.0 s): 30 s more in tools, 6.0 s more in model requests, 5.0 s more waiting (approvals, questions, retries, the daemon).");
  expect(d.also).toEqual([
    "Turn 12 read 0% of its prompt from the cache, turn 11 90%.",
    "Turn 12 made 3 requests, 2 of them failed attempts; turn 11 1 request.",
    "Turn 12 ran 2 tool calls (1 failed); turn 11 0.",
    "Turn 12 ran with a compaction; the other did not.",
  ]);
  // The other way round reads as cheaper and faster; equal turns say so; an unpriced one claims no difference.
  const back = turnDiff(turn(11, {}), cold);
  expect(back.cost).toStartWith("Turn 11 cost $0.04 less than turn 12 ($0.01 against $0.05): 46,000 fewer tokens written to the cache");
  expect(back.time).toStartWith("Turn 11 took 41 s less than turn 12 (4.0 s against 45 s): 30 s less in tools");
  expect(turnDiff(turn(2, {}), turn(1, {}))).toEqual({ cost: "Turn 2 cost the same as turn 1 ($0.01).", time: "Turn 2 took as long as turn 1 (4.0 s).", also: [] });
  expect(turnDiff(turn(2, { cost: null, output: 300 }), turn(1, {})).cost).toBe("Turn 2's cost against turn 1's is not known (a request without a price); 100 more output tokens.");
});

test("a ledger row becomes a turn's facts: the time outside requests and tools is the wait", () => {
  const f = turnFacts({ turn_event: "e", n: 3, ts: 5, ms: 10_000, outcome: "ok", reason: "end_turn", model: null, cost: null, requests: 2, failed_attempts: 1, tool_calls: 1, tool_errors: 0,
    input: 1, output: 2, cache_read: 3, cache_write: 4, cache_ms: null, compacted_in_turn: 0, compaction_event: null, prompt: null, measured: 0, request_ms: 3000, tool_ms: 2500, ttft_ms: null });
  expect([f.wait_ms, f.zones, f.compacted, f.prompt]).toEqual([4500, null, false, ""]);
});

test("spend is ranked by agent tree: an agent's spend counts under the session at the top", () => {
  const row = (key: string, cost: number, calls = 1) => ({ key, priced_cost_usd: cost, unpriced_calls: 0, calls, total_tokens: calls * 100 });
  const parents: Record<string, string> = { a1: "top", a2: "a1", lone: "gone" };
  const trees = rankTrees([row("many", 2.9, 1200), row("top", 0.004), row("a1", 0.003), row("a2", 0.001), row("small", 0.5), row("lone", 0.2)], (id) => parents[id]);
  expect(trees.map((t) => [t.key, Number(t.priced_cost_usd.toFixed(3)), t.agents])).toEqual([["many", 2.9, 0], ["small", 0.5, 0], ["gone", 0.2, 1], ["top", 0.008, 2]]);
  expect(trees[3]).toMatchObject({ own_cost_usd: 0.004, calls: 3 });
  const lines = rankLines(trees, (id) => ({ many: "Many turns", top: "Coordinator" })[id], 3);
  expect(lines[0]).toBe("   1.     $2.90    1200 requests  Many turns  [session=many]");
  expect(lines[2]).toBe("   3.     $0.20       1 request   a removed session, $0.20 of it in 1 agent  [session=gone]");
  expect(lines[3]).toBe("      1 more: $0.0080 in all");
});
