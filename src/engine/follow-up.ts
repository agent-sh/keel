// Where a follow-up to a finished agent starts: the work a message asks of an
// agent that already reported is priced three ways, and the cheapest that
// still holds what the message points at is taken. Pure: the engine reads the
// facts (src/engine/turn.ts, Engine.followUp) and carries out what this says.
//
// - carry: the agent goes on in its whole context. Cheapest while the context
//   is small, or its cache is warm and little work is asked.
// - summary: the context is replaced by a summary, the one prepared while it
//   was idle when one holds, else one written now with the message as its
//   focus (a request that reads the whole context once).
// - capsule: the context is replaced by a capsule the harness makes from the
//   agent's records with no model call: its task and the messages it was sent
//   (kept verbatim, as every compaction keeps them), its report, and the trail
//   of its work (files written, commands, commits). The agent keeps its id,
//   its session, its worktree and its place in the tree; the history stays
//   stored and searchable.
//
// Each way is priced over the work the message is expected to take: as many
// steps as the agent's last task took, each adding what a step of that task
// added. The first step writes what the cache does not hold (the whole context
// when its cache lapsed, the new start when it is replaced); each later step
// reads the context from the cache and writes what the step added. A fresh
// start also reads again the files the agent wrote, which a follow-up of
// review fixes opens first, and takes one step more to find its place. Output
// is the same for every way and is left out.
import type { Price } from "../providers/types.ts";
import { priceOf } from "../providers/pricing.ts";
import type { StoredEvent } from "../core/types.ts";
import { fileReads, resultText } from "./work-calls.ts";

export type Way = "carry" | "summary" | "capsule";
export const WAYS: readonly Way[] = ["carry", "summary", "capsule"];
export const isWay = (x: unknown): x is Way => typeof x === "string" && (WAYS as readonly string[]).includes(x);

export type FollowUpFacts = {
  used: number;     // tokens the context holds now
  prefix: number;   // tokens of the system prompt and tools: every way keeps them
  warm: boolean;    // the provider surely still holds the context's cache (cacheState)
  // The provider may still hold it: it does not say how long it keeps a
  // cache, and the longest it may keep one has not passed. Each way is priced
  // between its warm and its lapsed cost.
  maybe?: boolean;
  long: boolean;    // a cache write on this route asks for the long lifetime (priced at its own rate)
  price?: Price;    // the model's listed price; none: nothing can be priced
  steps: number;    // steps the work is expected to take
  growth: number;   // tokens a step adds
  capsule: number;  // tokens of the capsule as the model reads it
  // A summary prepared while the agent was idle that still holds (its tokens as the model reads it).
  prepared?: number;
  // Tokens a fresh start reads again: the files the agent wrote, and the
  // files the message names that the earlier context had read.
  reread: number;
  missing?: string[]; // what the message names that the history holds and the capsule leaves out
  // How its last task ended: only one it finished with its own report is a
  // cut a fresh start can be made at. One that failed, was stopped or ran out
  // was cut mid-work, and where the work stands is in its context. "declined":
  // the model declined to go on in it, so its context is what the model's check
  // flagged: going on in it, or in a summary of it, is declined again.
  ended: "completed" | "failed" | "stopped" | "incomplete" | "declined";
  force?: Way;      // the owner's choice for this agent
};

export type FollowUpPlan = {
  way: Way;
  why: string;
  forced?: true;
  // Dollars each way is expected to cost over the work asked, and the context its first step reads.
  costs: Partial<Record<Way, number>>;
  tokens: Partial<Record<Way, number>>;
  steps: number;
  warm: boolean;
  maybe?: true;
  used: number;
  missing?: string[];
};

// Whether the context's cache is still held, from its last read or write
// (`touched`, 0 for never). `own`: the lifetime the provider states for its
// cache; else retention()'s lifetimes on the wire: `sure` is what it keeps for
// certain (0 when it does not say), `max` the longest it may keep one. Each
// lifetime less the cache plan's margin (marginOf).
export function cacheState(o: { touched: number; now: number; own?: number; sure: number; max: number; margin: (life: number) => number }): "warm" | "maybe" | "lapsed" {
  if (o.touched <= 0) return "lapsed";
  const within = (life: number) => life > 0 && o.now < o.touched + life - o.margin(life);
  if (o.own !== undefined) return within(o.own) ? "warm" : "lapsed";
  if (within(o.sure)) return "warm";
  return o.sure === 0 && within(o.max) ? "maybe" : "lapsed";
}

const usage = (read: number, write: number) => ({ input: 0, output: 0, cache_read: Math.max(0, Math.round(read)), cache_write: Math.max(0, Math.round(write)) });

// What `steps` steps cost from a start of `start` tokens, of which `cached`
// are read from the cache at the first step and the rest written.
export function costFrom(start: number, cached: number, f: Pick<FollowUpFacts, "steps" | "growth" | "long" | "price">): number | undefined {
  if (!f.price) return undefined;
  const one = (read: number, write: number) => priceOf({ ...usage(read, write), ...(f.long ? { cache_write_1h: Math.max(0, Math.round(write)) } : {}) }, f.price);
  const first = one(cached, start - cached);
  if (first === undefined) return undefined;
  let total = first;
  for (let k = 1; k < Math.max(1, f.steps); k++) total += one(start + (k - 1) * f.growth, f.growth)!;
  return total;
}

const k = (n: number) => (n < 1000 ? `${Math.round(n)}` : n < 1_000_000 ? `${Math.round(n / 1000)}K` : `${(n / 1_000_000).toFixed(1)}M`);
const usd = (x: number) => (x >= 1 ? `$${x.toFixed(2)}` : x >= 0.01 ? `$${x.toFixed(3)}` : `$${x.toFixed(4)}`);
export const WAY_WORDS: Record<Way, string> = { carry: "went on in its context", summary: "started from a summary of its context", capsule: "started fresh from a capsule of its work" };

// The cheapest start; on a tie the one that keeps more (carry, then the
// summary). The owner's choice for the agent goes first: a summary forced
// with none prepared is written at the start of the work, with the message as
// its focus.
export function decideFollowUp(f: FollowUpFacts): FollowUpPlan {
  const tokens: Partial<Record<Way, number>> = { carry: f.used, capsule: f.prefix + f.capsule };
  const costs: Partial<Record<Way, number>> = {};
  // `held`: what the first step reads from a cache that holds. A cache that
  // may hold is priced halfway between holding and not.
  const priced = (start: number, held: number, g: Pick<FollowUpFacts, "steps" | "growth" | "long" | "price">) => {
    if (!f.maybe) return costFrom(start, f.warm ? held : 0, g);
    const a = costFrom(start, held, g), b = costFrom(start, 0, g);
    return a === undefined || b === undefined ? undefined : (a + b) / 2;
  };
  const carry = priced(f.used, f.used, f);
  if (carry !== undefined) costs.carry = carry;
  // A fresh start keeps the system prompt and tools in the cache while the
  // context's cache holds. It also takes one step more than going on: the
  // step that finds where its work stands (its branch, the files its report
  // names), which the whole context does not need.
  const fresh = (body: number) => priced(f.prefix + body + f.reread, f.prefix, { ...f, steps: f.steps + 1 });
  const cap = fresh(f.capsule);
  if (cap !== undefined) costs.capsule = cap;
  if (f.prepared !== undefined) {
    tokens.summary = f.prefix + f.prepared;
    const s = fresh(f.prepared);
    if (s !== undefined) costs.summary = s;
  }
  const base = { costs, tokens, steps: f.steps, warm: f.warm, ...(f.maybe ? { maybe: true as const } : {}), used: f.used, ...(f.missing?.length ? { missing: f.missing } : {}) };
  if (f.force) {
    const how = f.force === "carry" ? "go on in its context" : f.force === "summary" ? `start from a summary (${f.prepared !== undefined ? "the one prepared while it was idle" : "written now, with the message as its focus"})` : "start fresh from a capsule of its work";
    return { ...base, way: f.force, forced: true, why: `The owner chose that this agent's follow-ups ${how}.` };
  }
  // A context the model declined is not sent again: a fresh start from a capsule, which holds none of the declined reply.
  if (f.ended === "declined") return { ...base, way: "capsule", why: "Started fresh from a capsule of its work: the model declined to go on in its context, and a request in it would be declined again. The capsule holds its task, the messages it was sent and the trail of its work, and none of the declined reply." };
  if (f.ended !== "completed") return { ...base, way: "carry", why: `Went on in its context: its last task ${f.ended === "failed" ? "failed" : f.ended === "stopped" ? "was stopped" : "did not finish"} mid-work, and where the work stands is there.` };
  if (costs.carry === undefined) return { ...base, way: "carry", why: "Went on in its context: the model's price is not known, so no start could be priced." };
  let way: Way = "carry";
  for (const w of ["summary", "capsule"] as const) if (costs[w] !== undefined && costs[w]! < costs[way]!) way = w;
  const cache = f.warm ? "its cache warm" : f.maybe ? "its cache perhaps warm: the provider does not say how long it keeps one" : "its cache lapsed";
  const over = `over about ${f.steps} ${f.steps === 1 ? "step" : "steps"}`;
  // (Counted, not named: the words are told in timelines, which carry no message's content.)
  const named = f.missing?.length ? ` (${f.missing.length} of them named in the message)` : "";
  const again = f.reread > 0 ? `, ${k(f.reread)} of them files it reads again${named}` : "";
  const why = way === "carry"
    ? `Went on in its context of ${k(f.used)} tokens (${cache}): cheapest ${over}, ${usd(costs.carry!)}${costs.capsule !== undefined ? ` against ${usd(costs.capsule)} for a fresh start` : ""}.`
    : way === "summary"
      ? `Started from the summary prepared while it was idle, a start of ${k(tokens.summary! + f.reread)} tokens${again}, instead of its context of ${k(f.used)} (${cache}): ${usd(costs.summary!)} against ${usd(costs.carry!)} to go on, ${over}.`
      : `Started fresh from a capsule of its work, a start of ${k(tokens.capsule! + f.reread)} tokens${again}, instead of its context of ${k(f.used)} (${cache}): ${usd(costs.capsule!)} against ${usd(costs.carry!)} to go on, ${over}.`;
  return { ...base, way, why };
}

// The capsule's own words: what the agent reported, as the session that
// started it got it (its reports since its last checkpoint, the newest first),
// and what its context held before them (`before`: the story of its last
// checkpoint's summary, verbatim). Its task and the messages it was sent are
// kept beside it by the checkpoint, verbatim, and so are the statements that
// summary carried; the trail of its work follows it. `title` comes as a
// frame attribute (attr in src/automation/core.ts): one line, no quotes.
export function capsuleText(o: { title: string; report: string; tasks: number; before?: string }): string {
  const report = o.report.trim() || "(It wrote no report.)";
  const before = o.before?.trim();
  return [
    `You are agent "${o.title}", taking up new work after you reported${o.tasks ? ` (task ${o.tasks + 1})` : ""}. Your earlier context was replaced by this capsule, made by the harness from your records: your task and the messages you were sent are kept below as they were, and the trail lists the files you wrote and the commands you ran. The whole history is still stored: read the files again as you need them.`,
    ...(before ? ["", "What your context held before that work, from its last summary (as it was written then):", before] : []),
    "",
    "Your reports of the work so far (your final messages, as the session that started you got them; the newest first):",
    report,
  ].join("\n");
}

// The capsule of a top-level session the owner starts again after the model declined it. Made from the
// session's records with no model call, as an agent's is: what it reported since its last checkpoint (the
// declined reply is not in it), and the story of that checkpoint. The owner's messages and the trail of the
// work are kept beside it by the checkpoint. It says nothing of why: the declined reply is left out of it.
export function freshStartText(o: { report: string; before?: string }): string {
  const report = o.report.trim() || "(Nothing was reported yet.)";
  const before = o.before?.trim();
  return [
    "This session's earlier context was replaced by this capsule, made by the harness from its records: the owner's messages are kept below as they were, and the trail lists the files written and the commands run. The whole history is still stored: read the files again as you need them. Go on with the owner's last request.",
    ...(before ? ["", "What the context held before that work, from its last summary (as it was written then):", before] : []),
    "",
    "Your replies so far (your final messages; the newest first):",
    report,
  ].join("\n");
}

// The story part of a checkpoint's summary: its text after the "## Story"
// heading settle() writes (src/engine/compact.ts), else the whole text. The
// statements before it are carried by the next checkpoint on their own.
// A capsule's own text is a summary too (a follow-up that started fresh twice):
// its framing is left out, its intro and the two headings capsuleText writes,
// so the next capsule does not carry one more intro for each follow-up.
export function storyOf(summary: string): string {
  const at = summary.search(/^## Story$/m);
  const text = (at < 0 ? summary : summary.slice(at).replace(/^## Story\n?/, "")).trim();
  return unframe(text);
}

const CAPSULE_INTRO = /^(?:You are agent "[^\n]*", taking up new work after you reported|This session's earlier context was replaced by this capsule|The current loop run is being retried from a capsule)[^\n]*(?:\n+|$)/;
const CAPSULE_HEADS = /^(What your context held before that work, from its last summary \(as it was written then\):|Your reports of the work so far \(your final messages, as the session that started you got them; the newest first\):|Your replies so far \(your final messages; the newest first\):)\n/gm;

function unframe(text: string): string {
  if (!CAPSULE_INTRO.test(text)) return text;
  return text.replace(CAPSULE_INTRO, "").replace(CAPSULE_HEADS, "").replace(/\n{3,}/g, "\n\n").trim();
}

// The steps of the task the agent finished and what each added to its
// context: the expected shape of the work a follow-up asks. `contexts`: the
// context each step of that task read, oldest first.
export function taskShape(contexts: readonly number[]): { steps: number; growth: number } {
  const steps = contexts.length;
  if (steps < 2) return { steps: Math.max(1, steps), growth: 0 };
  return { steps, growth: Math.max(0, (contexts.at(-1)! - contexts[0]!) / (steps - 1)) };
}

// The identifiers a message names (paths, commit ids, issue numbers, long
// names) that the history holds and the capsule leaves out.
export function missingFrom(named: readonly string[], kept: string, inHistory: (id: string) => boolean): string[] {
  return named.filter((a) => !kept.includes(a) && inHistory(a));
}

// The bytes of each file a fresh start would read again, at its newest read
// in the history (a Write's content when it was only written): one walk,
// keeping only lengths. `wanted`: paths as the trail or the message gives
// them (a path the history names in full matches its tail).
export function rereadBytes(events: readonly Pick<StoredEvent, "kind" | "data">[], wanted: readonly string[]): number {
  if (!wanted.length) return 0;
  const match = (p: string) => wanted.find((w) => p === w || p.endsWith(`/${w}`) || w.endsWith(`/${p}`));
  const calls = new Map<string, string[]>();
  const bytes = new Map<string, number>();
  for (const e of events) {
    if (e.kind === "assistant") {
      for (const b of e.data.blocks ?? []) {
        if (b.type !== "tool_use") continue;
        const reads = fileReads(b.name, b.input).map(match).filter((x): x is string => !!x);
        if (reads.length) calls.set(b.id, reads);
        const path = typeof b.input?.file_path === "string" ? match(b.input.file_path) : undefined;
        if (path && typeof b.input?.content === "string") bytes.set(path, Buffer.byteLength(b.input.content));
      }
    } else if (e.kind === "tool_result") {
      for (const r of e.data.results ?? []) {
        const paths = calls.get(r.tool_use_id);
        if (!paths || r.is_error) continue;
        const n = Buffer.byteLength(resultText(r.content));
        // A command that printed several files: its output is shared among them.
        for (const p of paths) bytes.set(p, Math.ceil(n / paths.length));
      }
    }
  }
  let total = 0;
  for (const n of bytes.values()) total += n;
  return total;
}
