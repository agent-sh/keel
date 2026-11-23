// What the readers take from a source file: the owner's words as written, a
// recorded short ending, damage they could not read, and a Rust Keel tree whose
// head is gone.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestText } from "./agy.ts";
import { claudeFound, readClaude } from "./claude.ts";
import { damageNotes, readLines } from "./files.ts";
import { readCodex } from "./codex.ts";
import { readKeel } from "./keel.ts";
import { toMessages } from "../../engine/turn.ts";
import type { StoredEvent } from "../../core/types.ts";

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

test("a Claude Code import names the model of the latest reply, also past a long head, and the mode it ran in", async () => {
  const p = join(dir, "m.jsonl");
  const base = { sessionId: "m", cwd: dir, isSidechain: false, timestamp: new Date().toISOString() };
  const reply = (uuid: string, parent: string, model: string) => ({ ...base, type: "assistant", uuid, parentUuid: parent, message: { id: uuid, role: "assistant", model, content: [{ type: "text", text: "ok" }] } });
  const pad = "x".repeat(40 * 1024);
  const recs = [
    { ...base, type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "go " + pad } },
    { ...base, type: "attachment", uuid: "at", parentUuid: "u1", attachment: { text: pad } },
    reply("a1", "at", "claude-opus-5-5"),
    { ...base, type: "user", uuid: "u2", parentUuid: "a1", permissionMode: "bypassPermissions", message: { role: "user", content: "more " + pad } },
    reply("a2", "u2", "global.anthropic.claude-sonnet-5-5"),
    { ...base, type: "assistant", uuid: "n", parentUuid: "a2", message: { id: "n", role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "notice" }] } },
  ];
  const write = (r: any[]) => writeFileSync(p, r.map((x) => JSON.stringify(x)).join("\n") + "\n");
  write(recs);
  expect(claudeFound(p, 0, 0)?.model).toBe("global.anthropic.claude-sonnet-5-5");
  expect((await readClaude(p)).found.model).toBe("global.anthropic.claude-sonnet-5-5");
  expect(claudeFound(p, 0, 0)?.perm_mode).toBe("full-auto"); // bypassPermissions
  for (const [permissionMode, mode] of [["auto", "auto"], ["acceptEdits", "auto-edits"]] as const) {
    write([...recs, { ...base, type: "user", uuid: "u3", parentUuid: "a2", permissionMode, message: { role: "user", content: "continue" } }]);
    expect(claudeFound(p, 0, 0)?.perm_mode).toBe(mode);
    expect((await readClaude(p)).found.perm_mode).toBe(mode);
  }
  write([...recs.slice(0, 3),
    { ...base, type: "user", uuid: "latest", parentUuid: "a1", permissionMode: "auto", message: { role: "user", content: "active branch" } },
    { ...recs[3], isSidechain: true },
    reply("active-reply", "latest", "global.anthropic.claude-sonnet-5-5"),
  ]);
  expect((await readClaude(p)).found.perm_mode).toBe("auto");
  // Only the first reply, beyond the head the listing samples: still named.
  write([...recs.slice(0, 3), { ...base, type: "user", uuid: "u3", parentUuid: "a1", message: { role: "user", content: "tail " + pad + pad } }]);
  expect(claudeFound(p, 0, 0)?.model).toBe("claude-opus-5-5");
  // A switch, then a tail of tool output longer than the sample: the later model, not the first.
  const out = (uuid: string, parent: string) => ({ ...base, type: "user", uuid, parentUuid: parent, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: pad + pad }] } });
  write([...recs.slice(0, 5), out("o1", "a2"), out("o2", "o1"), out("o3", "o2")]);
  expect(claudeFound(p, 0, 0)?.model).toBe("global.anthropic.claude-sonnet-5-5");
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

test("a Codex rollout keeps namespaced tools apart, its discovery, agent and declared-tool items as history, and media byte for byte", async () => {
  const call = (id: string, name: string, namespace?: string, custom = false) => custom
    ? [{ type: "custom_tool_call", call_id: id, name, namespace, input: "patch" }, { type: "custom_tool_call_output", call_id: id, output: "ok" }]
    : [{ type: "function_call", call_id: id, name, namespace, arguments: "{}" }, { type: "function_call_output", call_id: id, output: "ok" }];
  const fns = [{ type: "namespace", name: "mcp__alpha", description: "Alpha", tools: [{ type: "function", name: "lookup", description: "Finds", parameters: { type: "object", properties: { q: { type: "string" } } } }] }];
  const read = async (name: string, items: any[]) => {
    const p = join(dir, `rollout-${name}.jsonl`);
    const rec = (type: string, payload: any) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload });
    writeFileSync(p, [rec("session_meta", { id: name, cwd: dir }), rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }), ...items.map((i) => rec("response_item", i))].join("\n") + "\n");
    const r = await readCodex(p);
    return { ...r, calls: r.events.flatMap((e) => (e.kind === "assistant" ? e.data.blocks : [])).filter((b: any) => b.type === "tool_use").map((b: any) => `${b.id}:${b.name}`), said: r.events.filter((e) => e.kind === "note").map((e) => e.data.text).join("\n") };
  };
  expect((await read("flat", [...call("a", "mcp__alpha__lookup"), ...call("b", "mcp__beta__lookup")])).calls).toEqual(["a:mcp__alpha__lookup", "b:mcp__beta__lookup"]);
  expect((await read("ns", [...call("a", "lookup", "mcp__alpha"), ...call("b", "lookup", "mcp__beta"), ...call("c", "mcp__alpha__x", "mcp__alpha")])).calls).toEqual(["a:mcp__alpha__lookup", "b:mcp__beta__lookup", "c:mcp__alpha__x"]);
  expect((await read("custom", [...call("a", "edit", "mcp__alpha", true), ...call("b", "edit", "mcp__beta", true)])).calls).toEqual(["a:mcp__alpha__edit", "b:mcp__beta__edit"]);
  const search = await read("search", [
    { type: "tool_search_call", call_id: "s", execution: "client", status: "completed", arguments: { query: "alpha lookup", limit: 1 } },
    { type: "tool_search_output", call_id: "s", execution: "client", status: "completed", tools: fns },
    ...call("a", "lookup", "mcp__alpha"),
  ]);
  expect(search.counts.skipped).toBe(0);
  expect(search.calls).toEqual(["a:mcp__alpha__lookup"]);
  expect(search.said).toContain('"alpha lookup"');
  expect(search.said).toContain('mcp__alpha__lookup: Finds {"type":"object"');
  const agent = await read("agent", [{ type: "agent_message", author: "child", recipient: "parent", content: [{ type: "input_text", text: "REPORT" }, { type: "encrypted_content", encrypted_content: "x" }] }]);
  expect(agent.events.filter((e) => e.kind === "user")).toHaveLength(1);
  expect(agent.said).toMatch(/from child to parent[^]*REPORT\n\[unavailable/);
  const declared = await read("declared", [{ type: "additional_tools", role: "developer", tools: fns }, { type: "web_search_call", status: "completed" }]);
  expect(declared.said).toContain("mcp__alpha__lookup");
  expect(declared.notes).toEqual(["1 skipped: items of a kind Keel does not import (web_search_call)."]);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQcGgAAAFkAOHHE8n2AAAAAElFTkSuQmCC";
  const image = { type: "input_image", image_url: `data:image/png;base64,${png}` };
  const pixel = { type: "image", media_type: "image/png", data: png };
  const prompt = await read("prompt-image", [{ type: "message", role: "user", content: [{ type: "input_text", text: "see" }, image, { type: "input_image", file_id: "file-1" }] }]);
  expect(prompt.events.find((e) => e.data.text === "see")?.data.images).toEqual([pixel]);
  expect(prompt.notes.join()).toContain("image file file-1");
  const viewed = await read("result-image", [
    { type: "function_call", call_id: "v", name: "view_image", arguments: "{}" },
    { type: "function_call_output", call_id: "v", output: [image, { type: "input_text", text: "viewed" }, { type: "input_audio", file_id: "aud-1" }, { type: "encrypted_content", encrypted_content: "x" }] },
  ]);
  expect(viewed.counts.media).toBe(1);
  expect(viewed.events.find((e) => e.kind === "tool_result")?.data.results).toEqual([{ type: "tool_result", tool_use_id: "v", content: [pixel, { type: "text", text: "viewed" }, { type: "text", text: "[unavailable: audio file aud-1]" }, { type: "text", text: "[unavailable: encrypted content]" }], is_error: undefined }]);
  // Imported definitions are history: notes carry them, and no result loads a tool (a tool_reference).
  for (const r of [search, declared]) expect(JSON.stringify(r.events)).not.toContain("tool_reference");
});

// The events of a copy as the store would hold them, for the wire's view of them.
const stored = (evs: { kind: string; data: any; ts: number }[]) => evs.map((e, i) => ({ ...e, id: `e${i}`, seq: i, session_id: "s", parent: i ? `e${i - 1}` : null }) as unknown as StoredEvent);
const wire = (evs: { kind: string; data: any; ts: number }[]) => JSON.stringify(toMessages(stored(evs)));

test("a compacted Claude Code conversation is copied whole, and the model reads from its last summary on", async () => {
  const p = join(dir, "compacted.jsonl");
  const base = { sessionId: "c", cwd: dir, isSidechain: false, timestamp: new Date().toISOString() };
  writeFileSync(p, [
    { ...base, type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "first question about apples" } },
    { ...base, type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "a1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "apples answered" }] } },
    { ...base, type: "system", subtype: "compact_boundary", uuid: "b1", parentUuid: null, logicalParentUuid: "a1", content: "Conversation compacted", compactMetadata: { trigger: "manual", preTokens: 1000 } },
    { ...base, type: "user", uuid: "s1", parentUuid: "b1", isCompactSummary: true, message: { role: "user", content: "Summary: the owner asked about apples." } },
    { ...base, type: "user", uuid: "u2", parentUuid: "s1", message: { role: "user", content: "now pears" } },
    { ...base, type: "assistant", uuid: "a2", parentUuid: "u2", message: { id: "a2", role: "assistant", model: "global.anthropic.claude-sonnet-5-5", content: [{ type: "text", text: "pears answered" }] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = await readClaude(p);
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant", "compaction", "user", "assistant"]);
  expect(r.events[2]!.data).toMatchObject({ mode: "summary", summary: "Summary: the owner asked about apples.", trigger: "owner" });
  expect(r.found.model).toBe("global.anthropic.claude-sonnet-5-5");
  const sent = wire(r.events);
  expect(sent).toContain("Summary: the owner asked about apples.");
  expect(sent).not.toContain("apples answered");
  expect(sent).toContain("pears answered");
});

test("a compacted Codex rollout is copied whole; the model reads Codex's summary and kept messages", async () => {
  const p = join(dir, "rollout-compacted.jsonl");
  const t = Date.now();
  const line = (i: number, type: string, payload: unknown) => JSON.stringify({ timestamp: new Date(t + i).toISOString(), type, payload });
  const msg = (role: string, text: string) => ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
  writeFileSync(p, [
    line(0, "session_meta", { id: "cx", cwd: dir, source: "cli" }),
    line(1, "turn_context", { model: "gpt-6.1", cwd: dir }),
    line(2, "response_item", msg("user", "first ask about plums")),
    line(3, "response_item", msg("assistant", "plums answered")),
    line(4, "compacted", { message: "Summary of plums.", replacement_history: [msg("user", "first ask about plums"), msg("user", "Prefix. Summary of plums.")] }),
    line(5, "response_item", msg("user", "and figs")),
    line(6, "response_item", msg("assistant", "figs answered")),
  ].join("\n") + "\n");
  const r = await readCodex(p);
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant", "compaction", "user", "assistant"]);
  expect(r.events[2]!.data).toMatchObject({ summary: "Summary of plums.", owner_messages: ["first ask about plums"] });
  const sent = wire(r.events);
  expect(sent).toContain("Summary of plums.");
  expect(sent).not.toContain("plums answered");
  expect(sent).toContain("figs answered");
});

test("an OpenCode session: calls with their results in place, a failed call, the compaction as a checkpoint", async () => {
  const { opencodeSession } = await import("../../../test/e2e/fixtures/import-stores.ts");
  const { opencodeSessions, readOpencode } = await import("./opencode.ts");
  const p = opencodeSession(join(dir, "opencode", "opencode.db"), dir, "ses_1", "Faros");
  const [f] = opencodeSessions(p);
  expect(f).toMatchObject({ harness: "opencode", id: "ses_1", cwd: dir, title: "Lantern Faros", first_prompt: "Which lantern do the notes name?", last_prompt: "Say it once more.", model: "scripted:stand-in" });
  const r = await readOpencode(f!, p);
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant", "tool_result", "assistant", "compaction", "user", "assistant"]);
  expect(r.events[2]!.data.results).toEqual([
    { type: "tool_result", tool_use_id: "call_1", content: "the Faros lantern", is_error: undefined },
    { type: "tool_result", tool_use_id: "call_2", content: "no such file", is_error: true },
  ]);
  expect(r.counts).toMatchObject({ tool_calls: 2, thoughts_dropped: 1 });
  expect(wire(r.events)).not.toContain("the Faros lantern");
});

test("an OpenCode session whose reply keeps its items as rows of their own reads the same", async () => {
  const { opencodeSession } = await import("../../../test/e2e/fixtures/import-stores.ts");
  const { opencodeSessions, readOpencode } = await import("./opencode.ts");
  const inline = opencodeSession(join(dir, "oc-inline", "opencode.db"), dir, "ses_2", "Faros");
  const p = opencodeSession(join(dir, "oc-parts", "opencode.db"), dir, "ses_2", "Faros");
  // As OpenCode 2.3 writes with part rows on: the items in session_part by ordinal, the content empty.
  const db = new Database(p);
  db.exec("CREATE TABLE `session_part` (`message_id` text NOT NULL, `session_id` text NOT NULL, `ordinal` integer NOT NULL, `type` text NOT NULL, `call_id` text, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL, PRIMARY KEY(`message_id`, `ordinal`))");
  for (const r of db.query<{ id: string; data: string }, []>("SELECT id, data FROM session_message WHERE type = 'assistant'").all()) {
    const m = JSON.parse(r.data);
    m.content.forEach((it: any, i: number) => { const { type, ...rest } = it; db.query("INSERT INTO session_part VALUES (?, 'ses_2', ?, ?, ?, 0, 0, ?)").run(r.id, i, type, it.id ?? null, JSON.stringify(rest)); });
    db.query("UPDATE session_message SET data = ? WHERE id = ?").run(JSON.stringify({ ...m, content: [] }), r.id);
  }
  db.close();
  const a = await readOpencode(opencodeSessions(inline)[0]!, inline), b = await readOpencode(opencodeSessions(p)[0]!, p);
  expect(b.counts).toMatchObject({ tool_calls: 2 });
  expect(b.events.map((e) => [e.kind, e.data])).toEqual(a.events.map((e) => [e.kind, e.data]));
});

// INT-M14: Gemini CLI's session log, applied as Gemini CLI loads it.
test("a Gemini CLI session: its folder from the project's marker, calls with their results, a rewind and a patch applied", async () => {
  const { geminiSession } = await import("../../../test/e2e/fixtures/import-stores.ts");
  const { geminiSessions, readGemini } = await import("./gemini.ts");
  const home = join(dir, "gemini");
  geminiSession(home, dir, "9e9e9e9e-0000-4000-8000-000000000001", "Hook Head");
  const [f] = geminiSessions(home);
  expect(f).toMatchObject({ harness: "gemini", id: "9e9e9e9e-0000-4000-8000-000000000001", cwd: dir, title: "Beacon Hook Head", first_prompt: "Which beacon do the notes name?", last_prompt: "Say it once more.", model: "gemini-3-pro", kind: "interactive" });
  const r = await readGemini(f!);
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant", "tool_result", "user", "assistant"]);
  expect(r.events[2]!.data.results).toEqual([
    { type: "tool_result", tool_use_id: "read_file-1", content: "the Hook Head beacon", is_error: undefined },
    { type: "tool_result", tool_use_id: "run_shell_command-2", content: "no such file", is_error: true },
  ]);
  expect(r.counts).toMatchObject({ prompts: 2, tool_calls: 2, thoughts_dropped: 1, skipped: 1 });
  expect(wire(r.events)).not.toContain("A prompt taken back.");
});

// Review of round 3, P2-d: a log costs what it touches. A file of rewinds was quadratic (seconds on the loop).
test("a Gemini CLI log is applied in time linear in what it touches, and one past the bound is cut and says so", async () => {
  const { conversationOf, WORK_MAX } = await import("./gemini.ts");
  const N = 20_000;
  const recs: any[] = [{ sessionId: "s", projectHash: "h" }];
  for (let i = 0; i < N; i++) recs.push({ id: `m${i}`, type: "user", content: "x" });
  for (let i = 0; i < N; i++) { recs.push({ id: `r${i}`, type: "user", content: "y" }); recs.push({ $rewindTo: `r${i}` }); }
  recs.push({ $patch: { removeIds: ["m1"] } }, { $rewindTo: "m5" }, { $patch: { orderIds: ["m0", "m3"] } }, { id: "m2", type: "gemini", content: "replaced in place" });
  const t0 = performance.now();
  const c = conversationOf(recs);
  expect(performance.now() - t0).toBeLessThan(1000);
  // The rewinds took back each prompt they named; m1 removed; the rewind to m5 cut after m4; m0 and m3 moved last.
  expect(c.messages.map((m) => m.id)).toEqual(["m2", "m4", "m0", "m3"]);
  expect(c.messages[0]!.content).toBe("replaced in place");
  expect(c.cut).toBeUndefined();
  // Reordering a long list again and again passes the bound: the rest is not applied.
  const many: any[] = [{ sessionId: "s", projectHash: "h" }];
  for (let i = 0; i < 5000; i++) many.push({ id: `m${i}`, type: "user", content: "x" });
  const order = Array.from({ length: 5000 }, (_, k) => `m${4999 - k}`);
  for (let i = 0; i < Math.ceil(WORK_MAX / 10_000) + 10; i++) many.push({ $patch: { orderIds: order } });
  expect(conversationOf(many).cut).toBe(true);
});
