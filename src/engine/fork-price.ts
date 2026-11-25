// What a step of a forked agent costs, told in the spawn's result. A fork starts from its parent's whole
// context and reads all of it from the cache at every step; a fresh agent starts from the system prompt, the
// tools and its task. The parent chooses between them knowing the difference. Pure: the spawn reads the
// facts (src/automation/agents.ts).
import type { Usage } from "../core/types.ts";
import type { Price } from "../providers/types.ts";
import { priceOf } from "../providers/pricing.ts";

const k = (n: number) => (n < 1000 ? `${Math.round(n)}` : n < 1_000_000 ? `${Math.round(n / 1000)}K` : `${(n / 1_000_000).toFixed(1)}M`);
const usd = (x: number) => (x >= 1 ? `$${x.toFixed(2)}` : x >= 0.01 ? `$${x.toFixed(3)}` : `$${x.toFixed(4)}`);

// The tokens a request carried before any conversation of its own: what the session's first measured reply read.
export function startTokens(usages: readonly (Usage | undefined)[]): number | undefined {
  const u = usages.find((x) => x && x.input + x.cache_read + x.cache_write > 0);
  return u ? u.input + u.cache_read + u.cache_write : undefined;
}

// `context`: the fork's start in tokens; `fresh`: where a fresh agent starts, when known; `price`: the model's.
export function forkPriceLine(o: { context: number; fresh?: number; price?: Price }): string {
  const step = (tokens: number) => (o.price ? priceOf({ input: 0, output: 0, cache_read: tokens, cache_write: 0 }, o.price) : undefined);
  const one = step(o.context);
  const base = step(o.fresh ?? 0);
  const fresh = o.fresh !== undefined && o.fresh < o.context ? o.fresh : undefined;
  const head = `A fork starts from this conversation, about ${k(o.context)} tokens, and reads all of it at every step${one === undefined ? " (its model lists no price, so no dollars are counted)" : `: about ${usd(one)} a step from the cache at the model's price, and more as it works`}.`;
  if (fresh === undefined) return head;
  return `${head} A fresh agent starts from about ${k(fresh)} tokens${base === undefined ? "" : ` (about ${usd(base)} a step)`}: when the task needs little of this conversation, spell it out for a fresh agent instead.`;
}
