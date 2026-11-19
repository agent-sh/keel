// What the readers take from a source file: the owner's words as written, a
// recorded short ending, damage they could not read, and a Rust Keel tree whose
// head is gone.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestText } from "./agy.ts";
import { readClaude } from "./claude.ts";
import { damageNotes, readLines } from "./files.ts";
import { readKeel } from "./keel.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-import-"));

test("an Antigravity request keeps what it quotes; only outer metadata goes", () => {
  const meta = "<ADDITIONAL_METADATA>cursor</ADDITIONAL_METADATA>";
  expect(requestText(`<USER_REQUEST>Use \`</USER_REQUEST>\` as the closing tag, then run the tests.</USER_REQUEST>\n${meta}`)).toBe("Use `</USER_REQUEST>` as the closing tag, then run the tests.");
  expect(requestText(`<USER_REQUEST>See \`<USER_SETTINGS_CHANGE>x</USER_SETTINGS_CHANGE>\`</USER_REQUEST>${meta}`)).toBe("See `<USER_SETTINGS_CHANGE>x</USER_SETTINGS_CHANGE>`");
  expect(requestText(`${meta}\nplain ask\n<USER_SETTINGS_CHANGE>m</USER_SETTINGS_CHANGE>`)).toBe("plain ask");
});

test("a damaged record and a record still being written read differently", () => {
  const ok = ['{"a":1}', '{"b":2}'];
  const clean = damageNotes(readLines(ok.join("\n") + "\n"));
  const bad = readLines([ok[0], "{broken", ok[1]].join("\n") + "\n");
  const cut = damageNotes(readLines(ok.join("\n") + '\n{"c":'));
  expect(clean).toEqual([]);
  expect(bad.records).toHaveLength(2);
  expect(damageNotes(bad)[0]).toContain("line 2");
  expect(cut[0]).toContain("still being written");
});

test("a Claude Code reply recorded as stopped stays stopped", async () => {
  const p = join(dir, "s.jsonl");
  const base = { sessionId: "s", cwd: dir, isSidechain: false, timestamp: new Date().toISOString() };
  writeFileSync(p, [
    { ...base, type: "user", uuid: "u", parentUuid: null, message: { role: "user", content: "go" } },
    { ...base, type: "assistant", uuid: "a", parentUuid: "u", message: { id: "m", role: "assistant", content: [{ type: "text", text: "First check passed" }], stop_reason: "interrupted" } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  expect((await readClaude(p)).events.find((e) => e.kind === "assistant")?.data.stop).toBe("interrupted");
});

test("a Rust Keel session whose head is gone is not read as all its branches", async () => {
  const p = join(dir, "keel.db");
  const db = new Database(p, { create: true });
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, cwd TEXT NOT NULL, family TEXT, model TEXT NOT NULL, provider TEXT NOT NULL, head_event_id TEXT, parent_session_id TEXT, updated_ms INTEGER, archived INTEGER DEFAULT 0, scratch INTEGER DEFAULT 0);
    CREATE TABLE events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_id TEXT, seq INTEGER NOT NULL, ts_ms INTEGER NOT NULL, event_json TEXT NOT NULL);`);
  db.query("INSERT INTO sessions (id, title, cwd, model, provider, head_event_id, updated_ms) VALUES ('s', 't', ?, 'm', '\"p\"', ?, 1)").run(dir, "right");
  const ins = db.query("INSERT INTO events VALUES (?, 's', ?, ?, 1, ?)");
  for (const [id, parent, seq] of [["base", null, 1], ["left", "base", 2], ["right", "base", 3]] as const) ins.run(id, parent, seq, JSON.stringify({ type: "user_turn", text: id }));
  db.close();
  expect((await readKeel("s", p)).events.map((e) => e.data.text)).toEqual(["base", "right"]);
  new Database(p).run("UPDATE sessions SET head_event_id = 'gone'");
  await expect(readKeel("s", p)).rejects.toMatchObject({ status: 409 });
});

test("a Hermes call left without a result is closed as failed; its notices are not the owner's prompts", async () => {
  const p = join(dir, "state.db");
  const db = new Database(p, { create: true });
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, cwd TEXT, title TEXT, model TEXT, archived INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, parent_session_id TEXT, started_at REAL, ended_at REAL, last_activity_at REAL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, reasoning TEXT, reasoning_details TEXT, codex_reasoning_items TEXT, display_kind TEXT, _compressed_summary INTEGER DEFAULT 0, active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0, timestamp REAL);`);
  db.query("INSERT INTO sessions (id, source, cwd, title, model, started_at) VALUES ('h', 'cli', ?, 't', 'm', 1)").run(dir);
  const m = db.query("INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, display_kind, timestamp) VALUES ('h', ?, ?, ?, ?, ?, 2)");
  m.run("user", "list the files", null, null, null);
  m.run("assistant", "", null, JSON.stringify([{ id: "c1", function: { name: "terminal", arguments: '{"command":"ls"}' } }, { id: "c2", function: { name: "terminal", arguments: '{"command":"pwd"}' } }]), null);
  m.run("tool", "a.txt", "c1", null, null);
  m.run("user", "background job finished", null, null, "process_complete");
  m.run("assistant", "Done.", null, null, null);
  db.close();
  const { hermesSessions, readHermes } = await import("./hermes.ts");
  const f = hermesSessions(p).find((x) => x.id === "h")!;
  expect(f.first_prompt).toBe("list the files");
  const r = await readHermes(f, p);
  const results = r.events.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results);
  expect(results.map((x: any) => [x.tool_use_id, !!x.is_error])).toEqual([["c1", false], ["c2", true]]);
  expect(r.events.filter((e) => e.kind === "user").map((e) => e.data.text)).toEqual(["list the files"]);
  expect(r.events.some((e) => e.kind === "note" && e.data.text === "background job finished")).toBe(true);
});
