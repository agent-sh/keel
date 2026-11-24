// A stop keeps the items the stream finished (its text and each whole tool call), gives every kept call
// an aborted result, and drops what was still streaming.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "./hooks.ts";
import { Engine, streamedItems, toMessages } from "./turn.ts";

const hooksAtStart = allHooks().length;
const dirs: string[] = [];
afterAll(() => { allHooks().length = hooksAtStart; for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const BIG = { id: "p:big", provider: "p", model: "big", name: "big", family: "other", context: 100_000, output: 4_000, efforts: [], billing: "per_token", price: { input: 1, output: 5 } };

test("streamedItems keeps text and whole calls, and drops the call still streaming", () => {
  const items = streamedItems(new Map<number, any>([
    [0, { kind: "thinking", text: "hmm" }],
    [1, { kind: "text", text: "Looking." }],
    [2, { kind: "tool_input", name: "Bash", text: '{"command":"ls"}', done: true }],
    [3, { kind: "tool_input", name: "Bash", text: '{"command":"p' }],
  ]), ["Bash"]);
  expect(items.map((b: any) => [b.type, b.text ?? b.input])).toEqual([["text", "Looking."], ["tool_use", { command: "ls" }]]);
  // a call the model has no tool for is not kept
  expect(streamedItems(new Map<number, any>([[0, { kind: "tool_input", name: "Gone", text: "{}", done: true }]]), ["Bash"])).toEqual([]);
});

test("a stop after one whole call and in the middle of a second keeps the text and the first call, aborted", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "item-stop-"));
  dirs.push(dir);
  const store = new Store(dir);
  const reached = Promise.withResolvers<void>();
  const provider = {
    id: "p", wire: "anthropic_messages", available: () => true, list: async () => [],
    stream: async (req: any, onDelta: (d: any) => void) => {
      onDelta({ kind: "text", index: 0, text: "Let me look." });
      onDelta({ kind: "tool_input", index: 1, text: "", name: "Bash" });
      onDelta({ kind: "tool_input", index: 1, text: '{"command":"ls"}', name: "Bash" });
      onDelta({ kind: "tool_input", index: 2, text: "", name: "Bash" });
      onDelta({ kind: "tool_input", index: 2, text: '{"command":"cat sec', name: "Bash" });
      reached.resolve();
      await new Promise<void>((_, reject) => req.signal.addEventListener("abort", () => reject(Object.assign(new Error("interrupted"), { name: "AbortError" })), { once: true }));
    },
  };
  const providers = { resolve: async () => ({ provider, info: BIG }), models: async () => [BIG], current: () => [BIG] };
  const engine = new Engine(store, new Bus(), providers as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }), recovered: () => {} } as any, join(dir, "spill"));
  (engine as any).systemOf = async () => ({ text: "A stand-in system prompt.", split: 0 });
  const s = store.createSession({ model: BIG.id, workspace: dir });
  engine.send(s.id, "list the files");
  await reached.promise;
  await engine.interrupt(s.id, "owner");
  await engine.idle(s.id);
  const events = engine.lineage(s.id);
  const asked = events.filter((e) => e.kind === "assistant");
  expect(asked).toHaveLength(1);
  const blocks = (asked[0]!.data as any).blocks;
  expect(blocks.map((b: any) => b.type)).toEqual(["text", "tool_use"]);
  expect(blocks[1].input).toEqual({ command: "ls" });
  const result = events.find((e) => e.kind === "tool_result")!.data as any;
  expect(result.results[0]).toMatchObject({ tool_use_id: blocks[1].id, is_error: true, content: "Interrupted by the user before this tool ran." });
  expect(JSON.stringify(events.map((e) => e.data))).not.toContain("cat sec");
  // The history a next request sends pairs the call with its result.
  const m = toMessages(events);
  expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
  expect((m[2]!.content[0] as any).tool_use_id).toBe(blocks[1].id);
  store.db.close();
});
