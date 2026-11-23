// The wire readers against the frozen provider-plugin v1 fixtures (copied from
// agent-sh/keel docs/provider-plugin-v1/fixtures): each stream is fed in
// 7-byte pieces, as the conformance check's fake vendor writes it, and must give
// the step `expected.json` states. Plus the cross-family projection rules.
import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Message, StoredEvent } from "../../core/types.ts";
import { toMessages } from "../../engine/turn.ts";
import { project } from "../project.ts";
import { priceOf } from "../pricing.ts";
import { JsonArrayDecoder, SseDecoder } from "../sse.ts";
import type { ProviderRequest } from "../types.ts";
import { anthropicWire, toWire } from "./anthropic.ts";
import { chatWire } from "./chat.ts";
import type { WireCodec } from "./common.ts";
import { geminiBody, geminiWire } from "./gemini.ts";
import { responsesBody, responsesWire } from "./responses.ts";

const DIR = join(import.meta.dir, "../../../test/fixtures/plugin-v1");
const expected = (await Bun.file(join(DIR, "expected.json")).json()).fixtures as Record<string, any>;
const req = { model: "m", system: "s", messages: [], tools: [], signal: new AbortController().signal } as ProviderRequest;
const ctx = { origin: "p:m", sessionKey: "k", efforts: [] };

const codecs: Record<string, (file: string) => WireCodec> = {
  anthropic_messages: () => anthropicWire,
  openai_responses: () => responsesWire("openai"),
  chat_completions: () => chatWire({}),
  gemini_generate_content: (f) => geminiWire({ responseEnvelope: f.includes("envelope") ? "response" : undefined }),
};

for (const [file, want] of Object.entries(expected)) {
  if (want.framing === "json") continue;
  test(`reads ${file}`, async () => {
    const bytes = new Uint8Array(await Bun.file(join(DIR, file)).arrayBuffer());
    const dec = want.framing === "sse" ? new SseDecoder() : new JsonArrayDecoder();
    const parser = codecs[want.wire]!(file).parser(req, ctx, () => {});
    for (let i = 0; i < bytes.length; i += 7) for (const ev of dec.push(bytes.slice(i, i + 7))) parser.event(ev);
    for (const ev of dec.finish()) parser.event(ev);
    expect(parser.finished).toBe(true);
    const r = parser.result();
    const text = r.blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("");
    const thought = r.blocks.filter((b) => b.type === "thinking").map((b: any) => b.thinking).join("");
    expect(text).toBe(want.text);
    expect(thought).toBe(want.thought ?? "");
    const calls = r.blocks.filter((b) => b.type === "tool_use") as any[];
    expect(calls.map((c) => ({ id: c.id, name: c.name, arguments: c.input }))).toEqual(want.tool_calls.map((c: any) => ({ id: c.id, name: c.name, arguments: c.arguments })));
    for (const [k, c] of want.tool_calls.entries()) if (c.thought_signature) expect(calls[k].signature).toBe(c.thought_signature);
    expect(r.stop).toBe(want.stop_reason === "end_turn" ? "end_turn" : want.stop_reason);
    const u = want.usage;
    expect(r.usage.input + r.usage.cache_read + r.usage.cache_write).toBe(u.input_tokens);
    expect(r.usage.cache_read).toBe(u.cache_read_tokens);
    expect(r.usage.output).toBe(u.output_tokens);
    const th = r.blocks.find((b) => b.type === "thinking") as any;
    for (const rs of want.reasoning ?? []) {
      if (rs.kind === "thinking") expect(th.signature).toBe(rs.signature);
      if (rs.kind === "reasoning") expect(th.opaque.encrypted_content).toBe(rs.item.encrypted_content);
      if (rs.kind === "gemini_part") expect(th.opaque.some((p: any) => p.thoughtSignature === rs.part.thoughtSignature)).toBe(true);
    }
  });
}

// A session written by Claude, then GPT, sent to each wire: signed reasoning
// reaches only its writer, ids stay portable, every call keeps its result.
const history: Message[] = [
  { role: "user", content: [{ type: "text", text: "rename old()" }] },
  { role: "assistant", content: [
    { type: "thinking", thinking: "inspect", signature: "SIG-CLAUDE", origin: "bedrock:claude" },
    { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a" } },
  ] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "fn old() {}" }] },
  { role: "assistant", content: [
    { type: "thinking", thinking: "edit", opaque: { type: "reasoning", summary: [], encrypted_content: "ENC-GPT" }, origin: "chatgpt:gpt" },
    { type: "tool_use", id: "call|odd id", name: "shell", input: { command: "sed" }, origin: "chatgpt:gpt" },
  ] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "call|odd id", content: "done" }, { type: "text", text: "now test" }] },
];

test("foreign reasoning is dropped and ids are portable on every wire", () => {
  const r = { ...req, messages: history };
  const claude = JSON.stringify(toWire(history, { origin: "bedrock:claude" }));
  expect(claude).toContain("SIG-CLAUDE");
  expect(claude).not.toContain("ENC-GPT");
  const gpt = JSON.stringify(responsesBody(r, { ...ctx, origin: "chatgpt:gpt" }, "codex"));
  expect(gpt).toContain("ENC-GPT");
  expect(gpt).not.toContain("SIG-CLAUDE");
  const gem = geminiBody(r, { ...ctx, origin: "gemini:g" }, { sentinel: true });
  const s = JSON.stringify(gem);
  expect(s).not.toContain("SIG-CLAUDE");
  expect(s).not.toContain("ENC-GPT");
  expect(s).toContain("skip_thought_signature_validator");
  expect(gem.contents.map((c: any) => c.role)).toEqual(["user", "model", "user", "model", "user"]);
  const ids = project(history, { origin: "x" }).flatMap((m) => m.content.map((b: any) => b.id ?? b.tool_use_id).filter(Boolean));
  expect(ids[0]).toBe("toolu_1");
  expect(ids[1]).toBe("toolu_1");
  expect(ids[2]).toMatch(/^call_odd_id_[a-z0-9]+$/);
  expect(ids[3]).toBe(ids[2]);
  // The same history projects to the same bytes: the cached prefix holds.
  expect(JSON.stringify(responsesBody(r, { ...ctx, origin: "chatgpt:gpt" }, "codex"))).toBe(gpt);
});

// Two calls whose ids clean to the same text stay two calls, each result
// naming its own tool, in either result order.
test("ids that clean alike stay distinct on the Gemini wire", () => {
  for (const order of [0, 1]) {
    const results = [
      { type: "tool_result", tool_use_id: "call.1", content: "A" },
      { type: "tool_result", tool_use_id: "call_1", content: "B" },
    ] as any[];
    if (order) results.reverse();
    const h: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [
        { type: "tool_use", id: "call.1", name: "read_alpha", input: {} },
        { type: "tool_use", id: "call_1", name: "read_beta", input: {} },
      ] },
      { role: "user", content: results },
    ];
    const gem = geminiBody({ ...req, messages: h }, { ...ctx, origin: "gemini:g" });
    const calls = gem.contents[1].parts.map((p: any) => p.functionCall);
    expect(new Set(calls.map((c: any) => c.id)).size).toBe(2);
    const byId = new Map(calls.map((c: any) => [c.id, c.name]));
    for (const p of gem.contents[2].parts) {
      const r = p.functionResponse;
      expect(r.name).toBe(byId.get(r.id));
      expect(r.name).toBe(r.response.output === "A" ? "read_alpha" : "read_beta");
    }
  }
});

// Chat Completions tool messages take text only: two parallel captures keep
// their tool replies paired first, then one user message carries both images,
// each once and named by its call.
test("tool screenshots reach a Chat Completions route once each, after the paired replies", () => {
  const img = (d: string) => ({ type: "image", media_type: "image/png", data: d }) as const;
  const h: Message[] = [
    { role: "user", content: [{ type: "text", text: "look" }, img("OWNER")] },
    { role: "assistant", content: [
      { type: "tool_use", id: "c1", name: "shot", input: {} },
      { type: "tool_use", id: "c2", name: "shot", input: {} },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "capture complete" }, img("SHOT_A")] },
      { type: "tool_result", tool_use_id: "c2", content: [img("SHOT_B")] },
    ] },
  ];
  const body = chatWire({}).body({ ...req, messages: h }, ctx);
  const s = JSON.stringify(body);
  for (const d of ["OWNER", "SHOT_A", "SHOT_B"]) expect(s.split(d).length - 1).toBe(1);
  const roles = body.messages.map((m: any) => m.role);
  expect(roles).toEqual(["system", "user", "assistant", "tool", "tool", "user"]);
  expect(body.messages[3].content).toContain("capture complete");
  const last = body.messages[5].content;
  expect(last[0].text).toContain("c1");
  expect(last[1].image_url.url).toContain("SHOT_A");
  expect(last[2].text).toContain("c2");
  expect(last[3].image_url.url).toContain("SHOT_B");
});

test("Messages wire corrects mislabeled images when replaying stored tool results", () => {
  const samples = ([
    ["image/jpeg", "\x89PNG\r\n\x1a\n", "image/png"],
    ["image/jpeg", "\xff\xd8\xff", "image/jpeg"],
    ["image/png", "GIF89a", "image/gif"],
    ["image/png", "RIFF\x00\x00\x00\x00WEBP", "image/webp"],
    ["image/png", "unknown header", "image/png"],
  ] as const).map(([declared, header, expected]) => ({ declared, data: btoa(header + "synthetic payload"), expected }));
  const text = { type: "text", text: "capture complete" };
  const events: StoredEvent[] = ([
    { kind: "user", data: { text: "capture an image" } },
    { kind: "assistant", data: { blocks: [{ type: "tool_use", id: "c1", name: "capture", input: {} }] } },
    { kind: "tool_result", data: { results: [{
      type: "tool_result", tool_use_id: "c1", is_error: true,
      content: [text, ...samples.map(({ declared, data }) => ({ type: "image", media_type: declared, data }))],
    }] } },
  ] as const).map((e, i) => ({ ...e, id: String(i), parent: i ? String(i - 1) : null, session_id: "fixture", seq: i, ts: 0 }));
  const stored = JSON.stringify(events);
  const replay: StoredEvent[] = JSON.parse(stored);
  const body = JSON.parse(JSON.stringify(anthropicWire.body({ ...req, messages: toMessages(replay) }, { ...ctx, origin: "bedrock:m" })));
  expect(body.messages[2].content).toEqual([{
    type: "tool_result", tool_use_id: "c1", is_error: true, cache_control: { type: "ephemeral", ttl: "1h" },
    content: [text, ...samples.map(({ expected, data }) => ({ type: "image", source: { type: "base64", media_type: expected, data } }))],
  }]);
  expect(JSON.stringify(replay)).toBe(stored);
});

test("a call is priced per part; an unstated cache read rate is unknown, not free", () => {
  const u = { input: 1_000_000, output: 1_000_000, cache_read: 0, cache_write: 0 };
  expect(priceOf(u, { input: 1, output: 5 })).toBe(6);
  expect(priceOf({ ...u, cache_read: 10 }, { input: 1, output: 5 })).toBeUndefined();
  expect(priceOf({ ...u, cache_read: 1_000_000 }, { input: 1, output: 5, cache_read: 0.1 })).toBeCloseTo(6.1);
  expect(priceOf(u, undefined)).toBeUndefined();
});

// Anthropic-compatible servers (Z.ai) put the input count only in message_delta.
test("the Messages reader takes input counts sent at message_delta", () => {
  const p = anthropicWire.parser(req, ctx, () => {});
  const ev = (data: any) => p.event({ event: data.type, data: JSON.stringify(data) });
  ev({ type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0 } } });
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } });
  ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 19, output_tokens: 3, cache_read_input_tokens: 4 } });
  ev({ type: "message_stop" });
  const u = p.result().usage;
  expect([u.input, u.cache_read, u.output]).toEqual([19, 4, 3]);
});

// Deferred tools: only the Anthropic wire with deferred tools in the request
// keeps tool_reference blocks; the tools breakpoint sits on the last eager tool.
test("deferred tools and tool_reference blocks on each wire", () => {
  const history: Message[] = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ToolSearch", input: { query: "echo" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "tool_reference", tool_name: "mcp__echo__echo" }] }] },
  ];
  const tools = [
    { name: "Bash", description: "b", input_schema: { type: "object" } },
    { name: "mcp__echo__echo", description: "e", input_schema: { type: "object" }, defer: true },
  ];
  const body = anthropicWire.body({ ...req, messages: history, tools }, ctx);
  expect(body.tools.map((t: any) => [t.name, !!t.defer_loading, !!t.cache_control])).toEqual([["Bash", false, true], ["mcp__echo__echo", true, false]]);
  expect(body.messages[2].content[0].content).toEqual([{ type: "tool_reference", tool_name: "mcp__echo__echo" }]);
  // Without deferred tools (a route that refused them), the reference is a line of text.
  const eager = anthropicWire.body({ ...req, messages: history, tools: tools.slice(0, 1) }, ctx);
  expect(eager.messages[2].content[0].content).toEqual([{ type: "text", text: "Tool loaded: mcp__echo__echo" }]);
  const resp = responsesBody({ ...req, messages: history }, ctx, "openai");
  expect(resp.input.find((i: any) => i.type === "function_call_output").output).toEqual([{ type: "input_text", text: "Tool loaded: mcp__echo__echo" }]);
});

// The system prompt on the Messages wire: what every session shares, what the
// sessions of one folder share, each with a breakpoint, then the session's
// own text without one, so two sessions of a folder differ only in the last.
test("the session's own system text is a block of its own after the folder's cached one", () => {
  const shared = "Core.\n\n", folder = "Working directory: /w\nInstructions.\n";
  const of = (own: string, marks: { systemSplit?: number; systemOwn?: number }) => anthropicWire.body({ ...req, system: shared + folder + own, ...marks }, ctx).system as any[];
  const at = { systemSplit: shared.length, systemOwn: shared.length + folder.length };
  const a = of("\nArtifacts go in /a/1/.\n", at), b = of("\nArtifacts go in /a/2/.\n", at);
  expect(a.map((x) => [x.text, !!x.cache_control])).toEqual([[shared, true], [folder, true], ["\nArtifacts go in /a/1/.\n", false]]);
  expect(JSON.stringify(a.slice(0, 2))).toBe(JSON.stringify(b.slice(0, 2)));
  // A prompt kept from before the mark was recorded goes as it always did, and a session with no text of its own has no third block.
  expect(of("\nArtifacts go in /a/1/.\n", { systemSplit: shared.length }).map((x) => [x.text.length, !!x.cache_control])).toEqual([[shared.length, true], [folder.length + 24, true]]);
  expect(of("", at).map((x) => x.text)).toEqual([shared, folder]);
  expect(of("own", { systemOwn: (shared + folder).length }).map((x) => [x.text, !!x.cache_control])).toEqual([[shared + folder, true], ["own", false]]);
});

// A freeform tool goes as an OpenAI custom tool and its call round-trips as one.
test("freeform tools are Responses custom tools, except on xAI", () => {
  const tools = [{ name: "exec", description: "run js", input_schema: { type: "object" }, freeform: { syntax: "lark" as const, definition: "start: /.+/" } }];
  const history: Message[] = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "exec", input: { input: "text(1)" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "Script completed" }] },
  ];
  const b = responsesBody({ ...req, messages: history, tools }, ctx, "codex");
  expect(b.tools).toEqual([{ type: "custom", name: "exec", description: "run js", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } }]);
  expect(b.input.slice(2)).toEqual([
    { type: "custom_tool_call", call_id: "c1", name: "exec", input: "text(1)" },
    { type: "custom_tool_call_output", call_id: "c1", output: "Script completed" },
  ]);
  expect(responsesBody({ ...req, messages: history, tools }, ctx, "xai").tools[0].type).toBe("function");
  const p = responsesWire("codex").parser(req, ctx, () => {});
  p.event({ data: JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "custom_tool_call", call_id: "c2", name: "exec", input: "text(2)" } }) } as any);
  p.event({ data: JSON.stringify({ type: "response.completed", response: { usage: {} } }) } as any);
  expect(p.result().blocks).toEqual([{ type: "tool_use", id: "c2", name: "exec", input: { input: "text(2)" }, origin: "p:m" }]);
});

// GPT's deferred tools on the Responses wire: only the client tool_search is
// declared; its call and answer replay as tool_search_call and a
// tool_search_output loading the named tools (an MCP server's as functions of
// its namespace), and a namespaced call comes back as the tool's own name.
test("deferred tools on the Responses wire: client tool_search, namespaces, round trip", () => {
  const tools = [
    { name: "exec_command", description: "run", input_schema: { type: "object" } },
    { name: "tool_search", description: "find tools", input_schema: { type: "object", properties: { query: { type: "string" } } }, search: true as const },
    { name: "mcp__echo__say", description: "say it", input_schema: { type: "object", properties: { text: { type: "string" } } }, defer: true, namespace: "mcp__echo" },
    { name: "request_secret", description: "ask for a secret", input_schema: { type: "object" }, defer: true },
    { name: "web__websearch", description: "search the web", input_schema: { type: "object" }, defer: true, namespace: "web" },
  ];
  const history: Message[] = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "s1", name: "tool_search", input: { query: "echo" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: [{ type: "tool_reference", tool_name: "mcp__echo__say" }, { type: "tool_reference", tool_name: "request_secret" }, { type: "tool_reference", tool_name: "web__websearch" }] }] },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "mcp__echo__say", input: { text: "hi" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "hi" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "w1", name: "web__websearch", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "w1", content: "results" }] },
  ];
  const b = responsesBody({ ...req, messages: history, tools }, ctx, "codex");
  expect(b.tools.map((t: any) => [t.type, t.name ?? null, t.execution ?? null])).toEqual([["function", "exec_command", null], ["tool_search", null, "client"]]);
  expect(b.input.slice(2)).toEqual([
    { type: "tool_search_call", call_id: "s1", execution: "client", status: "completed", arguments: { query: "echo" } },
    {
      type: "tool_search_output", call_id: "s1", execution: "client", status: "completed", tools: [
        { type: "namespace", name: "mcp__echo", description: "Tools in the mcp__echo namespace.", tools: [{ type: "function", name: "say", description: "say it", strict: false, defer_loading: true, parameters: tools[2]!.input_schema }] },
        { type: "function", name: "request_secret", description: "ask for a secret", strict: false, defer_loading: true, parameters: { type: "object" } },
        { type: "function", name: "web__websearch", description: "search the web", strict: false, defer_loading: true, parameters: { type: "object" } },
      ],
    },
    { type: "function_call", call_id: "c1", namespace: "mcp__echo", name: "say", arguments: '{"text":"hi"}' },
    { type: "function_call_output", call_id: "c1", output: "hi" },
    { type: "function_call", call_id: "w1", name: "web__websearch", arguments: "{}" },
    { type: "function_call_output", call_id: "w1", output: "results" },
  ]);
  const parse = (item: any) => {
    const p = responsesWire("codex").parser({ ...req, tools } as any, ctx, () => {});
    p.event({ data: JSON.stringify({ type: "response.output_item.done", output_index: 0, item }) } as any);
    p.event({ data: JSON.stringify({ type: "response.completed", response: { usage: {} } }) } as any);
    return p.result();
  };
  const searched = parse({ type: "tool_search_call", execution: "client", call_id: "s2", status: "completed", arguments: { query: "say", limit: 3 } });
  expect(searched.blocks).toMatchObject([{ type: "tool_use", id: "s2", name: "tool_search", input: { query: "say", limit: 3 } }]);
  expect(searched.stop).toBe("tool_use");
  expect(parse({ type: "function_call", call_id: "c2", namespace: "mcp__echo", name: "say", arguments: "{}" }).blocks).toMatchObject([{ type: "tool_use", name: "mcp__echo__say" }]);
  expect(parse({ type: "function_call", call_id: "c3", namespace: "request_secret", name: "request_secret", arguments: "{}" }).blocks).toMatchObject([{ type: "tool_use", name: "request_secret" }]);
  expect(parse({ type: "function_call", call_id: "c4", name: "web__websearch", arguments: "{}" }).blocks).toMatchObject([{ type: "tool_use", name: "web__websearch" }]);
  // Without a search tool (a route that refused it) nothing changes.
  expect(responsesBody({ ...req, messages: [], tools: tools.slice(0, 1) }, ctx, "codex").tools).toEqual([{ type: "function", name: "exec_command", description: "run", parameters: { type: "object" }, strict: false }]);
});

// A response the provider's policy check stopped (ChatGPT's cyber_policy) is
// the model declining with that category, not a failed request.
test("a policy response.failed on the Responses wire is a refusal with its category", () => {
  const p = responsesWire("codex").parser(req, ctx, () => {});
  p.event({ data: JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "partial" }) } as any);
  p.event({ data: JSON.stringify({ type: "response.failed", response: { error: { code: "cyber_policy", message: "This content was flagged for possible cybersecurity risk." } } }) } as any);
  expect(p.finished).toBe(true);
  const r = p.result();
  expect(r.stop).toBe("refusal");
  expect(r.stop_details).toEqual({ category: "cyber_policy", explanation: "This content was flagged for possible cybersecurity risk." });
  for (const code of ["bio_policy", "misalignment_policy_violation"]) {
    const b = responsesWire("codex").parser(req, ctx, () => {});
    b.event({ data: JSON.stringify({ type: "response.failed", response: { error: { code, message: "flagged" } } }) } as any);
    expect(b.result().stop_details).toEqual({ category: code, explanation: "flagged" });
  }
  // A workspace hook's block is not the model declining.
  const h = responsesWire("codex").parser(req, ctx, () => {});
  expect(() => h.event({ data: JSON.stringify({ type: "response.failed", response: { error: { code: "inference_hook_denied", message: "blocked" } } }) } as any)).toThrow("inference_hook_denied");
  // Any other failure still fails the request.
  const q = responsesWire("codex").parser(req, ctx, () => {});
  expect(() => q.event({ data: JSON.stringify({ type: "response.failed", response: { error: { code: "server_error", message: "boom" } } }) } as any)).toThrow("server_error: boom");
});
