// OpenAI-compatible /chat/completions: OpenRouter, Z.ai, Fireworks, NVIDIA,
// Kimi, Alibaba, Meta and any server that speaks it. Per-endpoint options
// shape the body; nothing here is about a model.
import type { AssistantBlock } from "../../core/types.ts";
import { emptyUsage } from "../../core/types.ts";
import { project, resultText, type WireRules } from "../project.ts";
import type { ProviderRequest } from "../types.ts";
import { effortFor, parseArgs, parseJson, type WireCodec, type WireCtx, type WireParser } from "./common.ts";

export type ChatOpts = {
  // How the effort travels: `reasoning_effort` (OpenAI style) or OpenRouter's
  // `reasoning: { effort }`.
  effortField?: "reasoning_effort" | "reasoning";
  // Thinking text replayed as `reasoning_content` on the assistant message
  // that wrote it (Kimi, GLM and DeepSeek ask for it on tool-call steps).
  // Also when the model's catalog entry names the field (req.interleaved).
  replayReasoning?: boolean;
  extraBody?: Record<string, unknown>;
  sendMaxTokens?: boolean;
};

const dataUrl = (b: { media_type: string; data: string }) => `data:${b.media_type};base64,${b.data}`;

// What Chat Completions refuses in a replayed history, with its source. This
// wire is spoken by local servers and compatible hosts, each with its own
// checks, so only what one of them documents is repaired. A call's name is
// not: the 64 characters of `[a-zA-Z0-9_-]` are one provider's rule, and a
// server here may check only that a name is there. A server that does hold a
// name to a rule answers as it did before.
export const CHAT_RULES: WireRules = {
  // Alibaba Cloud Model Studio, Error codes, under 400 InvalidParameter:
  // 'messages with role "tool" must be a response to a preceeding message with
  // "tool_calls"' and 'An assistant message with "tool_calls" must be followed
  // by tool messages responding to each "tool_call_id"'.
  pairs: "next",
};

export function chatBody(req: ProviderRequest, ctx: WireCtx, o: ChatOpts = {}, systemPrefix?: string) {
  const messages: any[] = [];
  if (systemPrefix) messages.push({ role: "system", content: systemPrefix });
  messages.push({ role: "system", content: req.system });
  for (const m of project(req.messages, { ...ctx, rules: ctx.rules ?? CHAT_RULES })) {
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
      const calls = m.content.filter((b) => b.type === "tool_use").map((b: any) => ({
        id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      const msg: any = { role: "assistant", content: text || null };
      if (calls.length) msg.tool_calls = calls;
      // An assistant message with no thinking of this model's (another model
      // wrote it, or a compaction did) still carries the field, empty: with
      // thinking on, Moonshot refuses a tool-call message without it ("thinking
      // is enabled but reasoning_content is missing in assistant tool call
      // message at index N"), and DeepSeek wants it on every earlier message
      // of a request with tools, else a 400 (api-docs.deepseek.com, Thinking
      // Mode, Tool Calls).
      if (o.replayReasoning || req.interleaved === "reasoning_content") {
        msg.reasoning_content = m.content.filter((b) => b.type === "thinking").map((b: any) => b.thinking).join("");
      }
      if (msg.content !== null || calls.length) messages.push(msg);
      continue;
    }
    // Results first (they answer the step before), then the owner's words. A
    // tool message carries text only, so an image a tool returned follows all
    // the results, in one user message, each labelled with the call it came
    // from (sent once; nothing is stored).
    const parts: any[] = [];
    const shots: any[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const imgs = typeof b.content === "string" ? [] : b.content.filter((c: any) => c.type === "image");
        const text = typeof b.content === "string" ? b.content : resultText(b.content.filter((c: any) => c.type !== "image"));
        const note = imgs.length ? `[${imgs.length === 1 ? "an image" : `${imgs.length} images`} from this call follow${imgs.length === 1 ? "s" : ""} in the next user message]` : "";
        messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: [text, note].filter(Boolean).join("\n") || "(no output)" });
        for (const [k, c] of imgs.entries()) {
          shots.push({ type: "text", text: `Image ${imgs.length > 1 ? `${k + 1} ` : ""}returned by tool call ${b.tool_use_id}:` });
          shots.push({ type: "image_url", image_url: { url: dataUrl(c as any) } });
        }
      } else if (b.type === "text") parts.push({ type: "text", text: b.text });
      else if (b.type === "image") parts.push({ type: "image_url", image_url: { url: dataUrl(b) } });
      else if (b.type === "document") parts.push({ type: "file", file: { filename: b.name, file_data: dataUrl(b) } });
    }
    if (shots.length) parts.unshift(...shots);
    if (parts.length) messages.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => p.text).join("\n") : parts });
  }
  const body: Record<string, any> = {
    model: req.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    body.tool_choice = "auto";
  }
  const effort = effortFor(req, ctx);
  if (effort) {
    if (o.effortField === "reasoning") body.reasoning = { effort };
    else body.reasoning_effort = effort;
  }
  if (o.sendMaxTokens && req.maxTokens) body.max_tokens = req.maxTokens;
  if (ctx.sessionKey && o.effortField === "reasoning") body.user = ctx.sessionKey;
  return { ...body, ...o.extraBody };
}

export function chatWire(o: ChatOpts = {}, systemPrefix?: string): WireCodec {
  return {
    body: (req, ctx) => chatBody(req, ctx, o, systemPrefix),
    parser(req, ctx, onDelta): WireParser {
      let text = "";
      let thinking = "";
      const calls: { id: string; name: string; args: string }[] = [];
      const usage = emptyUsage();
      let served: string | undefined;
      let stop = "end_turn";
      let finished = false;
      let sawFinish = false;
      return {
        get finished() { return finished; },
        usage,
        event(e) {
          if (e.data === "[DONE]") { finished = true; return; }
          const ev = parseJson(e.data);
          if (!ev) return;
          if (ev.error) throw new Error(`${ev.error.code ?? "error"}: ${ev.error.message ?? JSON.stringify(ev.error)}`);
          if (typeof ev.service_tier === "string") served = ev.service_tier;
          const u = ev.usage;
          if (u) {
            const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens ?? 0;
            usage.input = Math.max(0, (u.prompt_tokens ?? 0) - cached);
            usage.cache_read = cached;
            usage.output = u.completion_tokens ?? 0;
            if (sawFinish) finished = true;
          }
          const ch = ev.choices?.[0];
          if (!ch) return;
          const d = ch.delta ?? ch.message ?? {};
          const r = d.reasoning_content ?? d.reasoning;
          if (typeof r === "string" && r) { thinking += r; onDelta({ kind: "thinking", index: 0, text: r }); }
          if (typeof d.content === "string" && d.content) { text += d.content; onDelta({ kind: "text", index: 1, text: d.content }); }
          for (const tc of d.tool_calls ?? []) {
            const k = tc.index ?? calls.length;
            const c = (calls[k] ??= { id: "", name: "", args: "" });
            if (tc.id) c.id = tc.id;
            if (tc.function?.name) c.name += tc.function.name;
            if (tc.function?.arguments) c.args += tc.function.arguments;
            onDelta({ kind: "tool_input", index: 2 + k, text: tc.function?.arguments ?? "", name: c.name || undefined });
          }
          if (ch.finish_reason) {
            sawFinish = true;
            stop = ch.finish_reason === "length" ? "max_tokens" : ch.finish_reason === "content_filter" ? "refusal" : "end_turn";
          }
        },
        result() {
          const blocks: AssistantBlock[] = [];
          if (thinking) blocks.push({ type: "thinking", thinking, origin: ctx.origin });
          if (text) blocks.push({ type: "text", text });
          calls.forEach((c, k) => {
            if (c?.name) blocks.push({ type: "tool_use", id: c.id || `call_${Date.now().toString(36)}_${k}`, name: c.name, input: parseArgs(c.args) });
          });
          if (blocks.some((b) => b.type === "tool_use") && stop === "end_turn") stop = "tool_use";
          return { blocks, usage, stop, model: req.model, served };
        },
      };
    },
  };
}
