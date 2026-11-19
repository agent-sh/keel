// Small stores of the other harnesses, in their own formats, for the import e2e.
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const iso = (ms: number) => new Date(ms).toISOString();

export function claudeSession(root: string, cwd: string, id: string, fruit: string) {
  const dir = join(root, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const t = Date.now() - 60_000;
  const base = { cwd, sessionId: id, version: "2.1.300", gitBranch: "main", isSidechain: false, userType: "external", entrypoint: "cli" };
  const recs = [
    { type: "permission-mode", permissionMode: "default", sessionId: id },
    { ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: iso(t), message: { role: "user", content: "Look at fruit.txt and name the fruit in it." } },
    { ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: iso(t + 1000), message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "check the file", signature: "sig" }], stop_reason: null } },
    { ...base, type: "assistant", uuid: "a2", parentUuid: "a1", timestamp: iso(t + 1100), message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "cat fruit.txt" } }], stop_reason: "tool_use" } },
    { ...base, type: "user", uuid: "u2", parentUuid: "a2", timestamp: iso(t + 2000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: fruit }] } },
    { ...base, type: "attachment", uuid: "x1", parentUuid: "u2", timestamp: iso(t + 2100), attachment: { type: "todo" } },
    { ...base, type: "assistant", uuid: "a3", parentUuid: "x1", timestamp: iso(t + 3000), message: { id: "msg_2", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: `The fruit is ${fruit}.` }], stop_reason: "end_turn" } },
    { type: "ai-title", aiTitle: `Name the ${fruit} fixture`, sessionId: id },
  ];
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // A subagent of it: listed only when asked for.
  mkdirSync(join(dir, id, "subagents"), { recursive: true });
  writeFileSync(join(dir, id, "subagents", "agent-1.jsonl"), JSON.stringify({ ...base, isSidechain: true, type: "user", uuid: "s1", parentUuid: null, timestamp: iso(t), message: { role: "user", content: "subagent task" } }) + "\n");
  return path;
}

export function codexSession(home: string, cwd: string, id: string, word: string) {
  const d = new Date();
  const dir = join(home, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const t = Date.now() - 30_000;
  const line = (i: number, type: string, payload: unknown) => JSON.stringify({ timestamp: iso(t + i), type, payload });
  const recs = [
    line(0, "session_meta", { id, timestamp: iso(t), cwd, originator: "codex_cli_rs", cli_version: "0.169.0", source: "cli" }),
    line(1, "response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>sandbox</permissions instructions>" }] }),
    line(2, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context><cwd>x</cwd></environment_context>" }] }),
    line(3, "turn_context", { cwd, model: "gpt-6.1-sol" }),
    line(4, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Pick a code word for the release." }] }),
    line(5, "response_item", { type: "reasoning", summary: [], encrypted_content: "gAAAA" }),
    line(6, "response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "echo ok" }), call_id: "call_1" }),
    line(7, "response_item", { type: "function_call_output", call_id: "call_1", output: "ok" }),
    line(8, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: `The code word is ${word}.` }] }),
  ];
  const path = join(dir, `rollout-${iso(t).slice(0, 19).replace(/:/g, "-")}-${id}.jsonl`);
  writeFileSync(path, recs.join("\n") + "\n");
  return path;
}

export function keelDb(path: string, cwd: string, id: string, word: string) {
  rmSync(path, { force: true });
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, cwd TEXT NOT NULL, family TEXT, model TEXT NOT NULL, provider TEXT NOT NULL, head_event_id TEXT, parent_session_id TEXT, updated_ms INTEGER, archived INTEGER DEFAULT 0, scratch INTEGER DEFAULT 0);
    CREATE TABLE events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_id TEXT, seq INTEGER NOT NULL, ts_ms INTEGER NOT NULL, event_json TEXT NOT NULL);`);
  const t = Date.now() - 10_000;
  const ev = [
    { type: "injected_context", text: "system", source: "instructions_snapshot" },
    { type: "user_turn", text: "Which harbour is the fixture about?", input_kind: "typed" },
    { type: "tool_call", call_id: "c1", tool_name: "Read", arguments: { file_path: "/x" } },
    { type: "tool_result", call_id: "c1", tool_name: "Read", is_error: false, output: "harbour notes" },
    { type: "assistant_text", text: `The harbour is ${word}.`, model: "claude-opus-5-5" },
  ];
  let parent: string | null = null;
  ev.forEach((e, i) => {
    const eid = `e${i}`;
    db.query("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)").run(eid, id, parent, i + 1, t + i, JSON.stringify(e));
    parent = eid;
  });
  db.query("INSERT INTO sessions (id, title, cwd, model, provider, head_event_id, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, `Harbour ${word}`, cwd, "us.anthropic.claude-opus-5-5", '"bedrock_converse"', parent, t + 10);
  db.close();
}

// Antigravity's command line store: a row in conversation_summaries.db and the
// transcript, with results of two parallel calls written before the step that
// made them, as agy does.
export function agySession(home: string, cwd: string, id: string, word: string) {
  const store = join(home, "antigravity-cli");
  mkdirSync(store, { recursive: true });
  const db = new Database(join(store, "conversation_summaries.db"), { create: true });
  db.exec("CREATE TABLE IF NOT EXISTS `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT \"\",`preview` text NOT NULL DEFAULT \"\",`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`parent_conversation_id` text NOT NULL DEFAULT \"\",`last_user_input_time` datetime NOT NULL, PRIMARY KEY (`conversation_id`))");
  const t = Date.now() - 20_000;
  const go = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "000000+00:00");
  db.query("INSERT OR REPLACE INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, last_user_input_time) VALUES (?, ?, ?, 6, ?, ?, ?)")
    .run(id, `Lighthouse ${word}`, "Find the lighthouse", go(t + 6000), JSON.stringify([`file://${cwd}`]), go(t));
  db.close();
  const at = (i: number) => go(t + i * 1000);
  const recs = [
    { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", created_at: at(0), content: "<USER_REQUEST>\nWhich lighthouse do the notes name?\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe time is now.\n</ADDITIONAL_METADATA>" },
    { step_index: 2, type: "VIEW_FILE", source: "MODEL", status: "DONE", created_at: at(2), content: "Created At: 2026-11-19T01:00:00+00:00\nCompleted At: 2026-11-19T01:00:01+00:00\n\nlighthouse notes" },
    { step_index: 3, type: "RUN_COMMAND", source: "MODEL", status: "DONE", created_at: at(3), content: "notes.md" },
    { step_index: 1, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", created_at: at(1), content: "", thinking: "read the notes", tool_calls: [{ name: "view_file", args: { AbsolutePath: `${cwd}/notes.md` } }, { name: "run_command", args: { CommandLine: "ls", Cwd: cwd } }] },
    { step_index: 4, type: "SYSTEM_MESSAGE", source: "SYSTEM", status: "DONE", created_at: at(4), content: "harness note" },
    { step_index: 5, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", created_at: at(5), content: `The lighthouse is ${word}.`, tool_calls: [] },
  ];
  const dir = join(store, "brain", id, ".system_generated", "logs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "transcript_full.jsonl"), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return join(dir, "transcript_full.jsonl");
}

// bun test/e2e/fixtures/import-stores.ts <claude projects> <codex home> <keel db> <cwd> <tag> [agy home]
// (the e2e runs under node; bun:sqlite is bun's, so the stores are made here)
if (import.meta.main) {
  const [claude, codex, keel, cwd, tag, agy] = process.argv.slice(2) as [string, string, string, string, string, string | undefined];
  const out = {
    claude: claudeSession(claude, cwd, `c0ffee00-0000-4000-8000-${tag.padStart(12, "0")}`, "quince"),
    codex: codexSession(codex, cwd, `01a2c0de-0000-7000-8000-${tag.padStart(12, "0")}`, "bramble"),
    keel: (keelDb(keel, cwd, `keel-${tag}`, "Kythira"), keel),
    agy: agy ? agySession(agy, cwd, `a9a9a9a9-0000-4000-8000-${tag.padStart(12, "0")}`, "Pharos") : undefined,
  };
  console.log(JSON.stringify(out));
}
