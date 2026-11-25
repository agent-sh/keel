// Kimi Code's store as it is laid out on disk: sessions/<project>/session_<id>/ with state.json, one
// agents/<agent>/wire.jsonl a agent (main, and agent-N for a sub-agent) and media/ for what a message
// carried by reference.
import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv, tempTree } from "../../../test/env.ts";
import { kimiStore } from "./kimi.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const home = tempTree("keel-kimi-");
ownEnv({ KEEL_IMPORT_KIMI_DIR: home });

const bucket = join(home, "sessions", "wd_orchard_0123456789ab");
const S1 = "session_11111111-bbbb-4000-8000-000000000001";
const S2 = "session_11111111-bbbb-4000-8000-000000000002";
const S3 = "session_11111111-bbbb-4000-8000-000000000003";
const t0 = Date.parse("2026-11-01T10:00:00.000Z");
const at = (s: number) => t0 + s * 1000;
const jsonl = (rs: any[]) => rs.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";
const put = (p: string, text: string, ageS: number) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); const t = (t0 + ageS * 1000) / 1000; utimesSync(p, t, t); };

// A record as the wire holds it.
const rec = (type: string, s: number, body: any = {}) => ({ type, agentId: "main", ...body, time: at(s) });
const loop = (s: number, event: any) => rec("context.append_loop_event", s, { event });
const msg = (s: number, text: string, origin: any = { kind: "user" }, extra: any[] = []) => rec("context.append_message", s, { message: { role: "user", content: [{ type: "text", text }, ...extra], toolCalls: [], origin } });
const step = (n: number, s: number, parts: any[], calls: any[] = [], results: any[] = [], model = "model-a") => [
  loop(s, { type: "step.begin", uuid: `u${n}`, turnId: "0", step: n }),
  rec("llm.request", s, { kind: "main", provider: "openai", model, modelAlias: `kimi-code/${model}` }),
  ...parts.map((part, i) => loop(s, { type: "content.part", uuid: `p${n}${i}`, stepUuid: `u${n}`, block: part.__block ?? i, part: Object.fromEntries(Object.entries(part).filter(([k]) => k !== "__block")) })),
  ...calls.map((c) => loop(s, { type: "tool.call", uuid: `k${c.id}`, stepUuid: `u${n}`, toolCallId: c.id, name: c.name, args: c.args })),
  ...results.map((r) => loop(s + 1, { type: "tool.result", parentUuid: `k${r.id}`, toolCallId: r.id, result: { output: r.output, isError: r.isError, durationMs: 5 } })),
  loop(s + 1, { type: "step.end", uuid: `u${n}`, turnId: "0", step: n, finishReason: "stop" }),
  rec("agent.message.appended", s + 1, { kind: "event", message: { message: { role: "assistant", content: [] }, meta: { source: "llm" } } }),
];

function build() {
  const d1 = join(bucket, S1);
  const wire = [
    { type: "metadata", protocol_version: "1.5", created_at: at(0) },
    rec("profile.bind", 0, { modelAlias: "kimi-code/model-a", profileName: "agent", thinkingEffort: "high" }),
    msg(1, "<system-reminder>today is a day</system-reminder>", { kind: "injection", variant: "env" }),
    msg(2, "Which fruit is in notes.md? See the picture.", { kind: "user", attachments: [{ name: "notes.md", mediaType: "text/markdown", size: 5, path: "/work/orchard/notes.md" }] }, [{ type: "image_url", imageUrl: { url: "kimi-file://f_pic" } }]),
    rec("turn.prompt", 2, { input: [], promptId: "p1", turnId: 0 }),
    ...step(1, 3, [{ type: "think", think: "hmm" }, { type: "text", text: "I will read the notes." }, { type: "text", text: "I will read the notes, then check.", __block: 1 }],
      [{ id: "c1", name: "Read", args: { path: "/work/orchard/notes.md" } }, { id: "c2", name: "Bash", args: { command: "cat gone.md" } }],
      [{ id: "c1", output: "quince" }, { id: "c2", output: "cat: gone.md: No such file", isError: true }]),
    rec("subagent.spawned", 5, { subagentId: "agent-0", subagentName: "explore", parentToolCallId: "c3", description: "check" }),
    ...step(2, 5, [{ type: "text", text: "A sub-agent will check." }], [{ id: "c3", name: "Agent", args: { prompt: "check" } }],
      [{ id: "c3", output: [{ type: "text", text: "no change" }, { type: "image_url", imageUrl: { url: "kimi-file://f_pic" } }, { type: "audio_url", audioUrl: { url: "kimi-file://f_voice" } }] }]),
    "{broken line",
    msg(7, "<notification id=\"task:bash-1:failed\" category=\"task\">a background job failed</notification>", { kind: "task", taskId: "t1", status: "failed", notificationId: "n1" }),
    ...step(3, 8, [{ type: "text", text: "The fruit is quince." }]),
    msg(10, "Thanks. Now list the colors."),
    ...step(4, 11, [{ type: "text", text: "Listing." }], [{ id: "c4", name: "Bash", args: { command: "ls" } }]), // no result recorded
    rec("full_compaction.begin", 13, { source: "manual" }),
    rec("context.apply_compaction", 14, { summary: "short", contextSummary: "The owner asked about quince.", compactedCount: 9, keptUserMessageCount: 2 }),
    msg(15, "Oops, undo that."),
    ...step(5, 16, [{ type: "text", text: "This reply is undone." }]),
    rec("context.undo", 18, { count: 1 }),
    rec("context.clear", 19),
    msg(20, "Last question: any plums?"),
    ...step(6, 21, [{ type: "text", text: "No plums." }]),
    rec("turn.ended", 23, { turnId: 0, reason: "cancelled" }),
    rec("turn.ended", 24, { turnId: 1, reason: "failed" }),
  ];
  put(join(d1, "agents", "main", "wire.jsonl"), jsonl(wire) + '{"type":"context.append_mess', 100);
  put(join(d1, "state.json"), JSON.stringify({ id: S1, version: 2, cwd: "/work/orchard", archived: false, agents: { main: { type: "main" }, "agent-0": { type: "sub", parentAgentId: "main", labels: { parentAgentId: "main", profileName: "explore" } } }, createdAt: at(0), updatedAt: at(60), title: "Quince notes", isCustomTitle: true }), 100);
  put(join(d1, "media", "f_pic.png"), Buffer.from(PNG, "base64") as any, 100);
  put(join(d1, "media", "meta", "f_pic.json"), JSON.stringify({ version: 1, key: "f_pic.png", name: "pic.png", mediaType: "image/png" }), 100);

  // The sub-agent: its task comes from its parent as a system trigger.
  const sub = [
    { type: "metadata", protocol_version: "1.5", created_at: at(5) },
    { ...msg(6, "Check the notes for a change.", { kind: "system_trigger", name: "subagent_task" }), agentId: "agent-0" },
    ...step(1, 7, [{ type: "text", text: "No change." }]).map((r: any) => ({ ...r, agentId: "agent-0" })),
  ];
  put(join(d1, "agents", "agent-0", "wire.jsonl"), jsonl(sub), 90);

  // No title in state.json: the first prompt names it.
  const d2 = join(bucket, S2);
  put(join(d2, "agents", "main", "wire.jsonl"), jsonl([{ type: "metadata", protocol_version: "1.5", created_at: at(0) }, msg(1, "Is a pear a fruit?"), ...step(1, 2, [{ type: "text", text: "Yes." }], [], [], "model-b")]), 50);
  put(join(d2, "state.json"), JSON.stringify({ id: S2, version: 2, cwd: "/work/old", archived: true, agents: { main: { type: "main" } }, createdAt: at(0), updatedAt: at(10) }), 50);

  // A session that never ran: no wire.
  put(join(bucket, S3, "state.json"), JSON.stringify({ id: S3, version: 2, cwd: "/work/none", agents: {} }), 10);
}
build();

test("lists the sessions newest first, with the sub-agent as a row of its own, and skips one with no wire", () => {
  const rows = kimiStore.list();
  expect(kimiStore.store()).toBe(home);
  expect(rows.map((r) => r.id)).toEqual([S1, S2, `${S1}:agent-0`].sort((x, y) => rows.find((r) => r.id === y)!.updated_ms - rows.find((r) => r.id === x)!.updated_ms));
  const a = rows.find((r) => r.id === S1)!;
  expect(a).toMatchObject({ harness: "kimi", path: join(bucket, S1, "agents", "main", "wire.jsonl"), cwd: "/work/orchard", title: "Quince notes", model: "model-a", kind: "interactive", first_prompt: "Which fruit is in notes.md? See the picture.", last_prompt: "Last question: any plums?" });
  expect(rows.find((r) => r.id === S2)).toMatchObject({ title: "Is a pear a fruit?", model: "model-b", archived: true, cwd: "/work/old" });
  expect(rows.find((r) => r.id === `${S1}:agent-0`)).toMatchObject({ kind: "subagent", parent_id: S1, first_prompt: "Check the notes for a change.", cwd: "/work/orchard" });
  expect(kimiStore.pending?.()).toBe(0);
});

test("reads a session in order: prompts with images, replies, calls and results, failures, a compaction, an undo, a clear", async () => {
  const r = await kimiStore.read(kimiStore.list().find((x) => x.id === S1)!);
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant", "tool_result", "assistant", "tool_result", "note", "assistant", "user", "assistant", "tool_result", "compaction", "note", "user", "assistant"]);
  const [u1, a1, r1, a2, r2, task, a3, u2, a4, r4, comp, clear, u3, a5] = r.events;
  expect(u1!.data.text).toBe("Which fruit is in notes.md? See the picture.");
  expect(u1!.data.images).toEqual([{ type: "image", media_type: "image/png", data: PNG }]);
  // A block written again replaces the first one; the thought is counted, not carried.
  expect(a1!.data.blocks.map((b: any) => (b.type === "tool_use" ? `${b.name}:${b.id}` : b.text))).toEqual(["I will read the notes, then check.", "Read:c1", "Bash:c2"]);
  expect(a1!.data.model).toBe("model-a");
  expect(r1!.data.results.map((x: any) => [x.tool_use_id, x.content, !!x.is_error])).toEqual([["c1", "quince", false], ["c2", "cat: gone.md: No such file", true]]);
  expect(r2!.data.results[0].content).toEqual([{ type: "text", text: "no change" }, { type: "image", media_type: "image/png", data: PNG }, { type: "text", text: "[unavailable: audio]" }]);
  expect(task!.data).toMatchObject({ model: true, imported: true });
  expect(task!.data.text).toContain("a background job failed");
  expect(a3!.data.blocks).toEqual([{ type: "text", text: "The fruit is quince." }]);
  expect(u2!.data.text).toBe("Thanks. Now list the colors.");
  expect(r4!.data.results[0]).toMatchObject({ tool_use_id: "c4", is_error: true });
  expect(r4!.data.results[0].content).toContain("interrupted before its result was recorded");
  expect(comp!.data).toMatchObject({ mode: "summary", summary: "The owner asked about quince.", imported: true, trigger: "manual" });
  expect(clear!.data.text).toContain("cleared");
  expect(u3!.data.text).toBe("Last question: any plums?");
  expect(a5!.data.stop).toBe("interrupted");
  const all = JSON.stringify(r.events);
  expect(all).not.toContain("today is a day"); // Kimi's own reminder is not the owner's
  expect(all).not.toContain("undone");
  expect(r.counts).toMatchObject({ prompts: 3, assistant_messages: 5, tool_calls: 4, thoughts_dropped: 1, media: 2 });
  const notes = r.notes.join("\n");
  expect(notes).toContain("1 reminder");
  expect(notes).toContain("1 reasoning block is not carried");
  expect(notes).toContain("1 sub-agent run");
  expect(notes).toContain("1 attachment");
  expect(notes).toContain("1 audio");
  expect(notes).toContain("1 undo");
  expect(notes).toContain("kept the 2 latest user messages");
  expect(notes).toContain("1 turn ended with an error");
  expect(notes).toContain("line 25");
  expect(notes).toContain("still being written");
});

test("reads a sub-agent's own wire, whose task was a system trigger", async () => {
  const r = await kimiStore.read(kimiStore.list().find((x) => x.id === `${S1}:agent-0`)!);
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant"]);
  expect(r.events[0]!.data.text).toBe("Check the notes for a change.");
});

test("a repeat listing reads again only a wire that changed", () => {
  const before = kimiStore.list();
  const again = kimiStore.list();
  expect(again.find((x) => x.id === S2)).toBe(before.find((x) => x.id === S2)!);
  put(join(bucket, S2, "agents", "main", "wire.jsonl"), jsonl([{ type: "metadata", protocol_version: "1.5", created_at: at(0) }, msg(1, "A new first question")]), 500);
  expect(kimiStore.list()[0]).toMatchObject({ id: S2, title: "A new first question" });
});
