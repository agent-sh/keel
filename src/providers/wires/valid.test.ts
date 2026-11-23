// A request built from any stored history is valid for the wire it is sent on.
// A provider that refuses a request as malformed refuses every later one of
// the session too (the block that made it malformed stays in the history), so
// the projection repairs what the request's own wire refuses, and nothing
// else: a history a wire takes as it is stored is sent as it is stored.
// Proved three ways: the provider refusals seen in the field, each from a
// constructed history; random histories (calls, results, images, attachments,
// checkpoints, cuts, family switches) against each wire's rules (valid.ts);
// and that a request whose unrepaired form passes its wire's rules is the
// same bytes with and without the repairs.
import { afterAll, expect, test } from "bun:test";
import { ownEnv } from "../../../test/env.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, StoredEvent } from "../../core/types.ts";
import type { ProviderRequest, ToolSpec } from "../types.ts";

// Nothing here reads the owner's configuration.
const CONFIG = mkdtempSync(join(tmpdir(), "keel-valid-"));
ownEnv({ KEEL_CONFIG_DIR: CONFIG });
afterAll(() => rmSync(CONFIG, { recursive: true, force: true }));
const { toMessages } = await import("../../engine/turn.ts");
const { resolveAttachments } = await import("../../engine/attachments.ts");
const { toolsFor } = await import("../../tools/registry.ts");
const { referenced } = await import("../../tools/defer.ts");
const { fitName, LOOSE_RESULT, NO_RESULT, onRepair, portableId, project, recordRepairs } = await import("../project.ts");
type WireRules = import("../project.ts").WireRules;
const { ANTHROPIC_RULES, anthropicBody, toWire } = await import("./anthropic.ts");
const { CHAT_RULES, chatBody } = await import("./chat.ts");
const { GEMINI_RULES, geminiBody, geminiWire } = await import("./gemini.ts");
const { RESERVED_NAMESPACES, RESPONSES_RULES, responsesBody } = await import("./responses.ts");
const { anthropicProblems, chatProblems, geminiProblems, responsesProblems } = await import("./valid.ts");

const base = { model: "m", system: "s", signal: new AbortController().signal } as ProviderRequest;
const ctx = (origin = "p:m", sessionKey = "k", rules?: WireRules) => ({ origin, sessionKey, efforts: [] as string[], rules });
const spec = (name: string, more: Partial<ToolSpec> = {}): ToolSpec => ({ name, description: name, input_schema: { type: "object" }, ...more });

const b64 = (...bytes: number[]) => Buffer.from([...bytes, ...new Array(24).fill(0)]).toString("base64");
const PNG = b64(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = b64(0xff, 0xd8, 0xff, 0xe0);
const GIF = b64(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
const WEBP = b64(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50);
const text = (t: string) => ({ type: "text" as const, text: t });
const call = (id: string, name = "Read", input: unknown = { path: "/a" }) => ({ type: "tool_use" as const, id, name, input });
const result = (id: string, content: any = "ok") => ({ type: "tool_result" as const, tool_use_id: id, content });

// The four wires (and the xAI dialect of one), each with a body, the rules it
// repairs by and the check of what it refuses. `rules: {}` gives the body
// with nothing repaired: the history as it is stored.
type Target = { name: string; rules: WireRules; body: (messages: Message[], tools: ToolSpec[], session?: string, rules?: WireRules) => any; problems: (body: any) => string[] };
const targets: Target[] = [
  { name: "anthropic", rules: ANTHROPIC_RULES, body: (messages, tools, s, r) => anthropicBody({ ...base, messages, tools }, { ...ctx("bedrock:claude", s, r), legacyIsMine: true }), problems: anthropicProblems },
  { name: "responses", rules: RESPONSES_RULES, body: (messages, tools, s, r) => responsesBody({ ...base, messages, tools }, ctx("chatgpt:gpt", s, r), "codex"), problems: (b) => responsesProblems(b, "codex") },
  { name: "responses-xai", rules: RESPONSES_RULES, body: (messages, tools, s, r) => responsesBody({ ...base, messages, tools }, ctx("xai:grok", s, r), "xai"), problems: (b) => responsesProblems(b, "xai") },
  { name: "chat", rules: CHAT_RULES, body: (messages, tools, s, r) => chatBody({ ...base, messages, tools }, ctx("or:other", s, r), { replayReasoning: true }), problems: chatProblems },
  { name: "gemini", rules: GEMINI_RULES, body: (messages, tools, s, r) => geminiBody({ ...base, messages, tools }, ctx("gemini:g", s, r), { sentinel: true }), problems: geminiProblems },
];
const target = (name: string) => targets.find((t) => t.name === name)!;
const valid = (messages: Message[], tools: ToolSpec[] = [spec("Read")]) =>
  Object.fromEntries(targets.map((t) => [t.name, t.problems(t.body(messages, tools))]));
const none = Object.fromEntries(targets.map((t) => [t.name, [] as string[]]));
// Whether a wire's request is the stored history byte for byte.
const asStored = (name: string, messages: Message[], tools: ToolSpec[] = [spec("Read")]) =>
  JSON.stringify(target(name).body(messages, tools)) === JSON.stringify(target(name).body(messages, tools, undefined, {}));

// ---- the refusals seen in the field, each from a constructed history ----

test("an image is labelled by its bytes on the wire that refuses a wrong label", () => {
  // The Anthropic wire's answer: "The image was specified using the image/jpeg
  // media type, but the image appears to be a image/png image". A tool took
  // the type from the file's extension, an MCP server or a browser from
  // wherever it liked.
  const messages: Message[] = [
    { role: "user", content: [{ type: "image", media_type: "image/jpeg", data: PNG }, text("look")] },
    { role: "assistant", content: [call("c1")] },
    { role: "user", content: [result("c1", [{ type: "image", media_type: "image/png", data: JPEG }, { type: "image", media_type: "image/png", data: WEBP }, { type: "image", media_type: "image/gif", data: GIF }])] },
  ];
  const stored = JSON.stringify(messages);
  const a = anthropicBody({ ...base, messages, tools: [] }, ctx());
  expect(anthropicProblems(a)).toEqual([]);
  expect(anthropicProblems(anthropicBody({ ...base, messages, tools: [] }, ctx("p:m", "k", {})))).toContain("messages.0.content.0: an image labelled image/jpeg whose bytes are image/png");
  expect(a.messages[0].content[0].source.media_type).toBe("image/png");
  expect(a.messages[2].content[0].content.map((c: any) => c.source.media_type)).toEqual(["image/jpeg", "image/webp", "image/gif"]);
  // No refusal of a wrong label is established for the other wires: they send what is stored.
  for (const name of ["responses", "responses-xai", "chat", "gemini"]) expect([name, asStored(name, messages)]).toEqual([name, true]);
  // Bytes that are no known format keep their label; the stored history is untouched.
  const odd = { type: "image" as const, media_type: "image/png", data: b64(1, 2, 3, 4) };
  expect(project([{ role: "user", content: [odd] }], { origin: "p:m", rules: ANTHROPIC_RULES })[0]!.content[0]).toBe(odd);
  expect(JSON.stringify(messages)).toBe(stored);
});

test("a result with no call before it is sent as text, a call with no result gets one", () => {
  // Anthropic: "unexpected `tool_use_id` found in `tool_result` blocks ... Each
  // `tool_result` block must have a corresponding `tool_use` block in the
  // previous message". Responses: "No tool call found for function call
  // output with call_id ...". A request whose messages a hook rebuilt, or an
  // imported history: a result stored after a later reply, one whose call a
  // summary replaced, a second result for one call, a call cut before its result.
  const messages: Message[] = [
    { role: "user", content: [text("go"), result("gone", "output of a summarized call")] },
    { role: "assistant", content: [call("a"), call("b")] },
    { role: "user", content: [text("a steer"), result("a", "first"), result("a", "again"), result("late", [text("late output"), { type: "image", media_type: "image/png", data: PNG }]), result("empty", "")] },
    { role: "assistant", content: [text("done"), call("cut")] },
  ];
  const stored = JSON.stringify(messages);
  for (const t of targets) expect([t.name, t.problems(t.body(messages, [spec("Read")], undefined, {})).length > 0]).toEqual([t.name, true]); // every wire refuses it as stored
  expect(valid(messages)).toEqual(none);
  const cut = (id: string) => ({ ...result(id, NO_RESULT), is_error: true });
  const loose = [text(`${LOOSE_RESULT}\nagain`), text(`${LOOSE_RESULT}\nlate output`), { type: "image" as const, media_type: "image/png", data: PNG }];
  const want = (third: any[], tail: any[]): Message[] => [
    { role: "user", content: [text("go"), text(`${LOOSE_RESULT}\noutput of a summarized call`)] },
    { role: "assistant", content: [call("a"), call("b")] },
    { role: "user", content: third },
    { role: "assistant", content: [text("done"), call("cut")] },
    ...(tail.length ? [{ role: "user" as const, content: tail }] : []),
  ];
  // Anthropic: the call with no result is answered in the message after it, and results lead that message.
  expect(project(messages, { origin: "p:m", rules: ANTHROPIC_RULES })).toEqual(want([cut("b"), result("a", "first"), text("a steer"), ...loose], [cut("cut")]));
  // Chat Completions: answered there too; the blocks keep their order.
  expect(project(messages, { origin: "p:m", rules: CHAT_RULES })).toEqual(want([cut("b"), text("a steer"), result("a", "first"), ...loose], [cut("cut")]));
  // Gemini counts the results of the turn after a call's: that turn is made to
  // fit, and a call with no turn after it is left as it is stored.
  expect(project(messages, { origin: "p:m", rules: GEMINI_RULES })).toEqual(want([cut("b"), text("a steer"), result("a", "first"), ...loose], []));
  const counted: Message[] = [{ role: "user", content: [text("go")] }, { role: "assistant", content: [call("a"), call("b")] }, { role: "user", content: [result("a"), result("zzz")] }];
  expect(asStored("gemini", counted)).toBe(true);
  for (const name of ["anthropic", "responses", "chat"]) expect([name, asStored(name, counted)]).toEqual([name, false]);
  // Responses matches an output to its call by id wherever it comes, so the missing one goes at the end.
  expect(project(messages, { origin: "p:m", rules: RESPONSES_RULES })).toEqual(want([text("a steer"), result("a", "first"), ...loose], [cut("b"), cut("cut")]));
  const later: Message[] = [{ role: "user", content: [text("go")] }, { role: "assistant", content: [call("a")] }, { role: "user", content: [text("meanwhile")] }, { role: "assistant", content: [text("still waiting")] }, { role: "user", content: [result("a", "late")] }];
  expect(asStored("responses", later)).toBe(true);
  for (const name of ["anthropic", "chat", "gemini"]) expect([name, asStored(name, later)]).toEqual([name, false]);
  expect(JSON.stringify(messages)).toBe(stored);
  // A user message that held only an empty loose result is gone, and the replies around it are one.
  expect(project([{ role: "user", content: [text("q")] }, { role: "assistant", content: [text("one")] }, { role: "user", content: [result("x", "")] }, { role: "assistant", content: [text("two")] }], { origin: "p:m", rules: CHAT_RULES }))
    .toEqual([{ role: "user", content: [text("q")] }, { role: "assistant", content: [text("one"), text("two")] }]);
  // Results after other blocks, every one of them paired: only the Anthropic wire
  // asks for results first ("the tool_result blocks must come FIRST").
  const after: Message[] = [{ role: "user", content: [text("go")] }, { role: "assistant", content: [call("a")] }, { role: "user", content: [text("a note"), result("a")] }];
  expect(project(after, { origin: "p:m", rules: ANTHROPIC_RULES })[2]!.content).toEqual([result("a"), text("a note")]);
  for (const name of ["responses", "responses-xai", "chat", "gemini"]) expect([name, asStored(name, after)]).toEqual([name, true]);
});

test("a tool grouped under a namespace the Responses backend keeps for itself goes as its own function", () => {
  // "Invalid Value: 'tools'. Function 'web.websearch' is not allowed in reserved namespace 'web'."
  for (const ns of RESERVED_NAMESPACES) {
    const tools = [spec("exec_command"), spec("tool_search", { search: true }), spec(`${ns}__find`, { defer: true, namespace: ns })];
    const messages: Message[] = [
      { role: "user", content: [text("go")] },
      { role: "assistant", content: [call("s1", "tool_search", { query: "find" })] },
      { role: "user", content: [result("s1", [{ type: "tool_reference", tool_name: `${ns}__find` }])] },
      { role: "assistant", content: [call("c1", `${ns}__find`, {})] },
      { role: "user", content: [result("c1")] },
    ];
    const b = responsesBody({ ...base, messages, tools }, ctx(), "codex");
    expect(responsesProblems(b, "codex")).toEqual([]);
    expect(b.input[3].tools).toEqual([{ type: "function", name: `${ns}__find`, description: `${ns}__find`, strict: false, defer_loading: true, parameters: { type: "object" } }]);
    expect(b.input[4]).toEqual({ type: "function_call", call_id: "c1", name: `${ns}__find`, arguments: "{}" });
  }
  expect([...RESERVED_NAMESPACES]).toContain("web");
});

test("a session that changed family: each wire repairs only the ids, names and inputs it refuses", async () => {
  // A Gemini server that sends no call ids: from now on the same call in two steps is two calls.
  const reply = (args: any) => {
    const p = geminiWire().parser(base, ctx("gemini:g"), () => {});
    p.event({ data: JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args } }] }, finishReason: "STOP" }] }) } as any);
    return p.result().blocks.find((b) => b.type === "tool_use") as any;
  };
  const first = reply({ path: "/a" });
  await Bun.sleep(2);
  expect(reply({ path: "/a" }).id).not.toBe(first.id);

  const long = "mcp__plugin_agent-workspace-linux_agent-workspace-linux__mcp_agent_context"; // 74 characters
  const names = ["read_file", "functions.Read", "", "9" + "x".repeat(140), long, "7zip_list", "-odd", "ns:tool", "x".repeat(210), "web search"];
  const messages: Message[] = [
    { role: "user", content: [text("go")] },
    // One id on two calls of one message; names of every kind.
    { role: "assistant", content: names.map((n, i) => call(i < 2 ? "call_0_x" : `n${i}`, n)) },
    { role: "user", content: names.map((_, i) => result(i < 2 ? "call_0_x" : `n${i}`, `out ${i}`)) },
    // The same id again in a later step, as stored from a server that sends none.
    { role: "assistant", content: [call("call_0_x", "read_file", "not an object"), call("arr", "Read", [1, 2]), call("nil", "Read", null)] },
    { role: "user", content: [result("call_0_x", "three"), result("arr"), result("nil")] },
  ];
  expect(valid(messages)).toEqual(none);
  const view = (rules: WireRules) => {
    const p = project(messages, { origin: "p:m", rules });
    const calls = p.flatMap((m) => (m.role === "assistant" ? m.content : [])) as any[];
    const results = p.flatMap((m) => (m.role === "user" ? m.content : [])).filter((b) => b.type === "tool_result") as any[];
    expect(results.map((r) => r.tool_use_id)).toEqual(calls.map((c) => c.id)); // each result still answers its call
    expect(results.map((r) => r.content)).toEqual([...names.map((_, i) => `out ${i}`), "three", "ok", "ok"]);
    return { ids: calls.map((c) => c.id), names: calls.slice(0, names.length).map((c) => c.name), inputs: calls.slice(names.length).map((c) => c.input) };
  };
  const fit = (rules: WireRules) => names.map((n) => fitName(n, rules.name!));
  const raw = ["not an object", [1, 2], {}], wrapped = [{ input: "not an object" }, { input: [1, 2] }, {}];
  const stored = [...names.map((_, i) => (i < 2 ? "call_0_x" : `n${i}`)), "call_0_x", "arr", "nil"];

  // Anthropic: two calls of one message get two ids, the later step keeps its
  // stored one; a call's name is 1 to 200 characters of any kind; input is an object.
  const a = view(ANTHROPIC_RULES);
  expect(a.ids).toEqual(stored.map((id, i) => (i === 1 ? a.ids[1] : id)));
  expect(a.ids[1]).not.toBe("call_0_x");
  expect(a.ids[names.length]).toBe("call_0_x");
  expect(a.names).toEqual(["read_file", "functions.Read", fitName("", ANTHROPIC_RULES.name!), "9" + "x".repeat(140), long, "7zip_list", "-odd", "ns:tool", fitName("x".repeat(210), ANTHROPIC_RULES.name!), "web search"]);
  expect(a.names[2]!.length).toBeGreaterThan(0);
  expect(a.names[8]!.length).toBe(200);
  expect(a.inputs).toEqual(wrapped);
  // Gemini: every stored id stays; letters, digits, _ - . : up to 128; input is an object.
  const g = view(GEMINI_RULES);
  expect(g.ids).toEqual(stored);
  expect(g.names).toEqual(["read_file", "functions.Read", fit(GEMINI_RULES)[2]!, fit(GEMINI_RULES)[3]!, long, "7zip_list", "-odd", "ns:tool", fit(GEMINI_RULES)[8]!, fit(GEMINI_RULES)[9]!]);
  expect(g.names[3]!.length).toBe(128);
  expect(g.inputs).toEqual(wrapped);
  // Responses: the stored ids and inputs stay; letters, digits, _ - . up to 128.
  const r = view(RESPONSES_RULES);
  expect(r.ids).toEqual(stored);
  expect(r.names).toEqual(["read_file", "functions.Read", fit(RESPONSES_RULES)[2]!, fit(RESPONSES_RULES)[3]!, long, "7zip_list", "-odd", fit(RESPONSES_RULES)[7]!, fit(RESPONSES_RULES)[8]!, fit(RESPONSES_RULES)[9]!]);
  expect(r.names[7]).toMatch(/^ns_tool_[a-z0-9]+$/);
  expect(r.inputs).toEqual(raw);
  // Chat Completions: no rule for a name is established for its servers; all of it stays.
  const c = view(CHAT_RULES);
  expect(c.ids).toEqual(stored);
  expect(c.names).toEqual(names);
  expect(c.inputs).toEqual(raw);
  // Two names that clean alike stay two names.
  expect(fitName("web search", RESPONSES_RULES.name!)).not.toBe(fitName("web_search", RESPONSES_RULES.name!));
  expect(fitName("web_search", RESPONSES_RULES.name!)).toBe("web_search");
});

test("a blank text block of a user message is left out on the wire that refuses it", () => {
  // The Anthropic wire's answer: "text content blocks must contain non-whitespace
  // text", for a user message; the same block in a reply is accepted, and
  // nothing shows it refused inside a tool result.
  const blank = text(" \n\t");
  const messages: Message[] = [
    { role: "user", content: [blank, text("go")] },
    { role: "assistant", content: [blank, call("c1")] },
    { role: "user", content: [result("c1", [blank, text("out"), text("")]), blank] },
  ];
  expect(valid(messages)).toEqual(none);
  expect(anthropicProblems(target("anthropic").body(messages, [spec("Read")], undefined, {}))).toEqual([
    "messages.0.content.0: an empty text block", "messages.2.content.0.content.2: an empty text block", "messages.2.content.1: an empty text block",
  ]);
  expect(project(messages, { origin: "p:m", rules: ANTHROPIC_RULES })).toEqual([
    { role: "user", content: [text("go")] },
    { role: "assistant", content: [blank, call("c1")] },
    { role: "user", content: [result("c1", [blank, text("out")])] },
  ]);
  for (const name of ["responses", "responses-xai", "chat", "gemini"]) expect([name, asStored(name, messages)]).toEqual([name, true]);
});

test("a repair is told once per session and kind, with no content, and noted on the request's trace", async () => {
  const { wireScope } = await import("../wiretap.ts");
  const seen: any[] = [];
  const off = onRepair("test", (r) => seen.push(r));
  const messages: Message[] = [
    { role: "user", content: [text("secret words"), result("gone", "secret output"), { type: "image", media_type: "image/jpeg", data: PNG }] },
    { role: "assistant", content: [call("c1", "bad name")] },
  ];
  for (const s of ["told-1", "told-1", "told-2"]) for (const t of targets) t.body(messages, [spec("Read")], s);
  const tap: any = {};
  wireScope.run(tap, () => target("responses").body(messages, [spec("Read")], "told-1"));
  expect(tap.repairs).toEqual(["tool_name", "result_without_call", "call_without_result"]); // every request says its own
  off();
  target("anthropic").body(messages, [spec("Read")], "told-3");
  expect(seen.map((r) => `${r.session} ${r.kind}`).sort()).toEqual(["told-1", "told-2"].flatMap((s) => ["call_without_result", "image_type", "result_without_call", "tool_name"].map((k) => `${s} ${k}`)).sort());
  expect(seen.find((r) => r.kind === "tool_name")).toEqual({ kind: "tool_name", session: "told-1", message: 1, call: "c1" });
  expect(JSON.stringify(seen)).not.toMatch(/secret|iVBOR/);
});

test("the daemon keeps a repair once per session and kind for good, and never as an error", async () => {
  const { Store } = await import("../../core/store.ts");
  const { Bus } = await import("../../core/bus.ts");
  const dir = mkdtempSync(join(tmpdir(), "keel-valid-store-"));
  const store = new Store(dir);
  const frames: any[] = [];
  const bus = new Bus();
  bus.on((f: any) => frames.push(f));
  try {
    const one = store.createSession({ model: "m", workspace: "/" }), two = store.createSession({ model: "m", workspace: "/" });
    const messages: Message[] = [{ role: "user", content: [text("secret words"), result("gone", "secret output")] }];
    const marks = () => [one, two].map((s) => store.session(s.id)!.settings.repairs);
    let first: any;
    // Three daemon starts: each has a module of its own, with nothing told in memory.
    for (let start = 0; start < 3; start++) {
      const mod: typeof import("../project.ts") = await import(`../project.ts?start=${start}`);
      const off = mod.recordRepairs(store, (s) => (s === one.id ? "turn-1" : undefined));
      for (let i = 0; i < 5; i++) for (const s of [one.id, two.id, "no-such-session"]) mod.project(messages, { origin: "p:m", sessionKey: s, rules: CHAT_RULES });
      off();
      first ??= JSON.stringify(marks());
      expect(JSON.stringify(marks())).toBe(first); // a restart records nothing again
    }
    const [a, b] = marks();
    expect(Object.keys(a!)).toEqual(["result_without_call"]);
    expect(a!.result_without_call).toEqual({ ts: expect.any(Number), message: 0, call: "gone", turn: "turn-1" });
    expect(b!.result_without_call).toEqual({ ts: expect.any(Number), message: 0, call: "gone" });
    expect(store.errors(50)).toEqual([]);
    expect(frames).toEqual([]);
    expect(first).not.toContain("secret");
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- random histories ----

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// The tool profile each family's model is given, and the origin its blocks carry.
const FAMILIES = ["claude", "gpt", "gemini", "other"] as const;
type Fam = (typeof FAMILIES)[number];
const ORIGIN: Record<Fam, string> = { claude: "bedrock:claude", gpt: "chatgpt:gpt", gemini: "gemini:g", other: "or:other" };
const profile = (f: Fam, native = false): ToolSpec[] => toolsFor(f, native).map((t: any) => ({ name: t.name, description: t.description, input_schema: t.input_schema, freeform: t.freeform, defer: t.defer, namespace: t.namespace, search: t.search }));
const PROFILES = Object.fromEntries(FAMILIES.map((f) => [f, profile(f)])) as Record<Fam, ToolSpec[]>;
const FOREIGN = ["functions.Read", "multi_tool_use.parallel", "", "9lives", "x".repeat(80), "mcp__srv__do.it", "web search", "é"];

// One branch of stored events. `faults`: also what no healthy turn writes (a
// cut call, a late or doubled result, one with no call, ids two calls share,
// made-up tool names, inputs that are no object, mislabeled images, empty
// or blank text, a checkpoint that keeps a result without its call).
function branch(seed: number, faults: boolean): StoredEvent[] {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const maybe = (p: number) => r() < p;
  const bad = (p: number) => faults && maybe(p);
  const events: StoredEvent[] = [];
  const add = (kind: StoredEvent["kind"], data: any) => {
    const e = { id: `e${events.length}`, session_id: "s", seq: events.length + 1, parent: events.at(-1)?.id ?? null, kind, data, ts: 0 } as StoredEvent;
    events.push(e);
    return e;
  };
  const image = () => {
    const [type, data] = pick([["image/png", PNG], ["image/jpeg", JPEG], ["image/gif", GIF], ["image/webp", WEBP]] as const);
    return { type: "image", media_type: bad(0.4) ? pick(["image/jpeg", "image/png", "image/webp"]) : type, data };
  };
  let n = 0;
  const late: any[] = [];
  const id = (f: Fam) => {
    n++;
    if (bad(0.08)) return pick(["call_0_same", "dup", `call.${n % 3}`]);
    return f === "claude" ? `toolu_${n}` : f === "gpt" ? `call_${n}` : f === "gemini" ? `fc_${n}` : pick([`call-${n}`, `chatcmpl-tool-${n}`, ...(faults ? [`call|${n}`, `${n}`, `id.${n}`, `long${"z".repeat(70)}${n}`] : [])]);
  };
  const content = () => {
    const k = r();
    if (k < 0.5) return bad(0.1) ? "" : `out ${n}`;
    if (k < 0.65) return [image()];
    if (k < 0.75) return [{ type: "tool_reference", tool_name: pick(PROFILES.claude).name }];
    if (k < 0.8) return bad(0.5) ? [] : [text("x")];
    return [text(bad(0.3) ? "" : `out ${n}`), ...(maybe(0.3) ? [image()] : [])];
  };
  const turns = 1 + Math.floor(r() * 5);
  let fam: Fam = pick(FAMILIES);
  for (let t = 0; t < turns; t++) {
    if (maybe(0.3)) fam = pick(FAMILIES); // the owner picked another model
    const media = [...(maybe(0.25) ? [image()] : []), ...(maybe(0.15) ? [{ type: "attachment", id: "0".repeat(64), name: "notes.txt", media_type: "text/plain", size: 3 }] : [])];
    add("user", { text: bad(0.05) && media.length ? "" : bad(0.05) ? " \n" : `prompt ${t}`, ...(media.length ? { images: media } : {}) });
    add("turn_start", {});
    for (let step = 0, steps = Math.floor(r() * 4); step <= steps; step++) {
      const blocks: any[] = [];
      if (maybe(0.4)) blocks.push(fam === "claude" ? { type: "thinking", thinking: "t", signature: maybe(0.9) ? "SIG" : undefined, origin: maybe(0.8) ? ORIGIN.claude : undefined }
        : fam === "gpt" ? { type: "thinking", thinking: "t", opaque: { type: "reasoning", summary: [], encrypted_content: "ENC" }, origin: ORIGIN.gpt }
        : fam === "gemini" ? { type: "thinking", thinking: "t", opaque: [{ thought: true, text: "t" }], origin: ORIGIN.gemini }
        : { type: "thinking", thinking: "t", origin: ORIGIN.other });
      if (maybe(0.6)) blocks.push(text(bad(0.1) ? "" : `reply ${t}.${step}`));
      const last = step === steps;
      const calls: any[] = [];
      if (!last || maybe(0.2)) for (let c = 0, cs = 1 + Math.floor(r() * 3); c < cs; c++) {
        // A Gemini server that sends no call ids: the reader made the id from the
        // call's place in its reply and its content, so the same call in two
        // steps was stored with one id.
        const noIds = fam === "gemini" && maybe(0.7);
        const name = bad(0.12) ? pick(FOREIGN) : noIds ? PROFILES.gemini[0]!.name : pick(PROFILES[fam]).name;
        const input = bad(0.1) ? pick(["raw text", [1], 7, null, true]) : noIds ? { a: Math.floor(r() * 2) } : fam === "gpt" && maybe(0.2) ? { input: "*** Begin Patch" } : { a: n };
        const own = id(fam);
        calls.push({ type: "tool_use", id: noIds ? `call_${c}_${Bun.hash(JSON.stringify({ name, args: input })).toString(36)}` : own, name, input, ...(fam !== "claude" ? { origin: ORIGIN[fam] } : {}) });
      }
      blocks.push(...calls);
      if (!blocks.length) blocks.push(text("ok"));
      const refused = maybe(0.03) && !calls.length;
      add("assistant", { blocks, model: ORIGIN[fam], stop: refused ? "refusal" : calls.length ? "tool_use" : "end_turn" });
      // Each result is stored as its call settles, in any order, a steer or a note between them.
      const order = [...calls].sort(() => r() - 0.5);
      for (const c of order) {
        if (bad(0.12)) { if (maybe(0.5)) late.push(c); continue; } // cut before its result; some come late
        add("tool_result", { results: [{ type: "tool_result", tool_use_id: c.id, content: content(), ...(maybe(0.1) ? { is_error: true } : {}) }] });
        if (bad(0.06)) add("tool_result", { results: [{ type: "tool_result", tool_use_id: c.id, content: "again" }] });
        if (maybe(0.08)) add("user", { text: "a steer", origin: "steer" });
        if (maybe(0.08)) add("note", { model: true, text: bad(0.1) ? "" : "a job ended" });
      }
      if (bad(0.05)) add("tool_result", { results: [{ type: "tool_result", tool_use_id: `unknown_${n}`, content: content() }] });
      if (late.length && bad(0.3)) add("tool_result", { results: [{ type: "tool_result", tool_use_id: late.shift().id, content: "late" }] });
      if (calls.length && last) break; // the turn was stopped after its calls
    }
    add("turn_end", { reason: "end_turn" });
    if (maybe(0.15)) {
      // A checkpoint: a summary of everything, one prepared ahead that covers
      // up to an earlier event, or a clear.
      const clean = events.filter((e, i) => e.kind === "turn_end" && i < events.length - 1);
      const covered = faults && maybe(0.5) ? pick(events) : maybe(0.4) && clean.length ? pick(clean) : undefined;
      add("compaction", maybe(0.15) ? { mode: "clear" } : { mode: "summary", summary: "what happened", ...(maybe(0.5) ? { owner_messages: ["prompt 0"] } : {}), ...(covered ? { covered: covered.id } : {}) });
    }
  }
  return events;
}

// The request's messages the way the engine makes them, and the way a hook or
// an import that maps events one to one would (no pairing of its own).
const engineMessages = (events: StoredEvent[]) => resolveAttachments(toMessages(events), { pdf: true, name: "m" });
function plainMessages(events: StoredEvent[]): Message[] {
  const out: Message[] = [];
  for (const e of events) {
    if (e.kind === "user") out.push({ role: "user", content: [...(e.data.images ?? []), text(e.data.text ?? "")] });
    else if (e.kind === "assistant") out.push({ role: "assistant", content: e.data.blocks });
    else if (e.kind === "tool_result") out.push({ role: "user", content: e.data.results });
    else if (e.kind === "note" && e.data.model) out.push({ role: "user", content: [text(e.data.text)] });
    else if (e.kind === "compaction") out.length = 0;
  }
  return resolveAttachments(out, { pdf: true, name: "m" });
}

// The tools a request to `f` declares: its profile, plus (as the engine does,
// withCatalog) a stand-in for each tool a result references.
const declared = (f: Fam, messages: Message[], native = false): ToolSpec[] => {
  const tools = native ? profile(f, true) : PROFILES[f];
  const have = new Set(tools.map((t) => t.name));
  return native ? [...tools, ...[...referenced(messages)].filter((x) => !have.has(x)).map((x) => spec(x, { defer: true }))] : tools;
};
// Each wire's request for a history, with the tools its family is given.
// `stored`: the same request with nothing repaired, and what the wire's rules
// say of it.
const requests = (messages: Message[], session?: string) => {
  const of = (name: string, f: Fam, native = false) => {
    const t = target(name);
    const tools = declared(f, messages, native);
    const body = t.body(messages, tools, session), stored = t.body(messages, tools, session, {});
    return { name: `${name}${native ? " (deferred tools)" : ""}`, wire: name, body, problems: t.problems(body), stored, refused: t.problems(stored) };
  };
  return [of("anthropic", "claude"), of("anthropic", "claude", true), of("responses", "gpt"), of("responses", "gpt", true), of("responses-xai", "gpt"), of("chat", "other"), of("gemini", "gemini")];
};

const SEEDS = 150;

test("every wire's request from a random history passes the wire's rules, and one the wire takes as stored is sent as stored", () => {
  const failed: string[] = [];
  const count = { repaired: 0, as_stored: 0 };
  let told = 0;
  const off = onRepair("test", () => void told++);
  for (let seed = 1; seed <= SEEDS; seed++) {
    const events = branch(seed, true);
    const stored = JSON.stringify(events);
    for (const [how, messages] of [["engine", engineMessages(events)], ["plain", plainMessages(events)]] as const) {
      for (const q of requests(messages, `rand-${seed}-${how}`)) {
        if (q.problems.length) failed.push(`seed ${seed} ${how} ${q.name}: ${q.problems.slice(0, 3).join("; ")}`);
        const same = JSON.stringify(q.body) === JSON.stringify(q.stored);
        // A repair is made only where the wire refuses the stored form.
        if (!q.refused.length && !same) failed.push(`seed ${seed} ${how} ${q.name}: the wire takes the stored history, and it was changed`);
        count[same ? "as_stored" : "repaired"]++;
      }
    }
    expect(JSON.stringify(events)).toBe(stored); // the stored history is never rewritten
  }
  off();
  expect(failed.slice(0, 12)).toEqual([]);
  // The histories did need repairs, and many requests needed none.
  expect(count.repaired).toBeGreaterThan(SEEDS);
  expect(count.as_stored).toBeGreaterThan(SEEDS);
  expect(told).toBeGreaterThan(SEEDS);
});

// The projection as it was before it repaired anything.
function projectBefore(messages: Message[], o: { origin: string; legacyIsMine?: boolean; toolRefs?: boolean }): Message[] {
  const mine = (origin?: string) => (origin ? origin === o.origin : !!o.legacyIsMine);
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const content: any[] = [];
      for (const b of m.content) {
        if (b.type === "thinking") {
          if (!mine(b.origin)) continue;
          content.push({ type: "thinking", thinking: b.thinking, signature: b.signature, opaque: b.opaque, origin: b.origin, bind: b.bind });
        } else if (b.type === "redacted_thinking") {
          if (o.legacyIsMine) content.push(b);
        } else if (b.type === "text") {
          if (!b.text && !(mine(b.origin) && b.signature)) continue;
          content.push(mine(b.origin) && b.signature ? { type: "text", text: b.text, signature: b.signature } : { type: "text", text: b.text });
        } else if (b.type === "tool_use") {
          const t: any = { type: "tool_use", id: portableId(b.id), name: b.name, input: b.input ?? {} };
          if (mine(b.origin) && b.signature) t.signature = b.signature;
          content.push(t);
        }
      }
      if (content.length) out.push({ role: "assistant", content });
    } else {
      const content: any[] = m.content.map((b) => {
        if (b.type !== "tool_result") return b;
        const c = typeof b.content === "string" || o.toolRefs || !b.content.some((x) => x.type === "tool_reference")
          ? b.content
          : b.content.map((x) => (x.type === "tool_reference" ? { type: "text" as const, text: `Tool loaded: ${x.tool_name}` } : x));
        return { ...b, tool_use_id: portableId(b.tool_use_id), content: c };
      });
      if (content.length) out.push({ role: "user", content });
    }
  }
  const merged: Message[] = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) (last.content as any[]).push(...m.content);
    else merged.push(m);
  }
  return merged;
}

test("what a healthy engine wrote is projected as it was before, on every wire", () => {
  let told = 0;
  const off = onRepair("test", () => void told++);
  let results = 0, repeats = 0;
  const WIRES: [string, WireRules, Fam][] = [["anthropic", ANTHROPIC_RULES, "claude"], ["responses", RESPONSES_RULES, "gpt"], ["chat", CHAT_RULES, "other"], ["gemini", GEMINI_RULES, "gemini"]];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const messages = engineMessages(branch(seed, false));
    results += messages.flatMap((m) => m.content as any[]).filter((b) => b.type === "tool_result").length;
    // The same call in two steps of a Gemini server that sends no ids: one id,
    // stored so, and sent so on every wire.
    const ids = messages.flatMap((m) => (m.role === "assistant" ? m.content : [])).flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
    if (new Set(ids).size < ids.length) repeats++;
    for (const [name, rules, f] of WIRES) for (const toolRefs of [false, true]) {
      const o = { origin: ORIGIN[f], legacyIsMine: f === "claude", toolRefs };
      expect([seed, name, JSON.stringify(project(messages, { ...o, rules, sessionKey: `clean-${seed}-${name}` })) === JSON.stringify(projectBefore(messages, o))]).toEqual([seed, name, true]);
    }
    for (const q of requests(messages, `clean-${seed}`)) {
      expect([seed, q.name, q.problems, q.refused]).toEqual([seed, q.name, [], []]);
      expect([seed, q.name, JSON.stringify(q.body) === JSON.stringify(q.stored)]).toEqual([seed, q.name, true]);
    }
  }
  off();
  expect(told).toBe(0);
  expect(repeats).toBeGreaterThan(5);
  expect(results).toBeGreaterThan(SEEDS);
});

test("the same history gives the same bytes, and a longer one keeps the bytes of its start", () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const events = branch(seed, true);
    for (const messages of [engineMessages(events), plainMessages(events)]) {
      const once = requests(messages).map((q) => JSON.stringify(q.body));
      expect(requests(messages).map((q) => JSON.stringify(q.body))).toEqual(once);
    }
    // One more turn after it: every message but the last (which the next
    // prompt may join) is sent as it was, so the provider's cached prefix holds.
    const more = branch(seed + 10_000, true).filter((e) => e.kind !== "compaction").map((e, i) => ({ ...e, id: `m${i}`, parent: i ? `m${i - 1}` : events.at(-1)!.id }));
    const wire = (evs: StoredEvent[]) => toWire(engineMessages(evs), { origin: ORIGIN.claude, legacyIsMine: true }, null);
    const short = wire(events), long = wire([...events, ...more]);
    expect(JSON.stringify(long.slice(0, Math.max(0, short.length - 1)))).toBe(JSON.stringify(short.slice(0, -1)));
  }
});
