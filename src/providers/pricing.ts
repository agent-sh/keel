import type { Usage } from "../core/types.ts";
import type { Price } from "./types.ts";

// USD for one call. `input` excludes the cached parts (every driver reports it
// that way), so each part is priced at its own rate. A cache rate the price
// does not state falls back to the input rate (writes) or stays unknown
// (reads): an unknown cost is never shown as zero.
export function priceOf(u: Usage, p?: Price): number | undefined {
  if (!p) return undefined;
  let read = 0;
  if (u.cache_read) {
    // A free model's cached input is free too.
    const rate = p.cache_read ?? (p.input === 0 ? 0 : undefined);
    if (rate === undefined) return undefined;
    read = u.cache_read * rate;
  }
  const write = u.cache_write * (p.cache_write ?? p.input);
  return (u.input * p.input + u.output * p.output + read + write) / 1e6;
}
