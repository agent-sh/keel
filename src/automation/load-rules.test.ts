// Which agent trees wait for the machine: over only after a whole minute above the line, the newest held first,
// the oldest let go first, and nothing let go while its share would put the machine over again.
import { expect, test } from "bun:test";
import { decide, IDLE, over, SAMPLE_MS, SETTLE_MS, type LoadState, type Reading, type Tree } from "./load-rules.ts";

const T = 24;
// A minute of readings at one load, ending at `now`.
const minute = (load1: number, now: number): Reading[] => {
  const out: Reading[] = [];
  for (let at = now - SETTLE_MS; at <= now; at += SAMPLE_MS) out.push({ at, load1, threads: T });
  return out;
};
// Seventeen trees, the first the oldest.
const trees: Tree[] = Array.from({ length: 17 }, (_, i) => ({ key: `t${i}`, started: 1000 + i }));

test("a spike, or a minute not yet read, is not over; a whole minute above the line is", () => {
  const now = 1_000_000;
  expect(over(minute(36, now), now)).toBe(true);
  expect(over(minute(24, now), now)).toBe(false);
  const spike = minute(20, now).map((r, i, a) => (i === a.length - 1 ? { ...r, load1: 40 } : r));
  expect(over(spike, now)).toBe(false);
  expect(over(minute(36, now).slice(-3), now)).toBe(false);
});

test("over the line, the newest trees are held, as many as the load over it is shares", () => {
  const now = 1_000_000;
  const st = decide(IDLE, minute(36, now), trees, now);
  // A share is 36 / 17; the load over the line is 12: six shares.
  expect(st.held).toEqual(["t16", "t15", "t14", "t13", "t12", "t11"]);
  expect(st.since).toBe(now);
  // A minute later still over at 30: a share is 30 / 17, six over the line is four more, the newest left first.
  const later = decide(st, minute(30, now + SETTLE_MS), trees, now + SETTLE_MS);
  expect(later.held.slice(0, 6)).toEqual(st.held);
  expect(later.held.slice(6)).toEqual(["t10", "t9", "t8", "t7"]);
  // Inside the same minute nothing more changes.
  expect(decide(st, minute(36, now + 10_000), trees, now + 10_000).held).toEqual(st.held);
});

test("between the line less a share and the line nothing is let go; under it the oldest held go first", () => {
  const now = 1_000_000;
  const held: LoadState = { held: ["t16", "t15", "t14", "t13"], changed_at: now - SETTLE_MS, since: now - SETTLE_MS };
  // A share is 23 / 17 = 1.35: letting one go would put 24.35 on 24 threads.
  expect(decide(held, minute(23, now), trees, now).held).toEqual(held.held);
  // At 21 there is room for two shares: the two oldest held go.
  const freed = decide(held, minute(21, now), trees, now);
  expect(freed.held).toEqual(["t16", "t15"]);
  expect(freed.changed_at).toBe(now);
  // Within the minute after a release nothing more is let go, however low the load.
  expect(decide(freed, minute(2, now + 1000), trees, now + 1000).held).toEqual(freed.held);
  const all = decide(freed, minute(2, now + SETTLE_MS), trees, now + SETTLE_MS);
  expect(all).toEqual({ held: [], changed_at: now + SETTLE_MS, since: null });
});

test("a tree that starts while trees wait and the machine has no room waits from its start; an ended tree is dropped", () => {
  const now = 1_000_000;
  const held: LoadState = { held: ["t16"], changed_at: now - 5000, since: now - 5000 };
  const fresh = { key: "new", started: now };
  const st = decide(held, minute(30, now), [...trees, fresh], now);
  expect(st.held).toEqual(["t16", "new"]);
  // The held tree's work ended: it is no longer held, and with nothing held the hold is over.
  expect(decide({ held: ["t16"], changed_at: now, since: now }, minute(30, now + 1000), trees.slice(0, 16), now + 1000)).toEqual({ held: [], changed_at: now, since: null });
});
