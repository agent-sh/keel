// A stand-in for a provider's prompt cache on the Anthropic Messages wire, for
// unit tests that check where a request's breakpoints sit against what a later
// request looks up. It follows the prompt caching guide
// (platform.claude.com/docs/en/build-with-claude/prompt-caching):
// - "Cache writes occur only at your breakpoint": one entry, the hash of the
//   prefix ending at that block.
// - "Cache reads look backward for entries that prior requests wrote": from
//   each breakpoint, block by block, at most 20 positions, the breakpoint
//   itself first. (Every block is a position here; the Claude API counts a run
//   of tool_use or tool_result blocks as one, which only widens its window.)
// - The lifetime runs from the start of the request that writes or reads the
//   entry, and the entry a read uses is kept that long again.
// The guide does not say whether an entry found by the lookback, behind the
// breakpoint, is kept again by that read. `refresh` picks the reading:
// "breakpoint" keeps only an entry found at a breakpoint itself (the stricter
// one), "any" keeps every entry a read used. A plan that works must work under
// both.
// The thinking setting and the effort are part of the prefix ("those values are
// rendered into the prompt"), and cache_control itself is not.
export type CacheUsage = { input: number; cache_read: number; cache_write: number };
type Block = { hash: string; tokens: number; ttl?: number };

const TTL = { "5m": 5 * 60_000, "1h": 60 * 60_000 } as const;
const LOOKBACK = 20;

export class PromptCache {
  private entries = new Map<string, { until: number; ttl: number }>(); // prefix hash -> when it lapses, and the lifetime it was written with
  constructor(private o: { refresh: "breakpoint" | "any" }) {}

  // The request `body` sent at `now` (ms): what it read, wrote and sent as plain input.
  send(body: any, now: number): CacheUsage {
    const blocks = positions(body);
    const marks = blocks.flatMap((b, i) => (b.ttl ? [i] : []));
    let read = -1; // the last position read from the cache
    const used: number[] = [];
    for (const m of marks) {
      for (let i = m; i >= 0 && i > m - LOOKBACK; i--) {
        if ((this.entries.get(blocks[i]!.hash)?.until ?? 0) <= now) continue;
        read = Math.max(read, i);
        if (i === m || this.o.refresh === "any") used.push(i);
        break;
      }
    }
    for (const i of used) { const e = this.entries.get(blocks[i]!.hash)!; e.until = now + e.ttl; }
    for (const m of marks) {
      const e = this.entries.get(blocks[m]!.hash), ttl = Math.max(e?.ttl ?? 0, blocks[m]!.ttl!);
      this.entries.set(blocks[m]!.hash, { until: Math.max(e?.until ?? 0, now + ttl), ttl });
    }
    const last = marks.at(-1) ?? -1;
    const sum = (from: number, to: number) => blocks.slice(from, to + 1).reduce((n, b) => n + b.tokens, 0);
    return { cache_read: sum(0, read), cache_write: sum(read + 1, last), input: sum(Math.max(read, last) + 1, blocks.length - 1) };
  }
}

// The request's prompt as positions in order: tools, system, then each block of each message.
function positions(body: any): Block[] {
  const out: Block[] = [];
  let h = Bun.hash(JSON.stringify([body.model, body.thinking, body.output_config]));
  const add = (role: string, b: any) => {
    const { cache_control, ...rest } = b;
    const text = JSON.stringify([role, rest]);
    h = Bun.hash(`${h}\u0000${text}`);
    out.push({ hash: h.toString(36), tokens: Math.ceil(text.length / 4), ...(cache_control ? { ttl: TTL[(cache_control.ttl ?? "5m") as "5m" | "1h"] } : {}) });
  };
  for (const t of body.tools ?? []) if (!t.defer_loading) add("tool", t);
  for (const b of body.system ?? []) add("system", b);
  for (const m of body.messages ?? []) for (const b of m.content) add(m.role, b);
  return out;
}
