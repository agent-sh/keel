import { expect, test } from "bun:test";
import { zoneLabel } from "../core/clock.ts";
import { ABSENCES, daemonBrief, daemonLines, digest, digestBrief, digestText, Presence, stallCause, stallsLine, TICK_MS, waits } from "./away.ts";
import type { StallFact } from "./daemon-facts.ts";
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
  expect(lines[0]).toBe(`While you were away, 2026-01-05 22:00:00 to 07:00:00 ${Z} (9 h): the daemon went down and came back after 29 s, 3 turns cut (1 held for the owner); unresponsive twice; 6 of the sessions' own turns ended in 2 sessions, 2 failed; 1 approval and 2 questions wait; $1.25 spent in all.`);
  expect(lines[1]).toBe(`The daemon went down without stopping (killed, or the machine went down) at about 00:00:00 and came back at 00:00:29 ${Z} (down 29 s); 3 turns were cut: 2 resumed, 1 held for the owner.`);
  expect(lines[2]).toBe("The daemon was unresponsive 2 times, 9.9 s in all: 6.0 s blocked by its own code, outside anything it times; 3.9 s waiting for a child: the build.");
  expect(lines[3]).toBe('  "Asks", needs you: 1 turn ended; 1 approval and 2 questions wait  [session=000000000004]');
  // The Inbox's one line says it too, the daemon first.
  expect(digestBrief(d)).toBe("the daemon went down and came back after 29 s, 3 turns cut (1 held for the owner); unresponsive twice; 6 turns ended, 2 failed; 1 approval and 2 questions wait");
  // A kill in an absence in which no turn ended is still told.
  const quiet = digest(page([row(1, { title: "Quiet" })]), one, { daemon: { restarts: [killed], stalls: [] } })!;
  expect(quiet.sessions).toEqual([]);
  expect(digestBrief(quiet)).toBe("the daemon went down and came back after 29 s, 3 turns cut (1 held for the owner)");
  expect(digest(page([row(1, { title: "Quiet" })]), one, { daemon: { restarts: [], stalls: [] } })).toBeNull();
  expect(stallsLine([stalls[0]!])).toBe("The daemon was unresponsive once, 6.0 s: 6.0 s blocked by its own code, outside anything it times.");
  expect([waits(0), waits(1), waits(0, 1), waits(2, 1)]).toEqual(["", "1 approval waits", "1 question waits", "2 approvals and 1 question wait"]);
});

// A start is told by how it came about. A restart somebody asked for is never the daemon
// going down; the starts nobody asked for are counted apart and are the ones told one by one.
test("asked restarts are summed and never told as going down, and a kill among them is told first", () => {
  const one = { spans: [{ from: T0, to: T0 + 9 * H }], present: true };
  const turn = (i: number, k: number, state: Restart["turns"][number]["state"] = "continued") => ({ turn_event: `t${i}-${k}`, end_event: `e${i}-${k}`, step: 2, tools: [], ran_ms: 60_000, down_ms: 0, crashed: false, session_id: sid(k), title: `Session ${k}`, state }) as unknown as Restart["turns"][number];
  const start = (i: number, how: "killed" | "restart" | "crash" | "stop", cut: number): Restart => {
    const up = T0 + H + i * 10 * MIN, down = up - (how === "restart" ? 300 : 35_000);
    return { id: `${i}`, up_ms: up, pid: 100 + i, before: { pid: 99 + i, started_ms: up - 10 * MIN, down_ms: down, how }, turns: Array.from({ length: cut }, (_, k) => turn(i, k)), settled_ms: up + 300 };
  };
  // Twelve restarts that were asked for in two hours, 71 turns cut and resumed.
  const twelve = Array.from({ length: 12 }, (_, i) => start(i, "restart", i === 11 ? 5 : 6));
  expect(daemonBrief({ restarts: twelve, stalls: [] })).toBe("the daemon restarted 12 times when asked, 71 turns cut");
  const d = digest(page([row(1, { title: "Quiet" })]), one, { daemon: { restarts: twelve, stalls: [] } })!;
  expect(d.daemon).toEqual(["The daemon restarted 12 times when asked (down 3.6 s in all); 71 turns were cut: 71 resumed."]);
  expect(digestText(d)).not.toMatch(/went down|stopped by itself/);
  // One asked restart: its own sentence, and what did not go on by itself is in the short form.
  const held = { ...start(0, "restart", 2), turns: [turn(0, 0), turn(0, 1, "held")] };
  expect(daemonBrief({ restarts: [held], stalls: [] })).toBe("the daemon restarted when asked, 2 turns cut (1 held for the owner)");
  expect(digest(page([row(1, { title: "Quiet" })]), one, { daemon: { restarts: [held], stalls: [] } })!.daemon).toEqual([expect.stringMatching(/^The daemon stopped for a restart at \d\d:\d\d:\d\d and came back at \d\d:\d\d:\d\d UTC\S* \(down 300 ms\); 2 turns were cut: 1 resumed, 1 held for the owner\.$/)]);
  // Asked restarts that cut nothing are nothing to tell by themselves.
  const idle = Array.from({ length: 4 }, (_, i) => start(i, "restart", 0));
  expect(daemonBrief({ restarts: idle, stalls: [] })).toBe("");
  expect(digest(page([row(1, { title: "Quiet" })]), one, { daemon: { restarts: idle, stalls: [] } })).toBeNull();
  // Thirty starts, three of them kills, one a failure of its own: counted by how each came about,
  // the ones nobody asked for told one by one, the asked ones in one sentence.
  const thirty = Array.from({ length: 30 }, (_, i) => start(i, [4, 17, 26].includes(i) ? "killed" : i === 9 ? "crash" : "restart", (i * 5) % 13));
  const cutOwn = [4, 9, 17, 26].reduce((n, i) => n + ((i * 5) % 13), 0), cutAll = thirty.reduce((n, r) => n + r.turns.length, 0);
  expect(daemonBrief({ restarts: thirty, stalls: [] })).toBe(`the daemon stopped by itself 4 times, ${cutOwn} turns cut; restarted 26 times when asked, ${cutAll - cutOwn} turns cut`);
  const many = digest(page([row(1, { title: "Quiet" })]), one, { daemon: { restarts: thirty, stalls: [] } })!.daemon;
  expect(many).toHaveLength(5);
  expect(many[0]).toBe("The daemon stopped by itself 4 times (killed, or the machine went down; ended on a failure); the last 3:");
  expect(many[1]).toStartWith("The daemon ended on a failure at ");
  expect(many.slice(2, 4).every((l) => l.startsWith("The daemon went down without stopping (killed, or the machine went down) at about "))).toBe(true);
  expect(many[4]).toBe(`It also restarted 26 times when asked (down 7.8 s in all); ${cutAll - cutOwn} turns were cut: ${cutAll - cutOwn} resumed.`);
  expect(Buffer.byteLength(many.join("\n"))).toBeLessThan(900);
  // Three hundred starts are as short.
  expect(daemonLines({ restarts: Array.from({ length: 10 }, () => thirty).flat(), stalls: [] })).toHaveLength(5);
});

// Stalls are grouped by the kind of their cause: a cause's own duration, process id and
// pressure figure do not make two of a kind read as two causes.
test("stalls of one kind are one entry, in the words of the longest, without its duration or pid", () => {
  const stall = (i: number): StallFact => {
    const ms = 600 + ((i * 977) % 8400);
    const [what, kind] = [[`${(ms / 1000).toFixed(1)} s waiting for a child: git status (pid ${40000 + i})`, "child"], ["blocked by its own code, outside anything it times", "compute"], [`${(ms / 1000 - 0.2).toFixed(1)} s writing the store's log (keel.db-wal) (IO pressure ${3 + i}%)`, "io"], [`${(ms / 1000).toFixed(1)} s stopped by a signal (continued by SIGCONT)`, "stopped"]][i % 4]!;
    return { ts_ms: T0 + i * MIN, ms, what: what!, kind: kind! };
  };
  const forty = stallsLine(Array.from({ length: 40 }, (_, i) => stall(i)));
  expect(forty).toBe("The daemon was unresponsive 40 times, 3 min in all: 49 s (10 times) blocked by its own code, outside anything it times; 47 s (10 times) waiting for a child: git status; 43 s (10 times) stopped by a signal (continued by SIGCONT); 1 more kind of cause.");
  expect(forty).not.toMatch(/pid \d|pressure \d|\d s \d/);
  expect(stallsLine([stall(3), stall(7)])).toMatch(/^The daemon was unresponsive 2 times, [\d.]+ s in all: [\d.]+ s \(2 times\) stopped by a signal \(continued by SIGCONT\)\.$/);
  // Two children of different commands are one kind: the longest is named, and that there are others.
  const kids = [{ ts_ms: T0, ms: 4000, what: "4.0 s waiting for a child: sleep 4 (pid 1)", kind: "child" }, { ts_ms: T0 + 1, ms: 2000, what: "2.0 s waiting for a child: git status (pid 2)", kind: "child" }];
  expect(stallsLine(kids)).toBe("The daemon was unresponsive 2 times, 6.0 s in all: 6.0 s (2 times) waiting for a child: sleep 4 and others of that kind.");
  expect(stallCause("2.1 s waiting for a processor (machine load 22, CPU pressure 41%)")).toBe("waiting for a processor");
});
