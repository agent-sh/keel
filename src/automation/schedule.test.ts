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

test("a calendar schedule keeps its zone, and its times always move forward", () => {
  const z = Date.UTC(2026, 10, 23); // Monday 00:00 UTC
  const f = parseCron("30 9 * * 1-5");
  // The same three instants wherever the daemon runs: the zone travels with the loop.
  expect(nextRuns("30 9 * * 1-5", z, 3, "Europe/Paris")).toEqual([Date.UTC(2026, 10, 23, 8, 30), Date.UTC(2026, 10, 24, 8, 30), Date.UTC(2026, 10, 25, 8, 30)]);
  expect(nextCron(f, z, "UTC")).toBe(Date.UTC(2026, 10, 23, 9, 30));
  // The repeated autumn hour (New York, 2026-11-01): from the second 01:20 a
  // daily 01:30 is the next day's, never the earlier 01:30 already past.
  const ny = "America/New_York";
  const second0120 = Date.UTC(2026, 10, 1, 6, 20); // 01:20 EST
  expect(nextCron(parseCron("30 1 * * *"), second0120, ny)).toBe(Date.UTC(2026, 10, 2, 6, 30));
  expect(nextCron(parseCron("30 1 * * *"), Date.UTC(2026, 10, 1, 5, 20), ny)).toBe(Date.UTC(2026, 10, 1, 5, 30)); // first 01:20: today, once
  // Every minute keeps counting through the repeated hour.
  expect(nextCron(parseCron("* * * * *"), Date.UTC(2026, 10, 1, 6, 45, 20), ny)).toBe(Date.UTC(2026, 10, 1, 6, 46));
  // The skipped spring hour: 02:30 runs at the change, 03:00 EDT.
  expect(nextCron(parseCron("30 2 * * *"), Date.UTC(2026, 2, 8, 6, 55), ny)).toBe(Date.UTC(2026, 2, 8, 7, 0));
  // Strictly increasing across both changes.
  for (const [expr, from] of [["*/20 * * * *", Date.UTC(2026, 10, 1, 4)], ["0,30 0-3 * * *", Date.UTC(2026, 10, 1, 3)], ["30 2 * * *", Date.UTC(2026, 2, 7)]] as const) {
    let t = from;
    for (const x of nextRuns(expr, from, 12, ny)) { expect(x).toBeGreaterThan(t); t = x; }
  }
});

test("a malformed list, range or step is refused; the legal forms read as before", () => {
  for (const bad of ["*/2/3 * * * *", "1-2-3 * * * *", "1,,2 * * * *", ",1 * * * *", "1, * * * *", "1- * * * *", "-5 * * * *", "/5 * * * *", "5/ * * * *", "*-5 * * * *", "1e1 * * * *", "0x10 * * * *", "0 0 * * mon-", "0 0 * janx *"]) {
    expect(() => parseCron(bad), bad).toThrow();
  }
  const f = parseCron("*/20 9-11 1,15 jan,jul mon-fri");
  expect([...f.min]).toEqual([0, 20, 40]);
  expect([...f.hour]).toEqual([9, 10, 11]);
  expect([...f.dom]).toEqual([1, 15]);
  expect([...f.mon]).toEqual([1, 7]);
  expect([...f.dow]).toEqual([1, 2, 3, 4, 5]);
  expect([...parseCron("10-30/10,45 * * * *").min]).toEqual([10, 20, 30, 45]);
  expect([...parseCron("50/5 * * * *").min]).toEqual([50, 55]); // a start with a step runs to the end of the field
  expect([...parseCron("0 0 * * 7").dow]).toEqual([0]);
});

test("a loop on a server's notification reads as one, and /loop on names it", () => {
  expect(parseSchedule("on orders resources/updated")).toMatchObject({ kind: "mcp", server: "orders", method: "resources/updated", canon: "on orders resources/updated", text: "when orders sends resources/updated" });
  expect(parseSchedule("on Orders notifications/acme/ready")).toMatchObject({ server: "Orders", method: "acme/ready" });
  expect(parseSchedule("on orders resources/updated file:///a")).toMatchObject({ uri: "file:///a" });
  expect(() => parseSchedule("on orders acme/ready file:///a")).toThrow(/resources\/updated only/);
  expect(() => parseSchedule("on orders ???")).toThrow(/not the name of a notification/);
  expect(parseLoopCommand("/loop on orders resources/updated file:///a check it")).toEqual({ schedule: "on orders resources/updated file:///a", prompt: "check it" });
  expect(parseLoopCommand("/loop on orders acme/ready")).toEqual({ schedule: "on orders acme/ready", prompt: "" });
});
