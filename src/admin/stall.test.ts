// The stall monitor's arithmetic and words, on a clock the test moves: how
// late a tick is, which handler held the loop, and what the row says.
import { afterEach, expect, test } from "bun:test";
import { describeStall, inFlight, type Stall, StallMonitor, timed, TurnWatch } from "./stall.ts";

const real = performance.now;
afterEach(() => { performance.now = real; });
const monitor = (watch = new TurnWatch()) => {
  const clock = { now: 0, cpu: 0 };
  performance.now = () => clock.now;
  const seen: Stall[] = [];
  const noted: Stall[] = [];
  const m = new StallMonitor({ report: (s) => void seen.push(s), note: (s) => void noted.push(s), turns: (began) => watch.at(began), thresholdMs: 1000, cpu: () => clock.cpu });
  // start() without its timer: the test ticks.
  m.start();
  m.stop();
  return { m, clock, seen, noted, watch };
};

test("a tick on time, or a little late, is not a stall; a short one is noted and makes no row", () => {
  const { m, clock, seen, noted } = monitor();
  for (const step of [100, 104, 349]) { clock.now += step; clock.cpu += step; expect(m.tick()).toBeUndefined(); }
  expect(noted).toEqual([]);
  for (const step of [350, 1099]) { clock.now += step; clock.cpu += step; expect(m.tick()).toBeUndefined(); }
  expect(noted.map((s) => s.ms)).toEqual([250, 999]);
  expect(seen).toEqual([]);
});

test("a late tick is one stall, with how long, how busy, and the turns that ran when it began", () => {
  const { m, clock, seen, watch } = monitor();
  const start = (session_id: string, id: string) => watch.frame({ t: "event", event: { kind: "turn_start", id, session_id } });
  const status = (session_id: string, status: { kind: string; names?: string[] }) => watch.frame({ t: "status", session_id, status });
  // One turn over before the stall, one at a tool when it began.
  start("s0", "t0");
  watch.frame({ t: "event", event: { kind: "turn_end", id: "e0", session_id: "s0" } });
  start("s1", "t1");
  status("s1", { kind: "model" });
  clock.now += 20;
  status("s1", { kind: "tool", names: ["Bash"] });
  clock.now += 100;
  expect(m.tick()).toBeUndefined();
  // The loop is held; when it runs again the turn has moved on, ended, and another has started.
  clock.now += 10_300; clock.cpu += 10_250;
  status("s1", { kind: "idle" });
  watch.frame({ t: "event", event: { kind: "turn_end", id: "e1", session_id: "s1" } });
  start("s2", "t2");
  const s = m.tick()!;
  expect(seen).toEqual([s]);
  expect(s).toMatchObject({ ms: 10_200, busy_ms: 10_250, in_flight: [], turns: [{ session_id: "s1", turn: "t1", doing: "tool Bash" }] });
  expect(s.during).toBeUndefined();
  expect(describeStall(s)).toEqual({
    message: "Daemon unresponsive for 10 s: blocked by its own code, outside any request handler (1 turn was running)",
    context: { kind: "stall", ms: 10_200, busy_ms: 10_250, turns: [{ session_id: "s1", turn: "t1", doing: "tool Bash" }] },
  });
  // The next tick is on time again: one stall, one report.
  clock.now += 100;
  expect(m.tick()).toBeUndefined();
  expect(seen.length).toBe(1);
});

test("a stall with no processor time is the process not running, not its code", () => {
  const { m, clock } = monitor();
  clock.now += 4_100; clock.cpu += 30;
  expect(describeStall(m.tick()!).message).toBe("Daemon unresponsive for 4.0 s: its process was not running (a blocking call, or a stopped or starved machine)");
});

test("the handler that held the loop is named, and the row is filed under the session its path names", () => {
  const { m, clock } = monitor();
  const sid = "01a1fd35-2c19-75cf-986e-9d004d353f61";
  // A request that was open before, one that came just before the stall and waited, and the handler that held the loop.
  const open = inFlight({}, () => "GET /api/logs/stream");
  clock.now += 100; clock.cpu += 1;
  expect(m.tick()).toBeUndefined();
  const late = inFlight({}, () => "GET /api/sessions");
  timed(() => `GET /api/sessions/${sid}/timeline`, () => { clock.now += 2_600; });
  timed(() => "GET /api/daemon", () => { clock.now += 60; });
  const after = inFlight({}, () => "GET /api/models");
  clock.now += 100; clock.cpu += 2_700;
  const s = m.tick()!;
  late(); after();
  open();
  expect(s).toMatchObject({ ms: 2_660, during: { label: `GET /api/sessions/${sid}/timeline`, ms: 2_600 }, in_flight: ["GET /api/logs/stream", "GET /api/sessions"] });
  const d = describeStall(s);
  expect(d.message).toBe(`Daemon unresponsive for 2.7 s while answering GET /api/sessions/${sid}/timeline (2 requests waited)`);
  expect(d.context).toMatchObject({ kind: "stall", during: `GET /api/sessions/${sid}/timeline`, during_ms: 2_600, session: sid, in_flight: ["GET /api/logs/stream", "GET /api/sessions"] });
  // A handler that took a moment of a long stall is not what held the loop.
  timed(() => "GET /api/daemon", () => { clock.now += 60; });
  clock.now += 5_100; clock.cpu += 5_000;
  expect(m.tick()!.during).toBeUndefined();
});
