// The next-look queue: what waits on the owner, ordered by what the wait
// costs. Pure, and shared by every place that lists or tells what waits (the
// Inbox, the key that goes to what waits, the phone, the notifications), so
// they all say one order.
//
// What a wait costs is said in dollars a minute, the "cost of delay" of
// product triage, read when the item begins to wait:
// - the agents that sit idle until it is answered (the agent that asks, and
//   each agent above it that waits on its report), at what they spent a
//   minute while they worked;
// - the prompt cache the waiting context holds, at what writing it again
//   costs, spread over the minutes left before it lapses: a cache about to
//   lapse costs more a minute than one that keeps for an hour, and a cache
//   that has lapsed (or lapses within the margin a request needs) has no
//   minutes left to save and adds nothing.
// An item with no cost (nothing waits behind it, no cache at stake) costs 0.
//
// The order is stable: the key is fixed when the item begins to wait and is
// never read again (an item raised again keeps its first key), so two items
// never change places. A new one takes its place by its key. Ties, and every
// item of no cost, go by the wait: the oldest first, then by id.
//
// The line an item says is not the key's: it says what the wait costs as it
// stands when the list is read (the agents that wait now, the cache's life
// now: a warm ping lengthens it), so its words are never facts of the past
// told in the present.
//
// Imports nothing: the page and the daemon both use it.

export type WaitCost = {
  at: number;      // when it began to wait (ms)
  agents: number;  // agents idle until it is answered
  rate: number;    // what those agents spent a minute while they worked, dollars
  tokens?: number; // the prompt cache the waiting context holds
  usd?: number;    // writing that cache again, dollars
  until?: number;  // when that cache lapses (ms)
  key: number;     // what the wait costs a minute, as it began: the order's key, dollars
};

export type WaitFacts = Omit<WaitCost, "key">;
// What a wait costs at one moment, for its line: the facts without when it began or its key.
export type WaitNow = Omit<WaitCost, "key" | "at">;

// The key of a wait from its facts: the agents' rate, plus the cache's rewrite
// spread over the minutes it had left as the wait began, less the `margin` a
// request needs of a cache's lifetime before it ends (src/engine/cachewarn.ts
// PAUSE_MARGIN_MS). No minutes left (lapsed, or within the margin): the cache adds nothing.
export function waitKey(f: WaitFacts, margin: number): number {
  const left = f.until !== undefined ? (f.until - f.at - margin) / 60_000 : 0;
  const cache = f.usd && left > 0 ? f.usd / left : 0;
  const key = Math.max(0, f.rate) + cache;
  return Number.isFinite(key) ? Math.round(key * 1e6) / 1e6 : 0;
}

export type Waiting = { id: string; ts: number; wait?: Pick<WaitCost, "key"> | null };

// Compares two items that wait: the costlier first, then the one that waited longer, then by id.
export function byCost(a: Waiting, b: Waiting): number {
  return (b.wait?.key ?? 0) - (a.wait?.key ?? 0) || a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function rankWaiting<T>(xs: readonly T[], of: (x: T) => Waiting): T[] {
  return xs.map((x) => ({ x, w: of(x) })).sort((p, q) => byCost(p.w, q.w)).map((p) => p.x);
}

const usd = (x: number) => `$${x >= 0.1 ? x.toFixed(2) : x >= 0.01 ? x.toFixed(3) : x >= 0.0001 ? x.toFixed(4) : "0.0001"}`;
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.round(n)));
const span = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
};

// Whether the wait costs anything to say: agents wait behind it, or a cache is at stake.
export const costs = (c: WaitNow | null | undefined): c is WaitNow => !!c && (c.agents > 0 || (!!c.tokens && !!c.usd && c.until !== undefined));

// The item's cost in one short line, as it stands at `now`:
// "3 agents wait ($0.12/min); cache of 180K tokens expires in 2 min: about $0.90 to rewrite".
export function costLine(c: WaitNow | null | undefined, now: number): string {
  if (!c) return "";
  const parts: string[] = [];
  if (c.agents > 0) parts.push(`${c.agents} ${c.agents === 1 ? "agent waits" : "agents wait"}${c.rate >= 0.0001 ? ` (${usd(c.rate)}/min)` : ""}`);
  if (c.tokens && c.usd && c.until !== undefined) {
    const of = `cache of ${tokens(c.tokens)} tokens`;
    parts.push(c.until > now ? `${of} expires in ${span(c.until - now)}: about ${usd(c.usd)} to rewrite` : `${of} lapsed: about ${usd(c.usd)} to rewrite`);
  }
  if (!parts.length) return "Nothing waits behind it";
  const line = parts.join("; ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}
