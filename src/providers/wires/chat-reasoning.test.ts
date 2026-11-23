// reasoning_content on every assistant message of a Chat Completions request
// to a model that reads its earlier reasoning from that field, against a
// stand-in that refuses a request the way the providers document it:
// Moonshot refuses a tool-call message without the field when thinking is on
// ("thinking is enabled but reasoning_content is missing in assistant tool
// call message at index N"); DeepSeek wants it on every earlier assistant
// message of a request with tools (api-docs.deepseek.com, Thinking Mode:
// "the API will return a 400 error").
import { expect, test } from "bun:test";
import type { Message } from "../../core/types.ts";
import { httpEvents, runEvents } from "../drive.ts";
import type { ProviderRequest } from "../types.ts";
import { chatWire, type ChatOpts } from "./chat.ts";

function standIn() {
  const bodies: any[] = [];
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      bodies.push(body);
      const rule = new URL(req.url).pathname.split("/")[1];
      const at = body.messages.findIndex((m: any) => m.role === "assistant" && !("reasoning_content" in m) && (rule === "deepseek" ? !!body.tools : !!m.tool_calls));
      if (at >= 0) {
        const message = rule === "deepseek" ? `Missing \`reasoning_content\` field in the assistant message at message index ${at}` : `thinking is enabled but reasoning_content is missing in assistant tool call message at index ${at}`;
        return Response.json({ error: { message, type: "invalid_request_error" } }, { status: 400 });
      }
      const chunk = (delta: any, finish: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return new Response(chunk({ reasoning_content: "ok" }, null) + chunk({ content: "done" }, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${srv.port}`, bodies, stop: () => srv.stop(true) };
}

const TOOLS = [{ name: "shell", description: "Run a command.", input_schema: { type: "object", properties: { command: { type: "string" } } } }];
const ORIGIN = "kimi:k3";
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] } as Message);
const result = (id: string): Message => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "a.txt" }] } as Message);
// A history another model wrote: its thinking is not this model's and is left out.
const switched: Message[] = [
  user("List the files."),
  { role: "assistant", content: [{ type: "thinking", thinking: "Use the shell.", signature: "sig", origin: "anthropic:claude-x" }, { type: "tool_use", id: "toolu_1", name: "shell", input: { command: "ls" }, origin: "anthropic:claude-x" }] } as Message,
  result("toolu_1"),
  { role: "assistant", content: [{ type: "text", text: "One file." }] } as Message,
  user("Now count the lines."),
];
// After a compaction: the summary, then a step with no thinking kept.
const compacted: Message[] = [
  user("Summary of the work so far: the files were listed."),
  { role: "assistant", content: [{ type: "tool_use", id: "call_2", name: "shell", input: { command: "wc -l a.txt" } }] } as Message,
  result("call_2"),
];
// This model's own thinking goes back as it was written.
const own: Message[] = [
  user("List the files."),
  { role: "assistant", content: [{ type: "thinking", thinking: "Use the shell.", origin: ORIGIN }, { type: "tool_use", id: "call_1", name: "shell", input: { command: "ls" }, origin: ORIGIN }] } as Message,
  result("call_1"),
];

async function send(s: ReturnType<typeof standIn>, rule: string, messages: Message[], o: ChatOpts, interleaved?: string) {
  const req = { model: "k3", system: "sys", messages, tools: TOOLS, interleaved, signal: new AbortController().signal } as unknown as ProviderRequest;
  const ctx = { origin: ORIGIN, sessionKey: "k", efforts: [] };
  return runEvents(chatWire(o), req, ctx, () => {}, httpEvents({ label: "stand-in", url: `${s.url}/${rule}/chat/completions`, headers: {} }, req));
}

test("a route that replays reasoning sends the field on an assistant message with none (Moonshot's rule)", async () => {
  const s = standIn();
  try {
    for (const h of [switched, compacted]) {
      const res = await send(s, "moonshot", h, { replayReasoning: true });
      expect(res.blocks.find((b) => b.type === "text")).toMatchObject({ text: "done" });
      for (const m of s.bodies.at(-1).messages.filter((m: any) => m.role === "assistant")) expect(m.reasoning_content).toBe("");
    }
  } finally { s.stop(); }
});

test("a model whose catalog entry names the field gets it on every assistant message (DeepSeek's rule)", async () => {
  const s = standIn();
  try {
    for (const h of [switched, compacted]) {
      const res = await send(s, "deepseek", h, {}, "reasoning_content");
      expect(res.blocks.find((b) => b.type === "text")).toMatchObject({ text: "done" });
    }
    // Its own thinking is sent back, not a placeholder.
    await send(s, "deepseek", own, {}, "reasoning_content");
    expect(s.bodies.at(-1).messages.find((m: any) => m.role === "assistant").reasoning_content).toBe("Use the shell.");
  } finally { s.stop(); }
});

test("a route that neither replays reasoning nor names the field sends none", async () => {
  const s = standIn();
  try {
    // A catalog entry that names another field (OpenRouter's reasoning_details) is not this one.
    for (const interleaved of [undefined, "reasoning_details"]) {
      await expect(send(s, "moonshot", switched, {}, interleaved)).rejects.toThrow(/reasoning_content is missing/);
      for (const m of s.bodies.at(-1).messages) expect("reasoning_content" in m).toBe(false);
    }
  } finally { s.stop(); }
});
