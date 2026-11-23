import { expect, test } from "bun:test";
import { decide, expectedEnd, pingsTo, type PlanIn } from "./cache-plan.ts";

const MIN = 60_000;
// A 357K-token context on a five-minute cache: a warm request reads it at a
// fortieth of the input rate, a rewrite after a lapse writes it at twice the rate.
const base = (o: Partial<PlanIn> = {}): PlanIn => ({
  now: 0, started: 0, touched: 0, life: 5 * MIN, margin: MIN, warmable: true,
  wait: { kind: "timer" }, costs: { ping: 0.045, lapse: 3.57 }, spent: 0, ...o,
});

test("a wait that ends while the cache holds needs nothing", () => {
  expect(decide(base({ wait: { kind: "timer", due: 3 * MIN } })).choice).toBe("none");
});

test("a timer past the lifetime is kept warm when that is cheaper than a rewrite", () => {
  const p = decide(base({ wait: { kind: "timer", due: 20 * MIN } }));
  expect(p).toMatchObject({ choice: "warm", at: 3.5 * MIN, pings: 5, expect: { ms: 20 * MIN, from: "timer" } });
  expect(p.costs.warm).toBeCloseTo(0.225);
});

test("a wait so long that warming costs more than a rewrite lets the cache lapse, or takes the summary", () => {
  const long = base({ wait: { kind: "timer", due: 12 * 60 * MIN } });
  expect(decide(long).choice).toBe("lapse");
  expect(decide({ ...long, costs: { ...long.costs, summary: 0.9 } }).choice).toBe("summary");
  // A route whose reads do not refresh the lifetime cannot be kept warm.
  expect(decide(base({ warmable: false, wait: { kind: "timer", due: 20 * MIN } })).choice).toBe("lapse");
});

test("an unknown length is warmed while that costs less than one rewrite", () => {
  const open = base({ wait: { kind: "file" } });
  expect(decide(open).choice).toBe("warm");
  expect(decide({ ...open, spent: 3.55 }).choice).toBe("lapse");
  expect(decide({ ...open, spent: 3.55, costs: { ...open.costs, summary: 1 } }).choice).toBe("summary");
});

test("the past waits of the kind give the expected length, within the deadline", () => {
  expect(expectedEnd({ kind: "pr_checks", past: [10 * MIN, 30 * MIN, 20 * MIN] }, 0, 0)).toEqual({ end: 20 * MIN, sure: false, from: "past" });
  expect(expectedEnd({ kind: "pr_checks", past: [60 * MIN], deadline: 15 * MIN }, 0, 0)!.end).toBe(15 * MIN);
  const p = decide(base({ wait: { kind: "pr_checks", past: [20 * MIN] } }));
  expect(p).toMatchObject({ choice: "warm", pings: 5, expect: { from: "past" } });
  // Past its usual length the rule for an unknown length holds.
  expect(decide(base({ now: 25 * MIN, touched: 24 * MIN, wait: { kind: "pr_checks", past: [20 * MIN] }, spent: 3.6 })).choice).toBe("lapse");
});

test("a deadline decides only when warming to it is cheapest", () => {
  expect(decide(base({ wait: { kind: "file", deadline: 30 * MIN } })).choice).toBe("warm");
  // A day-long deadline: not decided by it; warmed as an unknown length.
  expect(decide(base({ wait: { kind: "file", deadline: 24 * 60 * MIN } }))).toMatchObject({ choice: "warm", why: expect.stringContaining("not known") });
});

test("warm requests are counted to the wake", () => {
  expect(pingsTo(4, 4, 4)).toBe(0);
  expect(pingsTo(4, 5, 4)).toBe(1);
  expect(pingsTo(4, 12, 4)).toBe(2);
  expect(pingsTo(4, 13, 4)).toBe(3);
});

test("nothing is sent once the last moment a request finds the cache has passed", () => {
  // A daemon that was down past the lapse, or a timer that ran late: never a warm request that would write the cache again.
  for (const wait of [{ kind: "file" }, { kind: "timer", due: 60 * MIN }])
    expect(decide(base({ now: 4 * MIN, wait, costs: { ping: 0.045, lapse: 3.57, summary: 1 } }))).toMatchObject({ choice: "lapse", why: expect.stringContaining("lapsed") });
  expect(decide(base({ now: 3.9 * MIN, wait: { kind: "file" } })).choice).toBe("warm");
});

test("the warm requests of one wait never cost more in all than one rewrite", () => {
  // A known wait whose remaining warm requests and what was spent pass a rewrite lets it lapse.
  expect(decide(base({ spent: 3.4, wait: { kind: "timer", due: 20 * MIN } })).choice).toBe("lapse");
  expect(decide(base({ spent: 3.3, wait: { kind: "timer", due: 20 * MIN } })).choice).toBe("warm");
  // A deadline-bound or usual-length wait too.
  expect(decide(base({ spent: 3.55, wait: { kind: "file", deadline: 30 * MIN } })).choice).toBe("lapse");
  expect(decide(base({ spent: 3.5, wait: { kind: "pr_checks", past: [20 * MIN] } })).choice).toBe("lapse");
});
