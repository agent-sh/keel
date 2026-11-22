// Memory given back at rest and under the unit's bound; the events budget; the control group's files.
import { expect, test } from "bun:test";
import { parseLimit, parseMemoryEvents } from "./cgroup.ts";
import { Rest, REST_AFTER_MS } from "./rest.ts";
import { EVENTS_MAX, EVENTS_MIN, eventsBudgetOf } from "./store.ts";

const GB = 2 ** 30;

test("the events budget is a share of the machine and of the unit's bounds, within its floor and ceiling", () => {
  // A large machine with no unit: the ceiling.
  expect(eventsBudgetOf({ total: 64 * GB })).toBe(EVENTS_MAX);
  // A small one: a thirty-second of it, and never under the floor.
  expect(eventsBudgetOf({ total: 4 * GB })).toBe(4 * GB / 32);
  expect(eventsBudgetOf({ total: 1 * GB })).toBe(EVENTS_MIN);
  // The unit throttles at 2 GB: an eighth of that, though the machine is large.
  expect(eventsBudgetOf({ total: 64 * GB, high: 2 * GB })).toBe(2 * GB / 8);
  // A container that kills at 1 GB: a sixteenth; at half a gigabyte, the floor.
  expect(eventsBudgetOf({ total: 64 * GB, max: 1 * GB })).toBe(GB / 16);
  expect(eventsBudgetOf({ total: 64 * GB, max: GB / 2 })).toBe(EVENTS_MIN);
  // The smallest of the three decides.
  expect(eventsBudgetOf({ total: 8 * GB, high: 8 * GB, max: 2 * GB })).toBe(2 * GB / 16);
  // The owner's own number stands, above the ceiling too.
  expect(eventsBudgetOf({ total: 64 * GB, high: 2 * GB, set: 900 })).toBe(900e6);
});

test("the control group's files are read as the kernel writes them", () => {
  expect(parseLimit("max\n")).toBeUndefined();
  expect(parseLimit("8589934592\n")).toBe(8 * GB);
  expect(parseLimit(undefined)).toBeUndefined();
  expect(parseMemoryEvents("low 0\nhigh 12\nmax 3\noom 1\noom_kill 1\noom_group_kill 0\n")).toEqual({ high: 12, max: 3, oom_kill: 1 });
  expect(parseMemoryEvents(undefined)).toBeUndefined();
});

function rest(high?: () => number | undefined) {
  const did: string[] = [];
  const said: string[] = [];
  let now = 1_000_000;
  let rss = 900e6;
  const r = new Rest({
    store: { shrink: () => void did.push("shrink"), giveBack: (share) => { did.push(`give back to ${share}`); return 120e6; } },
    release: () => { did.push("release"); rss = 300e6; },
    highEvents: high,
    say: (l) => void said.push(l),
    rss: () => rss,
    clock: () => now,
  });
  return { r, did, said, pass: (ms: number, working: boolean) => { now += ms; r.tick(working, now); }, at: () => now };
}

test("memory is given back once, a minute after the daemon stopped working, and not again until it has worked", () => {
  const { r, did, pass, at } = rest();
  // Working: nothing is released, and the tick is not needed for this before a minute after the work.
  pass(1000, true);
  expect(did).toEqual([]);
  expect(r.due()).toBe(at() + REST_AFTER_MS);
  // Idle, but not for a minute yet.
  pass(30_000, false);
  expect(did).toEqual([]);
  // A minute with no turn: the kept events (all of them), the store's cache, then the collector and the allocator, once.
  pass(30_000, false);
  expect(did).toEqual(["give back to 0", "shrink", "release"]);
  expect(r.last).toMatchObject({ why: "rest", rss_before: 900e6, events_bytes: 120e6 });
  expect(r.due()).toBeUndefined();
  // Idle on: nothing more. What it came to is read a tick later.
  pass(10_000, false);
  pass(600_000, false);
  expect(did.length).toBe(3);
  expect(r.last?.rss_after).toBe(300e6);
  // Work again, rest again: once more.
  pass(1000, true);
  pass(REST_AFTER_MS, false);
  expect(did.length).toBe(6);
});

test("when the unit's bound is passed the store gives events back at once, and the daemon says so once", () => {
  let high = 0;
  const { r, did, said, pass } = rest(() => high);
  pass(1000, true);
  expect(did).toEqual([]);
  // The kernel counted a moment over MemoryHigh: half the events budget goes, and memory is released, though the daemon works.
  high = 3;
  pass(1000, true);
  expect(did).toEqual(["give back to 0.5", "shrink", "release"]);
  expect(said.length).toBe(1);
  expect(said[0]).toContain("passed its unit's memory bound (MemoryHigh) at 900 MB resident: it gave back 120 MB of kept events");
  expect(r.last).toMatchObject({ why: "pressure", events_bytes: 120e6 });
  // The count stays: nothing more.
  pass(1000, true);
  expect(did.length).toBe(3);
  // It rises again a minute later: acted on, not said again.
  high = 9;
  pass(60_000, true);
  expect(did.length).toBe(6);
  expect(said.length).toBe(1);
  // No bound on the unit: the count is never read as pressure.
  const none = rest(() => undefined);
  none.pass(1000, true);
  expect(none.did).toEqual([]);
});
