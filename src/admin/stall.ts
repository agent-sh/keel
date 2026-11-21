// The daemon notices when it was itself unresponsive. One process answers
// every page, command and turn, so code that does not yield (a read that
// walks a whole session, a large parse) stops all of them, and from outside
// nothing says so. One timer measures how late it fires: late by seconds
// means nothing else ran for that long. The stall leaves one error row and
// one log line with how long it was, what held the loop when that was timed
// here (the part of a request handler that runs before its first await, the
// start's recovery), and the requests and turns that were in progress.
//
// The clock is the monotonic one: a suspended machine is not a stall.
// Two seconds make a row: a page that does not answer for that long reads as
// hung, and the daemon's ordinary work stays under it with room (a large
// session read into memory takes a few hundred milliseconds, and the probes
// a first turn runs once, a second on a busy machine). Half a second makes a
// log line only, so the smaller ones leave a trail without a row each.
//
// The timer fires ten times a second while the daemon works (a turn runs, a
// request is open or was a moment ago) and once a second while it is idle,
// so an idle daemon wakes for it once a second. Idle, a stall outside
// anything timed is measured up to a second short.
const G = globalThis as { __keelStall?: State; __keelStallMonitor?: StallMonitor };

export const STALL_MS = Number(process.env.KEEL_STALL_MS) > 0 ? Number(process.env.KEEL_STALL_MS) : 2000;
export const STALL_LOG_MS = STALL_MS / 4;
const TICK_MS = 100;
const IDLE_TICK_MS = 1000;
// After the last request or frame, the daemon counts as working this long.
const WORKING_MS = 5000;
// A section's own time that is worth naming as what the daemon was busy with.
const NOTED_MS = 50;
// A request open longer than this when a stall begins is a stream or a long
// poll, not a request the stall kept waiting (the server's own mark of a slow handler).
const WAITING_MS = 8000;

// `label`: what the daemon was doing, as the words after "while": "answering GET /api/daemon".
type Section = { label: string; ms: number };
// `work`: the daemon's own long passes (a start's read of its sessions), by what they are: in progress (false),
// or over since the last tick (true: a pass that ends as the loop comes free is still what the tick was late for).
type State = { longest: Section | null; flights: Map<object, { label: () => string; t0: number }>; work: Map<string, boolean>; touched: number };
const state = (): State => (G.__keelStall ??= { longest: null, flights: new Map(), work: new Map(), touched: 0 });
// The processor time the process has used, in milliseconds (a test sets its own).
let cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };

// Runs `f` and notes how long it held the event loop: its synchronous part,
// which is all of a handler with no await and the start of one with awaits.
// It is named only when the process was busy for it: a machine that stopped
// or starved the daemon inside a handler did not make that handler slow.
export function timed<T>(label: () => string, f: () => T): T {
  const t0 = performance.now();
  const c0 = cpuMs();
  try {
    return f();
  } finally {
    const now = performance.now();
    const ms = now - t0;
    const st = state();
    st.touched = now;
    if (ms >= NOTED_MS && ms > (st.longest?.ms ?? 0) && cpuMs() - c0 >= ms * 0.5) st.longest = { label: label(), ms };
  }
}

// A request from its handler's start to its answer: what was in progress when a stall began.
export function inFlight(key: object, label: () => string): () => void {
  const st = state();
  st.flights.set(key, { label, t0: (st.touched = performance.now()) });
  return () => void st.flights.delete(key);
}

// A pass of the daemon's own that goes on over several awaits (so no one
// section of it can be timed): while it is in progress a stall says so.
export function during<T>(label: string, work: Promise<T>): Promise<T> {
  const st = state();
  st.work.set(label, false);
  return work.finally(() => void st.work.set(label, true));
}

export type RunningTurn = { session_id: string; turn?: string; doing: string };
export type Stall = {
  ms: number;        // how long nothing else ran, at least
  busy_ms: number;   // the processor time the daemon used meanwhile
  during?: Section;  // what held the loop, when it was timed
  in_flight: string[]; // requests taken shortly before it and still open: they waited for it to end
  work?: string[];     // the daemon's own passes in progress then (see during)
  turns: RunningTurn[];
};

const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
// The session a request path names, so the row is filed under it.
const sessionIn = (label: string) => /\/api\/sessions\/([0-9a-f-]{36})(?:\/|$)/.exec(label)?.[1];

// What the error row and the log line say. Ids and counts only: no request
// body and no prompt is part of it.
export function describeStall(s: Stall): { message: string; context: Record<string, unknown> } {
  const busy = s.busy_ms >= s.ms * 0.5;
  // The row's title is cut short where it is listed: how long and what come first.
  const what = s.during
    ? ` while ${s.during.label}`
    : busy
      ? `: blocked by its own code, ${s.work?.length ? `with ${s.work.join(" and ")} in progress` : "outside anything it times"}`
      : ": its process was not running (a blocking call, or a stopped or starved machine)";
  const also = [
    s.turns.length ? `${s.turns.length} turn${s.turns.length > 1 ? "s were" : " was"} running` : "",
    s.in_flight.length ? `${s.in_flight.length} request${s.in_flight.length > 1 ? "s" : ""} waited` : "",
  ].filter(Boolean).join(", ");
  return {
    message: `Daemon unresponsive for ${secs(s.ms)}${what}${also ? ` (${also})` : ""}`,
    context: {
      kind: "stall", ms: Math.round(s.ms), busy_ms: Math.round(s.busy_ms),
      ...(s.during ? { during: s.during.label, during_ms: Math.round(s.during.ms), ...(sessionIn(s.during.label) ? { session: sessionIn(s.during.label) } : {}) } : {}),
      ...(s.in_flight.length ? { in_flight: s.in_flight.slice(0, 8) } : {}),
      ...(s.work?.length ? { work: s.work } : {}),
      ...(s.turns.length ? { turns: s.turns.slice(0, 8) } : {}),
    },
  };
}

// The turns that run, and what each is at, kept from the daemon's own frames:
// when a stall is found the loop has moved on (the turn that held it may be a
// step further, or over), so the answer is what held when the stall began.
type Doing = { doing: string; at: number };
type Watched = { turn: string; since: number; now: Doing; was?: Doing; ended?: number };
export class TurnWatch {
  private turns = new Map<string, Watched>();

  // Every bus frame passes here: only a turn's start, its end and a status change are looked at.
  frame(f: { t: string; session_id?: string; status?: { kind: string; names?: string[] }; event?: { kind: string; id: string; session_id: string } }) {
    const at = performance.now();
    if (f.t === "event" && f.event) {
      if (f.event.kind === "turn_start") this.turns.set(f.event.session_id, { turn: f.event.id, since: at, now: { doing: "idle", at } });
      else if (f.event.kind === "turn_end") { const w = this.turns.get(f.event.session_id); if (w) w.ended = at; }
    } else if (f.t === "status" && f.session_id && f.status) {
      const w = this.turns.get(f.session_id);
      if (!w || w.ended !== undefined) return;
      w.was = w.now;
      w.now = { doing: f.status.kind === "tool" ? `tool ${(f.status.names ?? []).slice(0, 3).join(", ")}` : f.status.kind, at };
    }
  }

  // Whether a turn runs now.
  running(): boolean {
    for (const w of this.turns.values()) if (w.ended === undefined) return true;
    return false;
  }

  // The turns that ran at `began`, each with what it was at then. Turns over before it are forgotten.
  at(began: number): RunningTurn[] {
    const out: RunningTurn[] = [];
    for (const [session_id, w] of this.turns) {
      if (w.ended !== undefined && w.ended < began) { this.turns.delete(session_id); continue; }
      if (w.since > began) continue;
      out.push({ session_id, turn: w.turn, doing: (w.now.at <= began || !w.was ? w.now : w.was).doing });
    }
    return out;
  }
}

export type StallDeps = {
  // A stall of STALL_MS or more: the error row. A shorter one, from STALL_LOG_MS: the log line only.
  report(s: Stall): void;
  note?(s: Stall): void;
  // The turns that ran when the stall began (`began`: on the monotonic clock).
  turns(began: number): RunningTurn[];
  // Whether a turn runs now: the timer keeps its short period while one does.
  working?(): boolean;
  // Every tick, late or not (the daemon's sign of life rides on it).
  tick?(): void;
  thresholdMs?: number;
  // For a test: the processor time used so far, in milliseconds.
  cpu?: () => number;
};

export class StallMonitor {
  private last = 0;
  private due = 0;
  private cpuLast = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private deps: StallDeps) {
    if (deps.cpu) cpuMs = deps.cpu;
  }

  // From now on: what came before (the start-up, a reload) is not a stall of a daemon that was answering.
  start() {
    this.stop();
    this.last = performance.now();
    this.cpuLast = cpuMs();
    state().longest = null;
    this.arm();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  // The time to the next tick: short while the daemon works, long while it is idle.
  period(): number {
    const st = state();
    return st.flights.size || performance.now() - st.touched < WORKING_MS || this.deps.working?.() ? TICK_MS : IDLE_TICK_MS;
  }

  private arm(timer = true) {
    const ms = this.period();
    this.due = this.last + ms;
    if (!timer) return;
    this.timer = setTimeout(() => { this.tick(); this.arm(); }, ms);
    (this.timer as any).unref?.();
  }

  // One tick of the timer: how late it is says how long the loop was held.
  // A test calls it by hand, with the clock it moves.
  tick(): Stall | undefined {
    const now = performance.now();
    const cpu = cpuMs();
    if (!this.due) this.due = this.last + this.period();
    const late = now - this.due;
    const busy = cpu - this.cpuLast;
    const st = state();
    const longest = st.longest;
    const began = this.last;
    this.last = now;
    this.cpuLast = cpu;
    st.longest = null;
    const work = [...st.work.keys()];
    for (const [label, over] of st.work) if (over) st.work.delete(label);
    if (!this.timer) this.arm(false);
    try { this.deps.tick?.(); } catch {}
    const row = this.deps.thresholdMs ?? STALL_MS;
    // A section that was timed says exactly how long it held the loop, also when the tick was a long one.
    const during = longest && longest.ms >= late * 0.5 ? longest : undefined;
    const held = during ? Math.max(late, during.ms) : late;
    if (held < row / 4) return undefined;
    const stall: Stall = {
      ms: held,
      busy_ms: Math.min(busy, now - began),
      ...(during ? { during } : {}),
      // Requests taken shortly before the stall began and still open: they waited for it to end.
      // One open for long before it (a stream, a long poll) did not.
      in_flight: [...st.flights.values()].filter((f) => f.t0 <= began + TICK_MS && began - f.t0 < WAITING_MS).map((f) => f.label()),
      ...(work.length ? { work } : {}),
      // Within a tick of its start: what the last good tick saw is from before it.
      turns: this.deps.turns(began + TICK_MS),
    };
    try {
      if (held >= row) this.deps.report(stall);
      else this.deps.note?.(stall);
    } catch {}
    return held >= row ? stall : undefined;
  }
}

// The daemon's one monitor: made with the admin routes, started once the server listens.
export function watchWith(m: StallMonitor) {
  G.__keelStallMonitor?.stop();
  G.__keelStallMonitor = m;
}
export const beginWatch = () => G.__keelStallMonitor?.start();
