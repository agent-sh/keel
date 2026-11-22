// The daemon's one tick: when its members run, and how long it sleeps between them.
import { expect, test } from "bun:test";
import { IDLE_MAX_MS, nextDelay, nextRun, Pulse } from "./pulse.ts";

test("a working daemon runs each member at its period; an idle one when the member says, and with the others at the idle round", () => {
  const m = { every: 1000, last: 50_000 };
  const round = 48_000;
  // Working: a period after the last run, whatever the member has scheduled.
  expect(nextRun(m, undefined, true, round)).toBe(51_000);
  expect(nextRun(m, 90_000, true, round)).toBe(51_000);
  // Idle with nothing scheduled: at the idle round, the longest sleep after the last one.
  expect(nextRun(m, undefined, false, round)).toBe(round + IDLE_MAX_MS);
  // Idle with something due in four seconds: then.
  expect(nextRun(m, 54_000, false, round)).toBe(54_000);
  // Due now, or overdue: never sooner than its own period.
  expect(nextRun(m, 50_200, false, round)).toBe(51_000);
  expect(nextRun(m, 0, false, round)).toBe(51_000);
  // Due in an hour: the idle round bounds it.
  expect(nextRun(m, 50_000 + 3_600_000, false, round)).toBe(round + IDLE_MAX_MS);
  // A member whose period is longer than the longest sleep keeps its period.
  expect(nextRun({ every: 30_000, last: 40_000 }, undefined, false, round)).toBe(70_000);
});

test("the tick sleeps until the first member's time, and no longer than the longest sleep", () => {
  const now = 100_000;
  const life = { every: 1000, last: now - 400 };
  const sweep = { every: 5000, last: now - 3000 };
  // Working: the sign of life is due in 600 ms.
  expect(nextDelay(now, [life, sweep], true)).toBe(600);
  // Idle, nothing scheduled: one sleep to the idle round for both, though they last ran at different moments.
  expect(nextDelay(now, [life, sweep], false, now - 100)).toBe(IDLE_MAX_MS - 100);
  // Idle, a timer wait fires in 2.5 s: then.
  expect(nextDelay(now, [{ ...life, due: now + 2500 }, sweep], false, now - 100)).toBe(2500);
  // Something overdue: at once, but not before the member's period has passed.
  expect(nextDelay(now, [{ every: 1000, last: now - 300, due: now - 5000 }], false, now)).toBe(700);
  expect(nextDelay(now, [{ every: 1000, last: now - 3000, due: now - 5000 }], false, now)).toBe(0);
  // No member: the longest sleep.
  expect(nextDelay(now, [], false, now)).toBe(IDLE_MAX_MS);
  // A round that is overdue comes at once.
  expect(nextDelay(now, [life], false, now - 60_000)).toBe(0);
});

test("members run on the tick: every second while working, when due while idle, and a failing one does not stop the others", () => {
  let now = 1_000_000;
  const failed: string[] = [];
  const p = new Pulse(() => now, (_e, name) => void failed.push(name));
  const ran: string[] = [];
  let due: number | undefined;
  p.join("automation", () => void ran.push("automation"), { due: () => due });
  p.join("broken", () => { throw new Error("no"); });
  p.join("sweep", () => void ran.push("sweep"), { every: 5000 });
  // Working: ten ticks of 100 ms make one pass of the 1 s members, none of the 5 s one.
  for (let i = 0; i < 10; i++) { now += 100; p.tick(true); }
  expect(ran).toEqual(["automation"]);
  expect(failed).toEqual(["broken"]);
  // Idle with nothing scheduled: one sleep to the idle round, the longest sleep after the last working tick, and a tick before it runs nothing.
  expect(p.delay(false)).toBe(IDLE_MAX_MS);
  now += 3000; p.tick(false);
  expect(ran).toEqual(["automation"]);
  // A wait is scheduled for two seconds from now: the sleep ends then, and that member alone runs.
  due = now + 2000;
  expect(p.delay(false)).toBe(2000);
  now += 2000; p.tick(false);
  expect(ran).toEqual(["automation", "automation"]);
  // At the idle round everything runs together, scheduled or not, whenever each ran last.
  due = undefined;
  expect(p.delay(false)).toBe(IDLE_MAX_MS - 5000);
  now += IDLE_MAX_MS - 5000; p.tick(false);
  expect(ran).toEqual(["automation", "automation", "automation", "sweep"]);
  expect(p.delay(false)).toBe(IDLE_MAX_MS);
  // A member that leaves runs no more.
  p.join("gone", () => void ran.push("gone"))();
  now += 1000; p.tick(true);
  expect(ran.includes("gone")).toBe(false);
});

test("what is scheduled while the tick sleeps wakes its driver, and a tick nothing drives runs by itself", async () => {
  const p = new Pulse(() => 0);
  let woken = 0;
  p.drivenBy(() => void woken++);
  p.join("a wait", () => {});
  expect(woken).toBe(1);
  p.kick();
  expect(woken).toBe(2);
  p.stop();
  // No monitor: the members still run, on the tick's own timer.
  const alone = new Pulse();
  let ran = 0;
  alone.join("fast", () => void ran++, { every: 100 });
  await Bun.sleep(350);
  alone.stop();
  expect(ran).toBeGreaterThanOrEqual(2);
  const at = ran;
  await Bun.sleep(250);
  expect(ran).toBe(at);
});
