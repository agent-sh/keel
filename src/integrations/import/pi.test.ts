// Pi's session folder as it is laid out on disk: sessions/--<folder>--/<time>_<id>.jsonl, entries
// as a tree (id, parentId), the file's last entry the leaf. The content is invented.
import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv, tempTree } from "../../../test/env.ts";
import { moreOf } from "./more.ts";
import { readLines } from "./files.ts";

const home = tempTree("keel-pi-");
ownEnv({ KEEL_IMPORT_PI_DIR: home });

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const T0 = Date.parse("2026-11-20T10:00:00.000Z");
const iso = (i: number) => new Date(T0 + i * 1000).toISOString();

function write(dir: string, name: string, recs: any[], mtime: number) {
  const d = join(home, "sessions", dir);
  mkdirSync(d, { recursive: true });
  const p = join(d, name);
  writeFileSync(p, recs.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  utimesSync(p, mtime / 1000, mtime / 1000);
  return p;
}

const cwd = "/work/fruit";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const asst = (content: any[], extra: any = {}) => ({ role: "assistant", content, api: "openai-completions", provider: "local", model: "fruit-model", usage, stopReason: "stop", timestamp: T0, ...extra });

function main() {
  let n = 0;
  const e = (parentId: string | null, type: string, extra: any, at = ++n) => ({ type, id: `e${at}`, parentId, timestamp: iso(at), ...extra });
  const m = (parentId: string | null, message: any, at = ++n) => e(parentId, "message", { message: { ...message, timestamp: T0 + at * 1000 } }, at);
  const recs: any[] = [
    { type: "session", version: 3, id: "11111111-aaaa-4000-8000-000000000001", timestamp: iso(0), cwd },
    m(null, { role: "system", content: "", sections: { preamble: "You are a coding assistant." }, toolsAdded: [] }), // e1
    e("e1", "model_change", { provider: "local", modelId: "fruit-model" }), // e2
    e("e2", "thinking_level_change", { thinkingLevel: "high" }), // e3
    m("e3", { role: "user", content: "Which fruit is in notes.md?" }), // e4
    m("e4", asst([{ type: "thinking", thinking: "look" }, { type: "text", text: "Let me look." }, { type: "toolCall", id: "call_1", name: "read", arguments: { path: "notes.md" } }, { type: "toolCall", id: "call_2", name: "bash", arguments: { command: "cat gone.md" } }], { stopReason: "toolUse" })), // e5
    m("e5", { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "quince" }], isError: false }), // e6
    m("e6", { role: "toolResult", toolCallId: "call_2", toolName: "bash", content: [{ type: "text", text: "cat: gone.md: No such file" }], isError: true }), // e7
    m("e7", asst([{ type: "text", text: "The fruit is quince." }])), // e8
    // A branch the owner left: a child of e8 that the file's last entry does not lead to.
    m("e8", { role: "user", content: "abandoned question" }), // e9
    m("e9", asst([{ type: "text", text: "abandoned answer" }])), // e10
    m("e8", { role: "user", content: [{ type: "text", text: "Here is a picture of one." }, { type: "image", data: PNG, mimeType: "image/png" }] }), // e11
    m("e11", asst([], { stopReason: "error", errorMessage: "400 context too long" })), // e12
    m("e12", { role: "user", content: "Try again." }), // e13
    m("e13", asst([{ type: "text", text: "It is a quince." }, { type: "toolCall", id: "call_3", name: "read", arguments: { path: "gone.md" } }], { model: "fruit-model-b", stopReason: "aborted" })), // e14
    e("e14", "compaction", { summary: "The owner asked about the fruit in notes.md; it is a quince.", firstKeptEntryId: "e11", tokensBefore: 900, details: { readFiles: ["notes.md"], modifiedFiles: [] }, fromHook: false }), // e15
    m("e15", { role: "user", content: "And its color?" }), // e16
    m("e16", asst([{ type: "text", text: "Yellow." }])), // e17
    e("e17", "session_info", { name: "Quince notes" }), // e18
  ];
  return write("--work-fruit--", "2026-11-20T10-00-00-000Z_11111111-aaaa-4000-8000-000000000001.jsonl", recs, T0 + 60_000);
}

function plain() {
  const recs = [
    { type: "session", version: 3, id: "22222222-bbbb-4000-8000-000000000002", timestamp: iso(0), cwd: "/work/other" },
    { type: "message", id: "a1", parentId: null, timestamp: iso(1), message: { role: "user", content: "Name a citrus fruit", timestamp: T0 } },
    { type: "message", id: "a2", parentId: "a1", timestamp: iso(2), message: asst([{ type: "text", text: "Lemon." }]) },
    "{broken line",
    { type: "message", id: "a3", parentId: "a2", timestamp: iso(3), message: { role: "user", content: "Another", timestamp: T0 } },
  ];
  return write("--work-other--", "2026-11-20T09-00-00-000Z_22222222-bbbb-4000-8000-000000000002.jsonl", recs, T0 + 10_000);
}

test("Pi sessions list newest first with name, folder, model and prompts", () => {
  const p1 = main();
  const p2 = plain();
  const store = moreOf("pi")!;
  expect(store.store()).toBe(home);
  const rows = store.list();
  expect(rows.map((r) => r.id)).toEqual(["11111111-aaaa-4000-8000-000000000001", "22222222-bbbb-4000-8000-000000000002"]);
  expect(rows[0]).toMatchObject({ harness: "pi", path: p1, cwd, title: "Quince notes", kind: "interactive", model: "fruit-model", first_prompt: "Which fruit is in notes.md?", last_prompt: "And its color?" });
  expect(rows[1]).toMatchObject({ path: p2, cwd: "/work/other", title: "Name a citrus fruit", last_prompt: "Another", model: "fruit-model" });
  expect(store.pending?.()).toBe(0);
});

test("a Pi session reads as the branch it ended on, with its calls, failures, compaction and notes", async () => {
  main();
  const store = moreOf("pi")!;
  const f = store.list().find((r) => r.id.endsWith("1"))!;
  const r = await store.read(f);
  const kinds = r.events.map((e) => e.kind);
  expect(kinds).toEqual(["user", "assistant", "tool_result", "assistant", "user", "note", "user", "assistant", "tool_result", "compaction", "user", "assistant"]);
  const [u1, a1, res1, a2, u2, note, u3, a3, res3, comp, u4, a4] = r.events;
  expect(u1!.data.text).toBe("Which fruit is in notes.md?");
  expect(a1!.data.blocks.map((b: any) => b.type)).toEqual(["text", "tool_use", "tool_use"]);
  expect(a1!.data.blocks[1]).toMatchObject({ id: "call_1", name: "read", input: { path: "notes.md" } });
  expect(a1!.data.model).toBe("fruit-model");
  expect(res1!.data.results).toEqual([
    { type: "tool_result", tool_use_id: "call_1", content: "quince" },
    { type: "tool_result", tool_use_id: "call_2", content: "cat: gone.md: No such file", is_error: true },
  ]);
  expect(a2!.data.blocks).toEqual([{ type: "text", text: "The fruit is quince." }]);
  expect(a2!.data.stop).toBe("end_turn");
  expect(u2!.data.text).toBe("Here is a picture of one.");
  expect(u2!.data.images).toEqual([{ type: "image", media_type: "image/png", data: expect.any(String) }]);
  expect(note!.data.text).toContain("Pi's model request failed here: 400 context too long");
  expect(u3!.data.text).toBe("Try again.");
  expect(a3!.data.stop).toBe("interrupted");
  expect(a3!.data.model).toBe("fruit-model-b");
  // The aborted call has no result in Pi: it is given one that says so, never left dangling.
  expect(res3!.data.results).toEqual([{ type: "tool_result", tool_use_id: "call_3", content: "No result was recorded for this call.", is_error: true }]);
  // The compaction keeps what Pi kept: the picture prompt and everything after it up to here (5 events).
  expect(comp!.data).toMatchObject({ mode: "summary", summary: expect.stringContaining("quince"), imported: true, tail: 5 });
  expect(u4!.data.text).toBe("And its color?");
  expect(a4!.data.blocks[0].text).toBe("Yellow.");
  expect(r.counts).toMatchObject({ prompts: 4, assistant_messages: 4, tool_calls: 3, thoughts_dropped: 1, media: 1 });
  expect(r.events.some((e) => JSON.stringify(e).includes("abandoned"))).toBe(false);
  expect(r.notes.join("\n")).toContain("2 entries on other branches");
  expect(r.notes.join("\n")).toContain("1 thinking block is not carried");
  expect(r.notes.join("\n")).toContain("The session used fruit-model, fruit-model-b.");
});

test("a damaged line is named and left out; the rest reads", async () => {
  plain();
  const store = moreOf("pi")!;
  const r = await store.read(store.list().find((x) => x.id.startsWith("2222"))!);
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant", "user"]);
  expect(r.notes.join("\n")).toContain("1 damaged record");
  expect(readLines("{}\n").bad).toEqual([]);
});

test("branch summaries, owner shell commands, extension messages and context edits read as the model saw them", async () => {
  const E = (id: string, parentId: string | null, type: string, extra: any) => ({ type, id, parentId, timestamp: iso(5), ...extra });
  const M = (id: string, parentId: string | null, message: any) => E(id, parentId, "message", { message: { ...message, timestamp: T0 } });
  write("--work-misc--", "2026-11-20T08-00-00-000Z_33333333-cccc-4000-8000-000000000003.jsonl", [
    { type: "session", version: 3, id: "33333333-cccc-4000-8000-000000000003", timestamp: iso(0), cwd: "/work/misc" },
    M("m1", null, { role: "user", content: "secret plum" }),
    M("m2", "m1", asst([{ type: "text", text: "Noted." }, { type: "text", text: "" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], { stopReason: "length" })),
    M("m3", "m2", { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a" }, { type: "image", data: PNG, mimeType: "image/png" }], isError: false }),
    M("m4", "m3", { role: "bashExecution", command: "echo pear", output: "pear", exitCode: 0, cancelled: false, truncated: false }),
    M("m5", "m4", { role: "bashExecution", command: "echo hidden", output: "hidden", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true }),
    E("m6", "m5", "custom_message", { customType: "notes", content: "Remember the orchard.", display: true }),
    E("m7", "m6", "branch_summary", { fromId: "zz", summary: "Tried apples first." }),
    E("m8", "m7", "context_edit", { targetId: "m1", replacement: null }),
    M("m9", "m8", { role: "user", content: "Go on." }),
  ], T0);
  const store = moreOf("pi")!;
  const r = await store.read(store.list().find((x) => x.id.startsWith("3333"))!);
  expect(r.events.map((e) => e.kind)).toEqual(["assistant", "tool_result", "note", "note", "note", "user"]);
  expect(r.events[0]!.data.stop).toBe("max_tokens");
  expect(r.events[1]!.data.results[0].content).toEqual([{ type: "text", text: "a" }, { type: "image", media_type: "image/png", data: PNG }]);
  expect(r.events[2]!.data).toMatchObject({ model: true, text: expect.stringContaining("echo pear") });
  expect(r.events[3]!.data.text).toContain("Remember the orchard.");
  expect(r.events[4]!.data.text).toContain("Tried apples first.");
  expect(JSON.stringify(r.events)).not.toContain("secret plum");
  expect(JSON.stringify(r.events)).not.toContain("hidden");
  expect(r.counts).toMatchObject({ skipped: 2, media: 1 });
});
