// The limits a search carries in its own words.
import { expect, test } from "bun:test";
import { zoneLabel } from "../core/clock.ts";
import { limitTime, searchLimits } from "./search-query.ts";

const NOW = new Date(2026, 10, 22, 7, 30, 0).getTime();
const at = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime();

const Z = zoneLabel(NOW);

test("a query's limits are taken out of its words: commands, a time range, a session state", () => {
  // since: is from then on: it sets no end, so what happened today is found too.
  const q = searchLimits("git push in:commands since:yesterday", NOW);
  expect(q).toEqual({ words: "git push", kinds: ["tool_use"], commands: true, since: at(2026, 11, 21), said: ["commands", `since 2026-11-21 00:00 ${Z}`] });
  // on: is the day alone.
  expect(searchLimits("git push in:commands on:yesterday", NOW)).toEqual({ words: "git push", kinds: ["tool_use"], commands: true, since: at(2026, 11, 21), until: at(2026, 11, 22), said: ["commands", `from 2026-11-21 00:00 to 2026-11-22 00:00 ${Z}`] });
  expect(searchLimits("x on:2026-11-20", NOW)).toMatchObject({ since: at(2026, 11, 20), until: at(2026, 11, 21) });
  expect(searchLimits("deploy state:failed since:2h", NOW)).toEqual({ words: "deploy", state: "fail", since: NOW - 2 * 3_600_000, said: ["sessions now: failed", `since 2026-11-22 05:30 ${Z}`] });
  expect(searchLimits("x state:needs-you in:prompts until:2026-11-20", NOW)).toMatchObject({ words: "x", state: "need", kinds: ["user"], until: at(2026, 11, 21), said: ["prompts", "sessions now: needs you", `until 2026-11-21 00:00 ${Z}`] });
  // The last in: wins, and a kind that is no command drops the command limit.
  expect(searchLimits("x in:commands in:output", NOW)).toMatchObject({ kinds: ["tool_result"], said: ["tool output"] });
  expect(searchLimits("x in:commands in:output", NOW).commands).toBeUndefined();
});

test("the order of the limits does not change the search", () => {
  const range = { since: at(2026, 11, 21), until: at(2026, 11, 23) };
  expect(searchLimits("echo since:yesterday until:today", NOW)).toMatchObject(range);
  expect(searchLimits("until:today echo since:yesterday", NOW)).toMatchObject(range);
  expect(searchLimits("until:today since:yesterday echo", NOW)).toEqual(searchLimits("echo since:yesterday until:today", NOW));
  // A day with a since: inside it, either way round: from then to the day's end.
  const narrowed = { since: NOW - 3_600_000, until: at(2026, 11, 23) };
  expect(searchLimits("x on:today since:1h", NOW)).toMatchObject(narrowed);
  expect(searchLimits("x since:1h on:today", NOW)).toMatchObject(narrowed);
});

test("a limit that is not understood is refused with what its name takes, and never searched as a word", () => {
  for (const [q, takes] of [["x since:lastweek", "since: and until: take"], ["x until:soon", "since: and until: take"], ["x state:bogus", "state: takes need, needs-you, work"], ["x in:nowhere", "in: takes commands, prompts"], ["x on:1h", "on: takes today, yesterday or a date"], ["x on:2026-02-31", "on: takes"]] as const) {
    const r = searchLimits(q, NOW);
    expect(`${q}: ${r.error}`).toContain(takes);
    expect(r.words).toBe("x");
  }
  expect(searchLimits("x since:lastweek", NOW).error).toBe('since:lastweek is not a limit this search knows. since: and until: take a span back (90s, 2h, 3d, 1w, ten years at most), today, yesterday, a date (2026-11-20) or an ISO time. To search for the text itself, put it in quotes: "since:lastweek"');
  // A span no date can carry is refused, not said as a time that is none.
  const far = searchLimits("x since:99999999999d", NOW);
  expect(far.error).toContain("ten years at most");
  expect(JSON.stringify(far)).not.toContain("NaN");
  expect(searchLimits("x since:3650d", NOW).error).toBeUndefined();
  // A range that ends before it starts.
  expect(searchLimits("x since:today until:yesterday", NOW).error).toStartWith("The search's time range is empty");
  // A name that is no limit, a URL and a quoted limit are words.
  expect(searchLimits('error: http://x file:a.ts "since:lastweek"', NOW)).toEqual({ words: 'error: http://x file:a.ts "since:lastweek"', said: [] });
  expect(searchLimits("  ", NOW)).toEqual({ words: "", said: [] });
});

test("a limit's time is a span back, a day's local midnight, or an ISO time", () => {
  expect(limitTime("90s", NOW)).toBe(NOW - 90_000);
  expect(limitTime("1w", NOW)).toBe(NOW - 7 * 86_400_000);
  expect([limitTime("today", NOW), limitTime("today", NOW, true)]).toEqual([at(2026, 11, 22), at(2026, 11, 23)]);
  expect([limitTime("yesterday", NOW), limitTime("yesterday", NOW, true)]).toEqual([at(2026, 11, 21), at(2026, 11, 22)]);
  expect([limitTime("2026-11-20", NOW), limitTime("2026-11-20", NOW, true)]).toEqual([at(2026, 11, 20), at(2026, 11, 21)]);
  expect(limitTime("2026-11-20T05:00:00Z", NOW)).toBe(Date.UTC(2026, 10, 20, 5));
  expect([limitTime("soon", NOW), limitTime("2026", NOW), limitTime("1e400d", NOW)]).toEqual([null, null, null]);
});
