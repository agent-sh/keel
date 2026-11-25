// Qwen Code's folder as it is laid out on disk: projects/<folder with every non-alphanumeric as ->/chats/<session id>.jsonl
// (older versions: tmp/<sha256 of the folder>/chats/), records as a tree (uuid, parentUuid) holding Gemini-style Content.
// The content is invented.
import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv, tempTree } from "../../../test/env.ts";
import { moreOf } from "./more.ts";

const home = tempTree("keel-qwen-");
ownEnv({ KEEL_IMPORT_QWEN_DIR: home });

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const T0 = Date.parse("2026-11-20T10:00:00.000Z");
const iso = (i: number) => new Date(T0 + i * 1000).toISOString();
const SID = "aaaaaaaa-1111-4000-8000-000000000001";
const SID2 = "bbbbbbbb-2222-4000-8000-000000000002";
const SID3 = "cccccccc-3333-4000-8000-000000000003";
const cwd = "/work/fruit";

function write(dir: string, id: string, recs: any[], mtime: number) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${id}.jsonl`);
  writeFileSync(p, recs.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  utimesSync(p, mtime / 1000, mtime / 1000);
  return p;
}

function main() {
  let n = 0;
  const rec = (parentUuid: string | null, type: string, extra: any = {}) => ({ uuid: `r${++n}`, parentUuid, sessionId: SID, timestamp: iso(n), type, cwd, version: "0.28.4", ...extra });
  const user = (p: string | null, parts: any[], extra: any = {}) => rec(p, "user", { message: { role: "user", parts }, ...extra });
  const model = (p: string | null, parts: any[], extra: any = {}) => rec(p, "assistant", { message: { role: "model", parts }, model: "qwen-fruit", usageMetadata: { promptTokenCount: 5 }, ...extra });
  const result = (p: string | null, id: string, name: string, response: any, extra: any = {}) => rec(p, "tool_result", { message: { role: "user", parts: [{ functionResponse: { id, name, response } }] }, ...extra });
  const recs: any[] = [
    user(null, [{ text: "Which fruit is in notes.md?" }]), // r1
    rec("r1", "system", { subtype: "ui_telemetry", systemPayload: { uiEvent: {} } }), // r2
    model("r2", [{ text: "Checking.", thought: false }, { text: "hmm", thought: true }]), // r3
    model("r3", [{ functionCall: { id: "call_1", name: "read_file", args: { path: "notes.md" } } }, { functionCall: { id: "call_2", name: "read_file", args: { path: "gone.md" } } }], { uuid: "r3b" }), // r4 (a second record of one reply with its own uuid: a new reply)
    result("r3b", "call_1", "read_file", { output: "quince" }, { toolCallResult: { callId: "call_1", status: "success" } }), // r5
    result("r5", "call_2", "read_file", { error: "File not found" }, { toolCallResult: { callId: "call_2", status: "error", error: { message: "File not found" } } }), // r6
    model("r6", [{ text: "The fruit is quince." }]), // r7
    // Records of a branch the owner rewound away from.
    user("r7", [{ text: "abandoned question" }]), // r8
    model("r8", [{ text: "abandoned answer" }]), // r9
    rec("r7", "system", { subtype: "rewind", systemPayload: { truncatedCount: 2 } }), // r10
    user("r10", [{ text: "Here is a picture." }, { inlineData: { mimeType: "image/png", data: PNG } }, { fileData: { fileUri: "gs://x/y.png", mimeType: "image/png" } }]), // r11
    model("r11", [{ text: "A quince." }], { uuid: "r12" }), // r12
    rec("r12", "system", { subtype: "chat_compression", systemPayload: { info: {}, compressedHistory: [
      { role: "user", parts: [{ text: "Summary: the owner asked about the fruit in notes.md; it is a quince." }] },
      { role: "model", parts: [{ text: "Understood." }] },
      { role: "user", parts: [{ text: "Here is a picture." }] },
      { role: "model", parts: [{ text: "A quince." }] },
    ], summaryPrefixLength: 2 } }), // r13
    user("r13", [{ text: "Also check the color" }], { subtype: "mid_turn_user_message" }), // r14
    rec("r14", "system", { subtype: "notification", message: { role: "user", parts: [{ text: "Background task finished." }] } }), // r15
    model("r15", [{ functionCall: { id: "call_3", name: "run_shell_command", args: { command: "echo yellow" } } }], { uuid: "r16", usageMetadata: {} }), // r16
    result("r16", "call_3", "run_shell_command", { output: "yellow" }, { toolCallResult: { callId: "call_3", status: "cancelled" } }), // r17
    // A background agent's own records are not the main conversation.
    model("r17", [{ text: "agent chatter" }], { isSidechain: true, agentId: "explore-1" }), // r18
    model("r18", [{ text: "Yellow." }], { model: "qwen-fruit-b" }), // r19
    rec("r19", "system", { subtype: "custom_title", systemPayload: { customTitle: "Quince notes", titleSource: "manual" } }), // r20
  ];
  const dir = join(home, "projects", "-work-fruit", "chats");
  return write(dir, SID, recs, T0 + 60_000);
}

function oldLayout() {
  // An older version: tmp/<hash>/chats, a damaged line, and a title in a sidecar file.
  const dir = join(home, "tmp", "a".repeat(64), "chats");
  const base = { sessionId: SID2, cwd: "/work/other", version: "0.5.0" };
  const p = write(dir, SID2, [
    { ...base, uuid: "x1", parentUuid: null, timestamp: iso(1), type: "user", message: { role: "user", parts: [{ text: "Name a citrus fruit" }] } },
    { ...base, uuid: "x2", parentUuid: "x1", timestamp: iso(2), type: "assistant", model: "qwen-fruit", message: { role: "model", parts: [{ text: "Lemon." }] } },
    "{broken line",
    { ...base, uuid: "x3", parentUuid: "x2", timestamp: iso(3), type: "user", message: { role: "user", parts: [{ text: "Another" }] } },
  ], T0 + 10_000);
  writeFileSync(join(dir, `${SID2}.title.json`), JSON.stringify({ version: 1, displayName: "Citrus", source: "manual", updatedAt: iso(4) }));
  writeFileSync(join(dir, `${SID2}.runtime.json`), "{}");
  return p;
}

function agent() {
  const base = { sessionId: SID3, cwd, version: "0.28.4" };
  write(join(home, "projects", "-work-fruit", "chats"), SID3, [
    { ...base, uuid: "g1", parentUuid: null, timestamp: iso(1), type: "system", subtype: "parent_session", systemPayload: { parentSessionId: SID } },
    { ...base, uuid: "g2", parentUuid: "g1", timestamp: iso(2), type: "system", subtype: "agent_bootstrap", systemPayload: { kind: "fork", history: [{ role: "user", parts: [{ text: "inherited" }] }] } },
    { ...base, uuid: "g3", parentUuid: "g2", timestamp: iso(3), type: "user", subtype: "agent_launch_prompt", message: { role: "user", parts: [{ text: "Find the fruit" }] } },
    { ...base, uuid: "g4", parentUuid: "g3", timestamp: iso(4), type: "assistant", model: "qwen-fruit", message: { role: "model", parts: [{ text: "Quince." }] } },
  ], T0 + 5_000);
}

test("Qwen Code sessions list newest first from both layouts, with title, folder, model, prompts and subagent", () => {
  const p1 = main();
  const p2 = oldLayout();
  agent();
  const store = moreOf("qwen")!;
  expect(store.store()).toBe(home);
  const rows = store.list();
  expect(rows.map((r) => r.id)).toEqual([SID, SID2, SID3]);
  expect(rows[0]).toMatchObject({ harness: "qwen", path: p1, cwd, title: "Quince notes", kind: "interactive", model: "qwen-fruit-b", first_prompt: "Which fruit is in notes.md?", last_prompt: "Also check the color" });
  expect(rows[1]).toMatchObject({ path: p2, cwd: "/work/other", title: "Citrus", first_prompt: "Name a citrus fruit", last_prompt: "Another", model: "qwen-fruit" });
  expect(rows[2]).toMatchObject({ kind: "subagent", parent_id: SID, first_prompt: "Find the fruit" });
  expect(store.pending?.()).toBe(0);
});

test("a Qwen Code session reads as the branch it ended on, with its calls, failures, compaction and notes", async () => {
  main();
  const store = moreOf("qwen")!;
  const r = await store.read(store.list().find((x) => x.id === SID)!);
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant", "assistant", "tool_result", "assistant", "user", "assistant", "compaction", "user", "note", "assistant", "tool_result", "assistant"]);
  const [u1, a1, a2, res, a3, u2, a4, comp, u3, note, a5, res2, a6] = r.events;
  expect(u1!.data.text).toBe("Which fruit is in notes.md?");
  expect(a1!.data).toMatchObject({ blocks: [{ type: "text", text: "Checking." }], model: "qwen-fruit" });
  expect(a2!.data.blocks.map((b: any) => b.type)).toEqual(["tool_use", "tool_use"]);
  expect(a2!.data.blocks[0]).toMatchObject({ id: "call_1", name: "read_file", input: { path: "notes.md" } });
  expect(res!.data.results).toEqual([
    { type: "tool_result", tool_use_id: "call_1", content: "quince" },
    { type: "tool_result", tool_use_id: "call_2", content: "File not found", is_error: true },
  ]);
  expect(a3!.data.blocks).toEqual([{ type: "text", text: "The fruit is quince." }]);
  expect(u2!.data.text).toBe("Here is a picture.");
  expect(u2!.data.images).toEqual([{ type: "image", media_type: "image/png", data: PNG }]);
  expect(a4!.data.blocks[0].text).toBe("A quince.");
  // The summary replaces what came before; the last two messages are kept beside it.
  expect(comp!.data).toMatchObject({ mode: "summary", summary: "Summary: the owner asked about the fruit in notes.md; it is a quince.", tail: 2 });
  expect(u3!.data.text).toBe("Also check the color");
  expect(note!.data).toMatchObject({ model: true, text: expect.stringContaining("Background task finished.") });
  expect(a5!.data.blocks[0]).toMatchObject({ type: "tool_use", id: "call_3", name: "run_shell_command" });
  expect(res2!.data.results).toEqual([{ type: "tool_result", tool_use_id: "call_3", content: "yellow", is_error: true }]);
  expect(a6!.data).toMatchObject({ blocks: [{ type: "text", text: "Yellow." }], model: "qwen-fruit-b" });
  expect(r.counts).toMatchObject({ prompts: 3, assistant_messages: 6, tool_calls: 3, thoughts_dropped: 1, media: 1 });
  expect(JSON.stringify(r.events)).not.toContain("abandoned");
  expect(JSON.stringify(r.events)).not.toContain("agent chatter");
  const notes = r.notes.join("\n");
  expect(notes).toContain("1 thinking block is not carried");
  expect(notes).toContain("records on other branches");
  expect(notes).toContain("background agent");
  expect(notes).toContain("Not carried: a file reference");
});

test("a damaged line is named and a subagent's launch prompt is its task", async () => {
  oldLayout();
  agent();
  const store = moreOf("qwen")!;
  const rows = store.list();
  const old = await store.read(rows.find((x) => x.id === SID2)!);
  expect(old.events.map((e) => e.kind)).toEqual(["user", "assistant", "user"]);
  expect(old.notes.join("\n")).toContain("1 damaged record");
  const sub = await store.read(rows.find((x) => x.id === SID3)!);
  expect(sub.events.map((e) => e.kind)).toEqual(["user", "assistant"]);
  expect(sub.events[0]!.data.text).toBe("Find the fruit");
  expect(sub.notes.join("\n")).toContain("inherited");
});
