// The stall watcher's thread (stall-watch.ts). It shares one number with the
// daemon's loop: the loop writes it at every tick of its stall timer and
// around every section it times, with how soon it will write again. Ten
// times a second this thread reads that number. While it changes in time,
// nothing else is done. (A slower look while the daemon is idle was tried:
// a thread of Bun's wakes several times a second by itself, so it saved
// next to nothing and saw less of a stall.) When it does not, the loop is held, and this thread
// samples the daemon's main thread from /proc until the number changes
// again: its state, what it runs or waits in, and how long it waited for a
// processor. It reads files of its own process only, from its own thread:
// it cannot hold the loop, and needs no privilege.
import { readFileSync, readlinkSync } from "node:fs";
import {
  type Arch, type Around, type CallMemo, commandOf, decide, type Dirs, type Lookup, parseEpoll, parseLoad, parsePidfd, parsePressure,
  parsePressureTotal, parseSchedstat, parseThrottled, type Sample, sampleOf,
} from "./stall-cause.ts";
import { ALLOW_MASK } from "./stall-beat.ts";

declare var self: Worker;

const TICK_MS = 100;
// A loop this late past its own promise is held: sampling starts.
const SLACK_MS = 200;
// A tick of this thread this late: the whole process did not run.
const GAP_MS = 1000;
// Samples kept: two minutes at ten a second. A stall sampled this many times is sampled once a second from there.
const KEPT = 1200;
const DENSE = 300;
// What is read while the loop is well, so a pause of the whole process can be told from a wait for a processor: this often.
const BASE_MS = 10_000;

type Started = { beat: SharedArrayBuffer; stmt?: SharedArrayBuffer; dirs: Dirs; arch: Arch };
type Asked = { ask: number; window_ms: number; ms: number };
type Episode = { ep: number; t0: number; t1: number; around: Around; throttled0?: number };

let beat: Int32Array | undefined;
// The statement the store's connection is in (src/core/statement-label.ts): its label's number, and the labels by number.
let stmt: Int32Array | undefined;
const labels: string[] = [];
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

function tick() {
  if (!beat) return;
  const now = performance.now();
  const v = Atomics.load(beat, 0);
  // The loop's stall timer does not run (the daemon is starting, or reloading): nothing is expected of it.
  if (v === 0 && !sampling) { lastTick = now; seen = v; changedAt = now; return; }
  const late = lastTick > 0 && now - lastTick > GAP_MS;
  const gapped = late ? gap(lastTick, now) : undefined;
  lastTick = now;
  if (v !== seen) {
    seen = v;
    changedAt = now;
    if (sampling) {
      // The loop runs again: one last look closes the counts.
      if (!late) keep(sample(now, sampling.ep));
      close(sampling, now);
      sampling = undefined;
    }
  } else if (now - changedAt > (v & ALLOW_MASK) + SLACK_MS) {
    // After a gap its sample is this tick's, and the time before and after it is one stretch.
    sampling ??= gapped ?? open(now);
    if (!late && (taken < DENSE || ticks % 10 === 0)) { keep(sample(now, sampling.ep)); taken++; }
  }
  ticks++;
  if (!sampling && now - based >= BASE_MS) { based = now; rebase(); }
}

// What the samples of the last `window_ms` say (the loop asks once it runs again).
function answer(m: Asked) {
  tick();
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
    clearInterval(timer);
    self.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
};
let timer: ReturnType<typeof setInterval> | undefined;

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data as { start: Started } | { label: [number, string] } | Asked;
  if ("label" in m) { labels[m.label[0]] = m.label[1]; return; }
  if ("start" in m) {
    guard(() => {
      beat = new Int32Array(m.start.beat);
      if (m.start.stmt) stmt = new Int32Array(m.start.stmt);
      dirs = m.start.dirs;
      arch = m.start.arch;
      unit = unitDir();
      quota = quotaDir();
      // Read once here: a machine whose kernel keeps no schedstat is found out at the start, not at the first stall.
      sample(performance.now(), 0);
      rebase();
      based = performance.now();
      timer = setInterval(() => guard(tick), TICK_MS);
      let tid: number | undefined;
      try { tid = Number(readlinkSync("/proc/thread-self").split("/").pop()); } catch {}
      self.postMessage({ ready: true, tid });
    });
    return;
  }
  guard(() => answer(m));
};
