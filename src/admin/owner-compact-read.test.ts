import { expect, test } from "bun:test";
import { numbersOf, windowsOf, type CallFact } from "./owner-compact-read.ts";

const H = 3_600_000;

test("the window before is as long as the one since, from an hour to a day; off, it is the last day", () => {
  expect(windowsOf(undefined, undefined, 100 * H)).toEqual({ before: [76 * H, 100 * H] });
  expect(windowsOf(90 * H, undefined, 100 * H)).toEqual({ before: [80 * H, 90 * H], since: [90 * H, 100 * H] });
  expect(windowsOf(99.5 * H, undefined, 100 * H)).toEqual({ before: [98.5 * H, 99.5 * H], since: [99.5 * H, 100 * H] });
  expect(windowsOf(50 * H, undefined, 100 * H)).toEqual({ before: [26 * H, 50 * H], since: [50 * H, 100 * H] });
  // Turned off again: the window since ends there.
  expect(windowsOf(90 * H, 94 * H, 100 * H)).toEqual({ before: [86 * H, 90 * H], since: [90 * H, 94 * H] });
});

test("a window's numbers: the turn steps' context and first token, every request's dollars, its compactions", () => {
  const call = (ts: number, context: number, o: Partial<CallFact> = {}): CallFact => ({ ts, purpose: "turn", outcome: "ok", ttft_ms: context / 100, context, cost: 1, ...o });
  const calls = [call(0, 100), call(H / 2, 300), call(H - 1, 200), call(10, 9_000, { purpose: "summary" }), call(20, 9_000, { outcome: "error", cost: null }), call(H, 999)];
  const n = numbersOf(calls, [5, H + 1], 0, H);
  expect(n).toEqual({ from: 0, to: H, hours: 1, steps: 3, context_p50: 200, context_p90: 300, first_token_p50_ms: 2, usd: 4, usd_per_hour: 4, usd_per_step: 1.3333, compactions: 1 });
});
