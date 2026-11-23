// What a server's sampling request is taken as, and what of it Keel refuses
// (2025-11-25 client/sampling): pure reading, before any card or model.
import { expect, test } from "bun:test";
import { NO_SYSTEM, samplingOf, SAMPLE_TOKENS_MAX, stopReason } from "./sampling.ts";

const text = (t: string, role = "user") => ({ role, content: { type: "text", text: t } });

test("a sampling request is read as one model request, and the card shows all of it", () => {
  const r = samplingOf({ systemPrompt: "Be terse.", messages: [text("Hi\u202e"), text("Hello", "assistant"), { role: "user", content: [{ type: "text", text: "Look" }, { type: "image", data: "AAAA", mimeType: "image/png" }] }], maxTokens: 64, modelPreferences: { hints: [{ name: "claude-3-sonnet" }] } });
  if ("refuse" in r) throw new Error(r.refuse);
  expect(r.system).toBe("Be terse.");
  expect(r.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "Hi\u202e" }] },
    { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    { role: "user", content: [{ type: "text", text: "Look" }, { type: "image", media_type: "image/png", data: "AAAA" }] },
  ]);
  // The card's text has no character that reorders what is seen.
  expect(r.shown).toBe("System prompt:\nBe terse.\n\nUser:\nHi\n\nAssistant:\nHello\n\nUser:\nLook\n[an image, image/png]");
  expect(r.notes).toEqual([expect.stringContaining("claude-3-sonnet"), "The reply is at most 64 tokens."]);
  // No system prompt: Keel's own line goes, and the card says so. A large maxTokens is held to the bound.
  const bare = samplingOf({ messages: [text("x")], maxTokens: 10_000_000 });
  if ("refuse" in bare) throw new Error(bare.refuse);
  expect([bare.system, bare.shown.startsWith("System prompt (Keel's"), bare.maxTokens]).toEqual([NO_SYSTEM, true, SAMPLE_TOKENS_MAX]);
});

test("what Keel did not offer, or cannot send, is invalid params", () => {
  for (const params of [
    { messages: [text("x")], maxTokens: 10, tools: [{ name: "t", inputSchema: {} }] },
    { messages: [text("x")] },
    { messages: [], maxTokens: 10 },
    { messages: [text("x", "system")], maxTokens: 10 },
    { messages: [{ role: "user", content: { type: "audio", data: "AA", mimeType: "audio/wav" } }], maxTokens: 10 },
    { messages: [{ role: "user", content: { type: "tool_result", toolUseId: "a", content: [] } }], maxTokens: 10 },
    { messages: [{ role: "assistant", content: { type: "image", data: "AA", mimeType: "image/png" } }], maxTokens: 10 },
    { messages: [text("x".repeat(2_100_000))], maxTokens: 10 },
  ]) expect(samplingOf(params)).toEqual({ refuse: expect.any(String), code: -32602 });
  expect(stopReason("max_tokens")).toBe("maxTokens");
});
