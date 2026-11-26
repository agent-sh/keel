// Replays the shape of a long session the owner talks to through the real Engine twice, with the switch for
// compaction by price (src/engine/owner-compact.ts) off and on, and prints what each read: tokens, dollars,
// context, the first token its own calls had at each context, and the compactions.
//
// The shape is sizes and times only (no text leaves the store): each turn, whether the owner's words started it
// and their bytes, and the tokens each of its model steps added. The stand-in provider measures each request by
// its bytes, answers with filler of the size the real step added (a tool call between steps), writes a summary
// two steps after it was asked for, and bills cache reads, writes and output at the prices given.
//
//   bun scripts/bench/compaction-replay.ts --store STATE/keel.db --session ID [--since MS] \
//       --price READ,WRITE,OUTPUT [--window TOKENS] [--output TOKENS] [--shape-out FILE] [--out FILE]
//   bun scripts/bench/compaction-replay.ts --shape FILE --price READ,WRITE,OUTPUT ...
//
// --store is opened read-only. --price is dollars a million tokens of cache read, cache write and output, as the
// session's own calls paid them. The first token by context comes from the session's own turn calls (medians per
// 200K tokens, straight lines between them and past the ends), or --ttft "TOKENS:MS,...".
//
// What it does not see: wall time (every step finds a warm cache, as a busy session does), the real summary's
// size (a fixed SUMMARY_TOKENS), and the meaning check on real words (filler has no statements or identifiers;
// the owner's words are counted by their bytes).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { standIns } from "../scratch-env.ts";

const { values: arg } = parseArgs({
  options: {
    store: { type: "string" }, session: { type: "string" }, since: { type: "string" }, shape: { type: "string" },
    price: { type: "string" }, window: { type: "string" }, output: { type: "string" }, ttft: { type: "string" },
    "shape-out": { type: "string" }, out: { type: "string" },
  },
});
if (!arg.price || (!arg.shape && !(arg.store && arg.session))) {
  console.error("usage: compaction-replay.ts (--store DB --session ID [--since MS] | --shape FILE) --price READ,WRITE,OUTPUT [--window N] [--output N] [--ttft T:MS,...] [--shape-out FILE] [--out FILE]");
  process.exit(2);
}

// `bytes`: what the input that opened the turn holds. Of a turn the owner's words opened, his words alone (the
// reports and notices that came with them are not his, and only his are kept whole by a compaction).
type Turn = { owner: boolean; bytes: number; steps: number[] };
type Shape = { first: number; turns: Turn[]; ttft: [number, number][] };

// Bytes a token as the engine counts a model it has not learned (BYTES_PER_TOKEN, src/engine/compact.ts).
const BPT = 2.5;
const SUMMARY_TOKENS = 6_000;
const filler = (bytes: number) => "lorem ipsum dolor sit amet ".repeat(Math.ceil(Math.max(0, bytes) / 27)).slice(0, Math.max(0, Math.round(bytes)));
const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)]!; };
const q = (xs: number[], p: number) => { const v = [...xs].sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]!; };

// A session's shape from a store, read-only: sizes and times, no text.
function shapeOf(db: Database, session: string, since: number, ownerPrompt: (d: any) => boolean): Shape {
  const rows = db.query<{ kind: string; data: string }, [string, number]>("SELECT kind, data FROM events WHERE session_id = ? AND ts >= ? AND kind IN ('user', 'assistant', 'turn_start') ORDER BY seq").all(session, since);
  const ctx = (d: any) => { const u = d.usage ?? {}; return (u.input ?? 0) + (u.cache_read ?? 0) + (u.cache_write ?? 0); };
  const steps = rows.filter((r) => r.kind === "assistant").map((r) => JSON.parse(r.data)).map((d) => ({ ctx: ctx(d), bytes: JSON.stringify(d.blocks ?? []).length }));
  const turns: Turn[] = [];
  let pending = { owner: false, bytes: 0, other: 0 };
  let ai = 0;
  for (const r of rows) {
    const d = JSON.parse(r.data);
    if (r.kind === "user") {
      const b = Buffer.byteLength(String(d.text ?? ""));
      if (ownerPrompt(d) && !d.system) { pending.owner = true; pending.bytes += b; } else pending.other += b;
      continue;
    }
    if (r.kind === "turn_start") { turns.push({ owner: pending.owner, bytes: pending.owner ? pending.bytes : pending.other, steps: [] }); pending = { owner: false, bytes: 0, other: 0 }; continue; }
    const now = steps[ai]!, next = steps[ai + 1];
    // What this step added before the next: the next step's context less this one's (across a real compaction, its own bytes).
    const grew = next ? next.ctx - now.ctx : 0;
    if (!turns.length) turns.push({ owner: false, bytes: 0, steps: [] });
    turns.at(-1)!.steps.push(grew >= 0 ? grew : Math.round(now.bytes / BPT));
    ai++;
  }
  // The first token by context, from the session's own turn calls.
  const calls = db.query<{ ttft: number; ctx: number }, [string, number]>("SELECT ttft_ms AS ttft, input + cache_read + cache_write AS ctx FROM telemetry_calls WHERE session_id = ? AND ts >= ? AND COALESCE(purpose, 'turn') = 'turn' AND outcome = 'ok' AND ttft_ms IS NOT NULL").all(session, since);
  const buckets = new Map<number, number[]>();
  for (const c of calls) { const b = Math.floor(c.ctx / 200_000); buckets.set(b, [...(buckets.get(b) ?? []), c.ttft]); }
  const ttft = [...buckets].filter(([, v]) => v.length >= 20).sort((a, b) => a[0] - b[0]).map(([b, v]) => [b * 200_000 + 100_000, median(v)] as [number, number]);
  return { first: steps[0]?.ctx ?? 0, turns: turns.filter((t) => t.steps.length), ttft };
}

const dir = mkdtempSync(join(tmpdir(), "compaction-replay-"));
for (const [k, v] of Object.entries(standIns(dir))) process.env[k] = v;
process.env.KEEL_STATE_DIR = join(dir, "state");
mkdirSync(process.env.KEEL_STATE_DIR, { recursive: true });
const { ownerPrompt } = await import("../../src/core/owner.ts");
const shape: Shape = arg.shape ? JSON.parse(readFileSync(arg.shape, "utf8")) : shapeOf(new Database(arg.store!, { readonly: true }), arg.session!, Number(arg.since ?? 0), ownerPrompt);
if (arg["shape-out"]) writeFileSync(arg["shape-out"], JSON.stringify(shape));
const pts: [number, number][] = arg.ttft ? arg.ttft.split(",").map((p) => p.split(":").map(Number) as [number, number]) : shape.ttft;
const ttft = (ctx: number) => {
  if (pts.length < 2) return pts[0]?.[1] ?? 0;
  let i = 0;
  while (i < pts.length - 2 && ctx > pts[i + 1]![0]) i++;
  const [[x0, y0], [x1, y1]] = [pts[i]!, pts[i + 1]!];
  return y0 + ((ctx - x0) * (y1 - y0)) / (x1 - x0);
};
const [read, write, output] = arg.price.split(",").map(Number) as [number, number, number];
const PRICE = { input: write, output, cache_read: read, cache_write: write };

const { loadSettings } = await import("../../src/admin/settings.ts");
loadSettings(process.env.KEEL_STATE_DIR, () => {});
const { Store } = await import("../../src/core/store.ts");
const { Bus } = await import("../../src/core/bus.ts");
const { Engine } = await import("../../src/engine/turn.ts");

async function run(on: boolean) {
  const at = mkdtempSync(join(dir, on ? "on-" : "off-"));
  const store = new Store(at);
  const info = { id: "replay:model", provider: "replay", model: "model", name: "Replay", family: "other", context: Number(arg.window ?? 1_000_000), output: Number(arg.output ?? 64_000), efforts: [], billing: "per_token", price: PRICE };
  const s = store.createSession({ title: "Replay", model: info.id, workspace: at, settings: on ? { owner_compact_by_price: true } : {} });
  // The history before the replayed span: one message, one reply of its size.
  store.append(s.id, "user", { text: "start" });
  store.append(s.id, "assistant", { blocks: [{ type: "text", text: filler(shape.first * BPT) }], model: info.id, stop: "end_turn", usage: { input: 0, output: 1, cache_read: shape.first, cache_write: 0 } });
  const acct = { read: 0, write: 0, usd: 0, summaryTokens: 0, summaries: 0, steps: [] as { ctx: number; ownerFirst: boolean }[] };
  let turn = shape.turns[0]!, k = 0, stepCount = 0;
  let prev: { head: string; tokens: number } | null = null;
  const bill = (r: number, w: number, o: number) => { acct.read += r; acct.write += w; acct.usd += (r * PRICE.cache_read + w * PRICE.cache_write + o * PRICE.output) / 1e6; };
  const provider = {
    id: "replay", wire: "anthropic_messages", available: () => true, list: async () => [],
    stream: async (req: any) => {
      const body = JSON.stringify(req.messages);
      const tokens = Math.ceil((body.length + JSON.stringify(req.system ?? "").length + JSON.stringify(req.tools ?? []).length) / BPT);
      const head = body.slice(0, 4096);
      if (req.purpose === "summary") {
        // Written while the work goes on: ready two steps later (one the turn waits for is answered soon all the same).
        const from = stepCount, t0 = Date.now();
        while (stepCount < from + 2 && Date.now() - t0 < 1_500) await Bun.sleep(5);
        acct.summaries++; acct.summaryTokens += tokens;
        bill(tokens, 2_000, SUMMARY_TOKENS);
        return { blocks: [{ type: "text", text: `## Story\n${filler(SUMMARY_TOKENS * BPT)}` }], usage: { input: 0, output: SUMMARY_TOKENS, cache_read: tokens, cache_write: 0 }, stop: "end_turn", model: "model" };
      }
      // The cached prefix goes on while the history only grew; a compaction writes it again.
      const cont = prev && prev.head === head && tokens >= prev.tokens;
      bill(cont ? prev!.tokens : 0, cont ? tokens - prev!.tokens : tokens, 300);
      prev = { head, tokens };
      acct.steps.push({ ctx: tokens, ownerFirst: k === 0 && turn.owner });
      const grew = turn.steps[k] ?? 0, last = k >= turn.steps.length - 1;
      k++; stepCount++;
      const text = filler(grew * BPT - (last ? 0 : 200));
      const usage = { input: 0, output: 300, cache_read: tokens, cache_write: 0 };
      return last
        ? { blocks: [{ type: "text", text }], usage, stop: "end_turn", model: "model" }
        : { blocks: [{ type: "text", text }, { type: "tool_use", id: `t${stepCount}`, name: "Read", input: {} }], usage, stop: "tool_use", model: "model" };
    },
  };
  const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] };
  const engine = new Engine(store, new Bus(), providers as any, { capture: (_s: string, e: unknown) => ({ message: String((e as Error).message) }) } as any, join(at, "spill"));
  for (const t of shape.turns) {
    turn = t; k = 0;
    engine.send(s.id, filler(Math.max(5, t.bytes)), t.owner ? undefined : { meta: { origin: "momentum" } });
    await engine.idle(s.id);
  }
  const events = store.events(s.id);
  const ctx = acct.steps.map((x) => x.ctx), own = acct.steps.filter((x) => x.ownerFirst).map((x) => ttft(x.ctx));
  const r = {
    switch: on ? "on" : "off", turns: shape.turns.length, steps: acct.steps.length,
    tokens_read_M: Math.round((acct.read + acct.write + acct.summaryTokens) / 1e5) / 10, summary_reads_M: Math.round(acct.summaryTokens / 1e5) / 10, summaries: acct.summaries,
    usd: Math.round(acct.usd * 100) / 100, ctx_p50: q(ctx, 0.5), ctx_p90: q(ctx, 0.9),
    first_token_p50_ms: Math.round(q(ctx.map(ttft), 0.5)), first_token_owner_p50_ms: own.length ? Math.round(q(own, 0.5)) : null,
    compactions: events.filter((e) => e.kind === "compaction").map((e) => `${e.data.trigger} at ${Math.round(e.data.tokens_before / 1000)}K`),
    held: events.filter((e) => e.kind === "note" && e.data.kind === "price_compaction_held").length,
  };
  return r;
}

const off = await run(false);
const on = await run(true);
const out = { off, on, tokens_on_over_off: Math.round((on.tokens_read_M / off.tokens_read_M) * 100) / 100, usd_on_over_off: Math.round((on.usd / off.usd) * 100) / 100, first_token_points: pts };
if (arg.out) writeFileSync(arg.out, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
