// What the e2e of the context window (test/e2e/context-over-window.spec.ts)
// cannot reach: a hook that adds to a request while it is built, a summary
// that keeps failing inside a turn, the budget of a transcript read in parts,
// and cache warmth on a fake clock. A counting stand-in takes the provider's
// place: it counts each request it is sent (system and messages at 2.5 bytes
// a token) and refuses one over its window.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import type { Message } from "../core/types.ts";
import { ProviderError } from "../providers/http.ts";
import { setRatio } from "./compact.ts";
import { allHooks, registerHooks } from "./hooks.ts";
import { Engine, instructionFilter, toMessages } from "./turn.ts";
import { lineage } from "../core/tree.ts";

const BIG = { id: "ctx:big", provider: "ctx", model: "big", name: "Big", family: "other", context: 200_000, output: 1_000, efforts: [], billing: "per_token", tools: false };
const SMALL = { ...BIG, id: "ctx:small", model: "small", name: "Small", context: 10_000 };
const MID = { ...BIG, id: "ctx:mid", model: "mid", name: "Mid", context: 20_000 };
const MODELS = [BIG, SMALL, MID];
const count = (req: { system: string; messages: Message[] }) =>
  Math.ceil((Buffer.byteLength(req.system) + req.messages.reduce((n, m) => n + (m.content as any[]).reduce((k, b) => k + Buffer.byteLength(b.text ?? b.thinking ?? JSON.stringify(b)), 0), 0)) / 2.5);

type Sent = { purpose: string; model: string; tokens: number; refused: boolean; messages: Message[] };
const dirs: string[] = [];
const hooksBefore = allHooks().length;
afterEach(() => {
  allHooks().length = hooksBefore;
  instructionFilter.file = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// `reply`: what the stand-in answers a request it takes (the default is a short text).
function rig(reply?: (req: any, sent: Sent[]) => any) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "ctx-"));
  dirs.push(dir);
  // The same prompt on every machine: no instruction file above the scratch folder is loaded.
  instructionFilter.file = () => null;
  for (const m of MODELS) setRatio(m.id, 2.5);
  const store = new Store(dir);
  const sent: Sent[] = [];
  const failures: any[] = [];
  const provider = {
    id: "ctx", wire: "anthropic_messages", available: () => true, list: async () => [],
    stream: async (req: any) => {
      const info = MODELS.find((m) => m.model === req.model)!;
      const tokens = count(req);
      const refused = tokens > info.context;
      sent.push({ purpose: req.purpose, model: info.id, tokens, refused, messages: req.messages });
      if (refused) throw new ProviderError("context", `prompt is too long: ${tokens} tokens > ${info.context} maximum`, 400);
      const last = count({ system: "", messages: req.messages.slice(-1) });
      const out = reply?.(req, sent) ?? { blocks: [{ type: "text", text: req.purpose === "summary" ? "SUMMARY" : "ok" }], stop: "end_turn" };
      return { model: req.model, ...out, usage: { input: last, cache_read: tokens - last, cache_write: 0, output: 10, ...out.usage } };
    },
  };
  const info = (id: string) => MODELS.find((m) => m.id === id)!;
  const providers = { resolve: async (id: string) => ({ provider, info: info(id) }), models: async () => MODELS, current: () => MODELS };
  const errors = { capture: (_s: string, e: any) => { failures.push(e); return { id: "err", message: String(e?.message ?? e) }; } };
  const engine = new Engine(store, new Bus(), providers as any, errors as any, join(dir, "spill"));
  const session = (model: string) => store.createSession({ model, workspace: dir }).id;
  // The turn has ended, and so has the summary a long context gets prepared after it.
  const idle = async (id: string) => {
    await engine.idle(id);
    for (let n = 0; n < 400 && (engine as any).preparing.size; n++) await Bun.sleep(5);
  };
  const line = (id: string) => lineage(store.events(id), store.session(id)!.head);
  return { store, engine, sent, failures, session, line, idle, dir };
}

const words = (n: number, w = "lorem ") => w.repeat(Math.ceil(n / w.length)).slice(0, n);

// A hook adds a note for the model while the request is built, after the turn counted its context.
const noteHook = (r: ReturnType<typeof rig>, id: string, bytes: number) => {
  let done = false;
  registerHooks({
    beforeRequest(s, req) {
      if (s.id !== id || req.purpose !== "turn" || done) return req;
      done = true;
      r.store.append(id, "note", { model: true, text: words(bytes, "memory ") });
      return { ...req, messages: toMessages(r.line(id)) };
    },
  });
};

test("what a hook adds counts: the turn compacts to fit and goes on; what cannot be reduced is refused", async () => {
  const r = rig();
  const history = (id: string) => {
    r.store.append(id, "user", { text: "read it" });
    r.store.append(id, "assistant", { blocks: [{ type: "text", text: words(15_000) }], model: SMALL.id, stop: "end_turn", usage: { input: 10, cache_read: 100, cache_write: 0, output: 6_000 } });
  };
  // 6,100 tokens measured, under the compaction line; the hook's 12 KB note takes the request over the window.
  const a = r.session(SMALL.id);
  history(a);
  noteHook(r, a, 12_000);
  r.engine.send(a, "go on");
  await r.idle(a);
  expect(r.sent.filter((s) => s.refused)).toEqual([]);
  expect(r.sent.map((s) => s.purpose)).toEqual(["summary", "turn"]);
  expect(r.store.events(a).find((e) => e.kind === "compaction")?.data.trigger).toBe("threshold");
  expect(r.store.events(a).at(-1)?.data.reason).toBe("end_turn");
  expect(JSON.stringify(r.sent.at(-1)!.messages)).toContain("memory memory");
  // A note larger than the window itself stays over it after the history is summarized.
  r.sent.length = 0;
  const b = r.session(SMALL.id);
  history(b);
  noteHook(r, b, 30_000);
  r.engine.send(b, "go on");
  await r.idle(b);
  expect(r.sent.filter((s) => s.purpose === "turn" || s.refused)).toEqual([]);
  expect(r.failures.at(-1)?.code).toBe("context_over_window");
  expect(r.store.events(b).findLast((e) => e.kind === "turn_end")?.data.reason).toBe("error");
});

const lastText = (req: any): string => (req.messages.at(-1).content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("\n");
const text = (t: string, stop = "end_turn") => ({ blocks: [{ type: "text", text: t }], stop });

// Inside a turn, a summary that is cut at the output limit each time is said
// once and the turn goes on with the history whole. The same context is not
// summarized again by itself, on a later step or turn: each try reads all of
// it. Once a checkpoint lands, summaries are written as before.
test("a summary cut each time is asked for once per context, not on every step", async () => {
  let cut = true, turns = 0;
  const r = rig((req) => {
    if (req.purpose === "summary") return cut ? text("Goal: a summary the limit cut in the middle of a", "max_tokens") : text("WHOLE-SUMMARY");
    // The first three requests of the turn call a tool, so the turn takes four steps.
    return ++turns <= 3 ? { blocks: [{ type: "tool_use", id: `t${turns}`, name: "none", input: {} }], stop: "tool_use" } : undefined;
  });
  const id = r.session(SMALL.id);
  r.store.updateSession(id, { settings: { compact_at: 2_000 } });
  r.store.append(id, "user", { text: "read it" });
  r.store.append(id, "assistant", { blocks: [{ type: "text", text: words(15_000) }], model: SMALL.id, stop: "end_turn", usage: { input: 10, cache_read: 100, cache_write: 0, output: 6_000 } });
  r.engine.send(id, "go on");
  await r.idle(id);
  r.engine.send(id, "and again");
  await r.idle(id);
  const events = r.store.events(id);
  // One request and its two shorter retries, in two turns of five steps.
  expect(r.sent.filter((s) => s.purpose === "summary")).toHaveLength(3);
  expect(r.sent.filter((s) => s.purpose === "turn")).toHaveLength(5);
  expect(events.filter((e) => e.kind === "compaction")).toEqual([]);
  const said = events.filter((e) => e.kind === "note" && e.data.kind === "compaction_failed");
  expect(said).toHaveLength(1);
  expect(said[0]!.data.text).toContain("compact with a focus that asks for less, continue on a model that writes longer replies, or clear the context");
  expect(events.filter((e) => e.kind === "turn_end").map((e) => e.data.reason)).toEqual(["end_turn", "end_turn"]);
  // The owner's own request is still tried; its checkpoint lets summaries be prepared again.
  cut = false;
  expect((await r.engine.compactNow(id)).data.summary).toBe("WHOLE-SUMMARY");
  r.sent.length = 0;
  r.store.append(id, "assistant", { blocks: [{ type: "text", text: words(15_000) }], model: SMALL.id, stop: "end_turn", usage: { input: 10, cache_read: 100, cache_write: 0, output: 6_000 } });
  r.engine.send(id, "once more");
  await r.idle(id);
  expect(r.sent.filter((s) => s.purpose === "summary")).toHaveLength(1);
  expect(r.store.events(id).filter((e) => e.kind === "compaction")).toHaveLength(2);
});

// A summary request whose reply stopped because request and reply together
// passed the window is not asked for again shorter: the history is read as a
// transcript in parts instead.
test("a summary that filled the window is written from the transcript", async () => {
  const r = rig((req) => {
    if (req.purpose !== "summary") return undefined;
    return req.messages.length > 1 ? text("Goal: the window ended he", "model_context_window_exceeded") : text("FROM-THE-TRANSCRIPT");
  });
  const id = r.session(SMALL.id);
  r.store.append(id, "user", { text: "read it" });
  r.store.append(id, "assistant", { blocks: [{ type: "text", text: words(15_000) }], model: SMALL.id, stop: "end_turn", usage: { input: 10, cache_read: 100, cache_write: 0, output: 6_000 } });
  const cp = await r.engine.compactNow(id);
  expect(cp.data.summary).toBe("FROM-THE-TRANSCRIPT");
  // One request on the session's own messages, then one message a part.
  expect(r.sent.map((s) => s.messages.length)).toEqual([3, ...Array(cp.data.parts).fill(1)]);
});

// A history read as a transcript in parts. The summary of the parts so far
// goes with each next part: the request budget is the compaction share of the
// window, whatever size the model made that summary.
test("a long summary of the earlier parts and the next part fit the request budget", async () => {
  const budget = Math.floor(MID.context * 0.85);
  const long = (n: number) => `## Story\n${words(n, "carried ")}`;
  const imported = (r: ReturnType<typeof rig>) => {
    const id = r.session(MID.id);
    for (let n = 0; n < 8; n++) {
      r.store.append(id, "user", { text: `step ${n}` });
      r.store.append(id, "assistant", { blocks: [{ type: "text", text: words(15_000, `line ${n}\n`) }], stop: "end_turn" });
    }
    return id;
  };
  const partOf = (req: any) => Number(lastText(req).match(/this is part (\d+)/)?.[1] ?? 0);
  // 30 KB for the first part's summary, where 2.5 KB was planned: the rest is cut again to fit beside it.
  const r = rig((req) => (partOf(req) === 1 ? text(long(30_000)) : undefined));
  const a = imported(r);
  const cp = await r.engine.compactNow(a);
  expect(r.sent.filter((s) => s.refused)).toEqual([]);
  expect(Math.max(...r.sent.map((s) => s.tokens))).toBeLessThanOrEqual(budget);
  expect(cp.data.parts).toBeGreaterThan(4);
  expect(cp.data.summary).toBe("SUMMARY");
  expect(lastText({ messages: r.sent[1]!.messages })).toContain("carried carried");

  // A summary that leaves no room for a part is asked for again, shorter.
  const r2 = rig((req) => (partOf(req) === 1 ? text(long(37_000)) : undefined));
  const b = imported(r2);
  expect((await r2.engine.compactNow(b)).data.summary).toBe("SUMMARY");
  expect(lastText({ messages: r2.sent[1]!.messages })).toContain("too long to go with the next part");
  expect(r2.sent.filter((s) => s.refused)).toEqual([]);
  expect(Math.max(...r2.sent.map((s) => s.tokens))).toBeLessThanOrEqual(budget);

  // Each part has its own retries: a cut on three different parts is three second requests, and the summary is kept.
  const cutOnce = new Set<number>();
  const r4 = rig((req) => {
    const k = partOf(req);
    if (req.purpose !== "summary" || k > 3 || cutOnce.has(k)) return undefined;
    cutOnce.add(k);
    return text("cut in the middle of a", "max_tokens");
  });
  const d = imported(r4);
  const whole = await r4.engine.compactNow(d);
  expect(whole.data.summary).toBe("SUMMARY");
  expect(r4.sent).toHaveLength(whole.data.parts + 3);

  // One that stays too long: a bounded number of requests, then the branch is left as it was.
  const r3 = rig((req) => (req.purpose === "summary" ? text(long(37_000)) : undefined));
  const c = imported(r3);
  const head = r3.store.session(c)!.head;
  await expect(r3.engine.compactNow(c)).rejects.toMatchObject({ code: "summary_too_long", status: 409 });
  expect(r3.sent).toHaveLength(3);
  expect(r3.sent.filter((s) => s.refused)).toEqual([]);
  expect(r3.store.events(c).filter((e) => e.kind === "compaction")).toEqual([]);
  expect(r3.store.session(c)!.head).toBe(head);
});

// Cache warmth, on a fake clock: what counts as a request that kept this
// context's cache alive on the model's route decides when the idle summary is
// prepared and whether a turn that comes back finds the cache cold.
test("cache warmth follows the route and prefix a request used", async () => {
  const { setSystemTime } = await import("bun:test");
  const MIN = 60_000;
  const T0 = Date.UTC(2026, 0, 1);
  const r = rig();
  const usage = (u: Record<string, number>) => ({ input: 10, output: 2_000, cache_read: 0, cache_write: 0, ...u });
  // A long context whose first reply wrote the cache for an hour at T0, then what `later` adds at minute 50.
  const at = async (later?: (id: string, covered: string) => void, nowMin = 70) => {
    setSystemTime(new Date(T0));
    const id = r.session(BIG.id);
    r.store.updateSession(id, { settings: { compact_at: 2_000 } });
    r.store.append(id, "user", { text: "read the big file" });
    const reply = r.store.append(id, "assistant", { blocks: [{ type: "text", text: words(8_000) }], model: BIG.id, stop: "end_turn", usage: usage({ cache_write: 9_000, cache_write_1h: 9_000 }) });
    setSystemTime(new Date(T0 + 50 * MIN));
    later?.(id, reply.id);
    setSystemTime(new Date(T0 + nowMin * MIN));
    const st = await (r.engine as any).step(r.store.session(id), BIG.id);
    // The delay the idle timer is set with (the timer itself is not left running).
    let delay: number | undefined;
    const real = globalThis.setTimeout;
    (globalThis as any).setTimeout = (_f: unknown, ms: number) => { delay = ms; return real(() => {}, 0); };
    try { (r.engine as any).scheduleIdle(id, st); } finally { globalThis.setTimeout = real; }
    return { cold: (r.engine as any).cacheCold(id, r.line(id), st) as boolean, idleIn: delay === undefined ? undefined : Math.round(delay / MIN) };
  };
  const prepared = (data: Record<string, unknown>) => (id: string, covered: string) =>
    r.store.db.run("INSERT INTO prepared_summaries (session_id, covered, data, ts) VALUES (?, ?, ?, ?)", [id, covered, JSON.stringify({ mode: "summary", summary: "s", model: BIG.id, prepared_ms: Date.now(), ...data }), Date.now()]);
  const reply = (model: string, u: Record<string, number>) => (id: string) => {
    r.store.append(id, "user", { text: "more" });
    r.store.append(id, "assistant", { blocks: [{ type: "text", text: "ok" }], model, stop: "end_turn", usage: usage(u) });
  };
  try {
    // Nothing since minute 0. At minute 56 the cache is warm and its idle summary is due at once;
    // at minute 70 the hour has passed, and no idle summary is prepared from a cache that is gone.
    expect(await at(undefined, 56)).toEqual({ cold: false, idleIn: 0 });
    expect(await at()).toEqual({ cold: true, idleIn: undefined });
    // A summary prepared from a transcript sent another prefix: the cache it read is not this context's.
    expect((await at(prepared({ parts: 3, usage: usage({ cache_read: 500, cache_write: 100 }) }))).cold).toBe(true);
    // One on the session's own request that reported no cache activity read nothing either.
    expect((await at(prepared({ usage: usage({}) }))).cold).toBe(true);
    // One on the session's own request that read the cache kept it alive.
    expect((await at(prepared({ usage: usage({ cache_read: 9_000, cache_write: 200 }) }))).cold).toBe(false);
    // A reply with no reported cache activity, and another model's reply, do not move the clock.
    expect(await at(reply(BIG.id, {}))).toEqual({ cold: true, idleIn: undefined });
    expect(await at(reply(SMALL.id, { cache_read: 9_000 }))).toEqual({ cold: true, idleIn: undefined });
    // A cache hit on the same prefix does: warm until minute 110, the idle summary due 6 minutes before.
    expect(await at(reply(BIG.id, { cache_read: 9_000 }))).toEqual({ cold: false, idleIn: 34 });
  } finally {
    setSystemTime();
  }
});
