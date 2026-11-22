// What is told late says so: a timer that fired after its time, a deadline that passed while the
// daemon was down, a condition first seen at a start (the audit's timers 14 and 11 min late).
import { expect, test } from "bun:test";
import { lateWords, whileDown } from "./late.ts";

const at = (h: number, m: number) => new Date(2026, 10, 22, h, m).getTime();

test("a wait or a command told after a downtime says how late and why", () => {
  const down = { from: at(20, 23), to: at(21, 6) };
  // Set for 40 min at 20:12, due 20:52, fired at the start at 21:06.
  expect(lateWords(at(20, 52), at(21, 6), down)).toBe("14 min late: the daemon was down from 20:23 to 21:06");
  // Late with no downtime that covers it: how late only.
  expect(lateWords(at(20, 52), at(20, 55))).toBe("3 min late");
  // On time, or within the daemon's own pace: nothing.
  expect(lateWords(at(20, 52), at(20, 52) + 20_000, down)).toBeUndefined();
  expect(whileDown(at(20, 27), down)).toBe("at 20:27, while the daemon was down");
  expect(whileDown(at(21, 10), down)).toBeUndefined();
  expect(whileDown(at(20, 27))).toBeUndefined();
});
