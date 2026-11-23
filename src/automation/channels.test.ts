// An event pushed into a session, with the real engine and store: what the
// sender is told when it sends an id again, past the rate, and into a session
// whose queue another's stop holds.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "keel-channels-"));
process.env.KEEL_CONFIG_DIR ??= join(dir, "config"); // before any Keel source is loaded
const { Bus } = await import("../core/bus.ts");
const { Store } = await import("../core/store.ts");
const { Engine } = await import("../engine/turn.ts");
const { PER_MINUTE } = await import("../mcp/channel.ts");
const core = await import("./core.ts");
const channels = await import("./channels.ts");

const store = new Store(join(dir, "state"));
const bus = new Bus();
const info = { id: "m:x", model: "x", name: "x", family: "gpt", context: 100_000, output: 64, efforts: [], tools: true };
const provider = { wire: "openai", stream: async () => ({ blocks: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, stop: "end_turn", model: "x" }) };
const errors = { capture: (_s: string, e: unknown) => ({ id: "e", message: String((e as any)?.message ?? e) }) };
const providers = { models: async () => [info], current: () => [info], resolve: async () => ({ provider, info }) };
const engine = new Engine(store, bus, providers as any, errors as any, join(dir, "spill"));
(engine as any).step = async () => ({ provider, info, tools: [], system: "s", systemSplit: 0, native: false });
core.setDeps({ store, bus, errors, engine, providers } as any);
channels.migrate();

const open = (title: string) => store.createSession({ model: "m:x", workspace: dir, title }).id;
let n = 0;
const src = () => ({ key: `test:${++n}`, name: "chat", via: "mcp" as const });

test("the same id with the same words is a duplicate, with other words it is refused", async () => {
  const s = open("dup");
  const from = src();
  engine.holdQueue(s, "owner"); // nothing runs: the event waits
  const first = await channels.push(from, [s], { content: "build 1 failed", meta: { event_id: "b1" } });
  expect(first.outcomes[0]).toMatchObject({ state: "held", by: "owner" });
  expect((await channels.push(from, [s], { content: "build 1 failed", meta: { event_id: "b1" } })).outcomes[0]!.state).toBe("duplicate");
  const other = (await channels.push(from, [s], { content: "build 1 passed", meta: { event_id: "b1" } })).outcomes[0]!;
  expect(other.state).toBe("refused");
  expect(other.reason).toContain("used for another event");
  expect(store.queue(s)).toHaveLength(1);
});

test("a resend of a stored event is a duplicate past the rate, and the rate refuses only what is new", async () => {
  const s = open("rate");
  const from = src();
  engine.holdQueue(s, "owner");
  for (let i = 0; i < PER_MINUTE; i++) expect((await channels.push(from, [s], { content: `e${i}`, meta: { event_id: `e${i}` } })).outcomes[0]!.state).toBe("held");
  expect((await channels.push(from, [s], { content: "e0", meta: { event_id: "e0" } })).outcomes[0]!.state).toBe("duplicate");
  const over = (await channels.push(from, [s], { content: "new", meta: { event_id: "new" } })).outcomes[0]!;
  expect(over).toMatchObject({ state: "refused", reason: `it sent more than ${PER_MINUTE} events in a minute` });
  expect(store.queue(s)).toHaveLength(PER_MINUTE);
});

test("an event behind a hold that is not the owner's says whose stop it waits behind", async () => {
  const s = open("parent");
  engine.holdQueue(s, "parent");
  const o = (await channels.push(src(), [s], { content: "deploy done" })).outcomes[0]!;
  expect(o).toEqual({ session: s, state: "held", by: "parent", reason: "its parent stopped this session" });
});
