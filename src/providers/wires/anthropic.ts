// Anthropic Messages wire: the body (shared by the Anthropic and Bedrock drivers and the plugin
// route) and the reader of its SSE events.
import type { AssistantBlock, Message } from "../../core/types.ts";
import { emptyUsage } from "../../core/types.ts";
import { project } from "../project.ts";
import { bindReply, carry, unbind, type Binder } from "./binding.ts";
import type { ProviderRequest, ProviderResult } from "../types.ts";
import { parseArgs, parseJson, type WireCodec, type WireCtx, type WireParser } from "./common.ts";

// Cache lifetime of every breakpoint. An agent loop's requests come seconds
// apart, but the owner's next prompt often comes after more than five minutes:
// with the 5-minute lifetime that prompt re-writes the whole conversation.
// A subagent's requests ask for five minutes (req.cacheTtl): it works without
// pauses and ends, so the hour's dearer writes buy nothing (Claude Code does the same).
export const CACHE_TTL: "5m" | "1h" = "1h";
const CACHE: { type: "ephemeral"; ttl: "5m" | "1h" } = { type: "ephemeral", ttl: CACHE_TTL };

const image = (b: { media_type: string; data: string }) => ({ type: "image", source: { type: "base64", media_type: b.media_type, data: b.data } });

// History to the wire. Cache breakpoints: tools + system are frozen (one
// breakpoint on the system), and a rolling breakpoint on the last user message
// so each request reads the whole previous prefix from cache.
export function toWire(messages: Message[], ctx: Pick<WireCtx, "origin" | "legacyIsMine">, mark: typeof CACHE | undefined = CACHE, toolRefs = false): any[] {
  const out: any[] = project(messages, { ...ctx, toolRefs }).map((m) => ({
    role: m.role,
    content: m.content.map((b): any => {
      switch (b.type) {
        case "image": return image(b);
        case "document": return { type: "document", source: { type: "base64", media_type: b.media_type, data: b.data }, title: b.name };
        case "text": return { type: "text", text: b.text };
        case "thinking":
          // A thought without a signature cannot be replayed on this wire.
          return b.signature ? carry({ type: "thinking", thinking: b.thinking, signature: b.signature }, b.bind) : null;
        case "redacted_thinking": return carry({ type: "redacted_thinking", data: b.data }, b.bind);
        case "tool_use": return { type: "tool_use", id: b.id, name: b.name, input: b.input };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: b.tool_use_id,
            is_error: b.is_error || undefined,
            content: typeof b.content === "string" ? b.content
              : b.content.map((c) => (c.type === "image" ? image(c) : c.type === "tool_reference" ? { type: "tool_reference", tool_name: c.tool_name } : { type: "text", text: c.text })),
          };
      }
    }).filter(Boolean),
  })).filter((m) => m.content.length);
  for (let i = out.length - 1; mark && i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== "user" || m.content.length === 0) continue;
    m.content[m.content.length - 1].cache_control = mark;
    break;
  }
  return out;
}

export function anthropicBody(req: ProviderRequest, ctx: WireCtx, systemPrefix?: string) {
  const cache = req.cache === false ? undefined : req.cacheTtl === "5m" ? { type: "ephemeral" as const, ttl: "5m" as const } : CACHE;
  // Deferred tools are not part of the prompt (the provider leaves them out of
  // the cached prefix until a tool_reference names one), so the tools
  // breakpoint sits on the last eager tool and the deferred set can change freely.
  const eager = req.tools.filter((t) => !t.defer);
  const deferred = req.tools.filter((t) => t.defer);
  const tools = [
    ...eager.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      eager_input_streaming: true,
      ...(cache && i === eager.length - 1 ? { cache_control: cache } : {}),
    })),
    ...deferred.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, defer_loading: true })),
  ];
  // Breakpoints (4 at most): the tools, the system text every session shares,
  // the session's own system text, and the rolling one on the last user message.
  const cut = req.systemSplit ?? 0;
  const system: any[] = [];
  if (cut > 0 && cut < req.system.length) system.push({ type: "text", text: req.system.slice(0, cut), ...(cache && { cache_control: cache }) });
  system.push({ type: "text", text: cut > 0 && cut < req.system.length ? req.system.slice(cut) : req.system, ...(cache && { cache_control: cache }) });
  if (systemPrefix) system.unshift({ type: "text", text: systemPrefix });
  // Thinking whose prefix changed since it was written is left out (binding.ts).
  const bound = unbind(toWire(req.messages, ctx, cache, deferred.length > 0), system, tools);
  binders.set(req, bound.binder);
  const body: Record<string, any> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 64_000,
    system,
    messages: bound.messages,
    thinking: { type: "adaptive", display: "summarized", ...(req.blockBinding ? { block_binding: { prefix_mismatch_behavior: req.blockBinding } } : {}) },
    output_config: { effort: req.effort ?? "high" },
  };
  if (tools.length) body.tools = tools;
  return body;
}

// Each request's walk, left after its last message: the reply's thinking is bound from there.
const binders = new WeakMap<ProviderRequest, Binder>();

export const anthropicWire: WireCodec = {
  body: (req, ctx) => ({ ...anthropicBody(req, ctx), stream: true }),
  parser(req, ctx, onDelta): WireParser {
    const blocks: any[] = [];
    const json = new Map<number, string>();
    const usage = emptyUsage();
    let served: string | undefined;
    let stop = "end_turn";
    let stopDetails: ProviderResult["stop_details"];
    let finished = false;
    let transformations: ProviderResult["input_transformations"];
    return {
      get finished() { return finished; },
      event(e) {
        const ev = parseJson(e.data);
        if (!ev) return;
        switch (ev.type) {
          case "message_start": {
            if (Array.isArray(ev.message?.input_transformations)) transformations = ev.message.input_transformations;
            const u = ev.message?.usage ?? {};
            usage.input = u.input_tokens ?? 0;
            usage.cache_read = u.cache_read_input_tokens ?? 0;
            usage.cache_write = u.cache_creation_input_tokens ?? 0;
            if (u.cache_creation?.ephemeral_1h_input_tokens) usage.cache_write_1h = u.cache_creation.ephemeral_1h_input_tokens;
            usage.output = u.output_tokens ?? 0;
            if (typeof u.speed === "string") served = u.speed;
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
            // After a fallback mid-stream, the last message_delta carries the list that counts.
            if (Array.isArray(ev.input_transformations ?? ev.delta?.input_transformations)) transformations = ev.input_transformations ?? ev.delta.input_transformations;
            if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
            if (ev.delta?.stop_details) stopDetails = ev.delta.stop_details;
            if (ev.usage?.output_tokens !== undefined) usage.output = ev.usage.output_tokens;
            // The counts here are cumulative; Anthropic-compatible servers
            // (Z.ai, gateways) send the input only here, zero at message_start.
            if (ev.usage?.input_tokens) usage.input = Math.max(usage.input, ev.usage.input_tokens);
            if (ev.usage?.cache_read_input_tokens) usage.cache_read = Math.max(usage.cache_read, ev.usage.cache_read_input_tokens);
            if (ev.usage?.cache_creation_input_tokens) usage.cache_write = Math.max(usage.cache_write, ev.usage.cache_creation_input_tokens);
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
        // Each thinking block keeps the fingerprint of what came before it, in the form it is sent back.
        const b = binders.get(req);
        if (b) for (const x of out) {
          const wire = toWire([{ role: "assistant", content: [x] }], ctx, undefined)[0]?.content[0];
          if (!wire) continue;
          const bind = bindReply(b, [wire])[0];
          if (bind) (x as any).bind = bind;
        }
        return { blocks: out, usage, stop, stop_details: stopDetails, model: req.model, served, ...(transformations ? { input_transformations: transformations } : {}) };
      },
    };
  },
};
