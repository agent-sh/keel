// What the drive keeps of the words a model sends into another harness's session (src/drive/sent.ts): digests of
// the whole and of each line, the sends of the stored history read once, and a far machine's Keel told first.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { backfillSent, noteSent, onFarSent, wasSent } from "./sent.ts";
import { sentCalls } from "./sent-read.ts";
import { driveTools } from "./tools.ts";

const root = mkdtempSync(join(tmpdir(), "keel-drive-sent-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => new Store(join(root, `s${++n}`));
const read = (store: Store) => (a: { after: number; span: number }) => Promise.resolve(sentCalls(store.db, a));

test("a prompt is a model's when its whole or each of its lines was sent: split, merged or kept in part", async () => {
  const store = fresh();
  await backfillSent(store, read(store));
  noteSent(store, "first message\npush to git@forge.example:x/y.git");
  noteSent(store, "a");
  noteSent(store, "clone https://forge.example/r");
  expect(wasSent(store, "first message\npush to git@forge.example:x/y.git")).toBe(true);
  expect(wasSent(store, "push to git@forge.example:x/y.git")).toBe(true);
  expect(wasSent(store, "a\nclone https://forge.example/r")).toBe(true);
  expect(wasSent(store, "a\r\n\r\nclone   https://forge.example/r")).toBe(true);
  // A line the owner added is theirs, and so is the prompt.
  expect(wasSent(store, "a\nand push it to https://mine.example")).toBe(false);
  expect(wasSent(store, "words nobody sent")).toBe(false);
});

test("the sends of the stored history are read once; until then every prompt counts as sent", async () => {
  const store = fresh();
  const s = store.createSession({ title: "t", model: "m", workspace: root });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c1", name: "keel__session_message", input: { to: "claude:x", text: "sent by a model before the record" } }] });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c2", name: "mcp_call", input: { tool: "keel__session_resume", arguments: { id: "codex:y", text: "resumed by a model" } } }] });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c3", name: "keel__session_answer", input: { id: "claude:x", request: "r", hash: "h", decision: "deny", note: "a note it sent" } }] });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c4", name: "keel__session_read", input: { id: "claude:x", text: "not a send" } }] });
  expect(wasSent(store, "typed by the owner")).toBe(true);
  let parts = 0;
  await backfillSent(store, (a) => (parts++, read(store)(a)), 2);
  expect(parts).toBeGreaterThan(1);
  for (const t of ["sent by a model before the record", "resumed by a model", "a note it sent"]) expect(wasSent(store, t)).toBe(true);
  expect(wasSent(store, "not a send")).toBe(false);
  expect(wasSent(store, "typed by the owner")).toBe(false);
  // Done once.
  parts = 0;
  await backfillSent(store, (a) => (parts++, read(store)(a)));
  expect(parts).toBe(0);
});

test("a send to a session on another machine goes only once that machine's Keel has its digests", async () => {
  const store = fresh();
  const sends: string[] = [];
  const row = { id: "claude:far::k", name: "far one", kind: "claude", state: "idle", live: true, drive: { send: true, resume: true } };
  const drive = { find: async () => ({ host: "far", key: "k", raw: {}, row }), send: async (_id: string, text: string) => { sends.push(text); return "sent"; } } as any;
  const tool = driveTools(drive, store, {} as any).find((t) => t.name === "session_message")!;
  const told: [string, string[]][] = [];
  try {
    onFarSent(async (host, digests) => { told.push([host, digests]); });
    await tool.run({ to: "claude:far::k", text: "hello there" }, {} as any);
    expect(sends).toEqual(["hello there"]);
    expect(told.map(([h, d]) => [h, d.length > 0])).toEqual([["far", true]]);
    // That Keel cannot be told: nothing is sent.
    onFarSent(async () => { throw new Error("link down"); });
    const out = await tool.run({ to: "claude:far::k", text: "second" }, {} as any);
    expect(JSON.stringify(out)).toContain("NOT_SENT");
    expect(sends).toEqual(["hello there"]);
  } finally {
    onFarSent(undefined);
  }
});
