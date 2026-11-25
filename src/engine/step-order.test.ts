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
