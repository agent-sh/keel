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
import { jobSlots, startJob, type Job, type StartOpts } from "./jobs.ts";
import { admit, before, checkConfig, compile, cpuList, loadBetween, schedTime, heavyPattern, order, placeLine, room, type Held, type PoolConfig, type Reading, type Room, type Who } from "./heavy-pool.ts";

// The defaults. The cost is measured, one command at a time in a cgroup of its
// own: a run of browser specs, the heaviest of the usual ones, peaks at about
// 3 cores over two seconds (1.2 on average) and 1 GB, and shows its load within
// 3 s of its start; a unit suite, a type check or a build peaks lower or ends
// in seconds. At most as many run as fit the limit at their peak. The limit
// and the memory floor are the capacity gate commands were run behind before
// this pool: a 1-minute load under 20 on 24 cores, 8 GB free.
export const DEFAULTS: PoolConfig = {
  patterns: [
    "(bun|deno) test",
    "(npm|pnpm|yarn|bun) (run )?(test|e2e|build)",
    "playwright test",
    "(vitest|jest|mocha|pytest|tox|nox)",
    "go (test|build|vet)",
    "cargo (build|test|nextest|clippy|bench|check)",
    "(make|ninja|gradle|gradlew|mvn|bazel|bazelisk)",
    "cmake --build",
    "(docker|podman) (build|compose build|buildx build)",
    "tsc",
    "(chromium|chromium-browser|google-chrome|chrome|firefox)",
    "\\S*smoke\\.sh",
  ],
  load_share: 0.83,
  free_mb: 8192,
  cost: { cores: 3, memory_mb: 1024, ramp_s: 3 },
  slots: null,
};
registerSettings("heavy", DEFAULTS as unknown as Record<string, unknown>, checkConfig);

export const config = (): PoolConfig => ({ ...DEFAULTS, ...(settings().heavy ?? {}) });

// One sample a second while anything waits or a slot is young; the busy count is their mean.
const SAMPLE_MS = 1000;
const WINDOW = 5;

export type Slot = { key: string; pattern: string; waitedMs: number; ahead: number; release: () => void };
type Entry = { key: string; who: Who; at: number; session: string; call?: string; command: string; pattern: string; go: (s: Slot) => void; told?: string; ahead0?: number };
type Holder = Held & { session: string; command: string; pattern: string; call?: string };

// What a change of a held call says (a frame of the session's: its state and its trace read it).
export type HeavyChange = { session_id: string; call_id?: string; key: string; state: "waiting" | "started" | "left"; line?: string; pattern: string; waited_ms?: number };
export const heavyChanged: { tell?: (c: HeavyChange) => void } = {};

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

// What the machine is read as (a test sets its own).
export const machine = {
  read: (): { cores: number; load1: number; runnable?: number; sched_ns?: number; mem_available_mb: number } => ({
    cores: allowedCpus()?.size || availableParallelism(), load1: loadavg()[0]!, runnable: runnableNow(),
    sched_ns: platform() === "linux" ? schedTime(read("/proc/schedstat"), allowedCpus()) : undefined, mem_available_mb: memAvailableMb(),
  }),
};

class Pool {
  held = new Map<string, Holder>();
  line: Entry[] = [];
  gone: number[] = [];
  private samples: { at: number; runnable?: number; ns?: number; load1: number; mem: number; cores: number }[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private n = 0;

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

  room(): Room {
    this.gone = this.gone.filter((t) => Date.now() - t < 60_000);
    return room(this.reading(), [...this.held.values()], config(), this.gone, WINDOW * SAMPLE_MS);
  }

  // The pattern that names a command heavy, or nothing (no slot is asked for).
  heavy(command: string): string | undefined {
    const cfg = config();
    if (!cfg.patterns.length) return undefined;
    return heavyPattern(splitCommand(command), compile(cfg.patterns), splitCommand);
  }

  private grant(e: Omit<Entry, "go" | "at"> & { at?: number }, waitedMs: number): Slot {
    const h: Holder = { key: e.key, who: e.who, since: Date.now(), session: e.session, command: e.command, pattern: e.pattern, call: e.call };
    this.held.set(e.key, h);
    this.tick();
    let done = false;
    return {
      key: e.key, pattern: e.pattern, waitedMs, ahead: e.ahead0 ?? 0,
      release: () => {
        if (done) return;
        done = true;
        if (this.held.get(e.key) === h) { this.held.delete(e.key); this.gone.push(Date.now()); }
        this.pump();
      },
    };
  }

  // A slot for a command, given at once or when one frees; undefined when the
  // command is not heavy; "aborted" when the call was stopped while it waited.
  async take(o: { session: string; who: Who; command: string; call?: string; signal?: AbortSignal }): Promise<Slot | "aborted" | undefined> {
    const pattern = this.heavy(o.command);
    if (!pattern) return undefined;
    const key = `${o.session}:${o.call ?? `c${++this.n}`}:${++this.n}`;
    const base = { key, who: o.who, session: o.session, call: o.call, command: o.command.slice(0, 200), pattern };
    // The owner's own command never waits.
    if (o.who === "owner") return this.grant(base, 0);
    const r = this.room();
    const ahead = before(this.line, o.who);
    if (r.free > 0 && ahead === 0) return this.grant(base, 0);
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
    const pattern = this.heavy(o.command);
    if (!pattern) return undefined;
    return this.grant({ key: `${o.session}:now:${++this.n}`, who, session: o.session, command: o.command.slice(0, 200), pattern }, 0);
  }

  // Slots that freed go to the head of the line; the rest are told their new places.
  pump() {
    if (!this.line.length) return;
    const r = this.room();
    for (const e of admit(this.line, r.free)) {
      this.line.splice(this.line.indexOf(e), 1);
      const waited = Date.now() - e.at;
      heavyChanged.tell?.({ session_id: e.session, call_id: e.call, key: e.key, state: "started", pattern: e.pattern, waited_ms: waited });
      e.go(this.grant(e, waited));
    }
    const left = order(this.line);
    left.forEach((e, i) => {
      const line = placeLine(i, this.held.size, r.cause);
      if (line === e.told) return;
      e.told = line;
      heavyChanged.tell?.({ session_id: e.session, call_id: e.call, key: e.key, state: "waiting", line, pattern: e.pattern });
    });
  }

  // Samples run while anything waits or a slot is young.
  private tick() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const ramp = config().cost.ramp_s * 1000;
      const young = [...this.held.values()].some((h) => Date.now() - h.since < ramp + WINDOW * SAMPLE_MS);
      if (!this.line.length && !young) { clearInterval(this.timer); this.timer = undefined; return; }
      this.sample();
      this.pump();
    }, SAMPLE_MS);
    (this.timer as any).unref?.();
  }

  // The session's held calls in one line: what its step says while it waits.
  lineOf(session: string): string | undefined {
    return this.line.find((e) => e.session === session)?.told;
  }
  waits(session: string) { return this.line.some((e) => e.session === session); }

  view(now = Date.now()) {
    const r = this.room();
    const rd = this.reading();
    return {
      config: config(),
      machine: { cores: rd.cores, load1: Math.round(rd.load1 * 100) / 100, runnable: rd.runnable === undefined ? null : Math.round(rd.runnable * 10) / 10, mem_available_mb: rd.mem_available_mb },
      room: { slots: r.slots, free: r.free, limit: Math.round(r.limit * 10) / 10, busy: Math.round(r.busy * 10) / 10, cause: r.cause, why: r.why },
      held: [...this.held.values()].map((h) => ({ session_id: h.session, who: h.who, command: h.command, pattern: h.pattern, since: h.since, ms: now - h.since })),
      line: order(this.line).map((e, i) => ({ place: i + 1, session_id: e.session, who: e.who, command: e.command, pattern: e.pattern, since: e.at, ms: now - e.at })),
    };
  }

  // For a test: no slot held, no one in line.
  reset() { this.held.clear(); this.line = []; this.gone = []; this.samples = []; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}

export const pool = new Pool();
jobSlots.count = (session, command) => pool.count({ session, command });

// A job started with the slot it took: the slot goes back at its end, or at once when it does not start.
export function startHeld(o: StartOpts, slot: Slot | undefined): Job {
  try { return startJob({ ...o, slot }); } catch (e) { slot?.release(); throw e; }
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
