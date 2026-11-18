// Anthropic Messages wire: the body (shared by the SDK drivers and the plugin
// route) and an SSE reader for streams that do not come through the SDK.
import type { AssistantBlock, Message } from "../../core/types.ts";
import { emptyUsage } from "../../core/types.ts";
import { project } from "../project.ts";
import type { ProviderRequest } from "../types.ts";
import { parseArgs, parseJson, type WireCodec, type WireCtx, type WireParser } from "./common.ts";

const image = (b: { media_type: string; data: string }) => ({ type: "image", source: { type: "base64", media_type: b.media_type, data: b.data } });

// History to the wire. Cache breakpoints: tools + system are frozen (one
// breakpoint on the system), and a rolling breakpoint on the last user message
// so each request reads the whole previous prefix from cache.
export function toWire(messages: Message[], ctx: Pick<WireCtx, "origin" | "legacyIsMine">): any[] {
  const out: any[] = project(messages, ctx).map((m) => ({
    role: m.role,
    content: m.content.map((b): any => {
      switch (b.type) {
        case "image": return image(b);
        case "text": return { type: "text", text: b.text };
        case "thinking":
          // A thought without a signature cannot be replayed on this wire.
          return b.signature ? { type: "thinking", thinking: b.thinking, signature: b.signature } : null;
        case "redacted_thinking": return b;
        case "tool_use": return { type: "tool_use", id: b.id, name: b.name, input: b.input };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: b.tool_use_id,
            is_error: b.is_error || undefined,
            content: typeof b.content === "string" ? b.content : b.content.map((c) => (c.type === "image" ? image(c) : { type: "text", text: c.text })),
          };
      }
    }).filter(Boolean),
  })).filter((m) => m.content.length);
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== "user" || m.content.length === 0) continue;
    m.content[m.content.length - 1].cache_control = { type: "ephemeral" };
    break;
  }
  return out;
}

export function anthropicBody(req: ProviderRequest, ctx: WireCtx, systemPrefix?: string) {
  const tools = req.tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    eager_input_streaming: true,
    ...(i === req.tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
  const system: any[] = [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }];
  if (systemPrefix) system.unshift({ type: "text", text: systemPrefix });
  const body: Record<string, any> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 64_000,
    system,
    messages: toWire(req.messages, ctx),
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: req.effort ?? "high" },
  };
  if (tools.length) body.tools = tools;
  return body;
}

export const anthropicWire: WireCodec = {
  body: (req, ctx) => ({ ...anthropicBody(req, ctx), stream: true }),
  parser(req, ctx, onDelta): WireParser {
    const blocks: any[] = [];
    const json = new Map<number, string>();
    const usage = emptyUsage();
    let stop = "end_turn";
    let finished = false;
    return {
      get finished() { return finished; },
      event(e) {
        const ev = parseJson(e.data);
        if (!ev) return;
        switch (ev.type) {
          case "message_start": {
            const u = ev.message?.usage ?? {};
            usage.input = u.input_tokens ?? 0;
            usage.cache_read = u.cache_read_input_tokens ?? 0;
            usage.cache_write = u.cache_creation_input_tokens ?? 0;
            usage.output = u.output_tokens ?? 0;
            break;
          }
          case "content_block_start": {
            const b = ev.content_block;
            blocks[ev.index] = { ...b };
            if (b.type === "tool_use") { json.set(ev.index, ""); onDelta({ kind: "tool_input", index: ev.index, text: "", name: b.name }); }
            break;
          }
          case "content_block_delta": {
            const b = blocks[ev.index];
            const d = ev.delta;
            if (!b) break;
            if (d.type === "text_delta") { b.text = (b.text ?? "") + d.text; onDelta({ kind: "text", index: ev.index, text: d.text }); }
            else if (d.type === "thinking_delta") { b.thinking = (b.thinking ?? "") + d.thinking; onDelta({ kind: "thinking", index: ev.index, text: d.thinking }); }
            else if (d.type === "signature_delta") b.signature = (b.signature ?? "") + d.signature;
            else if (d.type === "input_json_delta") { json.set(ev.index, (json.get(ev.index) ?? "") + d.partial_json); onDelta({ kind: "tool_input", index: ev.index, text: d.partial_json, name: b.name }); }
            break;
          }
          case "message_delta":
            if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
            if (ev.usage?.output_tokens !== undefined) usage.output = ev.usage.output_tokens;
            break;
          case "message_stop":
            finished = true;
            break;
          case "error":
            throw Object.assign(new Error(`${ev.error?.type ?? "error"}: ${ev.error?.message ?? e.data}`), { wireError: ev.error });
        }
      },
      result() {
        const out: AssistantBlock[] = [];
        blocks.forEach((b, i) => {
          if (!b) return;
          if (b.type === "text") out.push({ type: "text", text: b.text ?? "" });
          else if (b.type === "thinking") out.push({ type: "thinking", thinking: b.thinking ?? "", signature: b.signature, origin: ctx.origin });
          else if (b.type === "redacted_thinking") out.push({ type: "redacted_thinking", data: b.data });
          else if (b.type === "tool_use") out.push({ type: "tool_use", id: b.id, name: b.name, input: parseArgs(json.get(i) ?? "") });
        });
        return { blocks: out, usage, stop, model: req.model };
      },
    };
  },
};
