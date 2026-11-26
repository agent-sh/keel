import { expect, test } from "bun:test";
import { reportTimes } from "./report-times.ts";

const at = Date.UTC(2026, 0, 5, 10, 0, 0);
const hm = (ts: number) => new Date(ts).toISOString().slice(11, 19);
const fmt = { time: hm, span: (ms: number) => `${Math.round(ms / 1000)}s` };

test("a report that went at once says when its agent finished", () => {
  expect(reportTimes(fmt, at, at + 300)).toBe(`Its task ended ${hm(at)}, reached this session at once`);
});

test("a report that waited says when it reached the session, how much later and why", () => {
  expect(reportTimes(fmt, at, at + 8_000, "settle")).toBe(`Its task ended ${hm(at)}, reached this session ${hm(at + 8_000)} (8s later, waited for the other agents' reports)`);
  expect(reportTimes(fmt, at, at + 125_000, "held")).toBe(`Its task ended ${hm(at)}, reached this session ${hm(at + 125_000)} (125s later, held while the session was stopped)`);
  expect(reportTimes(fmt, at, at + 3_000, "restart")).toContain("kept across a restart");
  expect(reportTimes(fmt, at, at + 3_000, "nonsense")).toBe(`Its task ended ${hm(at)}, reached this session ${hm(at + 3_000)} (3s later)`);
});

test("an input from before the stamp says nothing", () => {
  expect(reportTimes(fmt, undefined, at)).toBeUndefined();
  expect(reportTimes(fmt, "x", at)).toBeUndefined();
});
