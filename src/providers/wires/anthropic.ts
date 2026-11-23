// Anthropic Messages wire: the body (shared by the Anthropic and Bedrock drivers and the plugin
// route) and the reader of its SSE events.
import type { AssistantBlock, ImageBlock, Message } from "../../core/types.ts";
import { emptyUsage } from "../../core/types.ts";
import { ProviderError } from "../http.ts";
import { project, type WireRules } from "../project.ts";
import { bindReply, carry, unbind, type Binder } from "./binding.ts";
import type { ProviderRequest, ProviderResult } from "../types.ts";
import { parseArgs, parseJson, type WireCodec, type WireCtx, type WireParser } from "./common.ts";

// The error types of a stream's error event that pass by waiting (the API's errors page).
const STREAM_ERROR_KIND: Record<string, "overloaded" | "rate" | "server"> = { overloaded_error: "overloaded", rate_limit_error: "rate", api_error: "server" };

// Cache lifetime of every breakpoint. An agent loop's requests come seconds
// apart, but the owner's next prompt often comes after more than five minutes:
// with the 5-minute lifetime that prompt re-writes the whole conversation.
// A subagent that has not paused asks for five minutes (req.cacheLife "short",
// see Engine.cacheLife): the hour's dearer writes would buy it nothing.
export const CACHE_TTL: "5m" | "1h" = "1h";
const CACHE: { type: "ephemeral"; ttl: "5m" | "1h" } = { type: "ephemeral", ttl: CACHE_TTL };

// What the Messages API refuses in a replayed history. Each rule names its
// source: a page of the documentation (platform.claude.com/docs/en), the API
// reference there (api/messages/create), or an answer of the API with where it
// is quoted.
export const ANTHROPIC_RULES: WireRules = {
  // agents-and-tools/tool-use/handle-tool-calls, "Important formatting
  // requirements": "Tool result blocks must immediately follow their
  // corresponding tool use blocks in the message history." The same page names
  // the answer "tool_use ids were found without tool_result blocks immediately
  // after". An answer this product received for a result with no call:
  // "unexpected `tool_use_id` found in `tool_result` blocks [...]. Each
  // `tool_result` block must have a corresponding `tool_use` block in the
  // previous message".
  pairs: "next",
  // Same section: "In the user message containing tool results, the
  // `tool_result` blocks must come FIRST in the content array. Any text must
  // come AFTER all tool results."
  resultsFirst: true,
  // Two calls of one assistant message with one id. The answer, as quoted in
  // the comment of 2026-02-23 on anthropics/claude-code issue 21206:
  // "messages.7.content.1:
  // `tool_use` ids must be unique". Its scope is one message, from the body of
  // antra-tess/membrane pull request 54 (a live call per shape, 2026-10-11):
  // "one id in two turns, each answered in place, returned 200; two calls with
  // one id in one assistant message returned 400 (`tool_use` ids must be
  // unique)". Bedrock InvokeModel answers the same for one message (the body
  // of maximhq/bifrost issue 9540).
  distinctIds: true,
  // API reference, ToolUseBlockParam: "`name: string`, minLength: 1,
  // maxLength: 200", with no pattern. A declared tool's name is narrower,
  // TOOL_NAME below.
  name: { max: 200 },
  // API reference, ToolUseBlockParam: "`input: map[unknown]`". The answer to
  // anything else, from the body of RightNow-AI/openfang issue 774:
  // "messages.3.content.1.tool_use.input: Input should be a valid dictionary".
  objectInput: true,
  // An answer this product received: "The image was specified using the
  // image/jpeg media type, but the image appears to be a image/png image".
  imageByBytes: true,
  // API reference, TextBlockParam (a tool result's content holds it too):
  // "`text: string`, minLength: 1". The answer, from the first comment on
  // anthropics/anthropic-sdk-python issue 461: "messages: text content blocks
  // must be non-empty". For a blank block of a user message, from the body of
  // pydantic/pydantic-ai issue 11124 (probed 2026-10-23): "400 `messages: text
  // content blocks must contain non-whitespace text`. A whitespace-only
  // `TextPart(' ')` in an assistant turn was accepted." Nothing shows a blank
  // block refused inside a result, so only an empty one is left out there.
  textNotEmpty: true,
};
// A declared tool's name, agents-and-tools/tool-use/define-tools, the table of
// a tool's fields: "Must match the regex `^[a-zA-Z0-9_-]{1,128}$`."
export const TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

// (The projection labels an image by its bytes, src/providers/project.ts.)
const image = (b: ImageBlock) => ({ type: "image", source: { type: "base64", media_type: b.media_type, data: b.data } });

// History to the wire. Cache breakpoints: tools + system are frozen (one
// breakpoint on the system), and a rolling breakpoint on the last user message
// so each request reads the whole previous prefix from cache.
// `part`: one reply's block, not a request (its calls are not paired with results).
export function toWire(messages: Message[], ctx: Pick<WireCtx, "origin" | "legacyIsMine" | "rules"> & { sessionKey?: string }, mark: typeof CACHE | null | undefined = CACHE, toolRefs = false, part = false): any[] {
  const out: any[] = project(messages, { origin: ctx.origin, legacyIsMine: ctx.legacyIsMine, sessionKey: ctx.sessionKey, rules: ctx.rules ?? ANTHROPIC_RULES, toolRefs, part }).map((m) => ({
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
  const cache = req.cache === false ? undefined : req.cacheLife === "short" ? { type: "ephemeral" as const, ttl: "5m" as const } : CACHE;
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
  // the text the sessions of one folder share (the place and its instruction
  // files), and the rolling one on the last user message. The session's own
  // text (its artifacts folder, its project) follows as a block without a
  // breakpoint: it is cached with the messages, and it no longer makes the
  // folder's block, the long one, differ from session to session.
  const cut = req.systemSplit ?? 0;
  const from = cut > 0 && cut < req.system.length ? cut : 0;
  const own = req.systemOwn !== undefined && req.systemOwn > from && req.systemOwn < req.system.length ? req.systemOwn : req.system.length;
  const system: any[] = [];
  if (from) system.push({ type: "text", text: req.system.slice(0, from), ...(cache && { cache_control: cache }) });
  system.push({ type: "text", text: req.system.slice(from, own), ...(cache && { cache_control: cache }) });
  if (own < req.system.length) system.push({ type: "text", text: req.system.slice(own) });
  if (systemPrefix) system.unshift({ type: "text", text: systemPrefix });
  // Thinking whose prefix changed since it was written is left out (binding.ts).
  // null, not undefined: a request without a cache marks no message either (undefined takes the default mark).
  const bound = unbind(toWire(req.messages, ctx, cache ?? null, deferred.length > 0), system, tools);
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
          case "error": {
            // An error event mid-stream: the passing kinds are said as the driver's own failures,
            // so the retry policy reads them as it reads the same answer given as an HTTP status.
            const text = `${ev.error?.type ?? "error"}: ${ev.error?.message ?? e.data}`;
            const kind = STREAM_ERROR_KIND[String(ev.error?.type)];
            throw Object.assign(kind ? new ProviderError(kind, text) : new Error(text), { wireError: ev.error });
          }
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
          const wire = toWire([{ role: "assistant", content: [x] }], ctx, undefined, false, true)[0]?.content[0];
          if (!wire) continue;
          const bind = bindReply(b, [wire])[0];
          if (bind) (x as any).bind = bind;
        }
        return { blocks: out, usage, stop, stop_details: stopDetails, model: req.model, served, ...(transformations ? { input_transformations: transformations } : {}) };
      },
    };
  },
};
