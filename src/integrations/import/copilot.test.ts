// GitHub Copilot CLI's store as it is laid out on disk: session-state/<id>/events.jsonl with
// workspace.yaml beside it, an older flat <id>.jsonl, a rotated log with its archive.
import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv, tempTree } from "../../../test/env.ts";
import { copilotStore } from "./copilot.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const home = tempTree("keel-copilot-");
ownEnv({ KEEL_IMPORT_COPILOT_DIR: home });

const root = join(home, "session-state");
const A = "11111111-aaaa-4000-8000-000000000001";
const B = "11111111-aaaa-4000-8000-000000000002";
const C = "11111111-aaaa-4000-8000-000000000003";
const D = "11111111-aaaa-4000-8000-000000000004";
const t0 = Date.parse("2026-11-01T10:00:00.000Z");
const at = (s: number) => new Date(t0 + s * 1000).toISOString();
let n = 0;
const ev = (type: string, s: number, data: any, extra: any = {}) => ({ id: `e${++n}`, parentId: null, timestamp: at(s), type, data, ...extra });
const jsonl = (rs: any[]) => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";
const put = (p: string, text: string, ageS: number) => { writeFileSync(p, text); const t = (t0 + ageS * 1000) / 1000; utimesSync(p, t, t); };
const yaml = (id: string, name: string) => `id: ${id}\ncwd: /work/orchard\nclient_name: cli\nname: ${name}\nuser_named: false\nsummary_count: 0\nfork_count: 0\ncreated_at: ${at(0)}\nupdated_at: ${at(60)}\n`;

function build() {
  mkdirSync(join(root, A), { recursive: true });
  const a = [
    ev("session.start", 0, { sessionId: A, selectedModel: "auto", context: { cwd: "/work/orchard" }, copilotVersion: "1.0.0", producer: "copilot-agent", startTime: at(0) }),
    ev("system.message", 0, { role: "system", content: "You are a coding agent." }),
    ev("session.binary_asset", 1, { assetId: "sha256:aa", mimeType: "image/png", data: PNG, byteLength: 70, type: "image" }),
    ev("user.message", 1, { content: "Which fruit is in notes.md? See the picture.", transformedContent: "<wrapped/>", attachments: [{ type: "file", displayName: "pic.png", path: "/work/orchard/pic.png", assetId: "sha256:aa", mimeType: "image/png" }, { type: "file", displayName: "notes.md", path: "/work/orchard/notes.md" }] }),
    ev("assistant.turn_start", 2, { turnId: "t1" }),
    ev("assistant.message", 3, { messageId: "m1", model: "model-a", content: "I will read the notes.", reasoningText: "think", encryptedContent: "xx", toolRequests: [{ toolCallId: "c1", name: "view", arguments: { path: "/work/orchard/notes.md" } }, { toolCallId: "c2", name: "bash", arguments: { command: "cat gone.md" } }, { toolCallId: "c3", name: "bash", arguments: { command: "sleep 1" } }, { toolCallId: "c5", name: "bash", arguments: { command: "rm x" } }] }),
    ev("tool.execution_start", 4, { toolCallId: "c1", toolName: "view", arguments: { path: "/work/orchard/notes.md" } }),
    ev("tool.execution_complete", 5, { toolCallId: "c1", success: true, result: { content: "quince", detailedContent: "quince (3 lines)" } }),
    ev("tool.execution_complete", 6, { toolCallId: "c2", success: false, result: { content: "cat: gone.md: No such file" }, error: { message: "exit 1", code: "failure" } }),
    ev("tool.execution_complete", 6, { toolCallId: "c5", success: false, error: { message: "The user denied this call.", code: "denied" } }),
    ev("session.error", 7, { errorType: "quota", message: "quota exceeded", statusCode: 402 }),
    ev("assistant.message", 8, { messageId: "m2", model: "model-a", content: "A sub-agent will check.", toolRequests: [{ toolCallId: "c4", name: "task", arguments: { prompt: "check" } }] }),
    ev("subagent.started", 8, { toolCallId: "c4", agentName: "explore" }),
    ev("assistant.message", 9, { messageId: "s1", model: "model-s", content: "inner words", toolRequests: [] }, { agentId: "ag1" }),
    ev("tool.execution_complete", 10, { toolCallId: "c4", success: true, result: { content: "no change", binaryResultsForLlm: [{ type: "image", mimeType: "image/png", data: PNG }, { type: "resource", mimeType: "application/pdf" }] } }),
    ev("assistant.message", 11, { messageId: "m3", model: "model-b", content: "The fruit is quince.", phase: "final_answer" }),
    ev("user.message", 12, { content: "hidden skill text", source: "skill-pdf" }),
    ev("user.message", 13, { content: "Thanks. Now list the colors." }),
    ev("tool.execution_start", 14, { toolCallId: "u1", toolName: "bash", arguments: { command: "ls" } }),
    ev("tool.execution_complete", 15, { toolCallId: "u1", success: true, result: { content: "a b" } }),
    ev("session.compaction_complete", 16, { success: true, summaryContent: "The owner asked about quince.", trigger: "auto" }),
    ev("user.message", 17, { content: "Oops, undo that." }),
    ev("assistant.message", 18, { messageId: "m4", model: "model-b", content: "This reply is rewound." }),
    ev("session.snapshot_rewind", 19, { upToEventId: `e${n}`, eventsRemoved: 1 }),
    ev("session.context_cleared", 20, { messagesCleared: 8 }),
    ev("user.message", 21, { content: "Last question: any plums?" }),
    ev("assistant.message", 22, { messageId: "m5", model: "model-b", content: "No plums.", toolRequests: [{ toolCallId: "c9", name: "bash", arguments: { command: "sleep 99" } }] }),
    ev("abort", 23, { reason: "user_initiated" }),
    ev("session.shutdown", 24, {}),
  ];
  put(join(root, A, "events.jsonl"), jsonl(a) + '{"type":"user.mess', 100);
  put(join(root, A, "workspace.yaml"), yaml(A, "|-\n  Quince notes"), 100);

  // An older version: one flat file, no workspace.yaml.
  put(join(root, `${B}.jsonl`), jsonl([
    ev("session.start", 0, { sessionId: B, context: { cwd: "/work/old" }, selectedModel: "model-old" }),
    ev("user.message", 1, { content: "Is a pear a fruit?" }),
    ev("assistant.message", 2, { messageId: "o1", content: "Yes.", model: "model-old" }),
  ]), 50);

  // A folder that never held a conversation.
  mkdirSync(join(root, C), { recursive: true });
  put(join(root, C, "workspace.yaml"), yaml(C, "empty"), 10);

  // A rotated log: the head links to its archive and starts with a replay checkpoint.
  mkdirSync(join(root, D), { recursive: true });
  put(join(root, D, "events.1.jsonl"), jsonl([
    ev("session.start", 0, { sessionId: D, context: { cwd: "/work/long" }, selectedModel: "model-r" }),
    ev("user.message", 1, { content: "Start of a long session." }),
    ev("assistant.message", 2, { messageId: "r1", content: "Started.", model: "model-r" }),
  ]), 20);
  put(join(root, D, "events.jsonl"), jsonl([
    ev("session.journal_link", 3, { previousFile: "events.1.jsonl", sessionId: D, version: 1 }),
    ev("user.message", 3, { content: "replayed copy" }, { checkpoint: true }),
    ev("user.message", 4, { content: "Later in the long session." }),
    ev("assistant.message", 5, { messageId: "r2", content: "Later.", model: "model-r" }),
  ]), 30);
}
build();

test("lists the sessions newest first, from the log and workspace.yaml, and skips a folder with no log", () => {
  const rows = copilotStore.list();
  expect(copilotStore.store()).toBe(home);
  expect(rows.map((r) => r.id)).toEqual([A, B, D].sort((x, y) => rows.find((r) => r.id === y)!.updated_ms - rows.find((r) => r.id === x)!.updated_ms));
  expect(rows.map((r) => r.id)).toEqual([A, B, D]);
  const a = rows.find((r) => r.id === A)!;
  expect(a).toMatchObject({ harness: "copilot", path: join(root, A, "events.jsonl"), cwd: "/work/orchard", title: "Quince notes", model: "model-b", kind: "interactive", first_prompt: "Which fruit is in notes.md? See the picture.", last_prompt: "Last question: any plums?" });
  const b = rows.find((r) => r.id === B)!;
  expect(b).toMatchObject({ cwd: "/work/old", title: "Is a pear a fruit?", model: "model-old" });
  expect(rows.find((r) => r.id === D)!.last_prompt).toBe("Later in the long session.");
  expect(copilotStore.pending?.()).toBe(0);
});

test("reads a session in order: prompts with images, replies, calls and their results, failures, a compaction, a rewind", async () => {
  const f = copilotStore.list().find((r) => r.id === A)!;
  const r = await copilotStore.read(f);
  const kinds = r.events.map((e) => e.kind);
  expect(kinds).toEqual(["user", "assistant", "tool_result", "assistant", "tool_result", "assistant", "user", "assistant", "tool_result", "compaction", "user", "note", "user", "assistant", "tool_result"]);
  const [u1, a1, r1, a2, r2, a3, u2, a4, r4, comp, u3, note, u4, a5, r5] = r.events;
  expect(u1!.data.text).toBe("Which fruit is in notes.md? See the picture.");
  expect(u1!.data.images).toEqual([{ type: "image", media_type: "image/png", data: PNG }]);
  expect(a1!.data.blocks.map((b: any) => b.type === "tool_use" ? `${b.name}:${b.id}` : b.type)).toEqual(["text", "view:c1", "bash:c2", "bash:c3", "bash:c5"]);
  expect(a1!.data.model).toBe("model-a");
  expect(a1!.data.blocks[1].input).toEqual({ path: "/work/orchard/notes.md" });
  expect(r1!.data.results.map((x: any) => [x.tool_use_id, x.content, !!x.is_error])).toEqual([
    ["c1", "quince", false],
    ["c2", "cat: gone.md: No such file", true],
    ["c3", "No result was recorded for this call.", true],
    ["c5", "The user denied this call.", true],
  ]);
  expect(a2!.data.blocks.at(-1).name).toBe("task");
  // The sub-agent's own message is left out; the call's result carries an image and names what could not be carried.
  expect(JSON.stringify(r.events)).not.toContain("inner words");
  expect(r2!.data.results[0].content).toEqual([{ type: "text", text: "no change" }, { type: "image", media_type: "image/png", data: PNG }, { type: "text", text: "[unavailable: resource result (application/pdf)]" }]);
  expect(a3!.data.blocks).toEqual([{ type: "text", text: "The fruit is quince." }]);
  expect(u2!.data.text).toBe("Thanks. Now list the colors.");
  expect(a4!.data.blocks[0]).toMatchObject({ type: "tool_use", id: "u1", name: "bash" });
  expect(r4!.data.results[0]).toMatchObject({ tool_use_id: "u1", content: "a b" });
  expect(comp!.data).toMatchObject({ mode: "summary", summary: "The owner asked about quince.", imported: true, trigger: "auto" });
  expect(u3!.data.text).toBe("Oops, undo that."); // the rewind removed its reply only
  expect(note!.data.text).toContain("cleared its context");
  expect(u4!.data.text).toBe("Last question: any plums?");
  expect(a5!.data.stop).toBe("interrupted");
  expect(r5!.data.results[0]).toMatchObject({ tool_use_id: "c9", content: "The call was cancelled.", is_error: true });
  expect(r.events.some((e) => JSON.stringify(e.data).includes("hidden skill text") || JSON.stringify(e.data).includes("rewound"))).toBe(false);
  expect(r.counts).toMatchObject({ prompts: 4, assistant_messages: 5, tool_calls: 7, thoughts_dropped: 1, media: 2, skipped: 2 });
  expect(r.notes.join("\n")).toContain("1 reasoning block is not carried");
  expect(r.notes.join("\n")).toContain("1 sub-agent run: 1 event of their own steps is left out");
  expect(r.notes.join("\n")).toContain("1 skill text");
  expect(r.notes.join("\n")).toContain("1 attachment");
  expect(r.notes.join("\n")).toContain("1 event the session rewound is left out");
  expect(r.notes.join("\n")).toContain("1 error");
  expect(r.notes.join("\n")).toContain("still being written");
  expect(r.notes.join("\n")).toContain("system prompt");
});

test("reads a flat file of an older version and a rotated log through its archive", async () => {
  const rows = copilotStore.list();
  const b = await copilotStore.read(rows.find((r) => r.id === B)!);
  expect(b.events.map((e) => e.kind)).toEqual(["user", "assistant"]);
  const d = await copilotStore.read(rows.find((r) => r.id === D)!);
  expect(d.events.map((e) => e.kind === "user" ? e.data.text : e.data.blocks[0].text)).toEqual(["Start of a long session.", "Started.", "Later in the long session.", "Later."]);
});

test("a repeat listing reads again only a log that changed", () => {
  const before = copilotStore.list();
  const again = copilotStore.list();
  expect(again[0]).toBe(before[0]!); // the same row object: not read again
  put(join(root, B + ".jsonl"), jsonl([ev("session.start", 0, { sessionId: B, context: { cwd: "/work/old" } }), ev("user.message", 1, { content: "A new first question" })]), 500);
  expect(copilotStore.list()[0]).toMatchObject({ id: B, title: "A new first question" });
});
