import type { Usage } from "../core/types.ts";
import type { Price } from "./types.ts";

// USD for one call. `input` excludes the cached parts (every driver reports it
// that way), so each part is priced at its own rate. A cache rate the price
// does not state falls back to the input rate (writes) or stays unknown
// (reads): an unknown cost is never shown as zero.
//
// A price with context tiers bills the whole request at the tier its prompt
// (input plus cache reads and writes) is above; a tier that states no cache
// rate follows the same rule as the base price.
export function priceOf(u: Usage, base?: Price): number | undefined {
  if (!base) return undefined;
  const prompt = u.input + u.cache_read + u.cache_write;
  const tier = base.tiers?.filter((t) => prompt > t.above).at(-1);
  const p: Price = tier ? { input: tier.input, output: tier.output, cache_read: tier.cache_read, cache_write: tier.cache_write } : base;
  let read = 0;
  if (u.cache_read) {
    // A free model's cached input is free too.
    const rate = p.cache_read ?? (p.input === 0 ? 0 : undefined);
    if (rate === undefined) return undefined;
    read = u.cache_read * rate;
  }
  // An hour-long cache write costs twice the input rate (Anthropic's rule on
  // every platform it serves); catalogs state only the 5-minute rate. OpenAI's
  // Responses writes cost 1.25x the input rate for 30 minutes and 2.5x for 12
  // hours (its prompt caching guide); the parts sum to cache_write.
  const hour = u.cache_write_1h ?? 0, m30 = u.cache_write_30m ?? 0, h12 = u.cache_write_12h ?? 0;
  const write = (u.cache_write - hour - m30 - h12) * (p.cache_write ?? p.input) + hour * 2 * p.input + m30 * (p.cache_write ?? 1.25 * p.input) + h12 * 2.5 * p.input;
  return (u.input * p.input + u.output * p.output + read + write) / 1e6;
}
