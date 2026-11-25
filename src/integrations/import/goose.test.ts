// Goose's session database as its source creates it (crates/goose/src/session/session_manager.rs, schema version 18):
// <data folder>/sessions/sessions.db with `sessions` and `messages` tables, a message's content and metadata as JSON.
// The content is invented.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ownEnv, tempTree } from "../../../test/env.ts";
import { moreOf } from "./more.ts";

const home = tempTree("keel-goose-");
ownEnv({ KEEL_IMPORT_GOOSE_DIR: home });

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const T0 = Math.floor(Date.parse("2026-11-20T10:00:00Z") / 1000);
const S1 = "20261120_1";
const S2 = "20261120_2";
const S3 = "20261120_3";
const S4 = "20261120_4";
const cwd = "/work/fruit";
const SCHEMA = `
CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', user_set_name BOOLEAN DEFAULT FALSE,
  session_type TEXT NOT NULL DEFAULT 'user', working_dir TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, extension_data TEXT DEFAULT '{}', total_tokens INTEGER, input_tokens INTEGER,
  output_tokens INTEGER, schedule_id TEXT, recipe_json TEXT, user_recipe_values_json TEXT, provider_name TEXT, model_config_json TEXT,
  goose_mode TEXT NOT NULL DEFAULT 'auto', archived_at TIMESTAMP, project_id TEXT, parent_session_id TEXT, system_prompt_override TEXT,
  system_prompt_extras_json TEXT, container_id TEXT);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL, content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  tokens INTEGER, metadata_json TEXT);
CREATE INDEX idx_messages_session ON messages(session_id);`;

const SHOWN = { userVisible: true, agentVisible: true };
const COMPACTED = { userVisible: true, agentVisible: false };
const AGENT_ONLY = { userVisible: false, agentVisible: true };
const text = (t: string) => ({ type: "text", text: t });
const ask = (id: string, name: string, args: any) => ({ type: "toolRequest", id, toolCall: { status: "success", value: { name, arguments: args } } });
const answer = (id: string, t: string, isError = false) => ({ type: "toolResponse", id, toolResult: { status: "success", value: { content: [text(t)], isError } } });

function build() {
  mkdirSync(join(home, "sessions"), { recursive: true });
  const db = new Database(join(home, "sessions", "sessions.db"), { create: true });
  db.exec(SCHEMA);
  const session = db.query("INSERT INTO sessions (id, name, description, user_set_name, session_type, working_dir, created_at, updated_at, provider_name, model_config_json, parent_session_id, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const at = (s: number) => new Date((T0 + s) * 1000).toISOString().slice(0, 19).replace("T", " ");
  const model = JSON.stringify({ model_name: "fruit-model", context_limit: null });
  session.run(S1, "Quince notes", "", 1, "user", cwd, at(0), at(100), "local", model, null, null);
  session.run(S2, "", "Fruit lookup", 0, "sub_agent", cwd, at(0), at(50), "local", model, S1, null);
  session.run(S3, "hidden", "", 0, "hidden", cwd, at(0), at(200), "local", model, null, null);
  session.run(S4, "", "Nightly fruit report", 0, "scheduled", "/work/cron", at(0), at(10), "local", null, null, at(20));
  const msg = db.query("INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, metadata_json) VALUES (?, ?, ?, ?, ?, ?)");
  let n = 0;
  const add = (sid: string, role: string, content: any[], meta: any = SHOWN) => msg.run(`m${++n}`, sid, role, JSON.stringify(content), T0 + n, JSON.stringify(meta));
  add(S1, "user", [text("Which fruit is in notes.md?")], COMPACTED);
  add(S1, "assistant", [{ type: "thinking", thinking: "look", signature: "s" }, text("Let me look."), ask("call_1", "developer__shell", { command: "cat notes.md" }), ask("call_2", "developer__shell", { command: "cat gone.md" })], COMPACTED);
  add(S1, "user", [answer("call_1", "quince"), answer("call_2", "cat: gone.md: No such file", true)], COMPACTED);
  add(S1, "assistant", [text("The fruit is quince.")], { ...COMPACTED, inference: { provider: "local", requestedModel: "fruit-model", resolvedModel: "fruit-model-b" } });
  add(S1, "user", [text("Here is a picture."), { type: "image", data: PNG, mimeType: "image/png" }, { type: "document", data: "AAAA", mimeType: "application/pdf", name: "plan.pdf" }], COMPACTED);
  add(S1, "user", [text("<turn-context>today</turn-context>")], { ...COMPACTED, turnContext: true });
  // What Goose adds when it compacts: the summary, a continuation and the latest prompt again, for the agent alone.
  add(S1, "user", [text("Summary: the owner asked about the fruit in notes.md; it is a quince.")], { ...AGENT_ONLY, compactionSummary: true });
  add(S1, "assistant", [text("Your context was compacted. Continue.")], AGENT_ONLY);
  add(S1, "user", [text("Here is a picture.")], AGENT_ONLY);
  add(S1, "user", [text("And its color?")]);
  add(S1, "assistant", [text("Checking."), ask("call_3", "developer__shell", { command: "echo yellow" })]);
  add(S1, "user", [{ type: "toolResponse", id: "call_3", toolResult: { status: "error", error: "tool crashed" } }]);
  add(S1, "assistant", [text("Yellow."), { type: "error", kind: "other", message: "rate limited" }, { type: "systemNotification", notificationType: "inlineMessage", msg: "progress" }]);
  add(S2, "user", [text("Find the fruit")]);
  add(S2, "assistant", [text("Quince.")]);
  add(S3, "user", [text("internal naming prompt")]);
  add(S4, "user", [text("Report fruit")]);
  add(S4, "assistant", [text("None today.")]);
  db.close();
  return join(home, "sessions", "sessions.db");
}
const dbPath = build();

test("Goose sessions list newest first with name, folder, model, kind and the sessions Goose hides left out", () => {
  const store = moreOf("goose")!;
  expect(store.store()).toBe(home);
  const rows = store.list();
  expect(rows.map((r) => r.id)).toEqual([S1, S2, S4]);
  expect(rows[0]).toMatchObject({ harness: "goose", path: `${dbPath}#${S1}`, cwd, title: "Quince notes", kind: "interactive", model: "fruit-model", first_prompt: "Which fruit is in notes.md?", last_prompt: "And its color?" });
  expect(rows[0]!.updated_ms).toBe((T0 + 100) * 1000);
  expect(rows[1]).toMatchObject({ title: "Fruit lookup", kind: "subagent", parent_id: S1, first_prompt: "Find the fruit" });
  expect(rows[2]).toMatchObject({ title: "Nightly fruit report", kind: "headless", cwd: "/work/cron", archived: true });
  expect(store.pending?.()).toBe(0);
});

test("a Goose session reads with its calls, failures, compaction and what it left out", async () => {
  const store = moreOf("goose")!;
  const r = await store.read(store.list().find((x) => x.id === S1)!);
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant", "tool_result", "assistant", "user", "compaction", "user", "assistant", "tool_result", "assistant", "note"]);
  const [u1, a1, res1, a2, u2, comp, u3, a3, res3, a4, err] = r.events;
  expect(u1!.data.text).toBe("Which fruit is in notes.md?");
  expect(a1!.data.blocks.map((b: any) => b.type)).toEqual(["text", "tool_use", "tool_use"]);
  expect(a1!.data.blocks[1]).toMatchObject({ id: "call_1", name: "developer__shell", input: { command: "cat notes.md" } });
  expect(a1!.data.model).toBe("fruit-model");
  expect(res1!.data.results).toEqual([
    { type: "tool_result", tool_use_id: "call_1", content: "quince" },
    { type: "tool_result", tool_use_id: "call_2", content: "cat: gone.md: No such file", is_error: true },
  ]);
  expect(a2!.data).toMatchObject({ blocks: [{ type: "text", text: "The fruit is quince." }], model: "fruit-model-b" });
  expect(u2!.data.text).toBe("Here is a picture.");
  expect(u2!.data.images).toEqual([{ type: "image", media_type: "image/png", data: PNG }]);
  // The latest prompt is the one Goose repeated after the summary: it stays as the one event kept beside it.
  expect(comp!.data).toMatchObject({ mode: "summary", summary: "Summary: the owner asked about the fruit in notes.md; it is a quince.", tail: 1, imported: true });
  expect(u3!.data.text).toBe("And its color?");
  expect(a3!.data.blocks[1]).toMatchObject({ type: "tool_use", id: "call_3" });
  expect(res3!.data.results).toEqual([{ type: "tool_result", tool_use_id: "call_3", content: "tool crashed", is_error: true }]);
  expect(a4!.data.blocks).toEqual([{ type: "text", text: "Yellow." }]);
  expect(err!.data.text).toContain("rate limited");
  expect(r.counts).toMatchObject({ prompts: 3, assistant_messages: 4, tool_calls: 3, thoughts_dropped: 1, media: 1 });
  const notes = r.notes.join("\n");
  expect(notes).toContain("1 thinking block is not carried");
  expect(notes).toContain("document plan.pdf");
  expect(notes).toContain("agent alone");
  expect(r.events.some((e) => JSON.stringify(e).includes("turn-context"))).toBe(false);
  expect(r.events.some((e) => JSON.stringify(e).includes("Your context was compacted"))).toBe(false);
});

test("a subagent's session reads as its task and answer", async () => {
  const store = moreOf("goose")!;
  const r = await store.read(store.list().find((x) => x.id === S2)!);
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant"]);
  expect(r.found.kind).toBe("subagent");
});
