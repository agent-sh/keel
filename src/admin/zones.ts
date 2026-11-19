// The zones of one model request, in the order the provider reads them: the
// tool schemas, the system prompt, the history the previous request of the
// session already carried (frozen: it can be read from the prompt cache), and
// the volatile tail (what is new since then: the last reply, tool results, the
// new prompt). A zone's tokens are an estimate: its bytes, scaled so the zones
// add up to what the provider counted for the prompt.
import type { Message } from "../core/types.ts";
import type { ProviderRequest } from "../providers/types.ts";

export const ZONES = ["tools", "system", "history", "tail"] as const;
export type Zone = (typeof ZONES)[number];
export type Zones = Record<Zone, number>;

// An image or document counts as about 1,600 tokens (a 1.15 megapixel image
// on Anthropic's formula), not as the length of its base64.
const BLOB_BYTES = 6_400;
const size = (v: unknown) =>
  JSON.stringify(v, (k, x) => (k === "data" && typeof x === "string" && x.length > BLOB_BYTES ? " ".repeat(BLOB_BYTES) : x))?.length ?? 0;

export const messageSizes = (messages: Message[]) => messages.map(size);
// What each message holds, as a short fingerprint (never its text): an edit of
// the same length is a different message.
const mark = (m: Message) => Bun.hash(JSON.stringify(m)).toString(36);

// `prev`: the marks of the messages the previous turn request carried. The
// leading messages of this request that match them are frozen history.
export function zoneBytes(req: Pick<ProviderRequest, "tools" | "system" | "messages">, prev: string[]): { bytes: Zones; sizes: number[]; marks: string[] } {
  const sizes = messageSizes(req.messages);
  const marks = req.messages.map(mark);
  let frozen = 0;
  while (frozen < sizes.length - 1 && frozen < prev.length && marks[frozen] === prev[frozen]) frozen++;
  const sum = (a: number[]) => a.reduce((n, x) => n + x, 0);
  return {
    sizes,
    marks,
    bytes: {
      tools: size(req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))),
      system: req.system.length,
      history: sum(sizes.slice(0, frozen)),
      tail: sum(sizes.slice(frozen)),
    },
  };
}

// Bytes to tokens: each zone's share of the provider's prompt count, summing
// to it exactly. Shares are floored and the tokens left go to the largest
// remainders (ties to the earlier zone), so no zone is negative and an empty
// zone gets nothing.
export function scaleZones(bytes: Zones, prompt: number): Zones {
  const total = ZONES.reduce((n, z) => n + bytes[z], 0);
  const out = { tools: 0, system: 0, history: 0, tail: 0 } as Zones;
  if (!total || prompt <= 0) return out;
  const exact = ZONES.map((z) => (bytes[z] / total) * prompt);
  ZONES.forEach((z, i) => (out[z] = Math.floor(exact[i]!)));
  let left = prompt - ZONES.reduce((n, z) => n + out[z], 0);
  const order = ZONES.map((z, i) => ({ z, r: exact[i]! - out[z] })).filter((x) => bytes[x.z] > 0).sort((a, b) => b.r - a.r);
  for (let i = 0; left > 0; i = (i + 1) % order.length, left--) out[order[i]!.z]++;
  return out;
}

export type ZoneCache = { tokens: number; read: number; written: number; fresh: number };

// How each zone was served: the provider reads its cache from the front of the
// prompt, writes the part after that up to the last breakpoint, and charges the
// rest in full. Laying the three counts over the zones in order gives each
// zone's share (an estimate: providers report totals, not where they fell).
export function zoneCache(z: Zones, u: { cache_read: number; cache_write: number; input: number }): Record<Zone, ZoneCache> {
  let read = u.cache_read, written = u.cache_write;
  const out = {} as Record<Zone, ZoneCache>;
  for (const k of ZONES) {
    const t = z[k];
    const r = Math.min(t, read);
    read -= r;
    const w = Math.min(t - r, written);
    written -= w;
    out[k] = { tokens: t, read: r, written: w, fresh: t - r - w };
  }
  return out;
}
