// What a session's tokens cost, by what they were: read from the provider's
// cache, written to it, new input at full price, output. The page's cost
// views (the Tokens panel, Settings > Usage) say where the money went with
// these, so what costs is what looks big.
import type { StoredEvent, Usage } from "../../../src/core/types.ts";
import { ownerPrompt } from "../../../src/core/owner.ts";
import { originOf } from "../../../src/admin/timeline-rows.ts";
import type { Price } from "../../../src/providers/types.ts";

export type Kind = "read" | "written" | "full" | "output";
export const KINDS: Kind[] = ["read", "written", "full", "output"];
// One name per kind on every page.
export const KIND_LABEL: Record<Kind, string> = { read: "Read from cache", written: "Written to cache", full: "New input, full price", output: "Output" };
// As the object of "went on".
export const KIND_WORDS: Record<Kind, string> = { read: "cache reads", written: "cache writes", full: "new input at full price", output: "output" };
export type Costs = Record<Kind, number>;

export const tokensOf = (u: Usage): Costs => ({ read: u.cache_read, written: u.cache_write, full: u.input, output: u.output });
export const sum = (c: Costs) => c.read + c.written + c.full + c.output;
export const addCosts = (a: Costs, b: Costs): Costs => ({ read: a.read + b.read, written: a.written + b.written, full: a.full + b.full, output: a.output + b.output });
export const noCosts = (): Costs => ({ read: 0, written: 0, full: 0, output: 0 });

// The cost of one request (or one model's requests), cut by kind: each kind's
// tokens at the price's own rate, scaled so the parts add up to the cost that
// was recorded (a tier or an hour-long write changes the total, not the
// proportions by much). Null when the cost or the price is not known: an
// unknown cost is never shown as a split of zero.
export function kindCosts(u: { input: number; output: number; cache_read: number; cache_write: number }, price: Price | undefined, cost: number | undefined): Costs | null {
  if (cost === undefined || !price) return null;
  const raw: Costs = {
    read: u.cache_read * (price.cache_read ?? price.input),
    written: u.cache_write * (price.cache_write ?? price.input),
    full: u.input * price.input,
    output: u.output * price.output,
  };
  const all = sum(raw);
  if (!all) return cost ? null : noCosts();
  return { read: (raw.read / all) * cost, written: (raw.written / all) * cost, full: (raw.full / all) * cost, output: (raw.output / all) * cost };
}

// One request of a turn: the model's, or the summary a compaction wrote in it.
export type Req = { u: Usage; model?: string; what?: "compaction" };
export type Turn = { n: number; prompt: string; ts: number; ms?: number; requests: Req[]; total: Usage; cold: boolean; reused?: { read: number; before: number } };

const zero = (): Usage => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cache_read: a.cache_read + b.cache_read,
  cache_write: a.cache_write + b.cache_write,
  cost: a.cost !== undefined || b.cost !== undefined ? (a.cost ?? 0) + (b.cost ?? 0) : undefined,
});
export const sent = (u: Usage) => u.input + u.cache_read + u.cache_write;

// A session's turns with their requests. A compaction's own request counts in
// the turn it ran in (or the turn before it, when it ran between turns): its
// summary is spend of that turn's context. A turn whose first model request
// read less than half of the prompt the turn before sent is cold: that prefix
// was not reused (an expired cache, a changed prefix).
export function turnsOf(events: StoredEvent[]): Turn[] {
  const out: Turn[] = [];
  let prompt = "";
  let cur: Turn | null = null;
  const take = (t: Turn, r: Req) => { t.requests.push(r); t.total = addUsage(t.total, r.u); };
  for (const e of events) {
    // A turn is named by the owner's words when they started it, else by what started it (an agent's report, a wake):
    // a delivered input's text is written for the model, not for a list the owner reads.
    if (e.kind === "user") prompt = ownerPrompt(e.data) ? String(e.data.text ?? "") : originOf(e.data).lead;
    else if (e.kind === "turn_start") cur = { n: out.length + 1, prompt, ts: e.ts, requests: [], total: zero(), cold: false };
    else if (e.kind === "assistant" && cur && e.data.usage) take(cur, { u: e.data.usage, model: e.data.model });
    else if (e.kind === "compaction" && e.data.usage && (cur ?? out.at(-1))) take((cur ?? out.at(-1))!, { u: e.data.usage, model: e.data.model, what: "compaction" });
    else if (e.kind === "turn_end" && cur) {
      cur.ms = e.data.ms;
      const first = cur.requests.find((r) => !r.what)?.u;
      const before = out.at(-1)?.requests.findLast((r) => !r.what)?.u;
      if (first && before) {
        cur.reused = { read: first.cache_read, before: sent(before) };
        cur.cold = sent(before) > 2000 && first.cache_read < 0.5 * sent(before);
      }
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// A share that makes something the driver of a cost, not merely its largest part.
export const DRIVES = 0.4;

// One turn's cost by kind, when every request of it is priced.
export function turnCosts(t: Turn, priceOf: (model?: string) => Price | undefined): Costs | null {
  let c: Costs | null = noCosts();
  for (const r of t.requests) { const k = kindCosts(r.u, priceOf(r.model), r.u.cost); c = c && k ? addCosts(c, k) : null; }
  return c;
}

export type Why = {
  // Money by kind over the turns' requests, when every one of them is priced.
  costs: Costs | null;
  tokens: Costs;
  top?: { kind: Kind; share: number };          // the kind that drove the cost (DRIVES of it or more)
  turn?: { n: number; share: number; kind?: Kind; compacted: boolean; cold: boolean };  // the turn that drove it, with what drove the turn
  compactions?: { n: number; cost?: number };
  cold: number[];                                // the turns that started on a cold cache, by number
  beside?: number;                               // spent outside the turns' requests: summaries on their own, side questions, readers
};

// Why a session cost what it did. `whole` is the session's own cost (what the
// header shows), which also counts requests beside the turns.
export function whyOf(turns: Turn[], priceOf: (model?: string) => Price | undefined, whole: number | undefined): Why {
  let costs: Costs | null = noCosts();
  let tokens = noCosts();
  let inTurns = 0;
  const comp = { n: 0, cost: 0 as number | undefined };
  for (const t of turns) for (const r of t.requests) {
    tokens = addCosts(tokens, tokensOf(r.u));
    const c = kindCosts(r.u, priceOf(r.model), r.u.cost);
    costs = costs && c ? addCosts(costs, c) : null;
    inTurns += r.u.cost ?? 0;
    if (r.what) { comp.n++; comp.cost = comp.cost !== undefined && r.u.cost !== undefined ? comp.cost + r.u.cost : undefined; }
  }
  const why: Why = { costs, tokens, cold: turns.filter((t) => t.cold).map((t) => t.n) };
  const lead = (c: Costs | null) => {
    if (!c || !(sum(c) > 0)) return undefined;
    const kind = KINDS.reduce((a, k) => (c[k] > c[a] ? k : a));
    return c[kind] / sum(c) >= DRIVES ? { kind, share: c[kind] / sum(c) } : undefined;
  };
  why.top = lead(costs);
  const total = whole ?? (inTurns || undefined);
  const dear = turns.reduce<Turn | null>((a, t) => ((t.total.cost ?? 0) > (a?.total.cost ?? 0) ? t : a), null);
  if (turns.length > 1 && dear?.total.cost && total && dear.total.cost / total >= DRIVES) {
    why.turn = { n: dear.n, share: Math.min(1, dear.total.cost / total), kind: lead(turnCosts(dear, priceOf))?.kind, compacted: dear.requests.some((r) => r.what), cold: dear.cold };
  }
  if (comp.n) why.compactions = comp;
  if (whole !== undefined && whole - inTurns > Math.max(0.00005, whole * 0.005)) why.beside = whole - inTurns;
  return why;
}

// ---- What drove a range's spend, in sentences (Settings > Usage).

// A bucket of the range by its own span: an hour, a day, or the hours it holds.
const COUNT = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
export function bucketName(ms: number): string {
  if (ms === 3_600_000) return "hour";
  if (ms === 86_400_000) return "day";
  const hours = ms / 3_600_000;
  if (Number.isInteger(hours)) return `${COUNT[hours] ?? hours} hours`;
  const days = ms / 86_400_000;
  return Number.isInteger(days) ? `${COUNT[days] ?? days} days` : `${Math.round(ms / 60_000)} minutes`;
}

// A purpose as the subject of "were": plural, whatever its label on a table row.
const PURPOSES: Record<string, string> = { turn: "Turns", summary: "Summaries", side: "Side questions", advisor: "Advisor calls", consult: "Consults", reader: "Readers" };
export const purposeNoun = (p: string) => PURPOSES[p] ?? `${p[0]?.toUpperCase() ?? ""}${p.slice(1)} requests`;

// The sentences name what drove the spend, not the normal case. Turns being most of it is
// normal: a purpose beside them is named when it took a real share (NOTABLE). A bucket is
// named when it stands out from the others (twice their mean, or a third of the whole), by
// its own span: only an hour's bucket is "the dearest hour".
export const NOTABLE = 0.15;
export function spendDrivers(o: {
  spent: number; models: { name: string; usd: number }[]; purposes: { purpose: string; usd: number }[];
  buckets: { t: number; usd: number }[]; bucket_ms: number; at: (t: number, day: boolean) => string; usd: (v: number) => string;
}): string[] {
  if (!(o.spent > 0)) return [];
  const share = (v: number) => `${Math.round((100 * v) / o.spent)}%`;
  const out: string[] = [];
  const models = o.models.filter((m) => m.usd > 0).sort((a, b) => b.usd - a.usd);
  if (models[0]) out.push(models.length > 1 ? `${share(models[0].usd)} of it went to ${models[0].name}.` : `All of it went to ${models[0].name}.`);
  const beside = o.purposes.filter((p) => p.purpose !== "turn" && p.usd / o.spent >= NOTABLE).sort((a, b) => b.usd - a.usd)[0];
  if (beside) out.push(`${purposeNoun(beside.purpose)} were ${share(beside.usd)} of it.`);
  const paid = o.buckets.filter((b) => b.usd > 0).sort((a, b) => b.usd - a.usd);
  const top = paid[0];
  if (top && paid.length > 1) {
    const rest = (o.spent - top.usd) / (paid.length - 1);
    if (top.usd >= 2 * rest || top.usd / o.spent >= 1 / 3) {
      const span = bucketName(o.bucket_ms);
      const day = o.bucket_ms >= 86_400_000;
      out.push(span === "hour" || span === "day" ? `The dearest ${span} was ${o.at(top.t, day)}: ${o.usd(top.usd)}.` : `The dearest ${span} began ${o.at(top.t, day)}: ${o.usd(top.usd)}.`);
    }
  }
  return out;
}
