// What switching a session's model or effort does to its prompt cache, for a
// warning before the switch. The provider caches the request prefix of the
// model (and settings) the last request ran on; a request on another model, or
// with an effort rendered into the prompt, reads the whole context again
// without that cache. Nothing is warned when the cache has expired (by the
// lifetime of the request that wrote it, see retention()), the
// context is empty (fresh or just cleared), or the switch goes back to what
// the last request already used.
import type { StoredEvent } from "../core/types.ts";
import type { ModelInfo, Wire } from "../providers/types.ts";

// Anthropic's default cache lifetime, measured from the start of the request;
// OpenAI keeps a prefix for 5 to 10 minutes of inactivity. The shorter one.
export const CACHE_TTL_MS = 5 * 60_000;

const MIN = 60_000;

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
export function retention(wire: Wire | undefined, prior: StoredEvent[], model: string): { sure: number; max: number } {
  const own = prior.filter((e) => e.kind === "assistant" && e.data.model === model && e.data.usage);
  if (wire === "anthropic_messages") return own.some((e) => e.data.usage.cache_write_1h) ? { sure: 60 * MIN, max: 60 * MIN } : { sure: 5 * MIN, max: 60 * MIN };
  if (wire === "openai_responses") return own.some((e) => e.data.usage.cache_write > 0) ? { sure: 30 * MIN, max: 30 * MIN } : { sure: 0, max: 60 * MIN };
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
  lineage: StoredEvent[];
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
  const last = events[li]!;
  // The request started when the event before its reply was stored.
  const started = events[li - 1]?.ts ?? last.ts;
  const keep = retention(o.fromWire, events.slice(0, li + 1), last.data.model);
  const warmUntil = started + keep.max;
  // Past the documented lifetime the prefix may be gone: the warning says "may".
  const sure = o.now < started + keep.sure;
  const u = last.data.usage;
  // Only what the provider reported reading from or writing to its cache: a
  // prompt below its caching minimum, or a route that reports nothing, has no
  // prefix to lose.
  const cached = u.cache_read + u.cache_write;
  if (o.now >= warmUntil || !cached) return { cached_tokens: 0, warning: null };
  let effort: string | undefined;
  for (let i = li; i >= 0; i--) if (events[i]!.kind === "turn_start") { effort = events[i]!.data.effort; break; }

  const ranOn: string = last.data.model;
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
  const rate = o.to.price ? o.to.price.cache_write ?? o.to.price.input : undefined;
  const readRate = o.from?.price?.cache_read;
  return {
    cached_tokens: cached,
    warm_until: warmUntil,
    warning: {
      cause,
      certain,
      uncached_tokens: tokens,
      cost_usd: rate !== undefined ? (tokens * rate) / 1e6 : undefined,
      cached_cost_usd: readRate !== undefined ? (tokens * readRate) / 1e6 : undefined,
      cost_estimated: true,
    },
  };
}
