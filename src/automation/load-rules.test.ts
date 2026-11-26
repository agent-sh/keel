// Which agent trees wait for the machine: over only after a whole minute above the line, the newest held first,
// the oldest let go first, and nothing let go while its share would put the machine over again.
import { expect, test } from "bun:test";
import { CPU_OVER, CPU_ROOM, decide, IDLE, MAX_WAIT_MS, over, SAMPLE_MS, SETTLE_MS, SLICE_OVER, type LoadState, type Psi, type Reading, type Tree } from "./load-rules.ts";

const T = 24;
// A minute of readings at one load, ending at `now`.
const minute = (load1: number, now: number): Reading[] => {
  const out: Reading[] = [];
  for (let at = now - SETTLE_MS; at <= now; at += SAMPLE_MS) out.push({ at, load1, threads: T });
  return out;
};
// A state with these trees held since `at`.
const hold = (held: string[], at: number): LoadState => ({ ...IDLE, held, changed_at: at, since: at, at: Object.fromEntries(held.map((k) => [k, at])) });
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
  // A minute later still over at 30: a share is 30 over the 11 trees that work (a held tree adds no load), six
  // over the line is three more, the newest left first.
  const later = decide(st, minute(30, now + SETTLE_MS), trees, now + SETTLE_MS);
  expect(later.held.slice(0, 6)).toEqual(st.held);
  expect(later.held.slice(6)).toEqual(["t10", "t9", "t8"]);
  // Inside the same minute nothing more changes.
  expect(decide(st, minute(36, now + 10_000), trees, now + 10_000).held).toEqual(st.held);
});

test("between the line less a share and the line nothing is let go; under it the oldest held go first", () => {
  const now = 1_000_000;
  const held = hold(["t16", "t15", "t14", "t13"], now - SETTLE_MS);
  // A share is 23 / 13 working trees = 1.77: letting one go would put 24.77 on 24 threads.
  expect(decide(held, minute(23, now), trees, now).held).toEqual(held.held);
  // At 20 there is room for two shares of 1.54: the two oldest held go.
  const freed = decide(held, minute(20, now), trees, now);
  expect(freed.held).toEqual(["t16", "t15"]);
  expect(freed.changed_at).toBe(now);
  // Within the minute after a release nothing more is let go, however low the load.
  expect(decide(freed, minute(2, now + 1000), trees, now + 1000).held).toEqual(freed.held);
  const all = decide(freed, minute(2, now + SETTLE_MS), trees, now + SETTLE_MS);
  expect(all).toMatchObject({ held: [], changed_at: now + SETTLE_MS, since: null });
});

test("a tree that starts while trees wait and the machine has no room waits from its start; an ended tree is dropped", () => {
  const now = 1_000_000;
  const held = hold(["t16"], now - 5000);
  const fresh = { key: "new", started: now };
  const st = decide(held, minute(30, now), [...trees, fresh], now);
  expect(st.held).toEqual(["t16", "new"]);
  // The held tree's work ended: it is no longer held, and with nothing held the hold is over.
  expect(decide(hold(["t16"], now), minute(30, now + 1000), trees.slice(0, 16), now + 1000)).toMatchObject({ held: [], changed_at: now, since: null });
});

test("a share is the load over the trees that work: held trees add none", () => {
  const now = 1_000_000;
  // Four held, thirteen work, load 30 on 24: a share is 30 / 13, the six over the line three more shares.
  const st = decide(hold(["t16", "t15", "t14", "t13"], now - SETTLE_MS), minute(30, now), trees, now);
  expect(st.held).toEqual(["t16", "t15", "t14", "t13", "t12", "t11", "t10"]);
});

test("with every tree held and the machine under its line, the oldest held goes; none waits for good", () => {
  const four = trees.slice(0, 4);
  let st = hold(["t3", "t2", "t1", "t0"], 0);
  // The load that stays is not Keel's (every tree waits): 28 on 32 threads for six hours.
  for (let now = SAMPLE_MS; now < 6 * 3_600_000; now += SAMPLE_MS)
    st = decide(st, minute(28, now).map((r) => ({ ...r, threads: 32 })), four, now);
  expect(st.held).toEqual([]);
  // The first goes at the first reading under the line, the oldest first.
  const first = decide(hold(["t3", "t2", "t1", "t0"], 0), minute(28, SETTLE_MS).map((r) => ({ ...r, threads: 32 })), four, SETTLE_MS);
  expect(first.held).toEqual(["t3", "t2", "t1"]);
});

test("a tree held past the cap goes on, the newest working tree takes its place, and it is not held again for as long", () => {
  const three = trees.slice(0, 3);
  // Held at 0 (the hold since after every tree started); its last change was a moment ago, so only the cap acts now.
  const held = { ...hold(["t2"], 0), since: 5000, changed_at: MAX_WAIT_MS - 1000 };
  // Still over at the cap (load 40 on 24, which is not this tree's): t2 goes and t1, the newest that works, waits.
  const st = decide(held, minute(40, MAX_WAIT_MS), three, MAX_WAIT_MS);
  expect(st.capped).toEqual(["t2"]);
  expect(st.held).toEqual(["t1"]);
  expect(st.rested.t2).toBe(2 * MAX_WAIT_MS);
  // A minute on, still over: the hold takes t0, never t2 while it rests.
  const next = decide(st, minute(40, MAX_WAIT_MS + SETTLE_MS), three, MAX_WAIT_MS + SETTLE_MS);
  expect(next.held).toEqual(["t1", "t0"]);
  expect(next.capped).toEqual([]);
  // Under the line at the cap nothing takes its place.
  expect(decide(held, minute(10, MAX_WAIT_MS), three, MAX_WAIT_MS)).toMatchObject({ held: [], capped: ["t2"] });
});

// A minute at one load with this pressure beside it.
const pressed = (load1: number, now: number, psi: Psi): Reading[] => minute(load1, now).map((r) => ({ ...r, psi }));

test("with pressure read, a load over the line holds only while tasks wait and the unattended slice's are among them", () => {
  const now = 1_000_000;
  // Over by the load and by the pressure, the slice waiting too: over, as the load alone says.
  expect(over(pressed(36, now, { cpu: CPU_OVER + 10, slice_cpu: SLICE_OVER + 10 }), now)).toBe(true);
  // A load that queues nobody for a processor (tasks waiting on the disk count in it): not over.
  expect(over(pressed(36, now, { cpu: CPU_OVER - 1, slice_cpu: SLICE_OVER + 10 }), now)).toBe(false);
  // The machine waits, the unattended jobs do not: holding trees would not take it away.
  expect(over(pressed(36, now, { cpu: CPU_OVER + 30, slice_cpu: 0 }), now)).toBe(false);
  // No slice read (jobs have no scopes here): the machine's pressure is enough.
  expect(over(pressed(36, now, { cpu: CPU_OVER + 10 }), now)).toBe(true);
  // A hot slice under the line is not over: the load still has to be.
  expect(over(pressed(20, now, { cpu: 40, slice_cpu: 60 }), now)).toBe(false);
  expect(decide(IDLE, pressed(36, now, { cpu: 50, slice_cpu: 0 }), trees, now).held).toEqual([]);
});

test("calm by the pressure lets every held tree go while the minute's load still says over", () => {
  const now = 1_000_000;
  const held = hold(["t16", "t15", "t14", "t13"], now - SETTLE_MS);
  // The load lags a burst that ended: 30 on 24 threads, but nothing waited in the last ten seconds.
  const calm = decide(held, pressed(30, now, { cpu: CPU_ROOM - 1, slice_cpu: 0 }), trees, now);
  expect(calm.held).toEqual([]);
  expect(calm.changed_at).toBe(now);
  // At the room line it is not calm, and the load alone decides: 30 over 13 working trees leaves no room.
  expect(decide(held, pressed(30, now, { cpu: CPU_ROOM, slice_cpu: 0 }), trees, now).held).toEqual(held.held);
  // Calm still waits a minute after the last change.
  expect(decide({ ...held, changed_at: now - 10_000 }, pressed(30, now, { cpu: 0 }), trees, now).held).toEqual(held.held);
  // With every tree held, calm lets them all go, not one a minute.
  const four = trees.slice(0, 4);
  expect(decide(hold(["t3", "t2", "t1", "t0"], 0), pressed(30, SETTLE_MS, { cpu: 1 }), four, SETTLE_MS).held).toEqual([]);
});
