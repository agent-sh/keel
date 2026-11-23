// The cache plan of a session that waits: on a wait it set (a timer, a file,
// a pull request's checks) or on a tool step that runs long (a test suite, a
// verification), past the provider's cache lifetime. Pure: the engine reads
// the facts and runs what this decides (src/engine/turn.ts, CachePlans).
//
// Three ways to wait, each priced from the model's listed price:
// - warm: before the cache lapses, one minimal request (the history and a
//   one-line placeholder, at most one output token) reads it at the cache
//   read price, which keeps the provider's lifetime from that read. Only on a
//   route whose provider documents that a read refreshes the lifetime.
// - summary: the context's summary is prepared while the cache is warm (that
//   request reads the history at the read price); a wake after the lapse
//   starts from the summary instead of writing the whole history again.
// - lapse: nothing is sent; the wake writes the whole history again.
//
// The wait's length is what decides: a timer's due time is known; else the
// past waits of the same kind in this session give its usual length, and its
// deadline bounds it. A wait of unknown length is warmed while what the warm
// requests cost stays under one rewrite (the ski-rental rule: never more than
// twice the cheaper of the two, whatever the wait turns out to be), and is
// decided again before each one.

export type WaitShape = {
  kind: string;      // a wait's kind, or tool:<name> for a tool step
  due?: number;      // when it ends for sure (a timer)
  deadline?: number; // when it ends at the latest
  past?: number[];   // how long earlier waits of the same kind lasted in this session, ms
  since?: number;    // when the wait began (its record's creation), kept across restarts
};

export type Costs = { ping: number; lapse: number; summary?: number }; // dollars

export type PlanIn = {
  now: number;
  started: number;   // when the wait began
  touched: number;   // when the last request that read or wrote this context's cache started
  life: number;      // how long the provider keeps the prefix for sure, from that request
  margin: number;    // what a request needs of the lifetime before it ends (src/engine/cachewarn.ts)
  warmable: boolean; // a read refreshes the lifetime on this route
  wait: WaitShape;
  costs: Costs;
  spent: number;     // dollars the warm requests of this wait cost so far
};

export type Choice = "none" | "warm" | "summary" | "lapse";
export type Expect = { ms: number; from: "timer" | "past" | "deadline" };
export type Plan = {
  choice: Choice;
  at: number;         // when to act (the next warm request, or the summary), or when the cache lapses
  expect?: Expect;    // the wait's expected length from its start
  pings?: number;     // warm requests a known wait needs from now on
  costs: { warm?: number; summary?: number; lapse: number };
  why: string;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : undefined;
};

// The wait's expected end: the timer's due time, else the usual length of its
// kind here (at least what it already lasted), within its deadline.
export function expectedEnd(w: WaitShape, started: number, now: number): { end: number; sure: boolean; from: Expect["from"] } | undefined {
  if (w.due) return { end: w.due, sure: true, from: "timer" };
  const usual = w.past?.length ? median(w.past.filter((x) => x >= 0)) : undefined;
  if (usual !== undefined) {
    const end = Math.max(started + usual, now);
    return { end: w.deadline ? Math.min(end, w.deadline) : end, sure: false, from: "past" };
  }
  return undefined;
}

// The warm requests that keep the cache from `from` to `end`, one each
// `step` (the lifetime less the margin) after the last.
export const pingsTo = (from: number, end: number, step: number) => (end <= from ? 0 : Math.ceil((end - from) / step));

// A request is sent before the cache lapses with a margin to spare (a long
// context's request takes up to half a minute, and timers run late): the plan
// acts half a margin before the last moment it may (`at`), and never warms or
// summarizes past that moment (the cache may be gone: a "read" would write it).
export const stepOf = (life: number, margin: number) => Math.max(1, life - 1.5 * margin);

export function decide(p: PlanIn): Plan {
  const step = stepOf(p.life, p.margin);
  const at = p.touched + step;
  const lapse = p.costs.lapse;
  const exp = expectedEnd(p.wait, p.started, p.now);
  const expect = exp ? { ms: Math.max(0, exp.end - p.started), from: exp.from } : undefined;
  const base = { at, ...(expect ? { expect } : {}) };
  // It ends while the cache still holds: nothing to do.
  if (exp?.sure && exp.end <= p.touched + p.life - p.margin) return { ...base, choice: "none", costs: { lapse }, why: "the wait ends while the cache holds" };
  // Past the last moment a request still finds the cache: nothing is sent (a daemon that was down, a timer that ran late).
  if (p.now >= p.touched + p.life - p.margin) return { ...base, choice: "lapse", costs: { lapse }, why: "the cache lapsed before anything could be sent" };
  const summary = p.costs.summary;
  // The warm requests of one wait never cost more in all than one rewrite (`spent` counts them across restarts).
  const within = (more: number) => p.warmable && p.spent + more <= lapse;
  // A known length (or a deadline that bounds it): the cheapest of the three.
  const bound = exp?.sure ? exp.end : p.wait.deadline;
  if (bound !== undefined && (exp?.sure || !exp)) {
    const pings = pingsTo(at, bound, step);
    const warm = within(pings * p.costs.ping) ? pings * p.costs.ping : undefined;
    const best = cheapest({ warm, summary, lapse });
    const sure = exp?.sure ? `the wait ends in ${mins(bound - p.now)}` : `the wait ends within ${mins(bound - p.now)} (its deadline)`;
    // A deadline is only a bound: it decides when warm is cheapest even if the wait lasts to it; else the length is not known.
    if (exp?.sure || best === "warm") return { ...base, choice: best, pings, costs: { ...(warm !== undefined ? { warm } : {}), ...(summary !== undefined ? { summary } : {}), lapse }, why: `${sure}: ${words(best)}` };
  }
  if (exp && exp.end > p.now) {
    // The usual length: the cheapest for that. Once the wait outlasts it, the rule for an unknown length holds.
    const pings = pingsTo(at, exp.end, step);
    const warm = within(pings * p.costs.ping) ? pings * p.costs.ping : undefined;
    const best = cheapest({ warm, summary, lapse });
    return { ...base, choice: best, pings, costs: { ...(warm !== undefined ? { warm } : {}), ...(summary !== undefined ? { summary } : {}), lapse }, why: `waits of this kind here last about ${mins(exp.end - p.started)}: ${words(best)}` };
  }
  // Unknown length: warm while the warm requests cost less than one rewrite.
  if (within(p.costs.ping) && (summary === undefined || p.spent + p.costs.ping <= summary)) {
    return { ...base, choice: "warm", costs: { warm: p.spent + p.costs.ping, ...(summary !== undefined ? { summary } : {}), lapse }, why: "its length is not known: kept warm while that costs less than writing the context again" };
  }
  const best = summary !== undefined && summary < lapse ? "summary" : "lapse";
  return { ...base, choice: best, costs: { ...(summary !== undefined ? { summary } : {}), lapse }, why: p.spent > 0 ? `kept warm as long as that cost less than a rewrite: ${words(best)}` : `its length is not known: ${words(best)}` };
}

function cheapest(c: { warm?: number; summary?: number; lapse: number }): Choice {
  let best: Choice = "lapse", v = c.lapse;
  if (c.summary !== undefined && c.summary < v) { best = "summary"; v = c.summary; }
  if (c.warm !== undefined && c.warm <= v) best = "warm";
  return best;
}

const words = (c: Choice) => c === "warm" ? "keeping the cache warm is cheapest" : c === "summary" ? "a summary prepared while the cache is warm is cheapest" : c === "lapse" ? "letting the cache lapse is cheapest" : "nothing to do";
export const mins = (ms: number) => (ms >= 90 * 60_000 ? `${Math.round(ms / 3_600_000 * 10) / 10} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(0, Math.round(ms / 1000))} s`);
