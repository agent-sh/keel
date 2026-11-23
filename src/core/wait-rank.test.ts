import { expect, test } from "bun:test";
import { byCost, costLine, rankWaiting, waitKey, type WaitCost } from "./wait-rank.ts";

const MIN = 60_000;
const margin = MIN;
const cost = (f: Omit<WaitCost, "key">): WaitCost => ({ ...f, key: waitKey(f, margin) });

test("the key is the agents' spend a minute plus the cache spread over the minutes left to save it", () => {
  // Three minutes left, one of them the margin: $0.90 over two minutes.
  expect(waitKey({ at: 0, agents: 0, rate: 0, tokens: 180_000, usd: 0.9, until: 3 * MIN }, margin)).toBeCloseTo(0.45);
  expect(waitKey({ at: 0, agents: 3, rate: 0.12, tokens: 180_000, usd: 0.9, until: 3 * MIN }, margin)).toBeCloseTo(0.57);
  // The same cache that keeps for an hour costs little a minute.
  expect(waitKey({ at: 0, agents: 0, rate: 0, tokens: 180_000, usd: 0.9, until: 61 * MIN }, margin)).toBeCloseTo(0.015);
  // Lapsed, or within the margin: nothing left to save.
  expect(waitKey({ at: 0, agents: 0, rate: 0, tokens: 180_000, usd: 0.9, until: MIN / 2 }, margin)).toBe(0);
  expect(waitKey({ at: 0, agents: 0, rate: 0 }, margin)).toBe(0);
});

test("the costlier wait comes first; ties and free waits go oldest first, then by id", () => {
  const cheap = { id: "q", ts: 1_000, wait: cost({ at: 1_000, agents: 0, rate: 0 }) };
  const dear = { id: "a", ts: 5_000, wait: cost({ at: 5_000, agents: 2, rate: 0.05, tokens: 90_000, usd: 0.4, until: 5_000 + 4 * MIN }) };
  const older = { id: "z", ts: 500 };
  const twin = { id: "b", ts: 500 };
  expect(rankWaiting([cheap, dear, older, twin], (x) => x).map((x) => x.id)).toEqual(["a", "b", "z", "q"]);
  // The order is a total one: it never depends on where an item stood before.
  const all = [cheap, dear, older, twin];
  for (let i = 0; i < 6; i++) {
    const shuffled = [...all].sort(() => (i % 2 ? 1 : -1));
    expect(rankWaiting(shuffled, (x) => x).map((x) => x.id)).toEqual(["a", "b", "z", "q"]);
  }
  expect(byCost(cheap, cheap)).toBe(0);
});

test("the line says what the wait costs, as it stands now", () => {
  const c = cost({ at: 0, agents: 3, rate: 0.12, tokens: 180_000, usd: 0.9, until: 2 * MIN });
  expect(costLine(c, 0)).toBe("3 agents wait ($0.12/min); cache of 180K tokens expires in 2 min: about $0.90 to rewrite");
  expect(costLine(c, 3 * MIN)).toBe("3 agents wait ($0.12/min); cache of 180K tokens lapsed: about $0.90 to rewrite");
  expect(costLine(cost({ at: 0, agents: 1, rate: 0, tokens: 1_200_000, usd: 4, until: 90 * MIN }), 0)).toBe("1 agent waits; cache of 1.2M tokens expires in 1 h 30 min: about $4.00 to rewrite");
  expect(costLine(cost({ at: 0, agents: 0, rate: 0, tokens: 2_400, usd: 0.003, until: 20_000 }), 0)).toBe("Cache of 2K tokens expires in under a minute: about $0.0030 to rewrite");
  expect(costLine(cost({ at: 0, agents: 0, rate: 0 }), 0)).toBe("Nothing waits behind it");
  expect(costLine(undefined, 0)).toBe("");
});
