// What a model switch keeps and what it costs, for the server (the switch
// and its question) and the page (the model picker shows on each row the
// effort a pick of it runs at and what it re-reads). Pure: the page imports it.
import { priceOf } from "../providers/pricing.ts";
import type { Price } from "../providers/types.ts";

// Effort levels from least to most: a level the new model does not list goes
// to the nearest one it does (xhigh on a model that stops at high runs high).
const LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export function nearestEffort(want: string, offered: readonly string[]): string | undefined {
  if (offered.includes(want)) return want;
  const w = LADDER.indexOf(want);
  if (w < 0) return undefined;
  let best: string | undefined;
  let gap = Infinity;
  for (const e of offered) {
    const i = LADDER.indexOf(e);
    // On a tie the lower level wins: the switch never makes a request dearer than asked.
    if (i >= 0 && (Math.abs(i - w) < gap || (Math.abs(i - w) === gap && i < w))) { best = e; gap = Math.abs(i - w); }
  }
  return best;
}

// The effort a model runs at when the session's wanted level moves to it:
// the nearest level it lists, else its default (high when it lists high, as
// the engine sends), else its first. Undefined: the model takes no effort.
export function carriedEffort(want: string | undefined, offered: readonly string[]): string | undefined {
  if (!offered.length) return undefined;
  return (want ? nearestEffort(want, offered) : undefined) ?? (offered.includes("high") ? "high" : offered[0]);
}

// The next level in the model's own list, one step down or up, held at the ends.
export function stepEffort(cur: string | undefined, offered: readonly string[], by: -1 | 1): string | undefined {
  if (!offered.length) return undefined;
  const i = cur ? offered.indexOf(cur) : -1;
  if (i < 0) return offered.includes("high") ? "high" : offered[0];
  return offered[Math.max(0, Math.min(offered.length - 1, i + by))];
}

// What a switch costs past staying: the next request reads the cached prefix
// again without the cache, at the new model's cache write rate (its input
// rate when it states none: priceOf), against reading it from the cache of
// the model the conversation ran on at that model's read rate. `extra` is
// the difference; with no read rate known it is the whole re-read (the most
// the switch can add). Undefined when the new model has no price.
export function switchCost(tokens: number, from: Price | undefined, to: Price | undefined): { cost?: number; cached?: number; extra?: number } {
  const none = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const cost = tokens > 0 ? priceOf({ ...none, cache_write: tokens }, to) : 0;
  const cached = tokens > 0 ? (from?.cache_read !== undefined ? priceOf({ ...none, cache_read: tokens }, from) : undefined) : 0;
  return { cost, cached, extra: cost === undefined ? undefined : Math.max(0, cost - (cached ?? 0)) };
}

// The amount a switch must add before the picker asks, in USD, unless the
// owner set another (Settings, Providers; the model_switch.ask_usd setting).
// What is worth a question is the owner's call; the default is one cent, the
// smallest amount a provider's bill shows: a switch that adds less changes no
// line of a bill, and the cost is already on the picker's row before the
// press. 0 asks before every switch that loses a warm cache.
export const ASK_USD_DEFAULT = 0.01;

// Whether a switch asks first, and why. Asked:
// - "context": the conversation is past where the new model compacts, so its
//   next request summarizes it first (what the model sees changes, and the
//   summary is a request of its own). Asked at any cost.
// - "unpriced": the cache is lost and the new model has no price: the cost
//   cannot be shown to be small.
// - "cost": the re-read adds at least `askUsd` past staying on the cache.
// Not asked: nothing cached is lost, or it adds less than `askUsd`.
export function asksFirst(o: { lost: { cost_usd?: number; cached_cost_usd?: number } | null; over: boolean; askUsd: number }): { ask: boolean; why?: "context" | "unpriced" | "cost"; extra_usd?: number } {
  if (o.over) return { ask: true, why: "context", ...(o.lost?.cost_usd !== undefined ? { extra_usd: extra(o.lost) } : {}) };
  if (!o.lost) return { ask: false };
  if (o.lost.cost_usd === undefined) return { ask: true, why: "unpriced" };
  const x = extra(o.lost);
  return x >= o.askUsd ? { ask: true, why: "cost", extra_usd: x } : { ask: false, extra_usd: x };
}
const extra = (l: { cost_usd?: number; cached_cost_usd?: number }) => Math.max(0, (l.cost_usd ?? 0) - (l.cached_cost_usd ?? 0));
