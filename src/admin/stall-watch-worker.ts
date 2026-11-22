// The stall watcher's thread (stall-watch.ts). It shares a few numbers with
// the daemon's loop. The first is the beat: the loop writes it at every tick
// of its stall timer and around every section it times, with how soon it
// will write again.
//
// While the daemon works this thread reads the beat ten times a second.
// While it changes in time, nothing else is done. When it does not, the
// loop is held, and this thread samples the daemon's main thread from /proc
// until the beat changes again: its state, what it runs or waits in, and how
// long it waited for a processor.
//
// While the daemon is idle the loop promises no time (it sleeps until
// something happens), and this thread looks once a second instead: whether
// the main thread sleeps in the loop's own wait, and how much processor time
// it used since the last look. A main thread that is anywhere else, or that
// ran for most of the second, is looked at ten times a second from there;
// one that stays out of the loop's wait is held, is sampled like any stall,
// and the loop is told how long it was once it runs again (no timer of its
// own was due to be late for it). The loop ends an idle wait at once when
// work begins: it raises a count this thread waits on.
//
// Between looks the thread is blocked in Atomics.wait, never in a timer: a
// timer turns the thread's event loop, and each turn that allocates brings
// the runtime's collector and its helper threads after it (measured: a
// thread with a 100 ms timer cost about ninety wakeups a second in a daemon
// with nothing to do, a blocked one costs its own ten, or one while idle).
// It returns to its event loop only when a message was posted to it, which
// the loop says with a count of the messages it sent.
//
// It reads files of its own process only, from its own thread: it cannot
// hold the loop, and needs no privilege.
import { readFileSync, readlinkSync } from "node:fs";
import {
  type Arch, type Around, type CallMemo, commandOf, decide, type Dirs, type Lookup, parseEpoll, parseLoad, parsePidfd, parsePressure,
  parsePressureTotal, parseSchedstat, parseThrottled, type Sample, sampleOf,
} from "./stall-cause.ts";
import { ALLOW_MASK, BEAT, IDLE_ALLOW, KICK, SENT } from "./stall-beat.ts";

declare var self: Worker;

const TICK_MS = 100;
// A look this often while the loop says it is idle.
const IDLE_LOOK_MS = 1000;
// An idle main thread that used this much processor time between two looks is looked at closely.
const BUSY_MS = 250;
// A loop this late past its own promise is held: sampling starts.
const SLACK_MS = 200;
// A tick of this thread this late: the whole process did not run.
const GAP_MS = 1000;
// Samples kept: two minutes at ten a second. A stall sampled this many times is sampled once a second from there.
const KEPT = 1200;
const DENSE = 300;
// What is read while the loop is well, so a pause of the whole process can be told from a wait for a processor: this often.
const BASE_MS = 10_000;

type Started = { beat: SharedArrayBuffer; stmt?: SharedArrayBuffer; ask?: SharedArrayBuffer; dirs: Dirs; arch: Arch };
type Asked = { ask: number; window_ms: number; ms: number };
type Episode = { ep: number; t0: number; t1: number; around: Around; throttled0?: number };

let beat: Int32Array | undefined;
// The statement the store's connection is in (src/core/statement-label.ts): its label's number, and the labels by number.
let stmt: Int32Array | undefined;
const labels: string[] = [];
// Who asked for the read the loop is in, when the store says (src/core/asker.ts): the same way.
let ask: Int32Array | undefined;
const askers: string[] = [];
let dirs: Dirs = { state: "", config: "" };
let arch: Arch = "x64";
// On Linux a process's first thread has the process's own id.
const MAIN = `/proc/self/task/${process.pid}`;
const ring: Sample[] = [];
const episodes: Episode[] = [];
let epoch = 0;
let seen = -1;
let changedAt = 0;
let lastTick = 0;
let based = 0;
let ticks = 0;
let sampling: Episode | undefined;
let taken = 0;
// How long the wait before this look was to be at most: a look later than that by GAP_MS means the process did not run.
let waited = TICK_MS;
// The loop is idle and its thread was found out of the loop's wait, or busy: since when (it is looked at closely from there).
let suspect: number | undefined;
// The run of samples in progress began while the loop was idle: the loop is told of it when it ends.
let unsaid = false;
// The main thread's processor time at the last idle look, and when that was.
let idleRun: number | undefined;
let idleAt = 0;
// Messages taken so far, against the count the loop keeps of the ones it sent.
let received = 0;
let kicked = 0;
let quota: string | undefined;
// What the call of the sample before was found to wait on (stall-cause.ts): never kept from one stall to the next.
const memo: CallMemo = {};
// The daemon's own cgroup, whose memory pressure says when all of its threads were held in reclaim.
let unit: string | undefined;
const base: { own?: number; run?: number; wait?: number; skew?: number; suspends?: number; memory?: number } = {};

const rd = (path: string): string | undefined => { try { return readFileSync(path, "utf8"); } catch { return undefined; } };
const look: Lookup = {
  link: (fd) => { try { return readlinkSync(`/proc/self/fd/${fd}`); } catch { return undefined; } },
  pidfd: (fd) => parsePidfd(rd(`/proc/self/fdinfo/${fd}`) ?? ""),
  epoll: (fd) => parseEpoll(rd(`/proc/self/fdinfo/${fd}`) ?? ""),
  child: (pid) => { const comm = rd(`/proc/${pid}/comm`); return comm === undefined ? undefined : commandOf(comm, rd(`/proc/${pid}/cmdline`)); },
};

const unitDir = (): string | undefined => {
  const own = /^0::(\/.*)$/m.exec(rd("/proc/self/cgroup") ?? "")?.[1];
  return own ? `/sys/fs/cgroup${own}`.replace(/\/$/, "") : undefined;
};
// The cgroup whose processor quota holds the daemon back, when one does.
function quotaDir(): string | undefined {
  if (!unit) return undefined;
  for (let dir = unit; dir.length > "/sys/fs/cgroup".length; dir = dir.slice(0, dir.lastIndexOf("/"))) {
    const max = rd(`${dir}/cpu.max`);
    if (max && !max.startsWith("max")) return dir;
  }
  return undefined;
}
const throttled = () => (quota ? parseThrottled(rd(`${quota}/cpu.stat`) ?? "") : undefined);
// How far the boot-time clock (it runs while the machine sleeps) is ahead of the monotonic one this thread reads.
const skew = () => { const up = Number((rd("/proc/uptime") ?? "").split(" ")[0]); return Number.isFinite(up) && up > 0 ? up * 1000 - performance.now() : undefined; };
const suspends = () => { const n = Number(rd("/sys/power/suspend_stats/success")); return Number.isFinite(n) ? n : undefined; };
const ownWait = () => parseSchedstat(rd("/proc/thread-self/schedstat") ?? "")?.wait_ns;
// How long some task waited for memory, in ms since the start: in the daemon's own unit when that is kept, else on the machine.
function memoryStall(): { ms: number; unit: boolean } | undefined {
  const own = unit ? parsePressureTotal(rd(`${unit}/memory.pressure`) ?? "") : undefined;
  if (own !== undefined) return { ms: own, unit: true };
  const all = parsePressureTotal(rd("/proc/pressure/memory") ?? "");
  return all === undefined ? undefined : { ms: all, unit: false };
}

function rebase() {
  const main = parseSchedstat(rd(`${MAIN}/schedstat`) ?? "");
  base.own = ownWait();
  base.run = main?.run_ns;
  base.wait = main?.wait_ns;
  base.skew = skew();
  base.suspends = suspends();
  base.memory = memoryStall()?.ms;
}

function around(): Around {
  const p = (what: string) => parsePressure(rd(`/proc/pressure/${what}`) ?? "");
  const cpu = p("cpu"), io = p("io"), memory = p("memory");
  const load = parseLoad(rd("/proc/loadavg") ?? "");
  return { ...(load !== undefined ? { load } : {}), pressure: { ...(cpu !== undefined ? { cpu } : {}), ...(io !== undefined ? { io } : {}), ...(memory !== undefined ? { memory } : {}) } };
}
const higher = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.max(a, b));
const merge = (a: Around, b: Around): Around => ({
  ...(higher(a.load, b.load) !== undefined ? { load: higher(a.load, b.load) } : {}),
  pressure: { cpu: higher(a.pressure?.cpu, b.pressure?.cpu), io: higher(a.pressure?.io, b.pressure?.io), memory: higher(a.pressure?.memory, b.pressure?.memory) },
  ...((a.throttled_ms ?? 0) + (b.throttled_ms ?? 0) > 0 ? { throttled_ms: (a.throttled_ms ?? 0) + (b.throttled_ms ?? 0) } : {}),
  ...((a.suspended_ms ?? 0) + (b.suspended_ms ?? 0) > 0 ? { suspended_ms: (a.suspended_ms ?? 0) + (b.suspended_ms ?? 0) } : {}),
  ...((a.memory_unit ?? b.memory_unit) !== undefined ? { memory_unit: a.memory_unit ?? b.memory_unit } : {}),
  ...((a.memory_stall_ms ?? 0) + (b.memory_stall_ms ?? 0) > 0 ? { memory_stall_ms: (a.memory_stall_ms ?? 0) + (b.memory_stall_ms ?? 0) } : {}),
});

function sample(t: number, ep: number): Sample {
  const s = sampleOf(t, ep, (file) => rd(`${MAIN}/${file}`), arch, dirs, look, memo);
  if (!s) throw new Error("the main thread's stat or schedstat under /proc cannot be read");
  const id = stmt ? Atomics.load(stmt, 0) : 0;
  if (id) s.stmt = labels[id] ?? "a statement of the store";
  const who = ask ? Atomics.load(ask, 0) : 0;
  if (id && who) s.stmt += `, asked by ${askers[who] ?? "a path with no name"}`;
  return s;
}

function keep(s: Sample) {
  ring.push(s);
  if (ring.length > KEPT) ring.splice(0, ring.length - KEPT);
}

function open(t: number): Episode {
  const e: Episode = { ep: ++epoch, t0: t, t1: t, around: around(), throttled0: throttled() };
  episodes.push(e);
  if (episodes.length > 40) episodes.shift();
  taken = 0;
  // A new stall: nothing found for an earlier one is its.
  memo.text = memo.run_ns = memo.link = memo.call = undefined;
  return e;
}
function close(e: Episode, t: number) {
  e.t1 = t;
  const now = throttled();
  e.around = merge(e.around, { ...around(), ...(now !== undefined && e.throttled0 !== undefined && now > e.throttled0 ? { throttled_ms: now - e.throttled0 } : {}) });
}

// This thread did not run from `from` to `now`, so the process did not: the
// machine slept, every thread was held waiting for memory (the unit over
// its memory limit: no thread runs and none waits for a processor, as in a
// stop, but the unit's memory stall grew meanwhile), it was stopped, or
// nothing got a processor. The first three are marked on the sample; in the
// last the main thread's own wait says so.
// Returns the run of samples the gap is in: a loop still held after it is sampled on in the same run.
function gap(from: number, now: number): Episode {
  const dt = now - from;
  const sk = skew(), count = suspends(), own = ownWait();
  const slept = sk !== undefined && base.skew !== undefined ? Math.max(0, sk - base.skew) : 0;
  const waited = own !== undefined && base.own !== undefined ? (own - base.own) / 1e6 : 0;
  const mem = memoryStall();
  const stalled = mem && base.memory !== undefined ? mem.ms - base.memory : 0;
  const kind = slept >= 500 || (count !== undefined && base.suspends !== undefined && count > base.suspends) ? "suspended"
    : stalled >= dt / 2 ? "memory"
    : waited < dt / 2 ? "stopped" : undefined;
  const e = sampling ?? open(from);
  const s = sample(now, e.ep);
  if (!sampling) {
    // No sample from before it: one is made at its start. A pause moved no
    // counter. A wait for a processor is taken to be where the main thread's
    // waits since the last look happened.
    const ran = kind || base.run === undefined ? 0 : Math.min(s.run_ns - base.run, dt * 1e6);
    const queued = kind || base.wait === undefined ? 0 : Math.min(s.wait_ns - base.wait, dt * 1e6);
    keep({ t: from, ep: e.ep, state: kind === "stopped" ? "T" : kind ? "S" : "R", user_ticks: s.user_ticks, sys_ticks: s.sys_ticks, run_ns: s.run_ns - Math.max(0, ran), wait_ns: s.wait_ns - Math.max(0, queued) });
  }
  keep(kind ? { ...s, gap: kind } : s);
  if (slept >= 500) e.around = merge(e.around, { suspended_ms: Math.round(slept) });
  if (kind === "memory") e.around.memory_unit = mem!.unit;
  // Some of a gap that reads as a stop was spent waiting for memory: the row says so instead of naming a stop alone.
  else if (kind === "stopped" && stalled >= 200) e.around = merge(e.around, { memory_stall_ms: Math.round(stalled) });
  if (!sampling) close(e, now);
  rebase();
  return e;
}

// The main thread sleeps in the loop's own wait: nothing holds it.
const parked = (s: Sample) => s.state === "S" && !!s.call && /^epoll_/.test(s.call.name);

// The run of samples ends: the loop runs again. One that began while the loop was idle is told to it.
function ended(now: number) {
  if (!sampling) return;
  close(sampling, now);
  if (unsaid) self.postMessage({ held: { ms: Math.round(now - sampling.t0) } });
  sampling = undefined;
  unsaid = false;
}

// A look while the loop says it is idle. Returns whether the next look is to come soon.
function idleLook(now: number, late: boolean): boolean {
  const s = sample(now, sampling?.ep ?? 0);
  const ran = idleRun === undefined ? 0 : (s.run_ns - idleRun) / 1e6;
  const since = idleAt;
  idleRun = s.run_ns;
  idleAt = now;
  if (parked(s)) {
    // Back in its wait: a stall that was being sampled is over, and a busy moment was no stall.
    if (sampling && !late) keep(s);
    ended(now);
    suspect = undefined;
    return false;
  }
  // Out of its wait. Since when: a thread that computed began as long ago as it ran (within the last look), another is first seen now.
  suspect ??= s.state === "R" && ran >= BUSY_MS ? Math.max(since, now - ran) : now;
  if (now - suspect >= SLACK_MS) {
    if (!sampling) {
      sampling = open(suspect);
      unsaid = true;
      // Nothing was sampled at its start: one sample is made there, of a thread that ran from then or that entered its call then.
      if (suspect < now) keep({ t: suspect, ep: sampling.ep, state: s.state === "R" ? "R" : s.state, user_ticks: s.user_ticks, sys_ticks: s.sys_ticks, run_ns: s.run_ns - (s.state === "R" ? Math.min(ran, now - suspect) * 1e6 : 0), wait_ns: s.wait_ns, ...(s.call ? { call: s.call } : {}) });
    }
    if (!late && (taken < DENSE || ticks % 10 === 0)) { keep({ ...s, ep: sampling.ep }); taken++; }
  }
  return true;
}

// One look. Returns how long the thread may wait for the next one.
function tick(): number {
  if (!beat) return TICK_MS;
  const now = performance.now();
  const v = Atomics.load(beat, BEAT);
  // The loop's stall timer does not run (the daemon is starting, or reloading): nothing is expected of it.
  if (v === 0 && !sampling) { lastTick = now; seen = v; changedAt = now; suspect = idleRun = undefined; return TICK_MS; }
  const late = lastTick > 0 && now - lastTick > waited + GAP_MS;
  const gapped = late ? gap(lastTick, now) : undefined;
  lastTick = now;
  const idle = (v & ALLOW_MASK) === IDLE_ALLOW;
  let soon = !idle;
  if (v !== seen) {
    seen = v;
    changedAt = now;
    if (sampling) {
      // The loop runs again: one last look closes the counts.
      if (!late) keep(sample(now, sampling.ep));
      ended(now);
    }
    suspect = idleRun = undefined;
    // The first look of an idle stretch is the one the later ones are measured from.
    if (idle) { idleRun = sample(now, 0).run_ns; idleAt = now; }
  } else if (idle) {
    // The whole process did not run for a while (it was stopped) and no timer of the idle loop's was due to be late for it: the loop is told.
    if (gapped && !sampling && gapped.t1 - gapped.t0 > waited) self.postMessage({ held: { ms: Math.round(gapped.t1 - gapped.t0 - waited) } });
    soon = idleLook(now, late);
  } else if (now - changedAt > (v & ALLOW_MASK) + SLACK_MS) {
    // After a gap its sample is this tick's, and the time before and after it is one stretch.
    sampling ??= gapped ?? open(now);
    if (!late && (taken < DENSE || ticks % 10 === 0)) { keep(sample(now, sampling.ep)); taken++; }
  }
  ticks++;
  if (!sampling && now - based >= BASE_MS) { based = now; rebase(); }
  return soon || sampling ? TICK_MS : IDLE_LOOK_MS;
}

// What the samples of the last `window_ms` say (the loop asks once it runs again).
function answer(m: Asked) {
  waited = tick();
  const now = performance.now();
  const from = now - m.window_ms - SLACK_MS;
  let about: Around = {};
  for (const e of episodes) if (e.t1 >= from) about = merge(about, e.around);
  self.postMessage({ id: m.ask, cause: decide(ring.filter((s) => s.t >= from), about, m.ms, m.window_ms) });
}

let failed = false;
const guard = (f: () => void) => {
  if (failed) return;
  try { f(); } catch (e) {
    failed = true;
    self.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
};

// Looks, and waits for the next look, until a message was posted to this
// thread: then it returns to its event loop, which hands the message to
// onmessage, and that comes back here. The wait ends early when the loop
// raises the count (work began, or it stopped).
function watch() {
  while (!failed && beat) {
    if (beat.length > SENT && Atomics.load(beat, SENT) !== received) return;
    guard(() => { waited = tick(); });
    if (failed) return;
    Atomics.wait(beat, KICK, kicked, waited);
    kicked = Atomics.load(beat, KICK);
  }
}

self.onmessage = (ev: MessageEvent) => {
  received++;
  const m = ev.data as { start: Started } | { label: [number, string] } | { asker: [number, string] } | Asked;
  if ("label" in m) labels[m.label[0]] = m.label[1];
  else if ("asker" in m) askers[m.asker[0]] = m.asker[1];
  else if ("start" in m) {
    guard(() => {
      beat = new Int32Array(m.start.beat);
      if (m.start.stmt) stmt = new Int32Array(m.start.stmt);
      if (m.start.ask) ask = new Int32Array(m.start.ask);
      dirs = m.start.dirs;
      arch = m.start.arch;
      unit = unitDir();
      quota = quotaDir();
      // Read once here: a machine whose kernel keeps no schedstat is found out at the start, not at the first stall.
      sample(performance.now(), 0);
      rebase();
      based = performance.now();
      let tid: number | undefined;
      try { tid = Number(readlinkSync("/proc/thread-self").split("/").pop()); } catch {}
      self.postMessage({ ready: true, tid });
    });
  } else guard(() => answer(m));
  watch();
};
