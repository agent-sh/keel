import { expect, test } from "bun:test";
import { dueNow, join, joinedReason } from "./restart-wait.ts";

const MIN = 60_000;

test("a restart waits while the owner is here, and goes when they step away or at its bound", () => {
  const w = join(null, { at: 0, timeoutMs: 120_000, reason: "keel restart from a terminal" }, 30 * MIN);
  expect(w).toEqual({ since_ms: 0, until_ms: 30 * MIN, asks: 1, reasons: ["keel restart from a terminal"], timeout_ms: 120_000 });
  expect(dueNow(w, true, 5 * MIN)).toBeNull();
  expect(dueNow(w, false, 5 * MIN)).toBe("away");
  expect(dueNow(w, true, 30 * MIN)).toBe("bound");
});

test("restarts asked meanwhile join the one that waits, and do not move its bound", () => {
  let w = join(null, { at: 0, timeoutMs: 60_000, reason: "a" }, 30 * MIN);
  w = join(w, { at: 20 * MIN, timeoutMs: 120_000, reason: "b" }, 30 * MIN);
  w = join(w, { at: 25 * MIN, timeoutMs: 30_000, reason: "a" }, 30 * MIN);
  expect(w).toEqual({ since_ms: 0, until_ms: 30 * MIN, asks: 3, reasons: ["a", "b"], timeout_ms: 120_000 });
  expect(joinedReason(w, "away")).toBe("a; b (3 restarts joined), once you stepped away");
});
