// A session on its way out (the owner archives or deletes it, and its commands are stopped first):
// with the real engine, since what starts a turn and what a turn does when its session is gone are its own.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "keel-closing-"));
process.env.KEEL_CONFIG_DIR ??= join(dir, "config"); // before any Keel source is loaded
const { Bus } = await import("../core/bus.ts");
const { Store } = await import("../core/store.ts");
const { allHooks, registerHooks } = await import("../engine/hooks.ts");
const { Engine } = await import("../engine/turn.ts");
const core = await import("./core.ts");

const store = new Store(join(dir, "state"));
const info = { id: "m:x", model: "x", name: "x", family: "gpt", context: 100_000, output: 64, efforts: [], tools: true };
const usage = { input: 1, output: 1, cache_read: 0, cache_write: 0 };
// A request of a session named here waits for the promise given for it.
const pauses = new Map<string, Promise<void>>();
let requests = 0;
const provider = {
  wire: "openai",
  stream: async (req: any) => { requests++; await pauses.get(req.sessionKey); return { blocks: [{ type: "text", text: "ok" }], usage, stop: "end_turn", model: "x" }; },
};
const captured: { message: string; context: any }[] = [];
const errors = { capture: (_s: string, e: unknown, context?: unknown) => { captured.push({ message: String((e as any)?.message ?? e), context }); return { id: "e", message: String(e) }; } };
const providers = { models: async () => [info], current: () => [info], resolve: async () => ({ provider, info }) };
const engine = new Engine(store, new Bus(), providers as any, errors as any, join(dir, "spill"));
(engine as any).step = async () => ({ provider, info, tools: [], system: "s", systemSplit: 0, native: false });
core.setDeps({ store, bus: new Bus(), errors, engine, providers } as any);
const hooksBefore = allHooks().length;
afterAll(() => { allHooks().length = hooksBefore; });
// As src/automation/index.ts wires them.
registerHooks({ turnEnd: (s) => core.afterTurn(s.id), closingOver: (id) => core.flush(id) });
const rejected: unknown[] = [];
const onRejection = (e: unknown) => void rejected.push(e);
process.on("unhandledRejection", onRejection);
afterAll(() => void process.off("unhandledRejection", onRejection));

const open = (title: string) => store.createSession({ model: "m:x", workspace: dir, title }).id;
const inputs = (id: string) => store.lineage(id).filter((e) => e.kind === "user").map((e) => String((e.data as any).text));
const wake = (id: string, text: string) => core.deliver(id, text, { kind: "harness", job: "b1" }, { onSent: () => void sent.push(text) });
const sent: string[] = [];

// The review's schedule: the archive (or the delete) stops the session's commands first; one of them
// ends, and its end is delivered while the session is neither archived nor removed yet.
test("what comes due while a session is archived or deleted starts no turn in it, and goes when it stays after all", async () => {
  const [archived, deleted, stays] = [open("Archived"), open("Deleted"), open("Stays")];
  const before = requests;
  await engine.whileClosing([archived], async () => {
    expect(wake(archived, "[harness] ended for the archived")).toBe(true);
    await Bun.sleep(20);
    store.updateSession(archived, { archived: true });
  });
  await engine.whileClosing([deleted], async () => {
    expect(wake(deleted, "[harness] ended for the deleted")).toBe(true);
    await Bun.sleep(20);
    store.deleteSession(deleted);
  });
  // A command of this one would not stop: the session is neither archived nor deleted, and gets what waited.
  await engine.whileClosing([stays], async () => {
    expect(wake(stays, "[harness] ended for the one that stays")).toBe(true);
    await Bun.sleep(20);
    expect(inputs(stays)).toEqual([]);
    expect(engine.isRunning(stays)).toBe(false);
  });
  await engine.idle(stays);
  await Bun.sleep(20);
  // It started a turn with a model request in the archived session, and one in the deleted one that then failed three times.
  expect(inputs(archived)).toEqual([]);
  expect(store.session(deleted)).toBeUndefined();
  expect(inputs(stays)).toEqual(["[harness] ended for the one that stays"]);
  expect(sent).toEqual(["[harness] ended for the one that stays"]);
  expect(requests - before).toBe(1);
  // Nothing is kept for a session that is restored later: what was due then is not sent weeks after.
  store.updateSession(archived, { archived: false });
  core.flush(archived);
  await Bun.sleep(20);
  expect(inputs(archived)).toEqual([]);
  expect(captured).toEqual([]);
  expect(rejected).toEqual([]);
});

test("a turn whose session is deleted under it ends without an error row and without a rejection nobody handles", async () => {
  const id = open("Gone mid-turn");
  let release!: () => void;
  pauses.set(id, new Promise<void>((r) => (release = r)));
  const before = requests;
  engine.send(id, "go");
  for (const until = Date.now() + 5000; requests === before && Date.now() < until;) await Bun.sleep(5);
  expect(engine.isRunning(id)).toBe(true);
  // Whatever lets a turn run in a session that is then removed (the owner's own prompt in the moment of a delete).
  store.deleteSession(id);
  release();
  for (const until = Date.now() + 5000; engine.isRunning(id) && Date.now() < until;) await Bun.sleep(5);
  await Bun.sleep(50);
  expect(engine.isRunning(id)).toBe(false);
  // It left "FOREIGN KEY constraint failed" twice (a provider error, and an unhandled rejection) and a third error.
  expect(captured).toEqual([]);
  expect(rejected).toEqual([]);
});
