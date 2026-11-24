// One admission per provider account and model, in front of every model request
// (the registry's wrap passes each request through it).
//
// Sessions and their agents share an account's limits. Without a line of
// their own, a limit one of them hits is hit again by each of the others: every
// session learns it from a 429 of its own and waits it out by itself, and when
// the wait ends they all go at once. Here the account learns it once, and the
// requests that come while it is spent wait in one line instead of being sent.
//
// The limits are the model's: Anthropic, OpenAI, Gemini and Bedrock count
// requests and tokens per model (or model class), so a 429 on one model holds
// that model's line only, and the account's other models (a reader's cheaper
// one) go on. The whole account is held only when the headers name a limit of
// the plan: a subscription that refused (`anthropic-ratelimit-unified-status:
// rejected`) or a ChatGPT plan's window used up.
//
// A request is held only on the account's own word, never on a guess:
// - a 429 it answered: the wait it asked for (retry-after), else the reset of
//   a subscription that refused (its reset in epoch seconds), else the earliest
//   reset of a window its headers say is spent, else, when it names no time,
//   the backoff one retry of the session would wait (src/engine/retry.ts);
// - an answer whose headers say a window has nothing left (requests or tokens,
//   with its limit stated: Anthropic `anthropic-ratelimit-*`, OpenAI-style
//   `x-ratelimit-*`; these are one model's) holds nothing for a time: the
//   buckets refill continuously and their reset is when they are full again,
//   so waiting for it would wait too long. The model's next request goes
//   alone, and the rest of its line wait for its answer.
// A plan's percentage (the ChatGPT plan's `used-percent`) holds nothing by
// itself: the plan may still answer (credits), so its own 429 decides. A spent
// quota (a spend cap, no credit) is not a rate limit: waiting does not clear it.
//
// A hold longer than a turn waits refuses requests unsent, but not for the
// whole of a stated reset that can be days away: every `probeMs` one request
// is let through to ask the account, and its answer clears the hold.
//
// When the hold ends one request goes first, the best placed, and the rest
// wait for its answer: one more 429 then costs one request, not the whole line.
// Once it is answered the rest go in order, a little apart (no burst at the
// account). The order: the owner's own turns, then sessions a page shows, then
// agents and other turns by their depth in the tree, then the requests nothing
// waits on at once (readers, titles, summaries made ahead, side answers). A
// request that has waited `ageMs` goes with the owner's turns, in the order
// they asked: none waits behind them without end.
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

// `scope`: the model's line, or the whole account (a limit of the plan).
// `since`: when the account said it; `probed`: when a request last went through to ask it.
export type Hold = { until: number; why: string; scope: "model" | "account"; since: number; probed?: number };

// Where a request stands, from what the engine knows of it.
export function laneOf(f: { inTurn: boolean; top: boolean; ownerTurn: boolean; shown: boolean; depth: number }): Pick<Lane, "cls" | "depth"> {
  if (!f.inTurn) return { cls: LANE.background, depth: 0 };
  if (f.top && f.ownerTurn) return { cls: LANE.owner, depth: 0 };
  if (f.shown) return { cls: LANE.shown, depth: f.depth };
  return { cls: LANE.agent, depth: f.depth };
}

// The windows these limits count by are a minute long (requests and tokens per minute): a request
// that waited one whole window goes before turns that asked after it.
export const AGE_MS = 60_000;

type Placed = Pick<Lane, "cls" | "depth" | "since"> & { seq: number };

// The line's order at `now`: by who waits, then depth, then who asked first. A request that has
// waited `ageMs` ranks with the owner's turns (and among them by when it asked).
export function order(now: number, ageMs = AGE_MS) {
  const aged = (w: Placed) => now - w.since >= ageMs;
  const rank = (w: Placed) => (aged(w) ? LANE.owner : w.cls);
  const depth = (w: Placed) => (aged(w) ? 0 : w.depth);
  return (a: Placed, b: Placed) => rank(a) - rank(b) || depth(a) - depth(b) || a.since - b.since || a.seq - b.seq;
}

const secs = (ms: number) => (ms >= 90_000 ? spanLabel(Math.max(1, Math.round(ms / 60_000))) : `${Math.max(1, Math.round(ms / 1000))} s`);

// The windows these headers say are spent (nothing left, and a reset ahead). `plan`: a plan's
// percentage counts too (only with a 429 that confirms it).
function spent(h: Headers | undefined, now: number, plan: boolean) {
  if (!h) return [];
  return fromHeaders(h, now).filter((w) => w.resets_at_ms !== undefined && w.resets_at_ms > now
    && (w.limit !== undefined ? w.remaining === 0 : plan && w.used_percent !== undefined && w.used_percent >= 100));
}

// Whether an answer's headers say a window has nothing left: the model's next request goes alone.
export const nothingLeft = (h: Headers | undefined, now = Date.now()) => spent(h, now, false).length > 0;

// A subscription that refused (Anthropic's plan headers, not documented by the API: Claude Code reads
// them): until its reset, in epoch seconds. Only the top-level status says requests are refused.
function refusedPlan(h: Headers | undefined, now: number): number | undefined {
  if (h?.get("anthropic-ratelimit-unified-status") !== "rejected") return undefined;
  const at = Number(h.get("anthropic-ratelimit-unified-reset")) * 1000;
  return Number.isFinite(at) && at > now ? at : undefined;
}

// The hold a 429 of the account states. `askedMs`: the wait it asked for (retry-after,
// retry-after-ms). `strikes`: 429s in a row on the line that named no time. The scope is the model's
// unless the headers name a limit of the plan.
export function holdFrom(a: { askedMs?: number; headers?: Headers; strikes?: number }, now = Date.now()): Hold & { guessed?: true } {
  const plan = refusedPlan(a.headers, now);
  const windows = spent(a.headers, now, true);
  // A window with no stated limit is a plan's percentage (the ChatGPT plan's windows): the account's.
  const scope = plan || windows.some((w) => w.limit === undefined) ? "account" : "model";
  if (a.askedMs !== undefined && a.askedMs >= 0) return { until: now + a.askedMs, why: `the account answered 429 and asked to wait ${secs(a.askedMs)}`, scope, since: now };
  if (plan) return { until: plan, why: `the account answered 429: its plan's limit is reached until ${zonedClock(plan)}`, scope, since: now };
  if (windows.length) {
    const w = windows.reduce((x, y) => (y.resets_at_ms! < x.resets_at_ms! ? y : x));
    return { until: w.resets_at_ms!, why: `the account answered 429: its ${w.label.toLowerCase()} window ${w.limit !== undefined ? "has nothing left" : "is used up"} until ${zonedClock(w.resets_at_ms!)}`, scope, since: now };
  }
  const ms = Math.min(RETRY.capMs, RETRY.baseMs * 2 ** Math.max(0, a.strikes ?? 0));
  return { until: now + ms, why: "the account answered 429 and named no time: held for one retry's backoff", scope, since: now, guessed: true };
}

// A failure that is the account's rate limit (not a spent quota: that does not pass by waiting).
export const rateLimited = (e: unknown) => {
  const err = e as { kind?: string; status?: number } | null;
  if (!err) return false;
  if (typeof err.kind === "string") return err.kind === "rate";
  return Number(err.status ?? 0) === 429;
};

// A 429 about one request alone, not the account's state, which the line does not learn: the
// scripted provider's long waits, which play one turn's wait and answer its next prompt at once.
const requestOnly = (e: unknown) => (e as { requestOnly?: unknown } | null)?.requestOnly === true;

// `trial`: it goes first after a hold, the rest of its line after its answer. `probe`: it went through
// a hold that refuses requests, to ask the account; its answer clears that hold.
export type Ticket = { account: string; model: string; trial: boolean; probe?: Hold; headers?: Headers; done?: boolean };
type Waiter = Lane & { seq: number; go: (t: Ticket) => void; fail: (e: unknown) => void; off?: () => void; told?: string };

// One model's line on an account.
type Line = { account: string; model: string; hold?: Hold; strikes: number; queue: Waiter[]; trial?: Ticket; trialTimer?: ReturnType<typeof setTimeout>; timer?: ReturnType<typeof setTimeout>; afterHold: boolean };

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
  // Inside a hold that refuses requests, one goes through this often to ask the account: the
  // longest a turn waits for one retry (retry.ts), so a reset days away costs one request each
  // five minutes, and a limit that lifted early is learned within them.
  probeMs: number;
  // A request that waited this long goes with the owner's turns.
  ageMs: number;
  // Where a callback's failure is told (the registry's error tracker).
  report?: (e: unknown) => void;
};

const DEFAULT_TIMING: Timing = {
  now: () => Date.now(), maxWaitMs: () => RETRY_WAIT_MAX_MS, staggerMs: OUTAGE.staggerMs, spreadMs: OUTAGE.spreadMs,
  trialMs: OUTAGE.canaryMs, probeMs: RETRY_WAIT_MAX_MS, ageMs: AGE_MS,
};

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

export class Admission {
  private lines = new Map<string, Line>();
  // The holds of whole accounts (a limit of the plan), by account.
  private plans = new Map<string, Hold>();
  private seq = 0;
  private t: Timing;

  constructor(t: Partial<Timing> = {}) {
    this.t = { ...DEFAULT_TIMING, ...t };
  }

  private of(account: string, model: string): Line {
    const key = `${account}\u0000${model}`;
    let l = this.lines.get(key);
    if (!l) this.lines.set(key, (l = { account, model, strikes: 0, queue: [], afterHold: false }));
    return l;
  }

  // An engine's callback never breaks the line.
  private safe(f: (() => void) | undefined) {
    if (!f) return;
    try { f(); } catch (e) { try { this.t.report?.(e); } catch { /* the report itself failed */ } }
  }

  // A waiter is told what it waits for when that changes, not at every move of the line.
  private tell(w: Waiter, h: { until?: number; why: string }) {
    const key = `${h.until ?? ""}\u0000${h.why}`;
    if (w.told === key) return;
    w.told = key;
    if (w.held) this.safe(() => w.held!(h));
  }

  // What holds this line now: its own hold or its account's, the later one.
  private holdOf(l: Line, now = this.t.now()): Hold | undefined {
    const own = l.hold && l.hold.until > now ? l.hold : undefined;
    const plan = this.plans.get(l.account);
    const acct = plan && plan.until > now ? plan : undefined;
    if (!own || !acct) return own ?? acct;
    return acct.until >= own.until ? acct : own;
  }

  // The hold of a model's requests now, if any.
  held(account: string, model: string): Hold | undefined {
    return this.holdOf(this.of(account, model));
  }

  // Every account or model that holds or lines up requests now: for the resources view.
  state(): { account: string; model?: string; until?: number; why?: string; waiting: number; trial: boolean }[] {
    const now = this.t.now();
    const out: ReturnType<Admission["state"]> = [];
    for (const [account, h] of this.plans) if (h.until > now) out.push({ account, until: h.until, why: h.why, waiting: 0, trial: false });
    for (const l of this.lines.values()) {
      const h = l.hold && l.hold.until > now ? l.hold : undefined;
      const acct = out.find((o) => o.account === l.account && o.model === undefined);
      if (acct && !h) { acct.waiting += l.queue.length; acct.trial ||= !!l.trial; continue; }
      if (!h && !l.queue.length && !l.trial) continue;
      out.push({ account: l.account, model: l.model, ...(h ? { until: h.until, why: h.why } : {}), waiting: l.queue.length, trial: !!l.trial });
    }
    return out;
  }

  // Before a request is sent: resolves when it may go. A request with no lane goes in the agents' place.
  async admit(account: string, model: string, lane: Lane | undefined, signal?: AbortSignal): Promise<Ticket> {
    if (signal?.aborted) throw abortError();
    const l = this.of(account, model);
    const now = this.t.now();
    const hold = this.holdOf(l, now);
    if (hold && hold.until - now > this.t.maxWaitMs()) {
      // A long hold lets one request through now and then to ask the account; the rest are refused.
      if (!l.trial && now - (hold.probed ?? hold.since) >= this.t.probeMs) {
        hold.probed = now;
        return this.startTrial(l, hold);
      }
      throw this.tooLong(l, hold);
    }
    if (!hold && !l.trial && !l.queue.length) {
      this.ended(l);
      if (!l.afterHold) return { account, model, trial: false };
      l.afterHold = false;
      return this.startTrial(l);
    }
    return new Promise<Ticket>((resolve, reject) => {
      const w: Waiter = {
        cls: lane?.cls ?? LANE.agent, depth: lane?.depth ?? 0, since: lane?.since ?? now, held: lane?.held, going: lane?.going, seq: ++this.seq,
        // Resolved first: what the engine does when told cannot keep the request from going.
        go: (t) => { resolve(t); this.safe(w.off); this.safe(w.going); },
        fail: (e) => { reject(e); this.safe(w.off); },
      };
      if (signal) {
        const onAbort = () => {
          const i = l.queue.indexOf(w);
          if (i >= 0) l.queue.splice(i, 1);
          reject(abortError());
          this.pump(l);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        w.off = () => signal.removeEventListener("abort", onAbort);
      }
      l.queue.push(w);
      this.tell(w, hold ? { until: hold.until, why: hold.why } : { why: l.trial ? "a request ahead tries the account first" : "requests ahead go first" });
      this.pump(l);
    });
  }

  // Every answer's headers, a refusal's too (they come before the status is read).
  heard(t: Ticket, h: Headers) {
    t.headers = h;
  }

  // The account answered the request: what its headers say of the model's windows is kept, a request
  // that went first after a hold lets the rest go, and one that asked through a long hold clears it.
  answered(t: Ticket) {
    if (t.done) return;
    t.done = true;
    const l = this.of(t.account, t.model);
    l.strikes = 0;
    if (t.probe) this.drop(l, t.probe);
    // Nothing left in a window of the model: its next request goes alone, and the rest after its answer.
    if (nothingLeft(t.headers, this.t.now())) l.afterHold = true;
    if (t.trial) this.settle(l, t);
  }

  // The request failed. A rate limit holds the model (or the account, on a limit of the plan); any
  // other failure only ends a trial.
  failed(t: Ticket, e: unknown) {
    if (t.done) return;
    t.done = true;
    const l = this.of(t.account, t.model);
    if (rateLimited(e) && !requestOnly(e)) {
      const asked = (e as { retryAfterMs?: unknown })?.retryAfterMs;
      const { guessed, ...hold } = holdFrom({ askedMs: typeof asked === "number" ? asked : undefined, headers: t.headers, strikes: l.strikes }, this.t.now());
      if (guessed) l.strikes++;
      if (t.trial && l.trial === t) { clearTimeout(l.trialTimer); l.trial = undefined; }
      // The account's answer to a request that asked through a hold is its word now, sooner or later.
      if (t.probe) this.drop(l, t.probe, false);
      this.setHold(l, hold);
      return;
    }
    if (t.trial) this.settle(l, t);
  }

  // A hold the account's answer replaced. `pump`: its account's other lines may move now.
  private drop(l: Line, hold: Hold, pump = true) {
    if (l.hold === hold) l.hold = undefined;
    if (this.plans.get(l.account) === hold) {
      this.plans.delete(l.account);
      if (pump) this.pumpAccount(l.account);
    }
  }

  private tooLong(l: Line, hold: Hold) {
    const ms = hold.until - this.t.now();
    const what = hold.scope === "account" ? l.account : `${l.account} (${l.model})`;
    return Object.assign(new ProviderError("rate", `${what}: the account's limit holds requests until ${zonedClock(hold.until)} (${hold.why}); not sent`, 429, ms), { held: true });
  }

  private setHold(l: Line, hold: Hold) {
    const now = this.t.now();
    if (hold.scope === "account") {
      const was = this.plans.get(l.account);
      if (was && was.until > now && was.until >= hold.until) return;
      this.plans.set(l.account, hold);
      this.pumpAccount(l.account);
      return;
    }
    if (l.hold && l.hold.until > now && l.hold.until >= hold.until) return;
    l.hold = hold;
    this.pump(l);
  }

  private pumpAccount(account: string) {
    for (const l of this.lines.values()) if (l.account === account) this.pump(l);
  }

  // A hold that passed: the next request goes alone.
  private ended(l: Line) {
    const now = this.t.now();
    if (l.hold && l.hold.until <= now) { l.hold = undefined; l.afterHold = true; }
    const plan = this.plans.get(l.account);
    if (plan && plan.until <= now) {
      this.plans.delete(l.account);
      for (const x of this.lines.values()) if (x.account === l.account) x.afterHold = true;
    }
  }

  private startTrial(l: Line, probe?: Hold): Ticket {
    const t: Ticket = { account: l.account, model: l.model, trial: true, ...(probe ? { probe } : {}) };
    l.trial = t;
    clearTimeout(l.trialTimer);
    l.trialTimer = setTimeout(() => this.settle(l, t), this.t.trialMs);
    return t;
  }

  private settle(l: Line, t: Ticket) {
    if (l.trial !== t) return;
    clearTimeout(l.trialTimer);
    l.trial = undefined;
    this.pump(l);
  }

  // Lets the line move: nothing while it is held, one first after a hold, then the rest apart.
  private pump(l: Line) {
    clearTimeout(l.timer);
    l.timer = undefined;
    const now = this.t.now();
    const hold = this.holdOf(l, now);
    if (hold) {
      if (!l.queue.length) return;
      if (hold.until - now > this.t.maxWaitMs()) {
        const e = this.tooLong(l, hold);
        for (const w of l.queue.splice(0)) w.fail(e);
        return;
      }
      for (const w of l.queue) this.tell(w, { until: hold.until, why: hold.why });
      l.timer = setTimeout(() => this.pump(l), hold.until - now);
      return;
    }
    this.ended(l);
    if (l.trial || !l.queue.length) return;
    l.queue.sort(order(now, this.t.ageMs));
    const w = l.queue.shift()!;
    if (l.afterHold) {
      l.afterHold = false;
      for (const x of l.queue) this.tell(x, { why: "a request ahead tries the account first" });
      return w.go(this.startTrial(l));
    }
    w.go({ account: l.account, model: l.model, trial: false });
    if (!l.queue.length) return;
    const gap = Math.min(this.t.staggerMs, this.t.spreadMs / l.queue.length);
    l.timer = setTimeout(() => this.pump(l), gap);
  }
}
