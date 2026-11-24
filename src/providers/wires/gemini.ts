// Gemini generateContent wire: the Gemini API and plugins that speak it
// (with an optional response envelope around each event).
import type { AssistantBlock } from "../../core/types.ts";
import { emptyUsage } from "../../core/types.ts";
import { ProviderError } from "../http.ts";
import { project, toolNames, type WireRules } from "../project.ts";
import type { ProviderRequest } from "../types.ts";
import { effortFor, parseJson, type WireCodec, type WireCtx, type WireParser } from "./common.ts";

export type GeminiOpts = {
  // The Gemini API takes this documented value on a function call that was
  // not written by Gemini; some proxies refuse it, so it is per route.
  sentinel?: boolean;
  responseEnvelope?: string; // member that wraps each response object
  thinking?: boolean;        // the model thinks: ask for its thoughts
};

const SENTINEL = "skip_thought_signature_validator";

// What generateContent refuses in a replayed history. Each rule names its
// source: an answer of the API with where it is quoted, or the API's
// description (the v1beta discovery document,
// generativelanguage.googleapis.com/$discovery/rest?version=v1beta, revision
// 20261120). A call id used by two calls is not among them: a server that
// sends no ids left the same id on the same call in several steps, and those
// histories are sent as they are stored.
export const GEMINI_RULES: WireRules = {
  // The answer, from the body of google-gemini/gemini-cli issue 6460: "Please
  // ensure that the number of function response parts is equal to the number
  // of function call parts of the function call turn." It speaks of their
  // number only, so a turn that holds as many is sent as it is stored.
  pairs: "count",
  // Discovery document, FunctionCall.name: "Required. The name of the function
  // to call. Must be a-z, A-Z, 0-9, or contain underscores and dashes, with a
  // maximum length of 128." FunctionDeclaration.name: "Must be a-z, A-Z, 0-9,
  // or contain underscores, colons, dots, and dashes, with a maximum length of
  // 128." A call may name such a function, so the wider set is taken.
  name: { max: 128, bad: /[^a-zA-Z0-9_.:-]/g },
  // Discovery document, FunctionCall.args: "type: object", "Optional. The
  // function parameters and values in JSON object format."
  objectInput: true,
};
// A declared function's name (FunctionDeclaration.name, quoted above).
export const FUNCTION_NAME = /^[a-zA-Z0-9_.:-]{1,128}$/;

export function geminiBody(req: ProviderRequest, ctx: WireCtx, o: GeminiOpts = {}, systemPrefix?: string) {
  const projected = project(req.messages, { ...ctx, rules: ctx.rules ?? GEMINI_RULES });
  const names = toolNames(projected);
  const contents: any[] = [];
  for (const m of projected) {
    const parts: any[] = [];
    let firstCall = true;
    for (const b of m.content) {
      if (b.type === "text") parts.push(b.signature ? { text: b.text, thoughtSignature: b.signature } : { text: b.text });
      else if (b.type === "image" || b.type === "document") parts.push({ inlineData: { mimeType: b.media_type, data: b.data } });
      else if (b.type === "thinking") { if (Array.isArray(b.opaque)) parts.push(...b.opaque); }
      else if (b.type === "tool_use") {
        const p: any = { functionCall: { id: b.id, name: b.name, args: b.input ?? {} } };
        if (b.signature) p.thoughtSignature = b.signature;
        else if (o.sentinel && firstCall) p.thoughtSignature = SENTINEL;
        firstCall = false;
        parts.push(p);
      } else if (b.type === "tool_result") {
        const text = typeof b.content === "string" ? b.content : b.content.filter((c) => c.type === "text").map((c: any) => c.text).join("\n");
        parts.push({ functionResponse: { id: b.tool_use_id, name: names.get(b.tool_use_id) ?? "tool", response: b.is_error ? { error: text } : { output: text } } });
        if (typeof b.content !== "string") for (const c of b.content) if (c.type === "image") parts.push({ inlineData: { mimeType: c.media_type, data: c.data } });
      }
    }
    if (parts.length) contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
  }
  const sys: any[] = [{ text: req.system }];
  if (systemPrefix) sys.unshift({ text: systemPrefix });
  const body: Record<string, any> = { contents, systemInstruction: { parts: sys } };
  if (req.tools.length) {
    body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })) }];
  }
  const gen: Record<string, any> = {};
  if (req.maxTokens) gen.maxOutputTokens = req.maxTokens;
  if (o.thinking) {
    gen.thinkingConfig = { includeThoughts: true };
    const effort = effortFor(req, ctx);
    if (effort) gen.thinkingConfig.thinkingLevel = effort;
  }
  if (Object.keys(gen).length) body.generationConfig = gen;
  return body;
}

export function geminiWire(o: GeminiOpts = {}, systemPrefix?: string): WireCodec {
  return {
    body: (req, ctx) => geminiBody(req, ctx, o, systemPrefix),
    parser(req, ctx, onDelta): WireParser {
      let thinking = "";
      const thoughtParts: any[] = [];
      const out: AssistantBlock[] = [];
      const usage = emptyUsage();
      let stop = "end_turn";
      let finished = false;
      let calls = 0;
      const started = Date.now().toString(36);
      return {
        get finished() { return finished; },
        usage,
        event(e) {
          let ev = parseJson(e.data);
          if (!ev || typeof ev !== "object") return;
          if (o.responseEnvelope && !ev.error) {
            const inner = ev[o.responseEnvelope];
            if (!inner || typeof inner !== "object" || Array.isArray(inner)) return; // keep-alive or metadata
            ev = inner;
          }
          if (ev.error) {
            const status = ev.error.code;
            throw new ProviderError(status === 429 ? "rate" : status >= 500 ? "server" : "invalid", `gemini: ${ev.error.status ?? status}: ${ev.error.message}`, status);
          }
          const um = ev.usageMetadata;
          if (um) {
            const cached = um.cachedContentTokenCount ?? 0;
            usage.input = Math.max(0, (um.promptTokenCount ?? 0) - cached);
            usage.cache_read = cached;
            usage.output = (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0);
          }
          const cand = ev.candidates?.[0];
          for (const p of cand?.content?.parts ?? []) {
            if (p.thought) {
              if (p.text) { thinking += p.text; onDelta({ kind: "thinking", index: 0, text: p.text }); }
              thoughtParts.push(p);
            } else if (p.functionCall) {
              const k = calls++;
              // A server that sends no id gets one of this reply's own: the same
              // call made again in a later step is another call (two calls with
              // one id are refused by the wires that pair results by id).
              const id = p.functionCall.id ?? `call_${started}_${k}_${Bun.hash(JSON.stringify(p.functionCall)).toString(36)}`;
              onDelta({ kind: "tool_input", index: 2 + k, text: JSON.stringify(p.functionCall.args ?? {}), name: p.functionCall.name });
              out.push({ type: "tool_use", id, name: p.functionCall.name, input: p.functionCall.args ?? {}, signature: p.thoughtSignature, origin: ctx.origin });
            } else if (typeof p.text === "string") {
              if (p.text) onDelta({ kind: "text", index: 1, text: p.text });
              const last = out[out.length - 1];
              if (last?.type === "text" && !last.signature) {
                last.text += p.text;
                if (p.thoughtSignature) { last.signature = p.thoughtSignature; last.origin = ctx.origin; }
              } else if (p.text || p.thoughtSignature) {
                out.push(p.thoughtSignature ? { type: "text", text: p.text, signature: p.thoughtSignature, origin: ctx.origin } : { type: "text", text: p.text });
              }
            }
          }
          if (cand?.finishReason) {
            const r = cand.finishReason;
            stop = r === "MAX_TOKENS" ? "max_tokens" : r === "SAFETY" || r === "PROHIBITED_CONTENT" || r === "RECITATION" ? "refusal" : r === "STOP" ? "end_turn" : r.toLowerCase();
            finished = true;
          }
        },
        result() {
          const blocks: AssistantBlock[] = [];
          if (thinking || thoughtParts.some((p) => p.thoughtSignature)) blocks.push({ type: "thinking", thinking, opaque: thoughtParts, origin: ctx.origin });
          blocks.push(...out);
          if (blocks.some((b) => b.type === "tool_use") && (stop === "end_turn")) stop = "tool_use";
          return { blocks, usage, stop, model: req.model };
        },
      };
    },
  };
}
