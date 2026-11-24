// The stall monitor's arithmetic and words, on a clock the test moves: how
// late a tick is, what held the loop, how often the timer fires, and what the
// row says.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { ErrorTracker } from "../core/errors.ts";
import { Store } from "../core/store.ts";
import { spike, SPIKE_COUNT, SPIKE_WINDOW_MS, spikeCounts } from "../helper/policy.ts";
import { describeStall, dropBeat, during, inFlight, Recurrence, RECUR_MS, shareBeat, type Stall, stallCapture, StallMonitor, timed, TurnWatch } from "./stall.ts";
import { ALLOW_MASK, IDLE_ALLOW } from "./stall-beat.ts";
import { type Cause, decide, type Sample, unknown, UNSEEN } from "./stall-cause.ts";

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
    report: (s) => void seen.push(s), note: (s) => void noted.push(s), turns: (when) => watch.at(when),
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
  expect(s).toMatchObject({ ms: 10_200, window_ms: 10_300, busy_ms: 10_250, in_flight: [], turns: [{ session_id: "s1", turn: "t1", doing: "tool Bash" }] });
  expect(s.during).toBeUndefined();
  expect(describeStall(s)).toEqual({
    message: "Daemon unresponsive for 10 s: blocked by its own code, outside anything it times (1 turn was running)",
    context: { kind: "stall", ms: 10_200, busy_ms: 10_250, turns: [{ session_id: "s1", turn: "t1", doing: "tool Bash" }] },
    group: "stall compute untimed", what: "blocked by its own code, outside anything it times", kind: "compute", ms: 10_200,
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

test("a turn that names its step inside the stretch that then holds the loop is told by that step", () => {
  const { m, seen, watch, pass, clock } = monitor();
  pass(100);
  expect(m.tick()).toBeUndefined();
  // Nothing yields from here: the turn starts just before the next tick is due, says it asks
  // the model a little after it was due, and the request holds the loop.
  pass(95);
  watch.frame({ t: "event", event: { kind: "turn_start", id: "t1", session_id: "s1" } });
  clock.now += 35;
  watch.frame({ t: "status", session_id: "s1", status: { kind: "model" } });
  pass(2_500);
  // The loop runs again: the turn ends before the timer is reached.
  watch.frame({ t: "event", event: { kind: "turn_end", id: "e1", session_id: "s1" } });
  const s = m.tick()!;
  expect(seen).toEqual([s]);
  expect(s.ms).toBe(2_530);
  expect(s.turns).toEqual([{ session_id: "s1", turn: "t1", doing: "model" }]);
  // A turn that began inside that stretch, long after the tick was due, held the loop too.
  pass(100);
  expect(m.tick()).toBeUndefined();
  pass(400);
  watch.frame({ t: "event", event: { kind: "turn_start", id: "t2", session_id: "s2" } });
  watch.frame({ t: "status", session_id: "s2", status: { kind: "model" } });
  pass(3_000);
  // It went on two steps before the timer was reached: neither is what it was at.
  watch.frame({ t: "status", session_id: "s2", status: { kind: "tool", names: ["Bash"] } });
  watch.frame({ t: "status", session_id: "s2", status: { kind: "model" } });
  expect(m.tick()!.turns).toEqual([{ session_id: "s2", turn: "t2", doing: "model" }]);
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
  // The handler is kept as where the process slept: it is named when the watcher saw a call of the daemon's own.
  expect(s.within).toEqual({ label: "answering GET /api/daemon", ms: 3_000 });
});

// The watcher's word for a stall: what the row says, and what repeats of it share.
const at = (t: number, state: string, run: number, wait: number, more: Partial<Sample> = {}): Sample => ({ t, ep: 1, state, run_ns: run * 1e6, wait_ns: wait * 1e6, user_ticks: run / 10, sys_ticks: 0, ...more });
const stall = (ms: number, cause: Cause | undefined, more: Partial<Stall> = {}): Stall => ({ ms, busy_ms: 20, in_flight: [], turns: [], ...(cause ? { cause } : {}), ...more });

test("the row says what took the time, and the rows are one per cause whatever the numbers", () => {
  const starved = (wait: number, load: number) => decide([at(0, "R", 0, 0), at(wait + 200, "R", 200, wait)], { load, pressure: { cpu: 41 } }, wait + 300);
  const a = describeStall(stall(2_300, starved(2_100, 22), { turns: [{ session_id: "s1", doing: "model" }] }));
  const b = describeStall(stall(7_400, starved(7_000, 31), { in_flight: ["answering GET /api/daemon", "answering GET /api/models"] }));
  expect(a.message).toBe("Daemon unresponsive for 2.3 s: 2.1 s waiting for a processor (machine load 22, CPU pressure 41%) (1 turn was running)");
  expect(b.message).toBe("Daemon unresponsive for 7.4 s: 7.0 s waiting for a processor (machine load 31, CPU pressure 41%) (2 requests waited)");
  expect([a.group, b.group, a.kind]).toEqual(["stall cpu_wait", "stall cpu_wait", "cpu_wait"]);
  expect(a.what).toBe("2.1 s waiting for a processor (machine load 22, CPU pressure 41%)");
  expect(a.context.cause).toMatchObject({ kind: "cpu_wait", wait_ms: 2_100, run_ms: 200, load: 22, pressure: { cpu: 41 }, sampled_ms: 2_300 });

  // A call of the daemon's own is another row, and is the doing of the section it was made in.
  const call = { name: "fsync", on: { kind: "store log", text: "the store's log (keel.db-wal)" } };
  const sync = decide([at(0, "D", 0, 0, { call }), at(5_100, "R", 5, 0)], {}, 5_200);
  const c = describeStall(stall(5_200, sync, { within: { label: "answering POST /api/sessions", ms: 5_150 } }));
  expect(c.message).toBe("Daemon unresponsive for 5.2 s: 5.1 s in fsync of the store's log (keel.db-wal) while answering POST /api/sessions");
  expect(c.group).toBe("stall fsync store log answering POST /api/sessions");
  // A write of the loop that waited for the write lock while the log was started again on a slow disk: the row says so.
  const sleep = decide([at(0, "S", 0, 0, { call: { name: "clock_nanosleep" }, stmt: "BEGIN IMMEDIATE" }), at(6_000, "R", 5, 0)], {}, 6_100);
  const w = describeStall(stall(6_100, sleep, { within: { label: "answering POST /api/sessions/:id/messages", ms: 6_050 }, waited: { label: "the log's restart waits for the disk (the write lock held 6.0 s: 2 syncs made under the lock so far, the thread's last sync of its own took 4.1 s)", ms: 4_600 } }));
  expect(w.message).toBe("Daemon unresponsive for 6.1 s: 6.0 s sleeping (clock_nanosleep), in the statement: BEGIN IMMEDIATE: the log's restart waits for the disk (the write lock held 6.0 s: 2 syncs made under the lock so far, the thread's last sync of its own took 4.1 s) while answering POST /api/sessions/:id/messages");
  expect(w.group).toContain("the log's restart");
  expect(w.context).toMatchObject({ waited_ms: 4_600 });
  // A machine that did not run the daemon inside a handler did not make that handler slow.
  expect(describeStall(stall(2_300, starved(2_100, 22), { within: { label: "answering GET /api/daemon", ms: 2_200 } })).message).not.toContain("while");
  // A section the daemon was busy in while it also waited for a processor is named, and the row stays the starved machine's.
  const both = describeStall(stall(2_300, starved(2_100, 22), { during: { label: "answering GET /api/sessions", ms: 2_250 } }));
  expect(both.message).toBe("Daemon unresponsive for 2.3 s: 2.1 s waiting for a processor (machine load 22, CPU pressure 41%) while answering GET /api/sessions");
  expect(both.group).toBe("stall cpu_wait");
  const child = decide([at(0, "S", 0, 0, { call: { name: "epoll_pwait2", child: { pid: 4_242, command: "git rev-parse" } } }), at(3_000, "R", 2, 0)], {}, 3_000);
  expect(describeStall(stall(3_000, child)).message).toBe("Daemon unresponsive for 3.0 s: 3.0 s waiting for a child: git rev-parse (pid 4242)");
  // The pid is not part of what repeats share.
  expect(describeStall(stall(3_000, child)).group).toBe("stall child git");

  // The watcher saw the main thread compute: the row keeps its words, and says the code is not visible to it.
  const computed = decide([at(0, "R", 0, 0), at(2_900, "R", 2_890, 4)], {}, 3_000);
  const d = describeStall(stall(3_000, computed, { busy_ms: 2_950 }));
  expect(d.message).toBe("Daemon unresponsive for 3.0 s: blocked by its own code, outside anything it times");
  expect((d.context.cause as Cause).note).toBe(UNSEEN);
  // The process was busy (its other threads), and the main thread was not: the watcher's word is the one kept.
  expect(describeStall(stall(2_300, starved(2_100, 22), { busy_ms: 2_200 })).kind).toBe("cpu_wait");

  // No watcher (another platform, or it failed): today's words, and that the cause is not known.
  const off = describeStall(stall(4_000, unknown("the cause is not known on this platform (the watcher reads Linux's /proc)")));
  expect(off.message).toBe("Daemon unresponsive for 4.0 s: its process was not running (a blocking call, or a stopped or starved machine); the cause is not known on this platform (the watcher reads Linux's /proc)");
  expect([off.group, off.kind]).toEqual(["stall unknown", "unknown"]);
  expect(describeStall(stall(4_000, unknown("x"), { busy_ms: 3_900 })).message).toBe("Daemon unresponsive for 4.0 s: blocked by its own code, outside anything it times");
});

test("idle, the loop measures a stall short: the row is as long as the watcher saw the loop held, within the time since its last tick", () => {
  const stopped = (seen: number): Cause => decide([{ t: 0, ep: 1, state: "T", run_ns: 1, wait_ns: 0, user_ticks: 0, sys_ticks: 0 }, { t: seen, ep: 1, state: "R", run_ns: 1, wait_ns: 0, user_ticks: 0, sys_ticks: 0, gap: "stopped" }], {}, 3_086, 4_086);
  const d = describeStall(stall(3_086, stopped(4_016), { window_ms: 4_086 }));
  expect(d.message).toBe("Daemon unresponsive for 4.0 s: 4.0 s stopped (a stop signal, a debugger or a frozen unit)");
  expect([d.ms, d.context.ms]).toEqual([4_016, 4_016]);
  expect((d.context.cause as Cause).shares.reduce((n, x) => n + x.ms, 0)).toBeLessThanOrEqual(d.ms);
  // The watcher saw less than the loop measured: the loop's length stands.
  expect(describeStall(stall(3_086, stopped(1_900), { window_ms: 4_086 })).ms).toBe(3_086);
});

test("work that begins while the timer waits out its idle second brings the next tick forward", () => {
  const { m, clock } = monitor();
  const cells = new Int32Array(new SharedArrayBuffer(8));
  shareBeat(cells);
  const allow = () => Atomics.load(cells, 0) & ALLOW_MASK;
  try {
    clock.working = false;
    m.start();
    // Idle, the loop promises no time: the watcher looks for itself.
    expect(allow()).toBe(IDLE_ALLOW);
    // A request arrives: the watcher is told to expect the next beat within the short period.
    const open = inFlight({}, () => "answering GET /api/sessions");
    expect(allow()).toBe(100);
    // Once per wait: more work does not move it again.
    const before = Atomics.load(cells, 0);
    timed(() => "answering GET /api/sessions", () => {});
    expect((Atomics.load(cells, 0) & ALLOW_MASK) <= 100).toBe(true);
    expect(Atomics.load(cells, 0)).not.toBe(before);
    open();
  } finally {
    m.stop();
    dropBeat(cells);
  }
});

test("a pass the daemon makes by its own clock does not count as work: an idle daemon stays idle, and a request's section does count", () => {
  const { m, clock, pass } = monitor();
  const cells = new Int32Array(new SharedArrayBuffer(8));
  shareBeat(cells);
  const allow = () => Atomics.load(cells, 0) & ALLOW_MASK;
  try {
    clock.working = false;
    pass(10_000);
    m.start();
    expect(m.working()).toBe(false);
    expect(allow()).toBe(IDLE_ALLOW);
    // A sampler's pass: timed as ever, and a stall in it is still named, but the daemon is not working afterwards.
    timed(() => "sampling what the daemon's processes use", () => pass(60), true);
    expect(m.working()).toBe(false);
    expect(m.period()).toBe(1000);
    // A request's section is work: the daemon works for the next seconds, and the tick comes at the short period.
    timed(() => "answering GET /api/daemon", () => pass(60));
    expect(m.working()).toBe(true);
    expect(m.period()).toBe(100);
  } finally {
    m.stop();
    dropBeat(cells);
  }
});

test("the loop tells its watcher when it will beat next, and at once when a section holds it", () => {
  const { m, pass, clock } = monitor();
  const cells = new Int32Array(new SharedArrayBuffer(8));
  shareBeat(cells);
  const read = () => { const v = Atomics.load(cells, 0); return { v, allow: v & ALLOW_MASK }; };
  try {
    pass(100);
    m.tick();
    const working = read();
    expect(working.allow).toBe(100);
    // Inside a timed section the loop cannot beat: the watcher is told to expect one at once, and after it when the next is due.
    let inside = { v: 0, allow: -1 };
    pass(40);
    timed(() => "answering GET /api/sessions", () => { inside = read(); pass(30); });
    expect(inside.allow).toBe(0);
    expect(inside.v).not.toBe(working.v);
    expect(read().allow).toBe(30);
    expect(read().v).not.toBe(inside.v);
    // Idle, it promises no time.
    clock.working = false;
    for (let i = 0; i < 60; i++) { pass(100); m.tick(); }
    expect(read().allow).toBe(IDLE_ALLOW);
    // A monitor whose timer is stopped promises nothing: the watcher reads a zero and expects no beat.
    m.stop();
    expect(read().v).toBe(0);
  } finally {
    dropBeat(cells);
  }
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

test("an idle daemon's timer sleeps until the next thing is due, and a stall the watcher saw meanwhile is reported once", () => {
  const watch = new TurnWatch();
  const clock = { now: (epoch += 1_000_000), cpu: 0, idle: 10_000 };
  performance.now = () => clock.now;
  const seen: Stall[] = [];
  const noted: Stall[] = [];
  const working: boolean[] = [];
  const m = new StallMonitor({
    report: (s) => void seen.push(s), note: (s) => void noted.push(s), turns: (when) => watch.at(when),
    working: () => false, tick: (w) => void working.push(w), idleMs: () => clock.idle, thresholdMs: 1000, cpu: () => clock.cpu,
  });
  m.start();
  m.stop();
  const pass = (ms: number, busy = ms) => { clock.now += ms; clock.cpu += busy; };
  // Working for a moment after its start, then idle: the sleep is what the tick says, between the short period and ten seconds.
  for (let i = 0; i < 60; i++) { pass(100, 0); m.tick(); }
  expect(m.period()).toBe(10_000);
  clock.idle = 2_500;
  expect(m.period()).toBe(2_500);
  clock.idle = 0;
  expect(m.period()).toBe(100);
  clock.idle = 60_000;
  expect(m.period()).toBe(10_000);
  // Whatever rides on the tick is told whether the daemon works.
  expect(working.at(-1)).toBe(false);
  // A stall of 2.4 s began and ended while the timer slept: no tick was late for it, the watcher's word makes the row.
  pass(3_000);
  const s = m.unsaid(2_400)!;
  expect(s).toMatchObject({ ms: 2_400, window_ms: 3_400, in_flight: [] });
  expect(describeStall(s).message).toBe("Daemon unresponsive for 2.4 s: blocked by its own code, outside anything it times");
  expect(seen).toEqual([s]);
  // The same stall told twice, or found by the tick a moment later, is one row.
  expect(m.unsaid(2_400)).toBeUndefined();
  pass(200, 0);
  clock.now += 2_000;
  expect(m.tick()).toBeUndefined();
  expect(seen.length).toBe(1);
  // One the tick found first is not told again by the watcher; a short one is a note.
  pass(10_000, 0);
  m.tick();
  // The timer slept its ten seconds and fired 1.8 s late.
  pass(10_000 + 1_800);
  expect(m.tick()).toMatchObject({ ms: 1_800 });
  expect(m.unsaid(1_800)).toBeUndefined();
  expect(seen.length).toBe(2);
  pass(5_000, 0);
  expect(m.unsaid(400)).toBeUndefined();
  expect(noted.map((x) => x.ms)).toEqual([400]);
  expect(m.unsaid(100)).toBeUndefined();
  expect(noted.length).toBe(1);
});

// A stall on a processor in the kernel: the row says what the kernel's time was for, in the
// watcher's own words, and each kind of work is a row of its own in the Errors panel.
test("a stall in the kernel says what it was for, and reading, writing and taking memory are rows apart", () => {
  const stall = (key: string, what: string): Stall => ({
    ms: 2_000, busy_ms: 1_900, in_flight: [], turns: [],
    cause: { kind: "compute", key, text: `1.9 s ${what}`, sampled_ms: 2_000, run_ms: 1_900, kernel_ms: 1_800, wait_ms: 0, shares: [{ kind: "compute", key, what, ms: 1_900 }] },
  } as unknown as Stall);
  const read = describeStall(stall("compute kernel read", "on a processor in the kernel, reading 1.9 GB in 30 calls"));
  const again = describeStall(stall("compute kernel read", "on a processor in the kernel, reading 64 MB in 2 calls"));
  const faults = describeStall(stall("compute kernel memory", "on a processor in the kernel, taking memory (120,000 page faults, about 492 MB)"));
  const bare = describeStall(stall("compute kernel", "on a processor in the kernel, for system calls of its own"));
  expect(read.message).toBe("Daemon unresponsive for 2.0 s: on a processor in the kernel, reading 1.9 GB in 30 calls, outside anything it times");
  expect(faults.message).toBe("Daemon unresponsive for 2.0 s: on a processor in the kernel, taking memory (120,000 page faults, about 492 MB), outside anything it times");
  expect(bare.message).toBe("Daemon unresponsive for 2.0 s: on a processor in the kernel, for system calls of its own, outside anything it times");
  expect(read.what).toBe("on a processor in the kernel, reading 1.9 GB in 30 calls, outside anything it times");
  // One row for the reads whatever their size, another for the memory, another for what is not known.
  expect([read.group, again.group, faults.group, bare.group]).toEqual(["stall compute kernel read untimed", "stall compute kernel read untimed", "stall compute kernel memory untimed", "stall compute kernel untimed"]);
  // A cause from a watcher that names no share keeps the words it had.
  const old = describeStall({ ms: 2_000, busy_ms: 1_900, in_flight: [], turns: [], cause: { kind: "compute", key: "compute", text: "x", sampled_ms: 2_000, run_ms: 1_900, kernel_ms: 1_800, wait_ms: 0 } } as unknown as Stall);
  expect(old.message).toBe("Daemon unresponsive for 2.0 s: on a processor in the kernel, for system calls of its own, outside anything it times");
});

// A shorter stall reaches the log alone until its cause comes back: the third of one cause within the hour is a row.
test("a cause that recurs three times in an hour is counted per cause, within the window", () => {
  const r = new Recurrence();
  const t0 = 10_000_000;
  expect(r.add("stall compute kernel memory untimed", t0)).toBe(1);
  expect(r.add("stall cpu_wait", t0 + 1_000)).toBe(1);
  expect(r.add("stall compute kernel memory untimed", t0 + 20 * 60_000)).toBe(2);
  expect(r.add("stall compute kernel memory untimed", t0 + 40 * 60_000)).toBe(3);
  // The first fell out of the window: two within the hour before this one, and this one.
  expect(r.add("stall compute kernel memory untimed", t0 + RECUR_MS + 1)).toBe(3);
  // Another cause counts by itself, and one gone for an hour starts again.
  expect(r.add("stall cpu_wait", t0 + RECUR_MS + 1_001)).toBe(1);
  expect(r.add("stall compute kernel memory untimed", t0 + 3 * RECUR_MS)).toBe(1);
});

// A short stall that keeps coming back makes one row at its third time, and each later one counts on it as
// a repeat: the frames update the views, and nothing that counts new failures pages on them. Five within
// ten minutes were five error frames before, and the helper's spike woke the coordinator for one slow cause.
test("a recurring short stall's later repeats count on its row and are no new failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-stall-"));
  const store = new Store(dir);
  const bus = new Bus();
  const errors = new ErrorTracker(store, bus);
  const quiet = console.error;
  console.error = () => {};
  try {
    const frames: { id: string; repeat?: true }[] = [];
    bus.on((f) => { if (f.t === "error") frames.push({ id: f.error.id, ...(f.repeat ? { repeat: f.repeat } : {}) }); });
    let times: number[] = [], spiked = false, counted = 0;
    errors.onCapture((c) => { if (!spikeCounts(c)) return; counted++; const r = spike(times, Date.now(), SPIKE_WINDOW_MS, SPIKE_COUNT); times = r.times; spiked ||= r.spiked; });
    const r = new Recurrence();
    const d = { message: "The daemon was unresponsive for 1.6 s", context: { kind: "stall", ms: 1600 }, group: "stall compute kernel memory untimed" };
    const t0 = 50_000_000;
    const made = [];
    for (let i = 0; i < 6; i++) {
      const ended = t0 + i * 60_000;
      const c = stallCapture(d, false, r.add(d.group, ended), ended);
      if (c) made.push(errors.capture("server", Object.assign(new Error(c.message), { stack: undefined }), c.context, c.at));
    }
    // The first two reach the log alone; the third makes the row, and the rest count on it.
    expect(made.length).toBe(4);
    expect(new Set(made.map((m) => m.id)).size).toBe(1);
    expect(store.error(made[0]!.id)?.count).toBe(4);
    expect(frames.map((f) => !!f.repeat)).toEqual([false, true, true, true]);
    expect(counted).toBe(1);
    expect(spiked).toBe(false);
    // A stall long enough for a row by itself is never a repeat.
    const long = stallCapture({ ...d, message: "The daemon was unresponsive for 3 s" }, true, r.add(d.group, t0 + 7 * 60_000), t0 + 7 * 60_000);
    expect(long?.at).toEqual({ group: d.group });
  } finally {
    console.error = quiet;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with the default bar, a stall of 0.3 s or more is noted for its row in daemon_stalls, and one under it is not", () => {
  const clock = { now: (epoch += 1_000_000), cpu: 0 };
  performance.now = () => clock.now;
  const seen: Stall[] = [], noted: Stall[] = [];
  const m = new StallMonitor({ report: (s) => void seen.push(s), note: (s) => void noted.push(s), turns: () => [], working: () => true, tick: () => {}, cpu: () => clock.cpu });
  m.start();
  m.stop();
  for (const step of [100, 380]) { clock.now += step; clock.cpu += step; expect(m.tick()).toBeUndefined(); }
  expect(noted.map((s) => s.ms)).toEqual([]);
  clock.now += 420; clock.cpu += 420;
  expect(m.tick()).toBeUndefined();
  expect(noted.map((s) => s.ms)).toEqual([320]);
  clock.now += 2_600; clock.cpu += 2_600;
  expect(m.tick()!.ms).toBe(2_500);
  expect(seen.map((s) => s.ms)).toEqual([2_500]);
});
