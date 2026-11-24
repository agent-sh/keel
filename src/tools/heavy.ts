// The daemon's one pool of heavy-command slots (the decision is pure, in
// src/tools/heavy-pool.ts). Every tool that starts a command asks it first:
// a command the owner's patterns name heavy takes a slot, or its tool call
// waits in line, spending nothing (no model request runs while a call waits).
// Its session's step says its place in one line, the wait is a span of the
// turn's trace ("slot wait"), and the result's first line says how long it
// waited. The slot goes back when the command ends.
//
// A call run on another machine (keel__run_on, a session whose tools run
// there) asks that machine's daemon, which has its own pool.
import { availableParallelism, freemem, loadavg, platform } from "node:os";
import { readFileSync } from "node:fs";
import { registerSettings, settings } from "../admin/settings.ts";
import { splitCommand } from "../safety/shell.ts";
import { cpuMs, jobSlots, running, startJob, type Job, type StartOpts } from "./jobs.ts";
import { before, checkConfig, compile, cpuList, loadBetween, nextQuiet, quiet, schedTime, heavyPattern, order, placeLine, room, type Cost, type Gone, type Held, type Match, type PoolConfig, type Quiet, type Reading, type Room, type Who } from "./heavy-pool.ts";

// The defaults. Each kind's cost is measured, one command at a time in a
// cgroup of its own, as its peak over two seconds and its peak memory:
//   browsers  a run of browser specs peaks at 3.0 to 3.2 cores and 0.7 to
//             1 GB, and shows its load within 2.5 s of its start
//   builds    a bundle build 3.5 cores, a type check 5.8 cores on average but
//             over in 2 s and 1.3 GB; a suite that compiles first (go test,
//             cargo test) is counted as a build
//   suites    a unit suite peaks at 0.4 to 1.6 cores; the whole suite of a
//             large repository at 1.6 cores and 2.1 GB
// The limit and the memory floor are the capacity gate commands were run
// behind before this pool: a 1-minute load under 20 on 24 cores, 8 GB free.
const SUITE = { cores: 1.5, memory_mb: 2048 };
const BROWSER = { cores: 3, memory_mb: 1024 };
const BUILD = { cores: 3, memory_mb: 1536 };
export const DEFAULTS: PoolConfig = {
  patterns: [
    { pattern: "(bun|deno) test", ...SUITE },
    { pattern: "(npm|pnpm|yarn|bun) (run )?test", ...SUITE },
    { pattern: "(vitest|jest|mocha|pytest|tox|nox)", ...SUITE },
    { pattern: "playwright test", ...BROWSER },
    { pattern: "(npm|pnpm|yarn|bun) (run )?e2e", ...BROWSER },
    { pattern: "(chromium|chromium-browser|google-chrome|chrome|firefox)", ...BROWSER },
    { pattern: "\\S*smoke\\.sh", ...BROWSER },
    { pattern: "(npm|pnpm|yarn|bun) (run )?build", ...BUILD },
    { pattern: "go (test|build|vet)", ...BUILD },
    { pattern: "cargo (build|test|nextest|clippy|bench|check)", ...BUILD },
    { pattern: "(make|ninja|gradle|gradlew|mvn|bazel|bazelisk)", ...BUILD },
    { pattern: "cmake --build", ...BUILD },
    { pattern: "(docker|podman) (build|compose build|buildx build)", ...BUILD },
    { pattern: "tsc", ...BUILD },
  ],
  load_share: 0.83,
  free_mb: 8192,
  // What a pattern given as text costs, and how long a command takes to show its load.
  cost: { ...BROWSER, ramp_s: 3 },
  slots: null,
};
registerSettings("heavy", DEFAULTS as unknown as Record<string, unknown>, checkConfig);

export const config = (): PoolConfig => ({ ...DEFAULTS, ...(settings().heavy ?? {}) });

// One sample a second while anything waits or a slot is young; the busy count is their mean.
const SAMPLE_MS = 1000;
const WINDOW = 5;

export type Slot = { key: string; pattern: string; waitedMs: number; ahead: number; release: () => void; bind: (job: Job) => void };
type Entry = { key: string; who: Who; at: number; session: string; call?: string; command: string; pattern: string; cost: Cost; go: (s: Slot) => void; told?: string; ahead0?: number };
type Holder = Held & { session: string; command: string; pattern: string; call?: string; job?: Job; quiet?: Quiet };

// What a change of a held call says (a frame of the session's: its state and its trace read it).
export type HeavyChange = { session_id: string; call_id?: string; key: string; state: "waiting" | "started" | "left"; line?: string; pattern: string; waited_ms?: number };
export const heavyChanged: { tell?: (c: HeavyChange) => void } = {};
// How many slots quiet holders gave back (src/tools/heavy-pool.ts, nextQuiet), for the view.
let quietFreed = 0;

const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
function memAvailableMb(): number {
  const m = read("/proc/meminfo").match(/MemAvailable:\s+(\d+)/);
  return m ? Math.round(Number(m[1]) / 1024) : Math.round(freemem() / 1048576);
}
// The processes that run or wait for a processor now, without this read's own thread.
function runnableNow(): number | undefined {
  if (platform() !== "linux") return undefined;
  const m = read("/proc/stat").match(/^procs_running (\d+)/m);
  return m ? Math.max(0, Number(m[1]) - 1) : undefined;
}
// The processors this daemon may use (read once: an affinity is set at the start).
let allowed: Set<number> | undefined | null;
const allowedCpus = () => {
  if (allowed === undefined) { const m = read("/proc/self/status").match(/^Cpus_allowed_list:\s*(\S+)/m); allowed = m ? cpuList(m[1]!) : null; }
  return allowed ?? undefined;
};

// What the machine is read as, and a job's processor time in ms (a test sets its own).
export const machine = {
  cpu: (job: Job): Promise<number> => cpuMs(job),
  read: (): { cores: number; load1: number; runnable?: number; sched_ns?: number; mem_available_mb: number } => ({
    cores: allowedCpus()?.size || availableParallelism(), load1: loadavg()[0]!, runnable: runnableNow(),
    sched_ns: platform() === "linux" ? schedTime(read("/proc/schedstat"), allowedCpus()) : undefined, mem_available_mb: memAvailableMb(),
  }),
};

class Pool {
  held = new Map<string, Holder>();
  line: Entry[] = [];
  gone: Gone[] = [];
  private samples: { at: number; runnable?: number; ns?: number; load1: number; mem: number; cores: number }[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private n = 0;
  private ticks = 0;
  private sampling: Promise<void> | undefined;

  private sample() {
    const m = machine.read();
    const at = Date.now();
    this.samples.push({ at, runnable: m.runnable, ns: m.sched_ns, load1: m.load1, mem: m.mem_available_mb, cores: m.cores });
    if (this.samples.length > WINDOW) this.samples.shift();
  }

  reading(): Reading {
    const now = Date.now();
    if (!this.samples.length || now - this.samples.at(-1)!.at > 2 * SAMPLE_MS) { this.samples = []; this.sample(); }
    const s = this.samples;
    const last = s.at(-1)!;
    // The load over the samples kept; with one sample yet, the processes that run now.
    const timed = s.filter((x) => x.ns !== undefined);
    const over = timed.length > 1 && timed.at(-1)!.at - timed[0]!.at >= 500 ? loadBetween({ at: timed[0]!.at, ns: timed[0]!.ns! }, { at: timed.at(-1)!.at, ns: timed.at(-1)!.ns! }) : undefined;
    const run = s.filter((x) => x.runnable !== undefined);
    const busy = over ?? (run.length ? run.reduce((a, x) => a + x.runnable!, 0) / run.length : undefined);
    return { cores: last.cores, load1: last.load1, mem_available_mb: last.mem, at: now, ...(busy !== undefined ? { runnable: busy } : {}) };
  }

  // The room for the next command: the head of the line's cost, else a command of `next`'s.
  room(next?: Cost): Room {
    this.gone = this.gone.filter((g) => Date.now() - g.at < 60_000);
    const cfg = config();
    return room(this.reading(), [...this.held.values()], cfg, this.gone, WINDOW * SAMPLE_MS, next ?? order(this.line)[0]?.cost ?? cfg.cost);
  }

  // What names a command heavy and what it costs, or nothing (no slot is asked for).
  heavy(command: string): Match | undefined {
    const cfg = config();
    if (!cfg.patterns.length) return undefined;
    return heavyPattern(splitCommand(command), compile(cfg.patterns, cfg.cost), splitCommand);
  }

  private grant(e: Omit<Entry, "go" | "at"> & { at?: number }, waitedMs: number): Slot {
    const h: Holder = { key: e.key, who: e.who, since: Date.now(), cost: e.cost, session: e.session, command: e.command, pattern: e.pattern, call: e.call };
    this.held.set(e.key, h);
    this.tick();
    let done = false;
    return {
      key: e.key, pattern: e.pattern, waitedMs, ahead: e.ahead0 ?? 0,
      bind: (job) => { h.job = job; },
      release: () => {
        if (done) return;
        done = true;
        if (this.held.get(e.key) === h) { this.held.delete(e.key); this.gone.push({ at: Date.now(), cost: h.cost }); }
        this.pump();
      },
    };
  }

  // A slot for a command, given at once or when one frees; undefined when the
  // command is not heavy; "aborted" when the call was stopped while it waited.
  async take(o: { session: string; who: Who; command: string; call?: string; signal?: AbortSignal }): Promise<Slot | "aborted" | undefined> {
    const m = this.heavy(o.command);
    if (!m) return undefined;
    const key = `${o.session}:${o.call ?? `c${++this.n}`}:${++this.n}`;
    const pattern = m.pattern;
    const base = { key, who: o.who, session: o.session, call: o.call, command: m.line, pattern, cost: m.cost };
    // The owner's own command never waits.
    if (o.who === "owner") return this.grant(base, 0);
    const ahead = before(this.line, o.who);
    if (ahead === 0 && this.room(m.cost).free > 0) return this.grant(base, 0);
    if (o.signal?.aborted) return "aborted";
    const at = Date.now();
    return await new Promise<Slot | "aborted">((resolve) => {
      const e: Entry = { ...base, at, ahead0: ahead, go: (s) => { o.signal?.removeEventListener("abort", stop); resolve(s); } };
      const stop = () => {
        const i = this.line.indexOf(e);
        if (i < 0) return;
        this.line.splice(i, 1);
        heavyChanged.tell?.({ session_id: e.session, call_id: e.call, key, state: "left", pattern, waited_ms: Date.now() - at });
        this.pump();
        resolve("aborted");
      };
      o.signal?.addEventListener("abort", stop, { once: true });
      this.line.push(e);
      this.tick();
      this.pump();
    });
  }

  // A command that starts without waiting (the owner's own, one a restart left running): it holds a slot while it runs.
  count(o: { session: string; command: string }, who: Who = "session"): Slot | undefined {
    const m = this.heavy(o.command);
    if (!m) return undefined;
    return this.grant({ key: `${o.session}:now:${++this.n}`, who, session: o.session, command: m.line, pattern: m.pattern, cost: m.cost }, 0);
  }

  // Slots that freed go to the head of the line, one at a time while the head
  // fits; the rest are told their new places.
  pump() {
    if (!this.line.length) return;
    let r = this.room();
    for (let head = order(this.line)[0]; head && r.free > 0; head = order(this.line)[0]) {
      this.line.splice(this.line.indexOf(head), 1);
      const waited = Date.now() - head.at;
      heavyChanged.tell?.({ session_id: head.session, call_id: head.call, key: head.key, state: "started", pattern: head.pattern, waited_ms: waited });
      head.go(this.grant(head, waited));
      r = this.room();
    }
    order(this.line).forEach((e, i) => {
      const line = placeLine(i, this.holders(e.session), r.cause);
      if (line === e.told) return;
      e.told = line;
      heavyChanged.tell?.({ session_id: e.session, call_id: e.call, key: e.key, state: "waiting", line, pattern: e.pattern });
    });
  }

  // Who holds the slots, as a waiting session is told: the program and whose
  // it is. Another session is named by its kind only: its title can hold a
  // path or a name that is not the waiting session's to read.
  private holders(session: string): string[] {
    return [...this.held.values()].map((h) => {
      const whose = h.who === "beside" ? (h.session === session ? "Keel's checks of this session's files" : "Keel's checks of an agent's files") : h.session === session ? "this session" : h.who === "agent" ? "an agent" : h.who === "owner" ? "the owner's terminal" : "another session";
      return `${program(h.command)} (${whose})`;
    });
  }

  // Samples run while anything waits or a slot is young; while anything waits,
  // the processor time of the commands that hold a slot too, so a quiet one
  // gives its slot back.
  private tick() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const ramp = config().cost.ramp_s * 1000;
      const young = [...this.held.values()].some((h) => Date.now() - h.since < ramp + WINDOW * SAMPLE_MS);
      if (!this.line.length && !young) { for (const h of this.held.values()) h.quiet = undefined; clearInterval(this.timer); this.timer = undefined; return; }
      this.sample();
      if (this.line.length && ++this.ticks % QUIET_EVERY === 0) void this.sampleQuiet();
      this.pump();
    }, SAMPLE_MS);
    (this.timer as any).unref?.();
  }

  // One sample of the holders' processor time at a time, read off the loop.
  sampleQuiet(): Promise<void> {
    if (this.sampling) return this.sampling;
    const ramp = config().cost.ramp_s * 1000;
    const list = [...this.held.values()].filter((h) => h.job && running(h.job) && Date.now() - h.since >= ramp);
    const run = (async () => {
      await Promise.all(list.map(async (h) => {
        const cpu = await machine.cpu(h.job!).catch(() => undefined);
        if (cpu === undefined || this.held.get(h.key) !== h) return;
        h.quiet = nextQuiet(h.quiet, { at: Date.now(), cpu }, h.cost.cores);
        if (!quiet(h.quiet)) return;
        this.held.delete(h.key);
        quietFreed++;
      }));
      this.pump();
    })();
    this.sampling = run.finally(() => { this.sampling = undefined; });
    return this.sampling;
  }

  // The session's held calls in one line: what its step says while it waits.
  lineOf(session: string): string | undefined {
    return this.line.find((e) => e.session === session)?.told;
  }
  waits(session: string) { return this.line.some((e) => e.session === session); }
  // When the session's oldest call in line asked.
  waitingSince(session: string): number | undefined {
    const at = this.line.filter((e) => e.session === session).map((e) => e.at);
    return at.length ? Math.min(...at) : undefined;
  }

  view(now = Date.now()) {
    const r = this.room();
    const rd = this.reading();
    return {
      config: config(),
      machine: { cores: rd.cores, load1: Math.round(rd.load1 * 100) / 100, runnable: rd.runnable === undefined ? null : Math.round(rd.runnable * 10) / 10, mem_available_mb: rd.mem_available_mb },
      room: { slots: r.slots, free: r.free, limit: Math.round(r.limit * 10) / 10, busy: Math.round(r.busy * 10) / 10, cause: r.cause, why: r.why },
      held: [...this.held.values()].map((h) => ({ session_id: h.session, who: h.who, command: h.command, pattern: h.pattern, cores: h.cost.cores, since: h.since, ms: now - h.since })),
      line: order(this.line).map((e, i) => ({ place: i + 1, session_id: e.session, who: e.who, command: e.command, pattern: e.pattern, cores: e.cost.cores, since: e.at, ms: now - e.at })),
      quiet_freed: quietFreed,
    };
  }

  // For a test: no slot held, no one in line.
  reset() { this.held.clear(); this.line = []; this.gone = []; this.samples = []; this.sampling = undefined; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}

// While a line waits, the holders' processor time is read every QUIET_EVERY samples.
const QUIET_EVERY = 3;
// A holder's program as a waiting session is told it: its first word, and its
// command word only when it is one of a fixed few (a make target or a script
// name such as deploy-prod is another session's to read, not the line's).
const SUBS = new Set(["build", "test", "run", "check", "vet", "clippy", "bench"]);
export const program = (line: string) => {
  const [p, sub] = line.split(" ");
  return sub && SUBS.has(sub) ? `${p} ${sub}` : p!;
};

export const pool = new Pool();
jobSlots.count = (job) => { const s = pool.count({ session: job.sessionId, command: job.command }); s?.bind(job); return s; };

// A job started with the slot it took: the slot goes back at its end, or at once when it does not start.
export function startHeld(o: StartOpts, slot: Slot | undefined): Job {
  let job: Job;
  try { job = startJob({ ...o, slot }); } catch (e) { slot?.release(); throw e; }
  slot?.bind(job);
  return job;
}

// The slot of a tool call's command: waits in line when the pool is full.
export const takeFor = (ctx: { sessionId: string; parentId?: string; heavyWho?: Who; callId?: string; signal: AbortSignal }, command: string) =>
  pool.take({ session: ctx.sessionId, who: whoOf(ctx), command, call: ctx.callId, signal: ctx.signal });

// What a call stopped while it waited answers: nothing ran.
export const ABORTED_TEXT = "Interrupted while waiting for a heavy-command slot: nothing ran.";

// Who a tool call is for the line: an agent's, or a session's own.
export const whoOf = (ctx: { parentId?: string; heavyWho?: Who }): Who => ctx.heavyWho ?? (ctx.parentId ? "agent" : "session");

// The one line a call's result starts with when it waited.
export function waitedLine(s: Slot | undefined): string {
  if (!s || s.waitedMs < 1000) return "";
  const sec = Math.round(s.waitedMs / 1000);
  const t = sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
  return `[Waited ${t} for a heavy-command slot (${s.ahead} ahead when it asked); the command's own time starts after that.]\n`;
}
