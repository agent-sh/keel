import { expect, test } from "bun:test";
import { BEAT_MS, GRACE_MS, idleCost, look, retryGap, SLOW_BEAT_MS, type Beat } from "./heartbeat.ts";

// Runs the looks of a socket that last delivered at `heard`, with frames arriving at `frames`.
function run(heard: number, frames: number[], until: number, every = BEAT_MS, late: Record<number, number> = {}) {
  let b: Beat = { heard, pings: 0, due: heard + every };
  const pings: number[] = [];
  let lost: number | null = null;
  const pending = [...frames].sort((x, y) => x - y);
  while (b.due <= until && lost === null) {
    const now = b.due + (late[b.due] ?? 0);
    while (pending.length && pending[0]! <= now) b = { ...b, heard: pending.shift()!, pings: 0 };
    const l = look(b, now, every);
    if (l.ping) pings.push(now);
    if (l.lost) lost = now;
    b = { heard: b.heard, pings: l.pings, due: l.due };
  }
  return { pings, lost };
}

test("a silent socket is lost two asks and a grace after its last frame", () => {
  const r = run(0, [], 60_000);
  expect(r.pings).toEqual([BEAT_MS, 2 * BEAT_MS]);
  expect(r.lost).toBe(2 * BEAT_MS + GRACE_MS);
  expect(r.lost!).toBeLessThanOrEqual(6_000);
});

test("an answer to each ask keeps the socket, one ask a beat and no more", () => {
  // Every ping is answered 30 ms later.
  const answers = Array.from({ length: 40 }, (_, i) => (i + 1) * (BEAT_MS + 30));
  const r = run(0, answers, 60_000);
  expect(r.lost).toBeNull();
  expect(r.pings.length).toBeGreaterThanOrEqual(28);
  expect(r.pings.length).toBeLessThanOrEqual(30);
});

test("one missed ask is not a loss: the second one's answer keeps the socket", () => {
  const r = run(0, [2 * BEAT_MS + 400], 3 * BEAT_MS + 300);
  expect(r.lost).toBeNull();
  expect(r.pings.slice(0, 2)).toEqual([BEAT_MS, 2 * BEAT_MS]);
});

test("a socket that delivers needs no ask", () => {
  // A reply streaming: a frame every 100 ms.
  const frames = Array.from({ length: 300 }, (_, i) => i * 100);
  const r = run(0, frames, 29_000);
  expect(r).toEqual({ pings: [], lost: null });
});

test("a look that ran late starts the count over instead of calling the socket lost", () => {
  // The page slept 30 s under the second ask's look: frames may wait behind the timer.
  const r = run(0, [], 2 * BEAT_MS + GRACE_MS + 30_000, BEAT_MS, { [2 * BEAT_MS + GRACE_MS]: 30_000 });
  expect(r.lost).toBeNull();
  expect(r.pings.at(-1)).toBe(2 * BEAT_MS + GRACE_MS + 30_000);
  // And from there the same two asks decide it.
  const again = run(0, [], 2 * BEAT_MS + GRACE_MS + 30_000 + BEAT_MS + GRACE_MS, BEAT_MS, { [2 * BEAT_MS + GRACE_MS]: 30_000 });
  expect(again.lost).toBe(2 * BEAT_MS + GRACE_MS + 30_000 + BEAT_MS + GRACE_MS);
});

test("the slow beat asks a fifth as often", () => {
  const r = run(0, [], 60_000, SLOW_BEAT_MS);
  expect(r.pings).toEqual([SLOW_BEAT_MS, 2 * SLOW_BEAT_MS]);
  expect(r.lost).toBe(2 * SLOW_BEAT_MS + GRACE_MS);
});

test("tries are close together at first and far apart for a long absence", () => {
  expect(retryGap(0)).toBe(500);
  expect(retryGap(25_000)).toBe(500);
  expect(retryGap(60_000)).toBe(1_000);
  expect(retryGap(5 * 60_000)).toBe(5_000);
  expect(retryGap(3_600_000)).toBe(8_000);
  expect(retryGap(1_000, true)).toBe(8_000);
});

test("an idle minute on screen costs thirty beats of about a kilobyte in all", () => {
  const c = idleCost();
  expect(c.beats).toBe(30);
  expect(c.bytes).toBeLessThan(1_200);
});
