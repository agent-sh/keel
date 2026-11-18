import { expect, test } from "bun:test";
import { nextCron, nextRuns, parseCron, parseLoopCommand, parseSchedule } from "./schedule.ts";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test("schedules: intervals, names, cron and the named forms", () => {
  expect(parseSchedule("5m")).toMatchObject({ kind: "interval", seconds: 300 });
  expect(parseSchedule("every 2 hours")).toMatchObject({ kind: "interval", seconds: 7200 });
  expect(parseSchedule("30s")).toMatchObject({ kind: "interval", seconds: 60 }); // rounds up to a minute
  expect(parseSchedule("daily")).toMatchObject({ kind: "interval", seconds: 86400 });
  expect(parseSchedule("auto").kind).toBe("auto");
  expect(parseSchedule("weekdays 09:30")).toMatchObject({ kind: "cron", expr: "30 9 * * 1-5", text: "weekdays at 09:30" });
  expect(parseSchedule("mon,thu 18:00")).toMatchObject({ kind: "cron", expr: "0 18 * * mon,thu" });
  expect(parseSchedule("at 23:00")).toMatchObject({ kind: "cron", expr: "0 23 * * *" });
  expect(() => parseSchedule("sometimes")).toThrow();
  expect(() => parseSchedule("0 0 31 2 *")).toThrow(/no time that comes/);
});

test("cron steps to the next matching minute", () => {
  const f = parseCron("*/15 9-17 * * 1-5");
  // Friday 2026-11-20 17:50 -> Monday 09:00
  expect(nextCron(f, at(2026, 11, 20, 17, 50))).toBe(at(2026, 11, 23, 9, 0));
  expect(nextCron(f, at(2026, 11, 23, 9, 0))).toBe(at(2026, 11, 23, 9, 15));
  // Both day fields restricted: either matches (the 1st, or any Sunday).
  const g = parseCron("0 8 1 * 0");
  expect(nextRuns("0 8 1 * 0", at(2026, 11, 28), 2)).toEqual([at(2026, 11, 29, 8), at(2026, 12, 1, 8)]);
  expect(nextCron(g, at(2026, 11, 28))).toBe(at(2026, 11, 29, 8));
  expect(nextCron(parseCron("0 0 * * 7"), at(2026, 11, 28))).toBe(at(2026, 11, 29)); // 7 is Sunday
});

test("/loop reads an interval, a trailing every-clause, or self-pacing", () => {
  expect(parseLoopCommand("/loop 5m check the deploy")).toEqual({ schedule: "5m", prompt: "check the deploy" });
  expect(parseLoopCommand("/loop check CI every 2 hours")).toEqual({ schedule: "2h", prompt: "check CI" });
  expect(parseLoopCommand("/loop check CI")).toEqual({ schedule: "auto", prompt: "check CI" });
  expect(parseLoopCommand("/loop")).toEqual({ schedule: "auto", prompt: "" });
  expect(parseLoopCommand("/looping")).toBeUndefined();
  expect(parseLoopCommand("hello")).toBeUndefined();
});
