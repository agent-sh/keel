// What switching a session's model or effort does to its prompt cache, for a
// warning before the switch. The provider caches the request prefix of the
// model (and settings) the last request ran on; a request on another model, or
// with an effort rendered into the prompt, reads the whole context again
// without that cache. Nothing is warned when the cache has expired, the
// context is empty (fresh or just cleared), or the switch goes back to what
// the last request already used.
import type { StoredEvent } from "../core/types.ts";
import type { ModelInfo, Wire } from "../providers/types.ts";
import { contextTokens } from "./compact.ts";

// Anthropic's default cache lifetime, measured from the start of the request;
// OpenAI keeps a prefix for 5 to 10 minutes of inactivity. The shorter one.
export const CACHE_TTL_MS = 5 * 60_000;

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
  const warmUntil = started + CACHE_TTL_MS;
  const u = last.data.usage;
  const cached = u.input + u.cache_read + u.cache_write;
  if (o.now >= warmUntil) return { cached_tokens: 0, warning: null };
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
  const tokens = contextTokens(events).used;
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
