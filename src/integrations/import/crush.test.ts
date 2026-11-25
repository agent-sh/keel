// Crush's stores as its source creates them (internal/db/migrations, internal/message/message.go): the global data
// folder lists the projects in projects.json, and each project keeps <data dir>/crush.db with `sessions` and
// `messages` tables, a message's parts as JSON [{ type, data }]. The content is invented.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv, tempTree } from "../../../test/env.ts";
import { moreOf } from "./more.ts";

const global = tempTree("keel-crush-");
const work = tempTree("keel-crush-work-");
ownEnv({ KEEL_IMPORT_CRUSH_DIR: global });

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const T0 = Math.floor(Date.parse("2026-11-20T10:00:00Z") / 1000);
const SCHEMA = `
CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0.0,
  updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL, summary_message_id TEXT, todos TEXT, channel TEXT);
CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, parts TEXT NOT NULL default '[]', model TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER, provider TEXT, is_summary_message INTEGER DEFAULT 0 NOT NULL,
  prism_model_id TEXT, prism_model_name TEXT, prism_hypercredit_savings REAL, prism_dollar_savings REAL, model_name TEXT);`;

const part = (type: string, data: any) => ({ type, data });
const text = (t: string, extra: any = {}) => part("text", { text: t, ...extra });
const call = (id: string, name: string, input: any) => part("tool_call", { id, name, input: JSON.stringify(input), provider_executed: false, finished: true });
const done = (id: string, content: string, is_error = false, extra: any = {}) => part("tool_result", { tool_call_id: id, name: "bash", content, data: "", mime_type: "", metadata: "", is_error, ...extra });
const finish = (reason: string, extra: any = {}) => part("finish", { reason, time: T0, ...extra });

function project(path: string, dataDir: string, sessions: { id: string; title: string; parent?: string; at: number; msgs: { id: string; role: string; parts: any[]; model?: string; summary?: boolean }[] }[]) {
  mkdirSync(join(path, dataDir), { recursive: true });
  const db = new Database(join(path, dataDir, "crush.db"), { create: true });
  db.exec(SCHEMA);
  const s = db.query("INSERT INTO sessions (id, parent_session_id, title, message_count, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const m = db.query("INSERT INTO messages (id, session_id, role, parts, model, model_name, created_at, updated_at, is_summary_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const x of sessions) {
    s.run(x.id, x.parent ?? null, x.title, x.msgs.length, x.at, T0);
    x.msgs.forEach((g, i) => m.run(g.id, x.id, g.role, JSON.stringify(g.parts), g.model ?? "", g.model ? "Fruit Model" : null, x.at - 100 + i, x.at - 100 + i, g.summary ? 1 : 0));
  }
  db.close();
  return join(path, dataDir, "crush.db");
}

const P1 = join(work, "fruit");
const P2 = join(work, "other");
const SESSION = "11111111-aaaa-4000-8000-000000000001";
const dbs: string[] = [];
dbs.push(project(P1, ".crush", [
  { id: SESSION, title: "Quince notes", at: T0 + 100, msgs: [
    { id: "m1", role: "user", parts: [text("Which fruit is in notes.md?")] },
    { id: "m2", role: "assistant", model: "fruit-model", parts: [part("reasoning", { thinking: "look", signature: "s" }), text("Let me look."), call("call_1", "view", { file_path: "notes.md" }), call("call_2", "bash", { command: "cat gone.md" }), finish("tool_use")] },
    { id: "m3", role: "tool", parts: [done("call_1", "quince"), done("call_2", "cat: gone.md: No such file", true)] },
    { id: "m4", role: "assistant", model: "fruit-model", parts: [text("The fruit is quince."), finish("end_turn")] },
    { id: "m5", role: "user", parts: [text("Here is a picture."), part("binary", { Path: "shot.png", MIMEType: "image/png", Data: PNG }), part("binary", { Path: "voice.wav", MIMEType: "audio/wav", Data: "AAAA" }), part("image_url", { url: "https://example.com/x.png" })] },
    { id: "m6", role: "user", parts: [part("shell_command", { command: "echo pear", output: "pear\n", exit_code: 0 })] },
    { id: "m7", role: "assistant", model: "fruit-model", summary: true, parts: [part("reasoning", { thinking: "sum" }), text("Summary: the owner asked about the fruit in notes.md; it is a quince."), finish("end_turn")] },
    { id: "m8", role: "user", parts: [text("continue", { hidden: true }), text("And its color?", { context: "host context" })] },
    { id: "m9", role: "assistant", model: "fruit-model-b", parts: [text("Checking."), call("call_3", "bash", { command: "echo yellow" }), finish("canceled")] },
    { id: "m10", role: "user", parts: [part("sub_agent_report", { label: "color", output: "yellow", failed: false, model: "x/y" })] },
    { id: "m11", role: "assistant", model: "fruit-model-b", parts: [text("Yellow."), finish("error", { message: "Provider error", details: "rate limited" })] },
  ] },
  { id: "call_task_1", title: "Look up the fruit", parent: SESSION, at: T0 + 50, msgs: [
    { id: "t1", role: "user", parts: [text("Find the fruit")] },
    { id: "t2", role: "assistant", model: "fruit-model", parts: [text("Quince."), finish("end_turn")] },
  ] },
  { id: `title-${SESSION}`, title: "Generate a title", parent: SESSION, at: T0 + 60, msgs: [{ id: "g1", role: "user", parts: [text("title this")] }] },
  { id: "empty", title: "Nothing", at: T0 + 70, msgs: [] },
]));
dbs.push(project(P2, "data", [
  { id: "22222222-bbbb-4000-8000-000000000002", title: "Citrus", at: T0 + 10, msgs: [
    { id: "c1", role: "user", parts: [text("Name a citrus fruit")] },
    { id: "c2", role: "assistant", model: "fruit-model", parts: [text("Lemon."), finish("end_turn")] },
    { id: "c3", role: "user", parts: [text("Another")] },
  ] },
]));
writeFileSync(join(global, "projects.json"), JSON.stringify({ projects: [
  { path: P1, data_dir: ".crush", last_accessed: "2026-11-20T10:05:00Z" },
  { path: P2, data_dir: join(P2, "data"), last_accessed: "2026-11-20T09:00:00Z" },
  { path: join(work, "gone"), data_dir: ".crush", last_accessed: "2026-11-01T09:00:00Z" },
] }));

test("Crush sessions list from every project it registered, newest first, with title, folder, model and subagents", () => {
  const store = moreOf("crush")!;
  expect(store.store()).toBe(global);
  const rows = store.list();
  expect(rows.map((r) => r.id)).toEqual([SESSION, "call_task_1", "22222222-bbbb-4000-8000-000000000002"]);
  expect(rows[0]).toMatchObject({ harness: "crush", path: `${dbs[0]}#${SESSION}`, cwd: P1, title: "Quince notes", kind: "interactive", model: "fruit-model-b", first_prompt: "Which fruit is in notes.md?", last_prompt: "And its color?" });
  expect(rows[0]!.updated_ms).toBe((T0 + 100) * 1000);
  expect(rows[1]).toMatchObject({ kind: "subagent", parent_id: SESSION, title: "Look up the fruit", cwd: P1 });
  expect(rows[2]).toMatchObject({ cwd: P2, title: "Citrus", last_prompt: "Another" });
  expect(store.pending?.()).toBe(0);
});

test("a Crush session reads with its calls, failures, summary and what it left out", async () => {
  const store = moreOf("crush")!;
  const r = await store.read(store.list().find((x) => x.id === SESSION)!);
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant", "tool_result", "assistant", "user", "note", "compaction", "note", "user", "assistant", "tool_result", "note", "assistant", "note"]);
  const [u1, a1, res1, a2, u2, shell, comp, hidden, u3, a3, res3, report, a4, err] = r.events;
  expect(u1!.data.text).toBe("Which fruit is in notes.md?");
  expect(a1!.data.blocks.map((b: any) => b.type)).toEqual(["text", "tool_use", "tool_use"]);
  expect(a1!.data.blocks[1]).toMatchObject({ id: "call_1", name: "view", input: { file_path: "notes.md" } });
  expect(a1!.data.model).toBe("fruit-model");
  expect(res1!.data.results).toEqual([
    { type: "tool_result", tool_use_id: "call_1", content: "quince" },
    { type: "tool_result", tool_use_id: "call_2", content: "cat: gone.md: No such file", is_error: true },
  ]);
  expect(a2!.data).toMatchObject({ blocks: [{ type: "text", text: "The fruit is quince." }], stop: "end_turn" });
  expect(u2!.data.text).toBe("Here is a picture.");
  expect(u2!.data.images).toEqual([{ type: "image", media_type: "image/png", data: PNG }]);
  expect(shell!.data).toMatchObject({ model: true, text: expect.stringContaining("echo pear") });
  expect(comp!.data).toMatchObject({ mode: "summary", summary: "Summary: the owner asked about the fruit in notes.md; it is a quince.", imported: true });
  expect(hidden!.data.text).toContain("continue");
  expect(u3!.data.text).toBe("And its color?");
  expect(a3!.data).toMatchObject({ stop: "interrupted", model: "fruit-model-b" });
  expect(a3!.data.blocks[1]).toMatchObject({ type: "tool_use", id: "call_3", input: { command: "echo yellow" } });
  // The cancelled call has no result in Crush: it is given one that says so.
  expect(res3!.data.results).toEqual([{ type: "tool_result", tool_use_id: "call_3", content: "No result was recorded for this call.", is_error: true }]);
  expect(report!.data.text).toContain("<subagent-report");
  expect(a4!.data.blocks).toEqual([{ type: "text", text: "Yellow." }]);
  expect(err!.data.text).toContain("Provider error");
  expect(r.counts).toMatchObject({ prompts: 3, assistant_messages: 4, tool_calls: 3, thoughts_dropped: 2, media: 1 });
  const notes = r.notes.join("\n");
  expect(notes).toContain("2 thinking blocks are not carried");
  expect(notes).toContain("audio/wav");
  expect(notes).toContain("https://example.com/x.png");
  expect(notes).toContain("host context");
});

test("a subagent's session reads as its task and answer", async () => {
  const store = moreOf("crush")!;
  const r = await store.read(store.list().find((x) => x.id === "call_task_1")!);
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant"]);
});
