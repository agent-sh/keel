// What switching a session's model or effort does to its prompt cache, for a
// warning before the switch. The provider caches the request prefix of the
// model (and settings) the last request ran on; a request on another model, or
// with an effort rendered into the prompt, reads the whole context again
// without that cache. Nothing is warned when the cache has expired (by the
// lifetime of the request that wrote it, see retention()), the
// context is empty (fresh or just cleared), or the switch goes back to what
// the last request already used.
import type { StoredEvent } from "../core/types.ts";
import { checkpointAt, warmReplyAt } from "./compact.ts";
import { priceOf } from "../providers/pricing.ts";
import type { ModelInfo, Wire } from "../providers/types.ts";

const MIN = 60_000;

// A gap this close to a short cache lifetime counts as past it: the request
// time (25 to 30 s seen on long contexts) and its spread take the rest.
export const PAUSE_MARGIN_MS = MIN;

// How long the request that wrote the prefix keeps it, from what that route
// documents and what its answers showed. `sure`: covered by a documented
// lifetime; up to `max`: it may still be there (a typical retention).
// - Anthropic: Keel asks for the 1-hour lifetime; an answer that reported
//   1-hour writes shows the route honours it (else the 5-minute default holds
//   for sure, the hour maybe).
// - OpenAI Responses: a model that reports cache writes takes
//   prompt_cache_options, whose default is a 30-minute minimum; older models
//   keep a prefix typically 5 to 10 minutes, up to an hour.
// - Other wires do not document it: maybe, for five minutes.
// The evidence is the write that made the prefix there now: the newest reply
// of this model after the last checkpoint that wrote to the cache (a later
// read keeps that entry alive at its own lifetime). A write before the
// checkpoint, or on another model, says nothing about this prefix.
export function retention(wire: Wire | undefined, prior: readonly StoredEvent[], model: string): { sure: number; max: number } {
  const cp = checkpointAt(prior).at;
  let wrote: { cache_write: number; cache_write_1h?: number } | undefined;
  for (let i = prior.length - 1; i > cp && !wrote; i--) {
    const e = prior[i]!;
    if (e.kind === "assistant" && e.data.model === model && e.data.usage?.cache_write > 0) wrote = e.data.usage;
  }
  if (wire === "anthropic_messages") return wrote?.cache_write_1h ? { sure: 60 * MIN, max: 60 * MIN } : { sure: 5 * MIN, max: 60 * MIN };
  if (wire === "openai_responses") return wrote ? { sure: 30 * MIN, max: 30 * MIN } : { sure: 0, max: 60 * MIN };
  return { sure: 0, max: 5 * MIN };
}

export type SwitchWarning = {
  cause: "model" | "effort";
  // false when the provider does not say whether the change reaches the prompt.
  certain: boolean;
  uncached_tokens: number;
  // At the new model's cache write rate (else its input rate); absent with no price.
  cost_usd?: number;
  // The same tokens read from the cache of the model in use now.
  cached_cost_usd?: number;
  cost_estimated: boolean;
};

// The effort a request on `info` sends for the wanted level (as the engine does).
export function effectiveEffort(info: ModelInfo | undefined, want?: string): string | undefined {
  const e = info?.efforts ?? [];
  return want && e.includes(want) ? want : e.includes("high") ? "high" : undefined;
}

export function switchWarning(o: {
  lineage: readonly StoredEvent[];
  now: number;
  from?: ModelInfo; // the model the last request ran on
  to: ModelInfo;
  toWire: Wire;
  toEffort?: string; // wanted level after the switch
  fromWire?: Wire;   // the wire of the request that wrote the prefix
}): { cached_tokens: number; warm_until?: number; warning: SwitchWarning | null } {
  const events = o.lineage;
  let li = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "compaction") break;
    if (e.kind === "assistant" && e.data.usage && e.data.stop !== "refusal") { li = i; break; }
  }
  if (li < 0) return { cached_tokens: 0, warning: null };
  const ranOn: string = events[li]!.data.model;
  // The prefix a switch would lose is the one of the model the last request
  // ran on, as its newest reply with cache activity left it. Only what the
  // provider reported reading from or writing to its cache: a prompt below its
  // caching minimum, or a route that reports nothing, has no prefix to lose,
  // and a later reply that reported none did not keep the prefix alive.
  const wi = warmReplyAt(events, ranOn);
  if (wi < 0) return { cached_tokens: 0, warning: null };
  const last = events[wi]!;
  // The request started when the event before its reply was stored.
  const started = events[wi - 1]?.ts ?? last.ts;
  const keep = retention(o.fromWire, events.slice(0, wi + 1), ranOn);
  const warmUntil = started + keep.max;
  // Past the documented lifetime the prefix may be gone: the warning says "may".
  const sure = o.now < started + keep.sure;
  const u = last.data.usage;
  const cached = u.cache_read + u.cache_write;
  if (o.now >= warmUntil) return { cached_tokens: 0, warning: null };
  let effort: string | undefined;
  for (let i = li; i >= 0; i--) if (events[i]!.kind === "turn_start") { effort = events[i]!.data.effort; break; }

  let cause: SwitchWarning["cause"] | null = null;
  let certain = true;
  if (ranOn !== o.to.id) cause = "model";
  else if (effectiveEffort(o.to, o.toEffort) !== effort) {
    cause = "effort";
    // Anthropic renders output_config.effort into the prompt: the message cache
    // goes. Other wires do not document it either way.
    certain = o.toWire === "anthropic_messages";
  }
  if (!cause) return { cached_tokens: cached, warm_until: warmUntil, warning: null };
  if (!sure) certain = false;
  // The reusable prefix is what loses its cache; what was added since is new input either way.
  const tokens = cached;
  // Priced the way the request will be: a prefix past a context tier is
  // written (or read) at that tier's rate.
  const none = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const cost = priceOf({ ...none, cache_write: tokens }, o.to.price);
  const cachedCost = o.from?.price?.cache_read !== undefined ? priceOf({ ...none, cache_read: tokens }, o.from.price) : undefined;
  return {
    cached_tokens: cached,
    warm_until: warmUntil,
    warning: {
      cause,
      certain,
      uncached_tokens: tokens,
      cost_usd: cost,
      cached_cost_usd: cachedCost,
      cost_estimated: true,
    },
  };
}
