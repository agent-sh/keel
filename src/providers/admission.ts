// One admission per provider account, in front of every model request
// (the registry's wrap passes each request through it).
//
// Sessions and their agents share an account's limits. Without a line of
// their own, a limit one of them hits is hit again by each of the others: every
// session learns it from a 429 of its own and waits it out by itself, and when
// the wait ends they all go at once. Here the account learns it once, and the
// requests that come while it is spent wait in one line instead of being sent.
//
// A request is held only on the account's own word, never on a guess:
// - a 429 it answered: the wait it asked for (retry-after), else the reset of
//   a subscription that refused (`anthropic-ratelimit-unified-status:
//   rejected`, its reset in epoch seconds), else the earliest reset of a window
//   its headers say is spent, else, when it names no time, the backoff one
//   retry of the session would wait (src/engine/retry.ts);
// - an answer whose headers say a window has nothing left (requests or tokens,
//   with its limit stated: Anthropic `anthropic-ratelimit-*`, OpenAI-style
//   `x-ratelimit-*`) holds nothing for a time: the buckets refill continuously
//   and their reset is when they are full again, so waiting for it would wait
//   too long. The next request goes alone, and the rest wait for its answer.
// A plan's percentage (the ChatGPT plan's `used-percent`) holds nothing by
// itself: the plan may still answer (credits), so its own 429 decides. A spent
// quota (a spend cap, no credit) is not a rate limit: waiting does not clear it.
//
// When the hold ends one request goes first, the best placed, and the rest
// wait for its answer: one more 429 then costs one request, not the whole line.
// Once it is answered the rest go in order, a little apart (no burst at the
// account). The order: the owner's own turns, then sessions a page shows, then
// agents and other turns by their depth in the tree, then the requests nothing
// waits on at once (readers, titles, summaries made ahead, side answers).
import { zonedClock } from "../core/clock.ts";
import { RETRY, RETRY_WAIT_MAX_MS } from "../engine/retry.ts";
import { ProviderError } from "./http.ts";
import { fromHeaders, spanLabel } from "./limits.ts";
import { OUTAGE } from "./outage.ts";

// Who waits, best first.
export const LANE = { owner: 0, shown: 1, agent: 2, background: 3 } as const;

export type Lane = {
  cls: number;
  // An agent's depth in its tree (a top-level session's turn is 0): the shallower first.
  depth: number;
  // When the request first asked: a retry keeps its place in the line.
  since: number;
  // Told when the request waits in the line (with when the account takes requests again, when it said)
  // and when it goes.
  held?: (h: { until?: number; why: string }) => void;
  going?: () => void;
};

export type Hold = { until: number; why: string };

// Where a request stands, from what the engine knows of it.
export function laneOf(f: { inTurn: boolean; top: boolean; ownerTurn: boolean; shown: boolean; depth: number }): Pick<Lane, "cls" | "depth"> {
  if (!f.inTurn) return { cls: LANE.background, depth: 0 };
  if (f.top && f.ownerTurn) return { cls: LANE.owner, depth: 0 };
  if (f.shown) return { cls: LANE.shown, depth: f.depth };
  return { cls: LANE.agent, depth: f.depth };
}

// The line's order: by who waits, then depth, then who asked first.
export const before = (a: Pick<Lane, "cls" | "depth" | "since"> & { seq: number }, b: Pick<Lane, "cls" | "depth" | "since"> & { seq: number }) =>
  a.cls - b.cls || a.depth - b.depth || a.since - b.since || a.seq - b.seq;

const secs = (ms: number) => (ms >= 90_000 ? spanLabel(Math.max(1, Math.round(ms / 60_000))) : `${Math.max(1, Math.round(ms / 1000))} s`);

// The windows these headers say are spent (nothing left, and a reset ahead). `plan`: a plan's
// percentage counts too (only with a 429 that confirms it).
function spent(h: Headers | undefined, now: number, plan: boolean) {
  if (!h) return [];
  return fromHeaders(h, now).filter((w) => w.resets_at_ms !== undefined && w.resets_at_ms > now
    && (w.limit !== undefined ? w.remaining === 0 : plan && w.used_percent !== undefined && w.used_percent >= 100));
}

// Whether an answer's headers say a window has nothing left: the next request goes alone.
export const nothingLeft = (h: Headers | undefined, now = Date.now()) => spent(h, now, false).length > 0;

// A subscription that refused (Anthropic's plan headers, not documented by the API: Claude Code reads
// them): until its reset, in epoch seconds. Only the top-level status says requests are refused.
function refusedPlan(h: Headers | undefined, now: number): number | undefined {
  if (h?.get("anthropic-ratelimit-unified-status") !== "rejected") return undefined;
  const at = Number(h.get("anthropic-ratelimit-unified-reset")) * 1000;
  return Number.isFinite(at) && at > now ? at : undefined;
}

// The hold a 429 of the account states. `askedMs`: the wait it asked for (retry-after,
// retry-after-ms). `strikes`: 429s in a row on the account that named no time.
export function holdFrom(a: { askedMs?: number; headers?: Headers; strikes?: number }, now = Date.now()): Hold {
  if (a.askedMs !== undefined && a.askedMs >= 0) return { until: now + a.askedMs, why: `the account answered 429 and asked to wait ${secs(a.askedMs)}` };
  const plan = refusedPlan(a.headers, now);
  if (plan) return { until: plan, why: `the account answered 429: its plan's limit is reached until ${zonedClock(plan)}` };
  const windows = spent(a.headers, now, true);
  if (windows.length) {
    const w = windows.reduce((x, y) => (y.resets_at_ms! < x.resets_at_ms! ? y : x));
    return { until: w.resets_at_ms!, why: `the account answered 429: its ${w.label.toLowerCase()} window ${w.limit !== undefined ? "has nothing left" : "is used up"} until ${zonedClock(w.resets_at_ms!)}` };
  }
  const ms = Math.min(RETRY.capMs, RETRY.baseMs * 2 ** Math.max(0, a.strikes ?? 0));
  return { until: now + ms, why: "the account answered 429 and named no time: held for one retry's backoff" };
}

// A failure that is the account's rate limit (not a spent quota: that does not pass by waiting).
export const rateLimited = (e: unknown) => {
  const err = e as { kind?: string; status?: number } | null;
  if (!err) return false;
  if (typeof err.kind === "string") return err.kind === "rate";
  return Number(err.status ?? 0) === 429;
};

export type Ticket = { account: string; trial: boolean; headers?: Headers; done?: boolean };
type Waiter = Lane & { seq: number; go: (t: Ticket) => void; fail: (e: unknown) => void; off?: () => void; told?: string };

// A waiter is told what it waits for when that changes, not at every move of the line.
const tell = (w: Waiter, h: { until?: number; why: string }) => {
  const key = `${h.until ?? ""}\u0000${h.why}`;
  if (w.told === key) return;
  w.told = key;
  w.held?.(h);
};
type Account = { hold?: Hold; strikes: number; queue: Waiter[]; trial?: Ticket; trialTimer?: ReturnType<typeof setTimeout>; timer?: ReturnType<typeof setTimeout>; afterHold: boolean };

export type Timing = {
  now: () => number;
  // The longest a turn waits for one retry: a hold longer than that is refused at once, as the
  // provider's own 429 asking for it would be (the turn ends with the time and goes on then).
  maxWaitMs: () => number;
  // The waiting requests go this far apart once the account answers, all within the spread
  // (the outage's numbers: no burst, and none waits long).
  staggerMs: number;
  spreadMs: number;
  // The request that goes first after a hold gets this long to be answered before the next goes.
  trialMs: number;
};

const DEFAULT_TIMING: Timing = { now: () => Date.now(), maxWaitMs: () => RETRY_WAIT_MAX_MS, staggerMs: OUTAGE.staggerMs, spreadMs: OUTAGE.spreadMs, trialMs: OUTAGE.canaryMs };

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

export class Admission {
  private accounts = new Map<string, Account>();
  private seq = 0;
  private t: Timing;

  constructor(t: Partial<Timing> = {}) {
    this.t = { ...DEFAULT_TIMING, ...t };
  }

  private of(account: string): Account {
    let a = this.accounts.get(account);
    if (!a) this.accounts.set(account, (a = { strikes: 0, queue: [], afterHold: false }));
    return a;
  }

  // The hold of an account now, if it holds requests.
  held(account: string): Hold | undefined {
    const h = this.accounts.get(account)?.hold;
    return h && h.until > this.t.now() ? h : undefined;
  }

  // Every account that holds or lines up requests now: for the resources view.
  state(): { account: string; until?: number; why?: string; waiting: number; trial: boolean }[] {
    const now = this.t.now();
    return [...this.accounts].filter(([, a]) => (a.hold && a.hold.until > now) || a.queue.length || a.trial)
      .map(([account, a]) => ({ account, ...(a.hold && a.hold.until > now ? { until: a.hold.until, why: a.hold.why } : {}), waiting: a.queue.length, trial: !!a.trial }));
  }

  // Before a request is sent: resolves when it may go. A request with no lane goes in the agents' place.
  async admit(account: string, lane: Lane | undefined, signal?: AbortSignal): Promise<Ticket> {
    if (signal?.aborted) throw abortError();
    const a = this.of(account);
    const now = this.t.now();
    const hold = a.hold && a.hold.until > now ? a.hold : undefined;
    if (hold && hold.until - now > this.t.maxWaitMs()) throw this.tooLong(account, hold);
    if (!hold && !a.trial && !a.queue.length) {
      if (a.hold) { a.hold = undefined; a.afterHold = true; }
      if (!a.afterHold) return { account, trial: false };
      a.afterHold = false;
      return this.startTrial(account, a);
    }
    return new Promise<Ticket>((resolve, reject) => {
      const w: Waiter = {
        cls: lane?.cls ?? LANE.agent, depth: lane?.depth ?? 0, since: lane?.since ?? now, held: lane?.held, going: lane?.going, seq: ++this.seq,
        go: (t) => { w.off?.(); w.going?.(); resolve(t); },
        fail: (e) => { w.off?.(); reject(e); },
      };
      if (signal) {
        const onAbort = () => {
          const i = a.queue.indexOf(w);
          if (i >= 0) a.queue.splice(i, 1);
          reject(abortError());
          this.pump(account);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        w.off = () => signal.removeEventListener("abort", onAbort);
      }
      a.queue.push(w);
      a.queue.sort(before);
      tell(w, hold ? { until: hold.until, why: hold.why } : { why: a.trial ? "a request ahead tries the account first" : "requests ahead go first" });
      this.pump(account);
    });
  }

  // Every answer's headers, a refusal's too (they come before the status is read).
  heard(t: Ticket, h: Headers) {
    t.headers = h;
  }

  // The account answered the request: what its headers say of its windows is kept, and a request
  // that went first after a hold lets the rest go.
  answered(t: Ticket) {
    if (t.done) return;
    t.done = true;
    const a = this.of(t.account);
    a.strikes = 0;
    // Nothing left in a window: the next request goes alone, and the rest after its answer.
    if (nothingLeft(t.headers, this.t.now())) a.afterHold = true;
    if (t.trial) this.settle(t.account, a, t);
  }

  // The request failed. A rate limit holds the account; any other failure only ends a trial.
  failed(t: Ticket, e: unknown) {
    if (t.done) return;
    t.done = true;
    const a = this.of(t.account);
    if (rateLimited(e)) {
      const asked = (e as { retryAfterMs?: unknown })?.retryAfterMs;
      const hold = holdFrom({ askedMs: typeof asked === "number" ? asked : undefined, headers: t.headers, strikes: a.strikes }, this.t.now());
      if (hold.why.includes("named no time")) a.strikes++;
      if (t.trial && a.trial === t) { clearTimeout(a.trialTimer); a.trial = undefined; }
      this.setHold(t.account, a, hold);
      return;
    }
    if (t.trial) this.settle(t.account, a, t);
  }

  private tooLong(account: string, hold: Hold) {
    const ms = hold.until - this.t.now();
    return Object.assign(new ProviderError("rate", `${account}: the account's limit holds requests until ${zonedClock(hold.until)} (${hold.why}); not sent`, 429, ms), { held: true });
  }

  private setHold(account: string, a: Account, hold: Hold) {
    if (a.hold && a.hold.until >= hold.until) return;
    a.hold = hold;
    this.pump(account);
  }

  private startTrial(account: string, a: Account): Ticket {
    const t: Ticket = { account, trial: true };
    a.trial = t;
    clearTimeout(a.trialTimer);
    a.trialTimer = setTimeout(() => this.settle(account, a, t), this.t.trialMs);
    return t;
  }

  private settle(account: string, a: Account, t: Ticket) {
    if (a.trial !== t) return;
    clearTimeout(a.trialTimer);
    a.trial = undefined;
    this.pump(account);
  }

  // Lets the line move: nothing while the account holds, one first after a hold, then the rest apart.
  private pump(account: string) {
    const a = this.of(account);
    clearTimeout(a.timer);
    a.timer = undefined;
    const now = this.t.now();
    if (a.hold && a.hold.until > now) {
      if (!a.queue.length) return;
      if (a.hold.until - now > this.t.maxWaitMs()) {
        const e = this.tooLong(account, a.hold);
        for (const w of a.queue.splice(0)) w.fail(e);
        return;
      }
      for (const w of a.queue) tell(w, { until: a.hold.until, why: a.hold.why });
      a.timer = setTimeout(() => this.pump(account), a.hold.until - now);
      return;
    }
    if (a.hold) { a.hold = undefined; a.afterHold = true; }
    if (a.trial || !a.queue.length) return;
    const w = a.queue.shift()!;
    if (a.afterHold) {
      a.afterHold = false;
      for (const x of a.queue) tell(x, { why: "a request ahead tries the account first" });
      return w.go(this.startTrial(account, a));
    }
    w.go({ account, trial: false });
    if (!a.queue.length) return;
    const gap = Math.min(this.t.staggerMs, this.t.spreadMs / a.queue.length);
    a.timer = setTimeout(() => this.pump(account), gap);
  }
}
