// The Grok CLI reader on a store in its real layout (sessions/<encoded cwd>/<id>/ with
// summary.json, chat_history.jsonl, updates.jsonl, subagents/<id>/meta.json), with
// invented content: a conversation with two tool calls (one failed), a search Grok ran
// on its servers, an image result, a finished-task notice, a subagent, a compaction,
// a session with a damaged line and a call left without a result.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv, tempTree } from "../../../test/env.ts";

const home = tempTree("keel-grok-");
ownEnv({ KEEL_IMPORT_GROK_DIR: home });
const { grokSessions, grokStore } = await import("./grok.ts");
const { moreOf } = await import("./more.ts");

const CWD = "/work/orchard";
const group = join(home, "sessions", encodeURIComponent(CWD));
const ID = { main: "01a00000-0000-7000-8000-00000000000a", parent: "01a00000-0000-7000-8000-00000000000b", child: "01a00000-0000-7000-8000-00000000000c", compact: "01a00000-0000-7000-8000-00000000000d", damaged: "01a00000-0000-7000-8000-00000000000e", empty: "01a00000-0000-7000-8000-00000000000f" };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const T = Date.UTC(2026, 10, 1, 9, 0, 0);

const jl = (rs: any[]) => rs.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";
const text = (t: string) => [{ type: "text", text: t }];
const SYSTEM = { type: "system", content: "You are Grok." };
const ENV = { type: "user", content: text("<user_info>\nOS Version: linux\nWorkspace Path: /work/orchard\n</user_info>") };
const REMINDER = { type: "user", content: text("<system-reminder> Skills available: none </system-reminder>"), synthetic_reason: "system_reminder" };
const prompt = (t: string, i: number, wrap = true) => ({ type: "user", content: text(wrap ? `<user_query>\n${t}\n</user_query>` : t), prompt_index: i });
const reasoning = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking" }], encrypted_content: "AAAA", status: "completed" };
const call = (id: string, name: string, args: any) => ({ id, name, arguments: JSON.stringify(args) });
const asst = (content: string, tool_calls: any[] | null, model_id = "grok-4.7-build") => ({ type: "assistant", content, tool_calls, model_id, model_fingerprint: "fp", reasoning_effort: "high" });
const result = (id: string, content: string, extra: any = {}) => ({ type: "tool_result", tool_call_id: id, content, ...extra });
const update = (u: any, sec: number) => ({ timestamp: Math.floor((T + sec * 1000) / 1000), method: "session/update", params: { sessionId: "x", update: u, _meta: { agentTimestampMs: T + sec * 1000 } } });

function session(id: string, o: { summary?: any; chat: any[]; updates?: any[]; meta?: Record<string, any>; at: number }) {
  const dir = join(group, id);
  mkdirSync(dir, { recursive: true });
  const sum = { info: { id, cwd: CWD }, session_summary: "", created_at: new Date(T + o.at).toISOString().replace("Z", "123456Z"), updated_at: new Date(T + o.at + 5000).toISOString(), current_model_id: "grok-4.7", chat_format_version: 1, ...o.summary };
  writeFileSync(join(dir, "summary.json"), JSON.stringify(sum));
  writeFileSync(join(dir, "chat_history.jsonl"), jl(o.chat));
  if (o.updates) writeFileSync(join(dir, "updates.jsonl"), jl(o.updates));
  for (const [sub, m] of Object.entries(o.meta ?? {})) {
    mkdirSync(join(dir, "subagents", sub), { recursive: true });
    writeFileSync(join(dir, "subagents", sub, "meta.json"), JSON.stringify(m));
  }
}

// A conversation about a mango: two calls at once (the second fails), a reply, a
// second prompt answered through a call that returns an image, a finished-task notice.
session(ID.main, {
  at: 0,
  summary: { generated_title: "Pick a mango" },
  chat: [
    SYSTEM, ENV, REMINDER,
    prompt("Which mango is ripe?", 0),
    reasoning,
    { type: "backend_tool_call", kind: { tool_type: "x_search", call_id: "s1", input: "{}", name: "x_keyword_search", id: "rs_2" } },
    asst("Let me check the basket.", [call("call_1", "read_file", { path: "basket.txt" }), call("call_2", "run_terminal_command", { command: "exit 3" })]),
    result("call_1", "mango: ripe"),
    result("call_2", "exit code 3"),
    asst("The mango is ripe.", null),
    prompt("Thanks, and the papaya?", 1, false),
    asst("", [call("call_3", "view_image", { path: "papaya.png" })]),
    result("call_3", "papaya.png", { images: [{ type: "image", url: `data:image/png;base64,${PNG}` }] }),
    { type: "user", content: text("<system-reminder> Background task \"call_9\" completed (exit code: 0). </system-reminder>"), synthetic_reason: "task_completed", prompt_index: 2 },
    asst("The papaya is not ripe yet.", null),
  ],
  updates: [
    update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "x" }, _meta: { promptIndex: 0 } }, 1),
    update({ sessionUpdate: "tool_call", toolCallId: "call_1", title: "read" }, 2),
    update({ sessionUpdate: "tool_call", toolCallId: "call_2", title: "run" }, 2),
    update({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" }, 3),
    update({ sessionUpdate: "tool_call_update", toolCallId: "call_2", status: "failed" }, 4),
    update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "y" }, _meta: { promptIndex: 1 } }, 10),
    update({ sessionUpdate: "tool_call_update", toolCallId: "call_3", status: "completed" }, 12),
  ],
});

// A parent that started a subagent, and the child, a session of its own.
session(ID.parent, {
  at: 100_000,
  summary: { session_kind: "headless", generated_title: "Sort the pears" },
  chat: [SYSTEM, ENV, prompt("Sort the pears by size.", 0), asst("Started a helper.", null)],
  meta: { [ID.child]: { subagent_id: ID.child, parent_session_id: ID.parent, child_session_id: ID.child, subagent_type: "explore", description: "Weigh pears", prompt: "Weigh the pears." } },
});
session(ID.child, {
  at: 110_000,
  summary: { session_kind: "subagent", agent_name: "explore", generated_title: "Weigh pears", current_model_id: "grok-4.6" },
  chat: [SYSTEM, ENV, prompt("Weigh the pears.", 0, false), asst("Each pear is light.", null, "grok-4.6-build")],
});

// A compacted session: the file holds the kept prompt and the summary, not the turns before.
session(ID.compact, {
  at: 200_000,
  summary: { generated_title: "Plum jam" },
  chat: [
    SYSTEM,
    { type: "user", content: text("<user_info>\nOS Version: linux\n</user_info>"), synthetic_reason: "compaction_meta" },
    { type: "user", content: text("<user_query>\nMake plum jam.\n</user_query>") },
    { type: "user", content: text("This session is being continued from a previous conversation. Summary: the plums are washed."), synthetic_reason: "compaction_meta" },
    asst("Next I boil them.", null),
  ],
});

// A damaged line, and a call whose result was never written.
session(ID.damaged, {
  at: 300_000,
  summary: { session_summary: "Fig count" },
  chat: [SYSTEM, ENV, prompt("Count the figs.", 0), "{broken", asst("", [call("call_7", "read_file", { path: "figs.txt" }), { id: "call_8", name: "list_dir", arguments: "not json" }]), result("call_8", "empty")],
});

// A start that was never used.
session(ID.empty, { at: 400_000, chat: [SYSTEM, ENV] });

test("a listing reads only what it has time for, and a repeat reads nothing again", () => {
  // No time: nothing is read, everything waits.
  const none = grokSessions(home, -1);
  expect(none.length).toBeLessThan(5);
  expect(grokStore.pending!()).toBeGreaterThan(0);
  const all = grokSessions(home, 10_000);
  expect(all).toHaveLength(5);
  expect(grokStore.pending!()).toBe(0);
  // Rows that have not changed are the same rows.
  const again = grokSessions(home, -1);
  expect(again.map((r) => r.id)).toEqual(all.map((r) => r.id));
  expect(grokStore.pending!()).toBe(0);
});

test("the store is the Grok folder and lists every session with a prompt, newest first", () => {
  expect(moreOf("grok")).toBe(grokStore);
  expect(grokStore.store()).toBe(home);
  const rows = grokStore.list();
  expect(rows.map((r) => r.id)).toEqual([ID.damaged, ID.compact, ID.child, ID.parent, ID.main]);
  const main = rows.find((r) => r.id === ID.main)!;
  expect(main).toMatchObject({ harness: "grok", path: join(group, ID.main, "chat_history.jsonl"), cwd: CWD, title: "Pick a mango", first_prompt: "Which mango is ripe?", last_prompt: "Thanks, and the papaya?", model: "grok-4.7", kind: "interactive" });
  expect(main.parent_id).toBeUndefined();
  expect(main.updated_ms).toBe(T + 5000);
  expect(rows.find((r) => r.id === ID.parent)).toMatchObject({ kind: "headless", title: "Sort the pears" });
  expect(rows.find((r) => r.id === ID.child)).toMatchObject({ kind: "subagent", parent_id: ID.parent, model: "grok-4.6" });
  // With no generated title, the summary is the title.
  expect(rows.find((r) => r.id === ID.damaged)?.title).toBe("Fig count");
  expect(grokStore.pending?.()).toBe(0);
});

test("a session is read whole: prompts, replies, calls and results in order, a failed call flagged", async () => {
  const f = grokStore.list().find((r) => r.id === ID.main)!;
  const r = await grokStore.read(f);
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant", "tool_result", "assistant", "user", "assistant", "tool_result", "note", "assistant"]);
  const [u1, a1, res1, a2, u2, a3, res3, note, a4] = r.events;
  expect(u1!.data.text).toBe("Which mango is ripe?");
  expect(u1!.ts).toBe(T + 1000);
  expect(a1!.data.blocks.map((b: any) => b.type)).toEqual(["text", "tool_use", "tool_use"]);
  expect(a1!.data.blocks[1]).toMatchObject({ id: "call_1", name: "read_file", input: { path: "basket.txt" } });
  expect(a1!.data.model).toBe("grok-4.7-build");
  expect(a1!.ts).toBe(T + 2000);
  expect(res1!.data.results).toEqual([
    { type: "tool_result", tool_use_id: "call_1", content: "mango: ripe", is_error: undefined },
    { type: "tool_result", tool_use_id: "call_2", content: "exit code 3", is_error: true },
  ]);
  expect(res1!.ts).toBe(T + 3000);
  expect(a2!.data.blocks[0].text).toBe("The mango is ripe.");
  expect(a2!.data.stop).toBe("end_turn");
  expect(u2!.data.text).toBe("Thanks, and the papaya?");
  expect(a3!.data.blocks).toEqual([{ type: "tool_use", id: "call_3", name: "view_image", input: { path: "papaya.png" } }]);
  expect(res3!.data.results[0].content).toEqual([{ type: "text", text: "papaya.png" }, { type: "image", media_type: "image/png", data: PNG }]);
  expect(note!.data).toMatchObject({ model: true, text: 'Background task "call_9" completed (exit code: 0).' });
  expect(a4!.data.blocks[0].text).toBe("The papaya is not ripe yet.");
  expect(r.counts).toMatchObject({ prompts: 2, assistant_messages: 4, tool_calls: 3, thoughts_dropped: 1, media: 1 });
  expect(r.notes.join("\n")).toContain("1 reasoning record is not carried");
  expect(r.notes.join("\n")).toContain("x_keyword_search: 1");
  expect(r.notes.join("\n")).toContain("3 records Grok added");
  expect(r.notes.join("\n")).not.toContain("compacted");
});

test("a subagent is read as its own session", async () => {
  const f = grokStore.list().find((x) => x.id === ID.child)!;
  const r = await grokStore.read(f);
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant"]);
  expect(r.events[0]!.data.text).toBe("Weigh the pears.");
  expect(r.events[1]!.data.model).toBe("grok-4.6-build");
});

test("a compaction keeps its summary and says the turns before it are gone", async () => {
  const r = await grokStore.read(grokStore.list().find((x) => x.id === ID.compact)!);
  expect(r.events.map((e) => e.kind)).toEqual(["user", "compaction", "assistant"]);
  expect(r.events[0]!.data.text).toBe("Make plum jam.");
  expect(r.events[1]!.data.summary).toContain("the plums are washed");
  expect(r.notes.join("\n")).toContain("compacted this session");
});

test("a damaged line is counted and named, and a call with no result is closed as failed", async () => {
  const r = await grokStore.read(grokStore.list().find((x) => x.id === ID.damaged)!);
  expect(r.notes.join("\n")).toContain("1 damaged record could not be read (line 4)");
  expect(r.notes.join("\n")).toContain("not JSON");
  const res = r.events.find((e) => e.kind === "tool_result")!;
  expect(res.data.results.map((x: any) => [x.tool_use_id, x.is_error])).toEqual([["call_8", undefined], ["call_7", true]]);
});
