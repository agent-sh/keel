// Cursor Agent's store, built in its real layout with invented content: a chat database
// (chats/<md5 of the workspace>/<agent>/store.db: a meta row and content addressed blobs, the root a
// protobuf of message ids), a subagent's database, and transcripts for sessions that have no database.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv, tempTree } from "../../../test/env.ts";
import { cursorStore } from "./cursor.ts";

const home = tempTree("keel-cursor-");
const work = join(tempTree("keel-cursor-work-"), "mango-notes");
mkdirSync(work, { recursive: true });
ownEnv({ KEEL_IMPORT_CURSOR_DIR: home });

// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

const varint = (n: number) => { const o: number[] = []; for (;;) { const c = n % 128; n = Math.floor(n / 128); if (n) o.push(c | 128); else { o.push(c); return Buffer.from(o); } } };
const field = (f: number, v: Buffer | string | number) => typeof v === "number" ? Buffer.concat([varint(f * 8), varint(v)]) : Buffer.concat([varint(f * 8 + 2), varint(Buffer.byteLength(v)), Buffer.from(v)]);

type Msg = Record<string, unknown>;
function chat(opts: { agent: string; cwd: string; name?: string; messages: Msg[]; archived?: { messages: Msg[]; summary: string }; sub?: string; started?: number }) {
  const dir = join(home, "chats", md5(opts.cwd), opts.agent);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "store.db"), { create: true });
  db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  const put = (data: Buffer) => { const id = sha(data); db.query("INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)").run(id, data); return id; };
  const idsOf = (ms: Msg[]) => ms.map((m) => put(Buffer.from(JSON.stringify(m))));
  const rootIds = idsOf(opts.messages);
  let root = Buffer.concat(rootIds.map((i) => field(1, Buffer.from(i, "hex"))));
  if (opts.archived) {
    const arch = Buffer.concat([...idsOf(opts.archived.messages).map((i) => field(1, Buffer.from(i, "hex"))), field(2, opts.archived.summary), field(3, 0)]);
    root = Buffer.concat([root, field(13, Buffer.from(put(arch), "hex"))]);
  }
  root = Buffer.concat([root, field(9, `file://${opts.cwd}`), field(22, "cli"), field(26, opts.started ?? 1_790_000_000_000)]);
  const rootId = put(root);
  const meta: any = { agentId: opts.agent, latestRootBlobId: rootId, name: opts.name ?? "New Agent", mode: "default", createdAt: opts.started ?? 1_790_000_000_000, lastUsedModel: "composer-fruit" };
  if (opts.sub) meta.subagentInfo = { parentAgentId: opts.sub, rootParentAgentId: opts.sub, toolCallId: "tc", typeName: "explore" };
  db.query("INSERT INTO meta (key, value) VALUES ('0', ?)").run(Buffer.from(JSON.stringify(meta)).toString("hex"));
  db.close();
  return join(dir, "store.db");
}

const user = (text: string, extra: unknown[] = []) => ({ role: "user", content: [{ type: "text", text: `<timestamp>Monday, Nov 2, 2026, 9:30 AM (UTC+2)</timestamp>\n<user_query>\n${text}\n</user_query>` }, ...extra], providerOptions: { cursor: { requestId: "r" } } });
const context = { role: "user", content: "<user_info>\nOS: linux\n</user_info>\n<git_status>\nclean\n</git_status>\n<rules>\nbe brief\n</rules>" };
const reason = { type: "redacted-reasoning", data: "Zm9v", providerOptions: { cursor: { modelName: "composer-fruit" } } };
const call = (id: string, toolName: string, args: unknown) => ({ type: "tool-call", toolCallId: id, toolName, args });
const done = (id: string, toolName: string, text: string, isError = false) => ({
  role: "tool", id,
  content: [{ type: "tool-result", toolCallId: id, toolName, result: text, experimental_content: [{ type: "text", text }] }],
  providerOptions: { cursor: { highLevelToolCallResult: { output: isError ? { error: { error: text } } : { success: {} }, isError } } },
});

const MAIN = "11111111-aaaa-4bbb-8ccc-000000000001";
const SUB = "22222222-aaaa-4bbb-8ccc-000000000002";
const COMPACT = "33333333-aaaa-4bbb-8ccc-000000000003";
chat({
  agent: MAIN, cwd: work, name: "Mango notes",
  messages: [
    { role: "system", content: "You are a coding agent." },
    context,
    user("Add a ripeness check to mango.py"),
    { role: "assistant", content: [reason, { type: "text", text: "I will read the file first." }, call("call_read", "Read", { path: "mango.py" }), call("call_missing", "Read", { path: "gone.py" })], id: "1" },
    done("call_read", "Read", "def ripe(m): return m.color == 'gold'"),
    done("call_missing", "Read", "no such file: gone.py", true),
    { role: "assistant", content: [reason, call("call_shell", "Shell", { command: "python mango.py" })], id: "2" },
    { role: "tool", id: "call_shell", content: [{ type: "tool-result", toolCallId: "call_shell", toolName: "Shell", result: "shot", experimental_content: [{ type: "text", text: "see picture" }, { type: "image", data: PNG, mimeType: "image/png" }] }], providerOptions: { cursor: { highLevelToolCallResult: { output: { success: {} }, isError: false } } } },
    { role: "assistant", content: [reason, { type: "text", text: "The check works." }], id: "3" },
    user("Now look at this ripe mango", [{ type: "image", image: PNG, mediaType: "image/png" }]),
    { role: "assistant", content: [{ type: "text", text: "It looks ripe." }, call("call_open", "Read", { path: "end.py" })], id: "4" },
  ],
});
chat({ agent: SUB, cwd: work, sub: MAIN, messages: [{ role: "system", content: "sub" }, user("Find the mango tests"), { role: "assistant", content: [{ type: "text", text: "None found." }], id: "1" }], started: 1_790_000_100_000 });
chat({
  agent: COMPACT, cwd: work, started: 1_790_000_200_000,
  archived: { summary: "The owner asked about papayas; a seed check was added.", messages: [user("Plan a papaya seed check"), { role: "assistant", content: [{ type: "text", text: "Planned." }], id: "1" }] },
  messages: [{ role: "system", content: "x" }, { role: "user", content: [{ type: "text", text: "Summary of the conversation:\nThe owner asked about papayas; a seed check was added." }] }, user("Run the papaya check"), { role: "assistant", content: [{ type: "text", text: "Done." }], id: "2" }],
});
// A database with no prompt in it holds no conversation.
chat({ agent: "44444444-aaaa-4bbb-8ccc-000000000004", cwd: work, messages: [{ role: "system", content: "x" }] });

// A transcript of a session that has no database: the words and the calls, no ids, no results.
const slug = work.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
const TR = "55555555-aaaa-4bbb-8ccc-000000000005";
const TS = "66666666-aaaa-4bbb-8ccc-000000000006";
const tdir = join(home, "projects", slug, "agent-transcripts", TR);
mkdirSync(join(tdir, "subagents"), { recursive: true });
const jl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
writeFileSync(join(tdir, `${TR}.jsonl`), jl([
  { role: "user", message: { content: [{ type: "text", text: "<timestamp>Tuesday, Nov 3, 2026, 4:05 PM (UTC+2)</timestamp>\n<user_query>\nList the plums\n</user_query>" }] } },
  { role: "assistant", message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", name: "Glob", input: { glob_pattern: "plum*" } }] } },
  { role: "assistant", message: { content: [{ type: "text", text: "Found two plums." }] } },
  { type: "turn_ended", status: "error", error: "limit reached" },
]));
writeFileSync(join(tdir, "subagents", `${TS}.jsonl`), jl([
  { role: "user", message: { content: [{ type: "text", text: "<user_query>\nCount the plums\n</user_query>" }] } },
  { role: "assistant", message: { content: [{ type: "text", text: "Two." }] } },
]));
writeFileSync(join(tdir, "damaged.jsonl"), "not json\n");

// The walk calls again until nothing is left unread.
const found = () => { for (let i = 0; i < 1000; i++) { const r = cursorStore.list(); if (!cursorStore.pending?.()) return r; } throw new Error("never settled"); };
const byId = (id: string) => found().find((f) => f.id === id)!;

test("the store is the folder named by the environment", () => {
  expect(cursorStore.store()).toBe(home);
});

test("lists databases and transcripts, newest first, a database without a prompt left out", () => {
  const rows = found();
  expect(rows.map((r) => r.id).sort()).toEqual([MAIN, SUB, COMPACT, TR, TS].sort());
  expect(rows.every((r) => r.harness === "cursor")).toBe(true);
  for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.updated_ms).toBeGreaterThanOrEqual(rows[i]!.updated_ms);
  const main = byId(MAIN);
  expect(main.title).toBe("Mango notes");
  expect(main.cwd).toBe(work);
  expect(main.model).toBe("composer-fruit");
  expect(main.first_prompt).toBe("Add a ripeness check to mango.py");
  expect(main.last_prompt).toBe("Now look at this ripe mango");
  expect(main.kind).toBe("interactive");
  expect(main.path.endsWith("store.db")).toBe(true);
  // A default name gives way to the first prompt.
  expect(byId(SUB).title).toBe("Find the mango tests");
  expect(byId(SUB)).toMatchObject({ kind: "subagent", parent_id: MAIN });
  expect(byId(TR)).toMatchObject({ title: "List the plums", cwd: work, kind: "interactive" });
  expect(byId(TS)).toMatchObject({ kind: "subagent", parent_id: TR });
});

test("a repeat listing reads again only what changed", () => {
  const a = found().find((f) => f.id === MAIN)!;
  const b = found().find((f) => f.id === MAIN)!;
  expect(b).toBe(a);
  expect(cursorStore.pending?.()).toBe(0);
});

test("reads a database whole: prompts, replies, calls and results in order, errors flagged, images kept", async () => {
  const r = await cursorStore.read(byId(MAIN));
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant", "tool_result", "assistant", "tool_result", "assistant", "user", "assistant", "tool_result"]);
  expect(r.events[0]!.data.text).toBe("Add a ripeness check to mango.py");
  const first = r.events[1]!.data.blocks;
  expect(first.map((b: any) => b.type)).toEqual(["text", "tool_use", "tool_use"]);
  expect(first[1]).toMatchObject({ id: "call_read", name: "Read", input: { path: "mango.py" } });
  const results = r.events[2]!.data.results;
  expect(results.map((x: any) => x.tool_use_id)).toEqual(["call_read", "call_missing"]);
  expect(results[0]).toMatchObject({ content: "def ripe(m): return m.color == 'gold'" });
  expect(results[0].is_error).toBeUndefined();
  expect(results[1]).toMatchObject({ content: "no such file: gone.py", is_error: true });
  // An image in a result stays beside its text.
  const shot = r.events[4]!.data.results[0].content;
  expect(shot[0]).toEqual({ type: "text", text: "see picture" });
  expect(shot[1]).toMatchObject({ type: "image", media_type: "image/png" });
  expect(r.events[6]!.data.images[0]).toMatchObject({ type: "image", media_type: "image/png" });
  // The call nothing answered gets a named gap, never an invented result.
  const last = r.events[8]!.data.results[0];
  expect(last.tool_use_id).toBe("call_open");
  expect(last.is_error).toBe(true);
  expect(JSON.stringify(last.content)).toContain("[unavailable:");
  expect(r.found.model).toBe("composer-fruit");
  expect(r.counts).toMatchObject({ prompts: 2, assistant_messages: 4, tool_calls: 4, thoughts_dropped: 3, media: 2 });
  expect(r.notes.join("\n")).toContain("3 thoughts are not carried");
  expect(r.notes.join("\n")).toContain("Cursor's own context message");
  expect(r.notes.join("\n")).toContain("Cursor's own system prompt");
  expect(r.notes.join("\n")).not.toContain("papaya");
});

test("a summary Cursor made comes after the messages it replaced", async () => {
  const r = await cursorStore.read(byId(COMPACT));
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant", "compaction", "user", "assistant"]);
  expect(r.events[0]!.data.text).toBe("Plan a papaya seed check");
  expect(r.events[2]!.data.summary).toContain("seed check was added");
  expect(r.events[3]!.data.text).toBe("Run the papaya check");
  expect(r.notes.join("\n")).toContain("summarized the conversation 1 time");
});

test("reads a transcript: the words and the calls, with the missing results named", async () => {
  const r = await cursorStore.read(byId(TR));
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant", "tool_result", "assistant"]);
  expect(r.events[0]!.data.text).toBe("List the plums");
  expect(r.events[0]!.ts).toBe(Date.UTC(2026, 10, 3, 14, 5));
  expect(r.events[1]!.data.blocks[1]).toMatchObject({ type: "tool_use", name: "Glob", input: { glob_pattern: "plum*" } });
  const res = r.events[2]!.data.results[0];
  expect(res.tool_use_id).toBe(r.events[1]!.data.blocks[1].id);
  expect(JSON.stringify(res.content)).toContain("does not keep tool results");
  expect(r.counts).toMatchObject({ prompts: 1, assistant_messages: 2, tool_calls: 1 });
  expect(r.notes.join("\n")).toContain("1 turn ended with an error");
  expect(r.notes.join("\n")).toContain("no tool results");
});
