// The wire readers against the frozen provider-plugin v1 fixtures (copied from
// agent-sh/keel docs/provider-plugin-v1/fixtures): each stream is fed in
// 7-byte pieces, as the conformance check's fake vendor writes it, and must give
// the step `expected.json` states. Plus the cross-family projection rules.
import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Message } from "../../core/types.ts";
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

test("a call is priced per part; an unstated cache read rate is unknown, not free", () => {
  const u = { input: 1_000_000, output: 1_000_000, cache_read: 0, cache_write: 0 };
  expect(priceOf(u, { input: 1, output: 5 })).toBe(6);
  expect(priceOf({ ...u, cache_read: 10 }, { input: 1, output: 5 })).toBeUndefined();
  expect(priceOf({ ...u, cache_read: 1_000_000 }, { input: 1, output: 5, cache_read: 0.1 })).toBeCloseTo(6.1);
  expect(priceOf(u, undefined)).toBeUndefined();
});
