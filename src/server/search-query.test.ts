// The limits a search carries in its own words.
import { expect, test } from "bun:test";
import { limitTime, searchLimits } from "./search-query.ts";

const NOW = new Date(2026, 10, 22, 7, 30, 0).getTime();
const at = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime();

test("a query's limits are taken out of its words: commands, a time range, a session state", () => {
  const q = searchLimits("git push in:commands since:yesterday", NOW);
  expect(q).toEqual({ words: "git push", kinds: ["tool_use"], commands: true, since: at(2026, 11, 21), until: at(2026, 11, 22), said: ["commands", "from 2026-11-21 00:00 to 2026-11-22 00:00"] });
  expect(searchLimits("deploy state:failed since:2h", NOW)).toEqual({ words: "deploy", state: "fail", since: NOW - 2 * 3_600_000, said: ["sessions now: failed", "since 2026-11-22 05:30"] });
  expect(searchLimits("x state:needs-you in:prompts until:2026-11-20", NOW)).toMatchObject({ words: "x", state: "need", kinds: ["user"], until: at(2026, 11, 21), said: ["prompts", "sessions now: needs you", "until 2026-11-21 00:00"] });
  // The last in: wins, and a kind that is no command drops the command limit.
  expect(searchLimits("x in:commands in:output", NOW)).toMatchObject({ kinds: ["tool_result"], said: ["tool output"] });
  expect(searchLimits("x in:commands in:output", NOW).commands).toBeUndefined();
});

test("a word with a colon that names no limit stays a search word", () => {
  expect(searchLimits("error: in:nowhere since:whenever state:odd http://x", NOW)).toEqual({ words: "error: in:nowhere since:whenever state:odd http://x", said: [] });
  expect(searchLimits("  ", NOW)).toEqual({ words: "", said: [] });
});

test("a limit's time is a span back, a day's local midnight, or an ISO time", () => {
  expect(limitTime("90s", NOW)).toBe(NOW - 90_000);
  expect(limitTime("1w", NOW)).toBe(NOW - 7 * 86_400_000);
  expect([limitTime("today", NOW), limitTime("today", NOW, true)]).toEqual([at(2026, 11, 22), at(2026, 11, 23)]);
  expect([limitTime("yesterday", NOW), limitTime("yesterday", NOW, true)]).toEqual([at(2026, 11, 21), at(2026, 11, 22)]);
  expect([limitTime("2026-11-20", NOW), limitTime("2026-11-20", NOW, true)]).toEqual([at(2026, 11, 20), at(2026, 11, 21)]);
  expect(limitTime("2026-11-20T05:00:00Z", NOW)).toBe(Date.UTC(2026, 10, 20, 5));
  expect(limitTime("soon", NOW)).toBeNull();
});
