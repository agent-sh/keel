// The request as it is finally built is held to the window of the model it
// goes to. A counting stand-in takes the provider's place: it counts each
// request it is sent (system and messages at 2.5 bytes a token) and refuses
// one over its window, so a test can show that none reached it oversized.
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
  for (const m of [BIG, SMALL]) setRatio(m.id, 2.5);
  const store = new Store(dir);
  const sent: Sent[] = [];
  const failures: any[] = [];
  const provider = {
    id: "ctx", wire: "anthropic_messages", available: () => true, list: async () => [],
    stream: async (req: any) => {
      const info = [BIG, SMALL].find((m) => m.model === req.model)!;
      const tokens = count(req);
      const refused = tokens > info.context;
      sent.push({ purpose: req.purpose, model: info.id, tokens, refused, messages: req.messages });
      if (refused) throw new ProviderError("context", `prompt is too long: ${tokens} tokens > ${info.context} maximum`, 400);
      const last = count({ system: "", messages: req.messages.slice(-1) });
      const out = reply?.(req, sent) ?? { blocks: [{ type: "text", text: req.purpose === "summary" ? "SUMMARY" : "ok" }], stop: "end_turn" };
      return { model: req.model, ...out, usage: { input: last, cache_read: tokens - last, cache_write: 0, output: 10, ...out.usage } };
    },
  };
  const info = (id: string) => [BIG, SMALL].find((m) => m.id === id)!;
  const providers = { resolve: async (id: string) => ({ provider, info: info(id) }), models: async () => [BIG, SMALL], current: () => [BIG, SMALL] };
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

test("an oversized first input is refused before it is sent, as context_over_window", async () => {
  const r = rig();
  const id = r.session(SMALL.id);
  r.engine.send(id, words(40_000)); // 16,000 tokens for a window of 10,000, and nothing to compact
  await r.idle(id);
  // No turn request went out; the summary prepared after the turn is read in parts that fit.
  expect(r.sent.filter((s) => s.purpose === "turn" || s.refused)).toEqual([]);
  expect(r.failures.map((e) => e.code)).toEqual(["context_over_window"]);
  const events = r.store.events(id);
  expect(events.find((e) => e.kind === "error")?.data.message).toContain("was not sent");
  expect(events.findLast((e) => e.kind === "turn_end")?.data.reason).toBe("error");
});

test("a session moved to a smaller model compacts on that model's count and goes on", async () => {
  const r = rig();
  const id = r.session(BIG.id);
  // 45 KB of history the big model measured in its own tokens (a third of what the small one counts).
  for (let n = 0; n < 3; n++) {
    r.store.append(id, "user", { text: `step ${n}` });
    r.store.append(id, "assistant", { blocks: [{ type: "text", text: words(15_000) }], model: BIG.id, stop: "end_turn", usage: { input: 10, cache_read: (n + 1) * 2_000, cache_write: 0, output: 2_000 } });
  }
  r.store.updateSession(id, { model: SMALL.id });
  r.engine.send(id, "and now?");
  await r.idle(id);
  expect(r.sent.filter((s) => s.refused)).toEqual([]);
  expect(Math.max(...r.sent.map((s) => s.tokens))).toBeLessThanOrEqual(SMALL.context);
  const events = r.store.events(id);
  expect(events.filter((e) => e.kind === "compaction").map((e) => e.data.trigger)).toEqual(["threshold"]);
  expect(events.at(-1)?.data.reason).toBe("end_turn");
  expect(JSON.stringify(r.sent.findLast((s) => s.purpose === "turn")!.messages)).toContain("and now?");
});

test("a side question whose words overflow the window is refused, and one that fits is answered", async () => {
  const r = rig();
  const id = r.session(SMALL.id);
  r.engine.send(id, "hello");
  await r.idle(id);
  r.sent.length = 0;
  const ask = (text: string) => r.engine.ask(id, [{ role: "user", content: [{ type: "text", text }] }], new AbortController().signal);
  await expect(ask(words(30_000))).rejects.toMatchObject({ code: "context_over_window", status: 409 });
  expect(r.sent).toEqual([]);
  expect((await ask("a short one")).model_id).toBe(SMALL.id);
  expect(r.sent.map((s) => [s.purpose, s.refused])).toEqual([["side", false]]);
});

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
