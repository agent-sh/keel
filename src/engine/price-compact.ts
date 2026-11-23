// Compaction by price: an agent's context is summarized when the steps it is
// expected to take still would read more in the context above what a summary
// keeps than the summary and the rewrite of what it keeps cost. The window rule
// (COMPACT_SHARE of the model's window, src/engine/compact.ts) stays the
// ceiling: this only compacts earlier. Pure: the engine reads the facts
// (src/engine/turn.ts, Engine.priced) and carries out what this says.
//
// Each step of an agent reads its whole context from the cache. A context of
// C tokens read for R more steps costs R x C x the cache read price; after a
// summary it is K tokens (the system prompt and tools, which are never
// compacted, the summary, the words kept verbatim and the steps since the
// summary was asked for), so the summary saves R x (C - K) x that price. It
// costs its own request (C read from the cache, its prompt written, the
// summary written as output) and one write of the K - prefix tokens the next
// step finds outside the cache. The summary is written in the background, on
// the session's own prefix, while the agent's steps go on, and is put in place
// at the first step after it is ready (a prepared summary, as the window rule
// prepares one): the agent's newest steps stay as they were, so no tool result
// it has not answered yet is ever summarized away, and no step waits for it.
//
// R comes from the agent's own history and comparable agents in the ledger:
// how many more steps agents of the same kind on the same model took once they
// had taken as many as this one (residual()). Only R past the steps the
// summary takes to be written counts, and the rewrite is paid only when the
// agent is still working by then.
import type { Price } from "../providers/types.ts";
import { priceOf } from "../providers/pricing.ts";

// A finished agent in the ledger: its kind (the agent definition's type), its
// model and how many model steps it took in all.
export type AgentLife = { type: string; model: string; steps: number };

// The steps ahead of an agent that has taken `done`: `after` is the expected
// number of steps it takes once the summary is ready (`delay` steps from now),
// none when it ends before; `survive` the chance it still works by then; `n`
// the comparable agents it is read from and `from` which ones they are.
export type Residual = { after: number; survive: number; n: number; from: "kind" | "model" | "all" | "own" };

// The fewest comparable agents a forecast is read from (the agents of the
// group that took more than `done` steps). Measured on the ledger's agents
// held out by time: with fewer, the mean of a group's long-tailed step counts
// missed by more than the next wider group did (see the FIND-M52 replay).
export const MIN_COMPARABLE = 20;

// With no comparable agents (a new daemon, a kind never seen), the agent's
// own history alone: an agent that has taken `done` steps is expected to take
// about OWN_RATIO x `done` more. Step counts of agents are long-tailed (a few
// take thousands); for a log-uniform lifetime the median of what is left is
// what was done, and the held-out agents fit this ratio best (the replay).
export const OWN_RATIO = 1;

export function residual(done: number, delay: number, kind: { type?: string; model: string }, lives: readonly AgentLife[]): Residual {
  const groups: [Residual["from"], (a: AgentLife) => boolean][] = [
    ["kind", (a) => kind.type !== undefined && a.type === kind.type && a.model === kind.model],
    ["model", (a) => a.model === kind.model],
    ["all", () => true],
  ];
  for (const [from, take] of groups) {
    let n = 0, sum = 0, live = 0;
    for (const a of lives) {
      if (a.steps <= done || !take(a)) continue;
      n++;
      const left = a.steps - done - delay;
      if (left > 0) { sum += left; live++; }
    }
    if (n >= MIN_COMPARABLE) return { after: sum / n, survive: live / n, n, from };
  }
  // A lifetime with a Pareto tail of index 1: P(T > done + delay | T > done) = done / (done + delay).
  const ahead = OWN_RATIO * Math.max(1, done);
  const survive = done > 0 ? done / (done + delay) : 0;
  return { after: Math.max(0, ahead - delay) * (done > 0 ? 1 : 0), survive, n: 0, from: "own" };
}

export type PriceAsk = {
  used: number;       // tokens the next request carries (C)
  prefix: number;     // tokens of the system prompt and tools: read from the cache either way
  keep: number;       // tokens a request carries once the summary is in place (K, the prefix included)
  growth: number;     // tokens a step adds
  summaryIn: number;  // tokens the summary request adds to the context (its prompt), written
  summaryOut: number; // tokens the summary is expected to be
  ahead: Residual;
  price?: Price;
  long?: boolean;     // a write asks for the long cache lifetime (priced at its own rate)
};

// `save`: what the steps ahead read less, in dollars; `cost`: the summary and
// the rewrite. `compact` when the first is larger and the gap has reached the
// cheapest one to compact at.
// `gap`: the tokens a summary takes off; `best_gap`: the gap that is cheapest to compact at over many steps.
export type PriceVerdict = { compact: boolean; save: number; cost: number; steps: number; gap?: number; best_gap?: number };

// The most steps ahead priced one by one (a tiered price bills each step at
// the tier of its own size); past it the rest are priced as the last one.
const PRICED_STEPS = 2_000;

export function priceCompaction(a: PriceAsk): PriceVerdict | undefined {
  if (!a.price || a.price.cache_read === undefined) return undefined;
  const read = (tokens: number, write = 0) => priceOf({ input: 0, output: 0, cache_read: Math.max(0, Math.round(tokens)), cache_write: Math.max(0, Math.round(write)), ...(a.long && write ? { cache_write_1h: Math.max(0, Math.round(write)) } : {}) }, a.price);
  const steps = a.ahead.after;
  if (!(steps > 0) || a.keep >= a.used) return { compact: false, save: 0, cost: 0, steps: Math.max(0, steps) };
  // What the steps ahead read in each case; each writes the same growth and is left out.
  let save = 0;
  const whole = Math.floor(Math.min(steps, PRICED_STEPS));
  for (let i = 0; i < whole; i++) save += read(a.used + i * a.growth)! - read(a.keep + i * a.growth)!;
  const rest = steps - whole;
  if (rest > 0) save += rest * (read(a.used + whole * a.growth)! - read(a.keep + whole * a.growth)!);
  // The summary's request reads the context and writes its prompt; its output is the summary.
  const summary = priceOf({ input: 0, output: Math.round(a.summaryOut), cache_read: Math.round(a.used), cache_write: Math.round(a.summaryIn), ...(a.long ? { cache_write_1h: Math.round(a.summaryIn) } : {}) }, a.price);
  // The first step after it writes what it keeps outside the prefix instead of reading it.
  const body = Math.max(0, a.keep - a.prefix);
  const rewrite = read(a.prefix, body)! - read(a.prefix + body)!;
  if (summary === undefined) return undefined;
  const cost = summary + a.ahead.survive * rewrite;
  // Worth it now, and not better a little later: a context that keeps growing is
  // compacted again and again, and each summary is paid for. Over many steps the
  // cheapest gap between the context and what a summary keeps is the one where
  // what a summary costs, spread over the steps until the next one, equals what
  // the gap costs to read in them: sqrt(2 x cost x growth / read price). A
  // smaller gap pays now but wastes summaries; a context that does not grow has
  // none to wait for.
  const perToken = (read(a.used)! - read(a.used - 1)!);
  const gap = a.used - a.keep;
  const best = perToken > 0 ? Math.sqrt((2 * cost * Math.max(0, a.growth)) / perToken) : 0;
  return { compact: save > cost && gap >= best, save, cost, steps, gap: Math.round(gap), best_gap: Math.round(best) };
}
