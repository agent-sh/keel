import { expect, test } from "bun:test";
import { gatherWait, GATHER_MAX_MS, SENT_MS, STILL_MS } from "./steer-gather.ts";

const since = 1_000_000;

test("a box that holds nothing, or no typing known, waits for nothing", () => {
  expect(gatherWait(undefined, since, since, false)).toBe(0);
  expect(gatherWait({ typed: 0, emptied: 0 }, since, since, false)).toBe(0);
});

test("a key within the last 3 s waits until the box has been still that long", () => {
  expect(gatherWait({ typed: since - 1000, emptied: 0 }, since, since, false)).toBe(STILL_MS - 1000);
  expect(gatherWait({ typed: since - STILL_MS, emptied: 0 }, since, since, false)).toBe(0);
});

test("the wait never runs past GATHER_MAX_MS from when it began, however the owner keeps typing", () => {
  const near = since + GATHER_MAX_MS - 500;
  expect(gatherWait({ typed: near, emptied: 0 }, near, since, false)).toBe(500);
  const at = since + GATHER_MAX_MS;
  expect(gatherWait({ typed: at, emptied: 0 }, at, since, false)).toBe(0);
  expect(gatherWait({ typed: at + 10, emptied: 0 }, at + 10, since, false)).toBe(0);
});

test("a box that emptied while the step waited gives the sent message 1 s to arrive, and goes as it does", () => {
  const sent = since + 2000;
  expect(gatherWait({ typed: 0, emptied: sent }, sent + 200, since, false)).toBe(SENT_MS - 200);
  expect(gatherWait({ typed: 0, emptied: sent }, sent + 200, since, true)).toBe(0);
  expect(gatherWait({ typed: 0, emptied: sent }, sent + SENT_MS, since, false)).toBe(0);
  // An emptying from before the wait began was a message already taken: nothing to wait for.
  expect(gatherWait({ typed: 0, emptied: since - 100 }, since + 100, since, false)).toBe(0);
  // The grace is capped too.
  const late = since + GATHER_MAX_MS - 300;
  expect(gatherWait({ typed: 0, emptied: late }, late, since, false)).toBe(300);
});
