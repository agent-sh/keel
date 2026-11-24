// A summary prepared ahead is put in place only when the context it leaves
// fits: a tool result that came after it was prepared can make the summary
// and what follows it as large as a context that needs compacting, and a fresh
// summary of the whole context is then written instead. The real engine and
// store; the model answers from the test (its counts are the test's to set).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { bytesPerToken, COMPACT_SHARE } from "./compact.ts";
import { allHooks } from "./hooks.ts";
import { Engine } from "./turn.ts";

const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; });
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const WINDOW = 20_000;
const LIMIT = Math.floor(WINDOW * COMPACT_SHARE);
const MODEL = { id: "p:m", provider: "p", model: "m", name: "M", family: "other", context: WINDOW, output: 4_000, efforts: [], billing: "per_token", price: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 } };
const said = (text: string, input = 1_000) => ({ blocks: [{ type: "text", text }], usage: { input, output: 10, cache_read: 0, cache_write: 0 }, stop: "end_turn", model: "m" });

function rig() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "prepared-fit-"));
  dirs.push(dir);
  const store = new Store(dir);
  const asked: string[] = [];
  const provider = {
    id: "p", available: () => true, list: async () => [],
    stream: async (req: any) => { asked.push(req.purpose ?? "turn"); return req.purpose === "summary" ? said("A fresh summary of the whole context.") : said("Done."); },
  };
  const providers = { resolve: async () => ({ provider, info: MODEL }), models: async () => [MODEL], current: () => [MODEL] };
  const engine = new Engine(store, new Bus(), providers as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }), recovered: () => {} } as any, join(dir, "spill"));
  (engine as any).systemOf = async () => ({ text: "A stand-in system prompt.", split: 0 });
  const s = store.createSession({ model: MODEL.id, workspace: dir, title: "Fit" });
  return { store, engine, s, asked };
}

// A session whose summary was prepared at 70% of the window, covering up to its first tool result;
// then one more step, its result `after` tokens long, takes the context to the compaction line.
function prepared(after: number, measured: number) {
  const r = rig();
  const { store, s } = r;
  const step = (id: string, input: number) => store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id, name: "Read", input: { path: "a.txt" } }], model: MODEL.id, usage: { input, output: 10, cache_read: 0, cache_write: 0 }, stop: "tool_use" });
  store.append(s.id, "user", { text: "Read the files." });
  step("c1", Math.round(WINDOW * 0.7));
  const first = store.append(s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: "c1", content: "short" }] });
  store.db.run("INSERT INTO prepared_summaries (session_id, covered, data, ts) VALUES (?, ?, ?, ?)", [s.id, first.id,
    JSON.stringify({ mode: "summary", summary: "The summary prepared ahead.", owner_messages: ["Read the files."], auto: true, ahead: true, trigger: "threshold", covered: first.id, tokens_before: Math.round(WINDOW * 0.7), model: MODEL.id, prepared_ms: Date.now() }), Date.now()]);
  step("c2", measured);
  store.append(s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: "c2", content: "x".repeat(Math.ceil(after * bytesPerToken(MODEL.id))) }] });
  return r;
}

const compactions = (store: Store, id: string) => store.events(id).filter((e) => e.kind === "compaction").map((e) => ({ ahead: !!e.data.ahead, trigger: e.data.trigger }));

test("a prepared summary that the history after it outgrew is not applied: a fresh one is written", async () => {
  // The result after the summary is half the compaction line.
  const { store, engine, s, asked } = prepared(Math.round(LIMIT * 0.5), Math.round(WINDOW * 0.72));
  engine.send(s.id, "Go on.");
  await engine.idle(s.id);
  expect(compactions(store, s.id)).toEqual([{ ahead: false, trigger: "threshold" }]);
  expect(asked.filter((p) => p === "summary")).toHaveLength(1);
  expect(store.events(s.id).findLast((e) => e.kind === "turn_end")?.data.reason).toBe("end_turn");
  expect(store.db.query("SELECT 1 FROM prepared_summaries WHERE session_id = ?").get(s.id)).toBeNull();
});

test("a prepared summary whose history after it fits is applied with no summary request", async () => {
  const { store, engine, s, asked } = prepared(500, LIMIT);
  engine.send(s.id, "Go on.");
  await engine.idle(s.id);
  expect(compactions(store, s.id)).toEqual([{ ahead: true, trigger: "threshold" }]);
  expect(asked.filter((p) => p === "summary")).toHaveLength(0);
  expect(store.events(s.id).findLast((e) => e.kind === "turn_end")?.data.reason).toBe("end_turn");
});
