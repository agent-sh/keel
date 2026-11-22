import { expect, test } from "bun:test";
import type { SessionState } from "../../../src/core/watch.ts";
import { MAX_BEHIND_MS, SETTLE_MS, settleIn, stateKey, urgent } from "./settle.ts";

const st = (o: Partial<SessionState>): SessionState => ({ watch: "idle", agents: 0, ...o });

test("a change that calls the owner is shown at once, any other waits", () => {
  expect(urgent(st({ watch: "done" }), st({ watch: "need", why: "approval" }))).toBe(true);
  expect(urgent(st({ watch: "need" }), st({ watch: "work" }))).toBe(true);
  expect(urgent(st({ watch: "work" }), st({ watch: "fail", cls: "billing" }))).toBe(true);
  expect(urgent(st({ watch: "need", text: "Approve Bash: ls" }), st({ watch: "need", text: "Approve Bash: rm" }))).toBe(true);
  expect(urgent(st({ watch: "work" }), st({ watch: "work", offline: true, as_of: 5 }))).toBe(true);
  expect(urgent(st({ watch: "done" }), st({ watch: "work", why: "model" }))).toBe(false);
  expect(urgent(st({ watch: "work", why: "model" }), st({ watch: "work", why: "tool", text: "Running Bash" }))).toBe(false);
  expect(urgent(st({ watch: "work", agents: 3 }), st({ watch: "work", agents: 9 }))).toBe(false);
  expect(urgent(undefined, st({ watch: "work" }))).toBe(true);
});

test("a new value waits until it has held, and never past the bound since the row fell behind", () => {
  expect(settleIn(1000, 1000, 1000)).toBe(SETTLE_MS);
  expect(settleIn(1000, 1000, 2000)).toBe(SETTLE_MS - 1000);
  // A value that keeps changing is shown at the latest MAX_BEHIND_MS after the row fell behind.
  expect(settleIn(10_000, 5_000, 10_000)).toBe(5_000 + MAX_BEHIND_MS - 10_000);
  expect(settleIn(1000, 1000, 9000)).toBe(0);
});

test("a new step's start is not a change of what the row says", () => {
  expect(stateKey(st({ watch: "work", why: "tool", text: "Running Bash", since: 1 }))).toBe(stateKey(st({ watch: "work", why: "tool", text: "Running Bash", since: 2 })));
  expect(stateKey(st({ watch: "work", agents: 3 }))).not.toBe(stateKey(st({ watch: "work", agents: 4 })));
});
