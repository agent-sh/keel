// An agent that ended is news until its end was seen, and only if it ended
// after this browser first looked.
import { expect, test } from "bun:test";
import { endedUnseen } from "./agent-seen.ts";

test("an ended agent is marked until its end is seen; a live one and an old end are not", () => {
  const kept = { since: 1000, seen: { b: 2000 } };
  expect(endedUnseen({ id: "a", status: "completed", ended: 1500 }, kept)).toBe(true);
  expect(endedUnseen({ id: "a", status: "failed", ended: 1500 }, kept)).toBe(true);
  // Still out: nothing to see yet.
  expect(endedUnseen({ id: "a", status: "running", ended: null }, kept)).toBe(false);
  expect(endedUnseen({ id: "a", status: "waiting" }, kept)).toBe(false);
  // Ended before this browser first looked: not news.
  expect(endedUnseen({ id: "a", status: "completed", ended: 900 }, kept)).toBe(false);
  // Seen. One that went on and ended again is news again.
  expect(endedUnseen({ id: "b", status: "completed", ended: 2000 }, kept)).toBe(false);
  expect(endedUnseen({ id: "b", status: "completed", ended: 3000 }, kept)).toBe(true);
});
