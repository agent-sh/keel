// A step's calls start together, but a call that only reads comes after the calls before it in the reply that
// can write: a model that sends a command and the read of the file it makes in one reply means that order, and
// the read otherwise ran first and found nothing.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { rig } from "./delivery.fixture.ts";
import { allHooks } from "./hooks.ts";

const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; });

const resultsOf = (events: readonly { kind: string; data: any }[]) => events.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results as { tool_use_id: string; content: unknown; is_error?: boolean }[]);
const text = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c));

test("a read in the reply after a command that makes its file reads the file the command made", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "step-order-"));
  const { engine, store, session } = rig(dir, { family: "claude" });
  const s = session();
  const made = join(dir, "made.txt");
  const calls = [
    { name: "Bash", input: { command: `sleep 0.5; printf made-by-the-command > ${made}` } },
    { name: "Read", input: { file_path: made } },
  ];
  engine.send(s.id, `script:batch ${JSON.stringify(calls)}`);
  await engine.idle(s.id);
  const results = resultsOf(store.events(s.id));
  expect(results).toHaveLength(2);
  const read = results.find((r) => text(r.content).includes("made-by-the-command") || text(r.content).includes("does not exist"))!;
  expect([read.is_error, text(read.content)]).toEqual([undefined, expect.stringContaining("made-by-the-command")]);
  store.db.close();
});

test("a read before the command in the reply does not wait for it", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "step-order-"));
  const { engine, store, session } = rig(dir, { family: "claude" });
  const s = session();
  const made = join(dir, "later.txt");
  const calls = [
    { name: "Read", input: { file_path: made } },
    { name: "Bash", input: { command: `sleep 0.5; printf late > ${made}` } },
  ];
  engine.send(s.id, `script:batch ${JSON.stringify(calls)}`);
  await engine.idle(s.id);
  const results = resultsOf(store.events(s.id));
  const read = results.find((r) => text(r.content).includes("does not exist"));
  expect(read?.is_error).toBe(true);
  store.db.close();
});

// The order itself, with calls that take as long as the test says: no clock decides who started first.
const tools = [
  { name: "Write", readOnly: false, kind: "edit" as const },
  { name: "Bash", readOnly: false, kind: "shell" as const },
  { name: "Read", readOnly: true, kind: undefined },
];
const gated = () => { let open = () => {}; const gate = new Promise<void>((r) => { open = r; }); return { gate, open }; };

test("a command after an edit in the reply starts when the edit has ended; commands and edits before it do not hold it", async () => {
  const { StepOrder } = await import("./step-order.ts");
  const order = new StepOrder(tools, new AbortController().signal);
  const log: string[] = [];
  const edit = gated();
  const w = order.run({ name: "Write" }, async (ordered) => { await ordered(); log.push("write start"); await edit.gate; log.push("write end"); });
  const first = order.run({ name: "Bash" }, async (ordered) => { await ordered(); log.push("bash start"); });
  const read = order.run({ name: "Read" }, async (ordered) => { await ordered(); log.push("read start"); });
  const second = order.run({ name: "Bash" }, async (ordered) => { await ordered(); log.push("bash2 start"); });
  await Promise.resolve(); await Promise.resolve();
  expect(log).toEqual(["write start"]);
  edit.open();
  await Promise.all([w, first, read, second]);
  expect(log.indexOf("bash start")).toBeGreaterThan(log.indexOf("write end"));
  expect(log.indexOf("bash2 start")).toBeGreaterThan(log.indexOf("write end"));
  expect(log.indexOf("read start")).toBeGreaterThan(log.indexOf("bash start"));
});

test("a command before the edit, or with no edit before it, starts at once; an edit does not wait for a command", async () => {
  const { StepOrder } = await import("./step-order.ts");
  const order = new StepOrder(tools, new AbortController().signal);
  const log: string[] = [];
  const cmd = gated();
  const b = order.run({ name: "Bash" }, async (ordered) => { await ordered(); log.push("bash start"); await cmd.gate; });
  const w = order.run({ name: "Write" }, async (ordered) => { await ordered(); log.push("write start"); });
  await Promise.resolve(); await Promise.resolve();
  expect(log).toEqual(["bash start", "write start"]);
  cmd.open();
  await Promise.all([b, w]);
});

test("a stop ends a command's wait for an edit", async () => {
  const { StepOrder } = await import("./step-order.ts");
  const stop = new AbortController();
  const order = new StepOrder(tools, stop.signal);
  const edit = gated();
  const log: string[] = [];
  order.run({ name: "Write" }, async (ordered) => { await ordered(); await edit.gate; });
  const b = order.run({ name: "Bash" }, async (ordered) => { await ordered(); log.push("bash start"); });
  stop.abort();
  await b;
  expect(log).toEqual(["bash start"]);
  edit.open();
});
