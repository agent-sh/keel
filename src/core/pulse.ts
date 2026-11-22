// The daemon's one periodic tick.
//
// What the daemon does by the clock (its sign of life, the automation pass,
// the state sweep, a look at the store's log, a word to the collector) used
// to be a timer each, a second apart at most. Every timer that fires wakes
// the loop, and every turn of the loop that allocates brings the runtime's
// collector and its helper threads after it: an idle daemon made about two
// hundred wakeups a second for work that found nothing to do.
//
// Here each of them is a member of one tick. While the daemon works (a turn
// runs, a request is open or was a moment ago) a member runs at its own
// period. While it is idle a member runs when it says it has something due,
// and at the latest every IDLE_MAX_MS: the tick sleeps until the first of
// those times. Work that begins brings the next tick forward (the stall
// monitor drives the tick and wakes with every request, timed section and
// turn: src/admin/stall.ts), so nothing that starts with a request or a turn
// waits out an idle stretch.
//
// A member that must not wait at idle says when with `due`. One with no
// `due` has nothing scheduled while the daemon is idle and runs at the
// longest wait.

// The longest the tick sleeps: what is only looked at by the clock is at most this late while idle.
export const IDLE_MAX_MS = 10_000;
// A member runs this much before its time rather than a whole tick after it.
const EARLY_MS = 20;

// `due`: while the daemon is idle, the time (Date.now's clock) of the member's next work, or nothing when it has none scheduled.
export type Member = { name: string; every: number; run: (now: number) => void; due?: (now: number) => number | undefined };
type Joined = Member & { last: number };

// When a member runs next. Working: a period after its last run. Idle: when
// it says, never sooner than its period; and with the others at the idle
// round, which comes the longest sleep after the last one (`round`), so
// members that ran at different moments while the daemon worked do not each
// wake it on a schedule of their own.
export function nextRun(m: { every: number; last: number }, due: number | undefined, working: boolean, round = m.last, idleMax = IDLE_MAX_MS): number {
  if (working) return m.last + m.every;
  return Math.min(Math.max(round + idleMax, m.last + m.every), Math.max(due ?? Infinity, m.last + m.every));
}

// How long the tick sleeps from `now`: until the first member's next run, within [0, idleMax].
export function nextDelay(now: number, members: readonly { every: number; last: number; due?: number }[], working: boolean, round = now, idleMax = IDLE_MAX_MS): number {
  let at = working ? now + idleMax : Math.max(now, round + idleMax);
  for (const m of members) at = Math.min(at, nextRun(m, m.due, working, round, idleMax));
  return Math.max(0, Math.min(idleMax, at - now));
}

export class Pulse {
  private members: Joined[] = [];
  private own?: ReturnType<typeof setTimeout>;
  private wake?: () => void;
  // The last tick of a working daemon, or the last idle round.
  private round: number;
  constructor(private clock: () => number = Date.now, private onError: (e: unknown, name: string) => void = () => {}) {
    this.round = clock();
  }

  // Joins the tick; the function returned leaves it. A member joined under a name already there replaces it (a hot reload).
  join(name: string, run: (now: number) => void, opts: { every?: number; due?: (now: number) => number | undefined } = {}): () => void {
    this.members = this.members.filter((m) => m.name !== name);
    const m: Joined = { name, run, every: opts.every ?? 1000, due: opts.due, last: this.clock() };
    this.members.push(m);
    // Until a stall monitor drives it (a command's own daemon keeps none), the tick runs on a timer of its own.
    if (this.wake) this.kick();
    else if (!this.own) this.drive();
    return () => { this.members = this.members.filter((x) => x !== m); };
  }

  // One tick: every member whose time came runs. `working`: whether the daemon works now.
  tick(working: boolean, now = this.clock()) {
    const round = this.round;
    if (working || now + EARLY_MS >= round + IDLE_MAX_MS) this.round = now;
    for (const m of this.members) {
      // The period alone decides while working: nothing is asked of a member that is not due.
      if (now + EARLY_MS < m.last + m.every) continue;
      if (!working && now + EARLY_MS < nextRun(m, this.dueOf(m, now), false, round)) continue;
      m.last = now;
      try { m.run(now); } catch (e) { this.onError(e, m.name); }
    }
  }

  // How long until the next tick is needed.
  delay(working: boolean, now = this.clock()): number {
    return nextDelay(now, this.members.map((m) => ({ every: m.every, last: m.last, due: working ? undefined : this.dueOf(m, now) })), working, this.round);
  }

  private dueOf(m: Joined, now: number): number | undefined {
    try { return m.due?.(now); } catch (e) { this.onError(e, m.name); return now; }
  }

  // Something was scheduled while the tick sleeps (a wait, a loop's next run): the next tick comes at once and the sleep is counted again.
  kick() { this.wake?.(); }

  // The stall monitor drives the tick with its own timer and is woken through `wake`.
  drivenBy(wake: () => void) {
    clearTimeout(this.own);
    this.own = undefined;
    this.wake = wake;
  }

  // No monitor drives it: a timer of the tick's own, at its members' periods.
  private drive() {
    const arm = () => {
      this.own = setTimeout(() => { this.tick(true); arm(); }, Math.max(100, this.delay(true)));
      this.own.unref?.();
    };
    arm();
  }

  stop() {
    clearTimeout(this.own);
    this.own = undefined;
    this.wake = undefined;
  }
}

const G = globalThis as { __keelPulse?: Pulse };
// The process's one tick (a hot reload keeps it; its members join again under their names).
export const pulse = (): Pulse => (G.__keelPulse ??= new Pulse(Date.now, (e, name) => console.warn(`[daemon] the tick's ${name} failed: ${(e as Error)?.message ?? e}`)));
// What another module calls to run on the tick: `const leave = joinPulse("checkpoint", () => this.tick(), { every: 1000 })`.
export const joinPulse = (name: string, run: (now: number) => void, opts?: { every?: number; due?: (now: number) => number | undefined }) => pulse().join(name, run, opts);
