// The daemon notices when it was itself unresponsive. One process answers
// every page, command and turn, so code that does not yield (a read that
// walks a whole session, a large parse) stops all of them, and from outside
// nothing says so. A timer that should fire every TICK_MS measures how late
// it fired: late by seconds means nothing else ran for that long. The stall
// leaves one error row and one log line with how long it was, what was on the
// stack when a request handler was (timed here: the part of a handler that
// runs before its first await), and the requests and turns that were in
// progress.
//
// The clock is the monotonic one: a suspended machine is not a stall.
// Two seconds make a row: a page that does not answer for that long reads as
// hung, and the daemon's ordinary work stays under it with room (a large
// session read into memory takes a few hundred milliseconds, and the probes
// a first turn runs once, a second on a busy machine). Half a second makes a
// log line only, so the smaller ones leave a trail without a row each.
const G = globalThis as { __keelStall?: State };

export const STALL_MS = Number(process.env.KEEL_STALL_MS) > 0 ? Number(process.env.KEEL_STALL_MS) : 2000;
export const STALL_LOG_MS = STALL_MS / 4;
const TICK_MS = 100;
// A handler's own time that is worth naming as what the daemon was busy with.
const NOTED_MS = 50;

type Section = { label: string; ms: number };
type State = { longest: Section | null; flights: Map<object, { label: () => string; t0: number }> };
const state = (): State => (G.__keelStall ??= { longest: null, flights: new Map() });

// Runs `f` and notes how long it held the event loop: its synchronous part,
// which is all of a handler with no await and the start of one with awaits.
export function timed<T>(label: () => string, f: () => T): T {
  const t0 = performance.now();
  try {
    return f();
  } finally {
    const ms = performance.now() - t0;
    const st = state();
    if (ms >= NOTED_MS && ms > (st.longest?.ms ?? 0)) st.longest = { label: label(), ms };
  }
}

// A request from its handler's start to its answer: what was in progress when a stall began.
export function inFlight(key: object, label: () => string): () => void {
  const st = state();
  st.flights.set(key, { label, t0: performance.now() });
  return () => void st.flights.delete(key);
}

export type RunningTurn = { session_id: string; turn?: string; doing: string };
export type Stall = {
  ms: number;        // how long nothing else ran, at least
  busy_ms: number;   // the processor time the daemon used meanwhile
  during?: Section;  // the handler that held the loop, when one was timed
  in_flight: string[];
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
    ? ` while answering ${s.during.label}`
    : busy
      ? ": blocked by its own code, outside any request handler"
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
  thresholdMs?: number;
  // For a test: the processor time used so far, in milliseconds.
  cpu?: () => number;
};

export class StallMonitor {
  private last = 0;
  private cpuLast = 0;
  private timer?: ReturnType<typeof setInterval>;
  private cpu: () => number;

  constructor(private deps: StallDeps) {
    this.cpu = deps.cpu ?? (() => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; });
  }

  start() {
    this.stop();
    this.last = performance.now();
    this.cpuLast = this.cpu();
    state().longest = null;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    (this.timer as any).unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // One tick of the timer: how late it is says how long the loop was held.
  tick(): Stall | undefined {
    const now = performance.now();
    const cpu = this.cpu();
    const late = now - this.last - TICK_MS;
    const busy = cpu - this.cpuLast;
    const st = state();
    const longest = st.longest;
    const began = this.last;
    this.last = now;
    this.cpuLast = cpu;
    st.longest = null;
    const row = this.deps.thresholdMs ?? STALL_MS;
    if (late < row / 4) return undefined;
    const stall: Stall = {
      // A handler that was timed says exactly how long it held the loop.
      ms: longest && longest.ms >= late * 0.5 ? Math.max(late, longest.ms) : late,
      busy_ms: Math.min(busy, now - began),
      ...(longest && longest.ms >= late * 0.5 ? { during: longest } : {}),
      // Requests taken before the stall began and still open: they waited for it to end.
      in_flight: [...st.flights.values()].filter((f) => f.t0 <= began + TICK_MS).map((f) => f.label()),
      // Within a tick of its start: what the last good tick saw is from before it.
      turns: this.deps.turns(began + TICK_MS),
    };
    try {
      if (late >= row) this.deps.report(stall);
      else this.deps.note?.(stall);
    } catch {}
    return late >= row ? stall : undefined;
  }
}
