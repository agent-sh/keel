// The stall monitor's arithmetic and words, on a clock the test moves: how
// late a tick is, what held the loop, how often the timer fires, and what the
// row says.
import { afterEach, expect, test } from "bun:test";
import { describeStall, during, inFlight, type Stall, StallMonitor, timed, TurnWatch } from "./stall.ts";

const real = performance.now;
afterEach(() => { performance.now = real; });
// The clock starts well after anything an earlier test touched.
let epoch = 0;
const monitor = (watch = new TurnWatch()) => {
  const clock = { now: (epoch += 1_000_000), cpu: 0, working: true, ticks: 0 };
  performance.now = () => clock.now;
  const seen: Stall[] = [];
  const noted: Stall[] = [];
  const m = new StallMonitor({
    report: (s) => void seen.push(s), note: (s) => void noted.push(s), turns: (began) => watch.at(began),
    working: () => clock.working, tick: () => void clock.ticks++, thresholdMs: 1000, cpu: () => clock.cpu,
  });
  // start() without its timer: the test ticks.
  m.start();
  m.stop();
  // Time passes, with the process busy for all of it unless told otherwise.
  const pass = (ms: number, busy = ms) => { clock.now += ms; clock.cpu += busy; };
  return { m, clock, seen, noted, watch, pass };
};

test("a tick on time, or a little late, is not a stall; a short one is noted and makes no row", () => {
  const { m, clock, seen, noted, pass } = monitor();
  for (const step of [100, 104, 349]) { pass(step); expect(m.tick()).toBeUndefined(); }
  expect(noted).toEqual([]);
  for (const step of [350, 1099]) { pass(step); expect(m.tick()).toBeUndefined(); }
  expect(noted.map((s) => s.ms)).toEqual([250, 999]);
  expect(seen).toEqual([]);
  // Every tick, late or not, is one beat of whatever rides on the timer.
  expect(clock.ticks).toBe(5);
});

test("a late tick is one stall, with how long, how busy, and the turns that ran when it began", () => {
  const { m, clock, seen, watch, pass } = monitor();
  const start = (session_id: string, id: string) => watch.frame({ t: "event", event: { kind: "turn_start", id, session_id } });
  const status = (session_id: string, status: { kind: string; names?: string[] }) => watch.frame({ t: "status", session_id, status });
  // One turn over before the stall, one at a tool when it began.
  start("s0", "t0");
  watch.frame({ t: "event", event: { kind: "turn_end", id: "e0", session_id: "s0" } });
  start("s1", "t1");
  status("s1", { kind: "model" });
  clock.now += 20;
  status("s1", { kind: "tool", names: ["Bash"] });
  pass(100);
  expect(m.tick()).toBeUndefined();
  // The loop is held; when it runs again the turn has moved on, ended, and another has started.
  pass(10_300, 10_250);
  status("s1", { kind: "idle" });
  watch.frame({ t: "event", event: { kind: "turn_end", id: "e1", session_id: "s1" } });
  start("s2", "t2");
  const s = m.tick()!;
  expect(seen).toEqual([s]);
  expect(s).toMatchObject({ ms: 10_200, busy_ms: 10_250, in_flight: [], turns: [{ session_id: "s1", turn: "t1", doing: "tool Bash" }] });
  expect(s.during).toBeUndefined();
  expect(describeStall(s)).toEqual({
    message: "Daemon unresponsive for 10 s: blocked by its own code, outside anything it times (1 turn was running)",
    context: { kind: "stall", ms: 10_200, busy_ms: 10_250, turns: [{ session_id: "s1", turn: "t1", doing: "tool Bash" }] },
  });
  // The same stall while a pass of the daemon's own was in progress says which.
  let done = () => {};
  void during("the start's recovery", new Promise<void>((r) => { done = r; }));
  pass(3_100);
  expect(describeStall(m.tick()!).message).toBe("Daemon unresponsive for 3.0 s: blocked by its own code, with the start's recovery in progress (1 turn was running)");
  done();
  // The next tick is on time again: one stall, one report.
  pass(100);
  expect(m.tick()).toBeUndefined();
  expect(seen.length).toBe(2);
});

test("a stall with no processor time is the process not running, not its code, and names no handler it fell in", () => {
  const { m, pass, clock } = monitor();
  pass(4_100, 30);
  expect(describeStall(m.tick()!).message).toBe("Daemon unresponsive for 4.0 s: its process was not running (a blocking call, or a stopped or starved machine)");
  // The machine stopped the daemon while a handler ran: that handler was not slow, and is not named.
  timed(() => "answering GET /api/daemon", () => { clock.now += 3_000; clock.cpu += 2; });
  pass(100, 0);
  const s = m.tick()!;
  expect(s.during).toBeUndefined();
  expect(describeStall(s).message).toStartWith("Daemon unresponsive for 3.0 s: its process was not running");
});

test("what held the loop is named, the row is filed under the session its path names, and only requests it kept waiting are counted", () => {
  const { m, pass } = monitor();
  const sid = "01a1fd35-2c19-75cf-986e-9d004d353f61";
  // A stream open for long, a request that came just before the stall and waited, and the handler that held the loop.
  const stream = inFlight({}, () => "answering GET /api/logs/stream");
  for (let i = 0; i < 90; i++) { pass(100); expect(m.tick()).toBeUndefined(); }
  const late = inFlight({}, () => "answering GET /api/sessions");
  timed(() => `answering GET /api/sessions/${sid}/timeline`, () => pass(2_600));
  timed(() => "answering GET /api/daemon", () => pass(60));
  const after = inFlight({}, () => "answering GET /api/models");
  pass(100);
  const s = m.tick()!;
  stream(); late(); after();
  expect(s).toMatchObject({ ms: 2_660, during: { label: `answering GET /api/sessions/${sid}/timeline`, ms: 2_600 }, in_flight: ["answering GET /api/sessions"] });
  const d = describeStall(s);
  expect(d.message).toBe(`Daemon unresponsive for 2.7 s while answering GET /api/sessions/${sid}/timeline (1 request waited)`);
  expect(d.context).toMatchObject({ kind: "stall", during: `answering GET /api/sessions/${sid}/timeline`, during_ms: 2_600, session: sid, in_flight: ["answering GET /api/sessions"] });
  // A handler that took a moment of a long stall is not what held the loop.
  timed(() => "answering GET /api/daemon", () => pass(60));
  pass(5_100);
  expect(m.tick()!.during).toBeUndefined();
});

test("the timer fires ten times a second while the daemon works and once a second while it is idle", () => {
  const { m, clock, seen, pass } = monitor();
  expect(m.period()).toBe(100);
  // No turn runs, and nothing was asked for a while: once a second, and a tick a second later is on time.
  clock.working = false;
  for (let i = 0; i < 60; i++) { pass(100); m.tick(); }
  expect(m.period()).toBe(1000);
  pass(1000);
  expect(m.tick()).toBeUndefined();
  // A handler that holds the loop then is still measured whole, though the tick it delays was a long one.
  pass(300);
  timed(() => "answering GET /api/sessions", () => pass(2_500));
  expect(m.period()).toBe(100);
  pass(10);
  const s = m.tick()!;
  expect(s).toMatchObject({ ms: 2_500, during: { label: "answering GET /api/sessions" } });
  expect(seen).toEqual([s]);
  // A request open, or a turn running, keeps the short period.
  for (let i = 0; i < 60; i++) { pass(100); m.tick(); }
  expect(m.period()).toBe(1000);
  const open = inFlight({}, () => "answering POST /api/drain");
  for (let i = 0; i < 60; i++) { pass(100); m.tick(); }
  expect(m.period()).toBe(100);
  open();
});
