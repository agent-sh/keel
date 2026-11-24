import { expect, test } from "bun:test";
import { planLine, planState, STALE_MS, STALE_TURNS, turnsSince, type PlanFacts } from "./plan-age.ts";

const open = [{ status: "completed" }, { status: "in_progress" }, { status: "pending" }];
const at = 1_000_000_000_000;
const facts = (p: Partial<PlanFacts> = {}): PlanFacts => ({ at, turns: 0, now: at + 60_000, working: false, items: open, ...p });

test("a plan the session is working through is live", () => {
  expect(planState(facts())).toBe("live");
  expect(planState(facts({ turns: STALE_TURNS - 1, now: at + STALE_MS - 1 }))).toBe("live");
});

test("a plan left alone for many turns or hours is stale", () => {
  expect(planState(facts({ turns: STALE_TURNS }))).toBe("stale");
  expect(planState(facts({ now: at + STALE_MS }))).toBe("stale");
});

test("a turn at work is not idle time", () => {
  expect(planState(facts({ now: at + 3 * STALE_MS, working: true }))).toBe("live");
  expect(planState(facts({ now: at + 3 * STALE_MS, working: true, turns: STALE_TURNS }))).toBe("stale");
});

test("a plan with every step done folds, and finishing the work ends it", () => {
  expect(planState(facts({ items: [{ status: "completed" }, { status: "cancelled" }] }))).toBe("settled");
  expect(planState(facts({ endedAt: at + 5 }))).toBe("ended");
  expect(planState(facts({ endedAt: at - 5 }))).toBe("live");
});

test("the folded line says how old the plan is", () => {
  const f = { at, now: at + 3 * 3_600_000, items: open };
  expect(planLine("stale", f)).toBe("Plan from 3 h ago, not updated since");
  expect(planLine("stale", { ...f, now: at + 20 * 60_000 })).toBe("Plan from 20 min ago, not updated since");
  expect(planLine("stale", { ...f, now: at + 72 * 3_600_000 })).toBe("Plan from 3 days ago, not updated since");
  expect(planLine("settled", f)).toBe("Plan from 3 h ago, all 3 done");
});

test("turns are the ends after the plan", () => {
  const ev = [{ kind: "turn_end", ts: at - 1 }, { kind: "assistant", ts: at }, { kind: "turn_end", ts: at + 1 }, { kind: "turn_end", ts: at + 2 }];
  expect(turnsSince(ev, at)).toBe(2);
});
