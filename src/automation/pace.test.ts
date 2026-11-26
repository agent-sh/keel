// The pace of unattended turns with the real engine: what starts a turn, and what one input holds, are its own.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "keel-pace-"));
process.env.KEEL_CONFIG_DIR ??= join(dir, "config"); // before any Keel source is loaded
const { Bus } = await import("../core/bus.ts");
const { Store } = await import("../core/store.ts");
const { allHooks, registerHooks } = await import("../engine/hooks.ts");
const { Engine } = await import("../engine/turn.ts");
const core = await import("./core.ts");
const pace = await import("./pace.ts");

const store = new Store(join(dir, "state"));
const info = { id: "m:x", model: "x", name: "x", family: "gpt", context: 100_000, output: 64, efforts: [], tools: true };
const usage = { input: 1, output: 1, cache_read: 0, cache_write: 0 };
let requests = 0;
const provider = { wire: "openai", stream: async () => { requests++; return { blocks: [{ type: "text", text: "ok" }], usage, stop: "end_turn", model: "x" }; } };
const errors = { capture: (_s: string, e: unknown) => ({ id: "e", message: String(e) }) };
const providers = { models: async () => [info], current: () => [info], resolve: async () => ({ provider, info }) };
const bus = new Bus();
const engine = new Engine(store, bus, providers as any, errors as any, join(dir, "spill"));
(engine as any).step = async () => ({ provider, info, tools: [], system: "s", systemSplit: 0, native: false });
core.setDeps({ store, bus, errors, engine, providers } as any);
const hooksBefore = allHooks().length;
afterAll(() => { allHooks().length = hooksBefore; core.paceGate.reset?.(); });
// As src/automation/index.ts wires them.
registerHooks({ turnEnd: (s) => { pace.turnEnded(s.id); core.afterTurn(s.id); } });

const open = (pace_min: number) => store.createSession({ model: "m:x", workspace: dir, title: "Paced", settings: { pace_min } }).id;
const prompts = (id: string) => store.lineage(id).filter((e) => e.kind === "user").map((e) => String((e.data as any).text));
const report = (id: string, text: string, by?: number) => core.deliver(id, text, { kind: "subagent" }, { pace: by !== undefined ? { by } : {} });
const until = async (f: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await Bun.sleep(5); return f(); };

test("inputs within the pace wait and go as one turn; an urgent one takes them at once", async () => {
  const id = open(5);
  report(id, "first");
  expect(await until(() => prompts(id).length === 1 && !engine.isRunning(id))).toBe(true);
  await engine.idle(id);
  const before = requests;
  report(id, "second");
  report(id, "third");
  await Bun.sleep(50);
  expect(prompts(id)).toEqual(["first"]);
  expect(requests).toBe(before);
  expect(pace.view(id)).toMatchObject({ pace_min: 5, from: "session", waiting: 2 });
  // A failure (no pace) goes now, and the two that waited go in the same input.
  core.deliver(id, "failed", { kind: "failures" });
  expect(await until(() => prompts(id).length === 2)).toBe(true);
  expect(prompts(id)[1]).toBe("second\n\nthird\n\nfailed");
  await engine.idle(id);
  expect(pace.view(id)).toMatchObject({ waiting: 0, joined: 2 });
});

test("nothing waits past its own deadline", async () => {
  const id = open(5);
  report(id, "first");
  expect(await until(() => prompts(id).length === 1 && !engine.isRunning(id))).toBe(true);
  await engine.idle(id);
  report(id, "due soon", Date.now() + 80);
  await Bun.sleep(20);
  expect(prompts(id)).toHaveLength(1);
  expect(await until(() => prompts(id).length === 2)).toBe(true);
  expect(prompts(id)[1]).toBe("due soon");
});

test("after a turn of the owner's words an input goes at once, and a pace of 0 never holds", async () => {
  const id = open(5);
  engine.send(id, "the owner's question");
  expect(await until(() => prompts(id).length === 1 && !engine.isRunning(id))).toBe(true);
  await engine.idle(id);
  report(id, "a report after it");
  expect(await until(() => prompts(id).length === 2)).toBe(true);
  await engine.idle(id);
  // That turn was unattended: the next waits, until the owner turns the pace off.
  report(id, "held");
  await Bun.sleep(30);
  expect(prompts(id)).toHaveLength(2);
  store.updateSession(id, { settings: { pace_min: 0 } });
  pace.onSession(store.session(id)!);
  expect(await until(() => prompts(id).length === 3)).toBe(true);
});
