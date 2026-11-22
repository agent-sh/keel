import { expect, test } from "bun:test";
import { zoneLabel } from "../core/clock.ts";
import { ABSENCES, daemonBrief, digest, digestBrief, digestText, Presence, stallsLine, TICK_MS, waits } from "./away.ts";
import type { Restart } from "./life-rows.ts";
import { TEXT_TOKENS, tokensOf, type Overview, type OverviewRow } from "./overview.ts";

const MIN = 60_000;
const H = 60 * MIN;
const GAP = 5 * MIN;
// A local time: the digest's text is in the machine's zone, whatever it is.
const T0 = new Date(2026, 0, 5, 22, 0, 0).getTime();
const Z = zoneLabel(T0);

function kept() {
  let v: string | null = null;
  return { load: () => v, save: (x: string) => { v = x; } };
}
// The owner at a page from `from` to `to`: an input every 20 s, the daemon's note every minute.
function stays(p: Presence, from: number, to: number) {
  for (let t = from; t <= to; t += 20_000) {
    if ((t - from) % TICK_MS === 0) p.tick(t);
    p.seen(t);
  }
}

// The daemon runs from `from` to `to` with nobody at a page: its note every minute.
function runs(p: Presence, from: number, to: number) {
  for (let t = from + TICK_MS; t < to; t += TICK_MS) p.tick(t);
}

// The record of when the owner was last at a page: an absence is a gap
// between two inputs, kept as its own window until dismissed, never widened
// over the time the owner was there, and never read off time the daemon was
// not running.
test("an absence is the gap between two inputs, and the time the owner was there is in none", () => {
  const io = kept();
  const p = new Presence(io, GAP, T0);
  expect(p.window(T0)).toBeNull(); // nobody was ever here
  stays(p, T0, T0 + MIN);
  expect(p.window(T0 + 2 * MIN)).toBeNull(); // here a minute ago: not away
  // No input for the gap: the absence is going on, from the last input.
  expect(p.window(T0 + MIN + GAP)).toEqual({ spans: [{ from: T0 + MIN, to: T0 + MIN + GAP }], present: false });
  // Back after nine hours: the window closes at the first input and stays until dismissed.
  const back = T0 + 9 * H;
  runs(p, T0 + MIN, back);
  p.seen(back);
  expect(p.window(back + 30_000)).toEqual({ spans: [{ from: T0 + MIN, to: back }], present: true });
  // An older report (another page that was idle) changes nothing.
  p.seen(back - 2 * H);
  expect(p.lastSeen).toBe(back);
  // The owner stays ten minutes, leaves for an hour and returns: two absences, the ten minutes in neither.
  stays(p, back, back + 10 * MIN);
  const again = back + 10 * MIN + H;
  expect(p.window(again)).toEqual({ spans: [{ from: T0 + MIN, to: back }, { from: back + 10 * MIN, to: again }], present: false });
  runs(p, back + 10 * MIN, again);
  p.seen(again);
  const two = [{ from: T0 + MIN, to: back }, { from: back + 10 * MIN, to: again }];
  expect(p.window(again + MIN)).toEqual({ spans: two, present: true });
  // The next daemon reads it back, and its own time down is not a third absence:
  // the owner was at the page when it stopped and is there when it answers again.
  stays(p, again, again + 2 * MIN);
  const up = again + 2 * MIN + 20 * MIN;
  const next = new Presence(io, GAP, up);
  expect(next.window(up)).toEqual({ spans: two, present: true });
  next.seen(up + 5_000);
  expect(next.window(up + MIN)).toEqual({ spans: two, present: true });
  // A machine that slept eight hours under an owner who was there: the daemon's note comes late, and that is no absence either.
  stays(next, up + 5_000, up + 3 * MIN);
  // The page's report is the first thing the daemon hears after it: the late note is made before the report is read.
  const woke = up + 3 * MIN + 8 * H;
  next.seen(woke + 2_000, woke + 2_500);
  next.tick(woke + 30_000);
  expect(next.window(woke + MIN)).toEqual({ spans: two, present: true });
  // But an owner who had left an hour before the sleep was away: from their last input to their return.
  stays(next, woke + 2_000, woke + 2 * MIN);
  const left = next.lastSeen!;
  runs(next, left, left + H);
  const morning = left + H + 8 * H;
  next.tick(morning);
  next.seen(morning + 1_000);
  expect(next.window(morning + MIN)!.spans.at(-1)).toEqual({ from: next.window(morning + MIN)!.spans.at(-1)!.from, to: morning + 1_000 });
  expect(next.window(morning + MIN)!.spans).toHaveLength(3);
  expect(morning + 1_000 - next.window(morning + MIN)!.spans.at(-1)!.from).toBeGreaterThan(9 * H - MIN);
  // Dismissed: nothing to tell, on this daemon and the next.
  next.dismiss();
  expect(next.window(morning + MIN)).toBeNull();
  expect(new Presence(io, GAP, morning + MIN).window(morning + MIN)).toBeNull();
  // Only the newest absences are kept.
  const many = new Presence(kept(), GAP, T0);
  for (let i = 0; i <= ABSENCES + 2; i++) { if (i) runs(many, T0 + (i - 1) * H, T0 + i * H); many.seen(T0 + i * H); }
  expect(many.window(T0 + (ABSENCES + 2) * H)!.spans).toHaveLength(ABSENCES);
  expect(many.window(T0 + (ABSENCES + 2) * H)!.spans[0]!.from).toBe(T0 + 2 * H);
  // An absence that ended longer ago than the longest window a read is asked for goes; one that
  // began before it is told from there.
  const old = new Presence(kept(), GAP, T0);
  old.seen(T0);
  runs(old, T0, T0 + 2 * H);
  old.seen(T0 + 2 * H);
  const DAY = 24 * H;
  expect(old.window(T0 + 6 * DAY)!.spans).toEqual([{ from: T0, to: T0 + 2 * H }, { from: T0 + 2 * H, to: T0 + 6 * DAY }]);
  expect(old.window(T0 + 8 * DAY)!.spans).toEqual([{ from: T0 + DAY, to: T0 + 8 * DAY }]);
  // A record that does not parse is no record.
  expect(new Presence({ load: () => "{not json", save: () => {} }, GAP, T0).window(T0)).toBeNull();
});

const sid = (n: number) => `01a1fd4b-73d5-7478-a92a-${String(n).padStart(12, "0")}`;
const row = (n: number, r: Partial<OverviewRow> & { title: string }): OverviewRow => ({ id: sid(n), watch: "done", agents: 0, approvals: 0, parked: 0, ...r });
const page = (sessions: OverviewRow[], hidden = 0): Overview => ({ as_of: T0 + 9 * H, since: T0, until: T0 + 9 * H, hidden, totals: { turns: 0, failed: 0, agents: {}, cost: 0 }, sessions });

test("the digest tells the sessions in which something happened, and nothing when nothing did", () => {
  const o = page([
    row(1, { title: "Quiet" }),
    row(2, { title: "Build", did: { turns: 5, failed: { "rate limit": 2, declined: 1 }, agents: { completed: 2, failed: 1 }, cost: 1.25 } }),
    // A card that waits in a session where nothing happened while the owner was away is the Inbox's to tell.
    row(3, { title: "Old card", watch: "need", approvals: 2 }),
    row(4, { title: "Coordinator", watch: "work", approvals: 1, parked: 1, did: { turns: 1, failed: {}, agents: {}, cost: 0.004, unpriced: true } }),
  ], 2);
  const one = { spans: [{ from: T0, to: T0 + 9 * H }], present: true };
  const away = digest(o, one)!;
  expect(away.sessions.map((r) => r.title)).toEqual(["Coordinator", "Build"]);
  expect(away.quiet).toBe(4);
  // The headline counts the sessions' own turns, and the agents that failed beside them.
  expect(away.totals).toEqual({ turns: 6, failed: 3, agents: { completed: 2, failed: 1 }, approvals: 1, questions: 0, parked: 1, cost: 1.254, unpriced: true });
  expect(away.sessions[1]).toMatchObject({ bad: "3 failed (2 rate limit, 1 declined)" });
  expect(digestText(away).split("\n")).toEqual([
    `While you were away, 2026-01-05 22:00:00 to 07:00:00 ${Z} (9 h): 6 of the sessions' own turns ended in 2 sessions, 3 failed; agents: 3 ended, 1 failed; 1 approval waits; 1 agent parked; $1.25 + unpriced spent in all.`,
    '  "Coordinator", working: 1 turn ended; 1 approval waits; 1 agent parked; $0.0040 + unpriced  [session=000000000004]',
    '  "Build", done: 5 turns ended, 3 failed (2 rate limit, 1 declined); agents: 3 ended, 1 failed; $1.25  [session=000000000002]',
    "4 other sessions: nothing happened.",
  ]);
  expect(digestBrief(away)).toBe("6 turns ended, 3 failed; 1 agent failed; 1 approval waits");
  // Several absences are told as that, with the time away in all (not the time between the first and the last).
  const two = digest(o, { spans: [{ from: T0, to: T0 + 2 * H }, { from: T0 + 8 * H, to: T0 + 9 * H }], present: true })!;
  expect(two.away_ms).toBe(3 * H);
  expect(digestText(two).split("\n")[0]).toStartWith(`While you were away, 2 times between 2026-01-05 22:00:00 and 07:00:00 ${Z} (3 h in all): `);
  expect(digestText({ ...away, present: false }, { ids: false }).split("\n")[0]).toStartWith(`While you are away, since 2026-01-05 22:00:00 ${Z} (9 h): `);
  expect(digestText({ ...two, present: false }).split("\n")[0]).toStartWith(`While you are away, 2 times since 2026-01-05 22:00:00 ${Z} (3 h in all): `);
  expect(digestText(away, { since: true }).split("\n")[0]).toStartWith(`From 2026-01-05 22:00:00 to 07:00:00 ${Z} (9 h): `);
  // Nothing happened: no digest at all.
  expect(digest(page([row(1, { title: "Quiet" }), row(3, { title: "Old card", watch: "need", approvals: 2 })]), one)).toBeNull();
});

// Twenty rows at most, within the bound the report keeps (1.5k tokens), also when every row is heavy.
test("the digest's text lists twenty sessions within the report's bound and counts the rest", () => {
  const did = { turns: 14, failed: { "rate limit": 6, overloaded: 2, "server error": 1, "dropped stream": 2, "quota or billing": 1, declined: 1, budget: 1 }, agents: { completed: 12, failed: 3, incomplete: 1, stopped: 2 }, cost: 12.34, unpriced: true as const };
  const heavy = (i: number) => row(i, { title: `Review the tracing lane and report what blocks landing, with the probes and the numbers ${i}`, watch: i % 3 ? "fail" : "need", approvals: 2, parked: 1, did });
  const text = digestText(digest(page(Array.from({ length: 200 }, (_, i) => heavy(i))), { spans: [{ from: T0, to: T0 + 2 * H }, { from: T0 + 8 * H, to: T0 + 9 * H }], present: true })!);
  expect(tokensOf(text)).toBeLessThanOrEqual(TEXT_TOKENS);
  const lines = text.split("\n");
  expect(lines.filter((l) => /\[session=[0-9a-f]{12}\]$/.test(l))).toHaveLength(20);
  expect(lines.at(-1)).toBe("180 more sessions with something to tell, not listed.");
  // Cut to fit (a shorter title, of the agents only those that failed), each row keeps what failed,
  // what waits and what is parked.
  expect(lines[1]).toMatch(/^ {2}"Review the tracing lane…", needs you: 14 turns ended, 14 failed \(6 rate limit, 2 overloaded, 5 more\); agents: 3 failed; 2 approvals wait; 1 agent parked; \$12\.34 \+ unpriced {2}\[session=/);
  // Twenty light rows are told in full.
  const light = digestText(digest(page(Array.from({ length: 20 }, (_, i) => row(i, { title: `Session ${i}`, did: { turns: 2, failed: { "rate limit": 1 }, agents: { completed: 1 }, cost: 0.02 } }))), { spans: [{ from: T0, to: T0 + H }], present: true })!);
  expect(light.split("\n")[1]).toBe('  "Session 0", done: 2 turns ended, 1 failed (rate limit); agents: 1 reported; $0.02  [session=000000000000]');
});

// What the daemon went through in the absence is told first: on the first
// line in a few words, then a sentence a restart and one for the stalls.
test("the digest names a kill, what it cut and the stalls of the absence, and counts questions with approvals", () => {
  const one = { spans: [{ from: T0, to: T0 + 9 * H }], present: true };
  const down = T0 + 2 * H, up = down + 29_000;
  const cut = (n: number, state: Restart["turns"][number]["state"]) => ({ turn_event: `t${n}`, end_event: `e${n}`, step: 1, tools: [], ran_ms: 16_000, down_ms: down, crashed: true, session_id: sid(n), title: `Cut ${n}`, state }) as unknown as Restart["turns"][number];
  const killed: Restart = { id: "2-1", up_ms: up, pid: 2, before: { pid: 1, started_ms: T0 - H, down_ms: down, how: "killed" }, turns: [cut(1, "continued"), cut(2, "continued"), cut(3, "held")], settled_ms: up + 1000 };
  const stalls = [
    { ts_ms: T0 + 3 * H, ms: 6000, what: ": blocked by its own code, outside anything it times", kind: "compute" },
    { ts_ms: T0 + 4 * H, ms: 3900, what: " waiting for a child: the build", kind: "child" },
  ];
  const o = page([
    row(2, { title: "Build", did: { turns: 5, failed: { "rate limit": 2 }, agents: {}, cost: 1.25 } }),
    row(4, { title: "Asks", watch: "need", approvals: 1, did: { turns: 1, failed: {}, agents: {}, cost: 0 } }),
  ]);
  const d = digest(o, one, { daemon: { restarts: [killed], stalls }, questions: { [sid(4)]: 2, [sid(9)]: 1 } })!;
  expect(d.totals).toMatchObject({ approvals: 1, questions: 2 });
  const lines = digestText(d).split("\n");
  expect(lines[0]).toBe(`While you were away, 2026-01-05 22:00:00 to 07:00:00 ${Z} (9 h): the daemon went down and came back after 29 s, 3 turns cut; unresponsive 2 times; 6 of the sessions' own turns ended in 2 sessions, 2 failed; 1 approval and 2 questions wait; $1.25 spent in all.`);
  expect(lines[1]).toBe("The daemon went down without stopping (killed, or the machine went down) at about 00:00:00 and came back at 00:00:29 (down 29 s); 3 turns were cut: 2 resumed, 1 held for the owner.");
  expect(lines[2]).toBe("The daemon was unresponsive 2 times, 9.9 s in all: 6.0 s blocked by its own code, outside anything it times; 3.9 s waiting for a child: the build.");
  expect(lines[3]).toBe('  "Asks", needs you: 1 turn ended; 1 approval and 2 questions wait  [session=000000000004]');
  // The Inbox's one line says it too, the daemon first.
  expect(digestBrief(d)).toBe("the daemon went down and came back after 29 s, 3 turns cut; unresponsive 2 times; 6 turns ended, 2 failed; 1 approval and 2 questions wait");
  // A kill in an absence in which no turn ended is still told.
  const quiet = digest(page([row(1, { title: "Quiet" })]), one, { daemon: { restarts: [killed], stalls: [] } })!;
  expect(quiet.sessions).toEqual([]);
  expect(digestBrief(quiet)).toBe("the daemon went down and came back after 29 s, 3 turns cut");
  expect(digest(page([row(1, { title: "Quiet" })]), one, { daemon: { restarts: [], stalls: [] } })).toBeNull();
  // Many restarts and many causes stay a few lines: the newest three starts, the three longest causes.
  const starts = Array.from({ length: 7 }, (_, i) => ({ ...killed, id: `r${i}`, up_ms: up + i * MIN, before: { ...killed.before!, down_ms: down + i * MIN }, turns: [] }));
  const causes = Array.from({ length: 9 }, (_, i) => ({ ts_ms: T0 + i, ms: 1000 * (i + 1), what: ` in cause ${i}`, kind: "call" }));
  const busy = digest(o, one, { daemon: { restarts: starts, stalls: causes } })!;
  expect(busy.daemon).toHaveLength(5);
  expect(busy.daemon[0]).toBe("The daemon started 7 times; the last 3:");
  expect(busy.daemon[4]).toEndWith("9.0 s in cause 8; 8.0 s in cause 7; 7.0 s in cause 6; 6 more causes.");
  expect(daemonBrief({ restarts: starts, stalls: [] })).toBe("the daemon went down 7 times");
  expect(stallsLine([stalls[0]!])).toBe("The daemon was unresponsive once, 6.0 s: 6.0 s blocked by its own code, outside anything it times.");
  expect([waits(0), waits(1), waits(0, 1), waits(2, 1)]).toEqual(["", "1 approval waits", "1 question waits", "2 approvals and 1 question wait"]);
});
