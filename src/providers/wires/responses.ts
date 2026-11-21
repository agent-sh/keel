// OpenAI Responses wire: the OpenAI API, the ChatGPT (Codex) backend, xAI.
// Stateless (`store: false`): the whole history goes every time, reasoning
// travels as the encrypted items the model returned, and one
// `prompt_cache_key` per session keeps the steps on one cache shard.
import type { AssistantBlock } from "../../core/types.ts";
import { emptyUsage } from "../../core/types.ts";
import { ProviderError } from "../http.ts";
import { project, refText } from "../project.ts";
import type { ProviderRequest } from "../types.ts";
import { effortFor, parseArgs, parseJson, type WireCodec, type WireCtx, type WireParser } from "./common.ts";

export type ResponsesDialect = "openai" | "codex" | "xai";

// xAI reserves these function names for its own server tools.
const XAI_RESERVED = new Set(["web_search", "tool_search", "x_search", "code_execution"]);
const wireName = (d: ResponsesDialect, n: string) => (d === "xai" && XAI_RESERVED.has(n) ? `keel_${n}` : n);
const localName = (d: ResponsesDialect, n: string) => (d === "xai" && n.startsWith("keel_") && XAI_RESERVED.has(n.slice(5)) ? n.slice(5) : n);

// xAI's schema check refuses `pattern`, `format` and enum values with a slash.
function xaiSchema(s: any): any {
  if (Array.isArray(s)) return s.map(xaiSchema);
  if (!s || typeof s !== "object") return s;
  const out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "pattern" || k === "format") continue;
    if (k === "enum" && Array.isArray(v)) { const kept = v.filter((x) => !(typeof x === "string" && x.includes("/"))); if (kept.length) out.enum = kept; continue; }
    out[k] = xaiSchema(v);
  }
  return out;
}

const dataUrl = (b: { media_type: string; data: string }) => `data:${b.media_type};base64,${b.data}`;

// Freeform tools (a grammar, raw text in and out: apply_patch, exec) go as
// OpenAI custom tools, as Codex sends them; xAI gets the JSON form.
const customOf = (req: ProviderRequest, d: ResponsesDialect) =>
  new Set(d === "xai" ? [] : req.tools.filter((t) => t.freeform).map((t) => t.name));
const rawInput = (input: unknown) => (typeof input === "string" ? input : typeof (input as any)?.input === "string" ? (input as any).input : undefined);

// Deferred tools (src/tools/defer.ts): the request declares the client
// tool_search and none of them. A search call is a tool_search_call item, its
// answer a tool_search_output that loads the tools it named, an MCP server's
// as functions of its namespace (mcp__<server>), as Codex does it. The items
// stay in the history, so a loaded tool stays loaded and the prefix stays.
const searchOf = (req: ProviderRequest) => req.tools.find((t) => t.search);
// Namespaces the Responses backend keeps for its own tools: a function sent
// inside one is refused ("Function 'web.websearch' is not allowed in reserved
// namespace 'web'"), which fails every request that declares or replays it.
// The list is Codex's (RESERVED_RESPONSES_NAMESPACES in openai/codex,
// codex-rs/core/src/config/mod.rs and app-server thread_processor.rs, as of
// 2026-11-21) plus `collaboration`, which the backend keeps for models with
// their own agent tools (openai/codex issues 31864 and 55495). The API
// reference lists none of them. A tool grouped under one of these goes as a
// function of its own with its full name.
export const RESERVED_NAMESPACES = new Set([
  "api_tool", "browser", "collaboration", "computer", "container", "file_search", "functions", "image_gen",
  "multi_tool_use", "python", "python_user_visible", "submodel_delegator", "terminal", "tool_search", "web",
]);
const namespaceOf = (t: { namespace?: string }) => (t.namespace && RESERVED_NAMESPACES.has(t.namespace) ? undefined : t.namespace);
const memberOf = (name: string, namespace?: string) => namespace ? name.slice(namespace.length + 2) : name;
// A function call's tool, by its namespace and name there.
const calledName = (it: { name?: string; namespace?: string }) =>
  it.namespace && it.namespace !== it.name ? `${it.namespace}__${it.name}` : String(it.name ?? "");

function loaded(req: ProviderRequest, names: string[]): any[] {
  const out: any[] = [];
  const spaces = new Map<string, any>();
  for (const n of names) {
    const t = req.tools.find((x) => x.name === n && x.defer);
    if (!t) continue;
    const namespace = namespaceOf(t);
    const fn = { type: "function", name: memberOf(t.name, namespace), description: t.description, strict: false, defer_loading: true, parameters: t.input_schema };
    if (!namespace) { out.push(fn); continue; }
    let ns = spaces.get(namespace);
    if (!ns) { ns = { type: "namespace", name: namespace, description: `Tools in the ${namespace} namespace.`, tools: [] }; spaces.set(namespace, ns); out.push(ns); }
    ns.tools.push(fn);
  }
  return out;
}

export function responsesBody(req: ProviderRequest, ctx: WireCtx, dialect: ResponsesDialect, systemPrefix?: string) {
  const input: any[] = [];
  const custom = customOf(req, dialect);
  const customCalls = new Set<string>();
  const search = searchOf(req);
  const searches = new Set<string>();
  for (const m of project(req.messages, { ...ctx, toolRefs: !!search })) {
    let texts: any[] = [];
    const flush = () => {
      if (texts.length) input.push({ type: "message", role: m.role, content: texts });
      texts = [];
    };
    for (const b of m.content) {
      if (b.type === "text") texts.push({ type: m.role === "user" ? "input_text" : "output_text", text: b.text });
      else if (b.type === "image") texts.push({ type: "input_image", image_url: dataUrl(b) });
      else if (b.type === "document") texts.push({ type: "input_file", filename: b.name, file_data: dataUrl(b) });
      else if (b.type === "thinking") {
        flush();
        if (b.opaque) input.push(b.opaque);
      } else if (b.type === "tool_use") {
        flush();
        const raw = custom.has(b.name) ? rawInput(b.input) : undefined;
        const t = req.tools.find((x) => x.name === b.name);
        const namespace = t && namespaceOf(t);
        if (search && b.name === search.name) { searches.add(b.id); input.push({ type: "tool_search_call", call_id: b.id, execution: "client", status: "completed", arguments: b.input ?? {} }); }
        else if (raw !== undefined) { customCalls.add(b.id); input.push({ type: "custom_tool_call", call_id: b.id, name: b.name, input: raw }); }
        else if (search && namespace) input.push({ type: "function_call", call_id: b.id, namespace, name: memberOf(b.name, namespace), arguments: JSON.stringify(b.input ?? {}) });
        else input.push({ type: "function_call", call_id: b.id, name: wireName(dialect, b.name), arguments: JSON.stringify(b.input ?? {}) });
      } else if (b.type === "tool_result" && searches.has(b.tool_use_id)) {
        flush();
        const names = typeof b.content === "string" ? [] : b.content.flatMap((c) => (c.type === "tool_reference" ? [c.tool_name] : []));
        input.push({ type: "tool_search_output", call_id: b.tool_use_id, execution: "client", status: "completed", tools: loaded(req, names) });
      } else if (b.type === "tool_result") {
        flush();
        const output = typeof b.content === "string"
          ? b.content
          // (A loaded tool named in a result that is not this wire's search, one another family wrote: a line of text.)
          : b.content.map((c) => (c.type === "image" ? { type: "input_image", image_url: dataUrl(c) } : { type: "input_text", text: c.type === "text" ? c.text : refText(c.tool_name) }));
        input.push({ type: customCalls.has(b.tool_use_id) ? "custom_tool_call_output" : "function_call_output", call_id: b.tool_use_id, output });
      }
    }
    flush();
  }
  const tools = req.tools.filter((t) => !(search && t.defer)).map((t) => t.search
    ? { type: "tool_search", execution: "client", description: t.description, parameters: t.input_schema }
    : custom.has(t.name)
    ? { type: "custom", name: t.name, description: t.description, format: { type: "grammar", syntax: t.freeform!.syntax, definition: t.freeform!.definition } }
    : {
      type: "function",
      name: wireName(dialect, t.name),
      description: t.description,
      parameters: dialect === "xai" ? xaiSchema(t.input_schema) : t.input_schema,
      strict: false,
    });
  const body: Record<string, any> = {
    model: req.model,
    instructions: systemPrefix ? `${systemPrefix}\n\n${req.system}` : req.system,
    input,
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: ctx.sessionKey || undefined,
  };
  if (tools.length) body.tools = tools;
  else delete body.tool_choice;
  const effort = effortFor(req, ctx);
  if (effort) body.reasoning = dialect === "xai" ? { effort } : { effort, summary: "auto" };
  return body;
}

export function responsesWire(dialect: ResponsesDialect, systemPrefix?: string): WireCodec {
  return {
    body: (req, ctx) => responsesBody(req, ctx, dialect, systemPrefix),
    parser(req, ctx, onDelta): WireParser {
      const items: any[] = [];
      const names = new Map<number, string>();
      const usage = emptyUsage();
      let stop = "end_turn";
      let finished = false;
      let served: string | undefined;
      const fail = (code: string, message: string) => {
        const kind = /context_length|context_window/.test(code) ? "context"
          : /rate_limit/.test(code) ? "rate"
          : /quota|usage_limit|insufficient/.test(code) ? "quota"
          : /server_error|overloaded/.test(code) ? "server" : "invalid";
        throw new ProviderError(kind, `${code}: ${message}`);
      };
      return {
        get finished() { return finished; },
        event(e) {
          if (e.data === "[DONE]") { finished = true; return; }
          const ev = parseJson(e.data);
          if (!ev) return;
          const i = ev.output_index ?? 0;
          switch (ev.type) {
            case "response.output_item.added":
              if (ev.item?.type === "function_call" || ev.item?.type === "custom_tool_call") {
                names.set(i, localName(dialect, calledName(ev.item)));
                onDelta({ kind: "tool_input", index: i, text: "", name: names.get(i) });
              }
              break;
            case "response.output_text.delta":
              onDelta({ kind: "text", index: i, text: ev.delta ?? "" });
              break;
            case "response.reasoning_summary_text.delta":
            case "response.reasoning_text.delta":
              onDelta({ kind: "thinking", index: i, text: ev.delta ?? "" });
              break;
            case "response.reasoning_summary_part.added":
              if (ev.summary_index > 0) onDelta({ kind: "thinking", index: i, text: "\n\n" });
              break;
            case "response.function_call_arguments.delta":
            case "response.custom_tool_call_input.delta":
              onDelta({ kind: "tool_input", index: i, text: ev.delta ?? "", name: names.get(i) });
              break;
            case "response.output_item.done":
              items[i] = ev.item;
              break;
            case "response.completed":
            case "response.incomplete": {
              const u = ev.response?.usage ?? {};
              const cached = u.input_tokens_details?.cached_tokens ?? 0;
              const written = u.input_tokens_details?.cache_write_tokens ?? 0;
              usage.input = Math.max(0, (u.input_tokens ?? 0) - cached - written);
              usage.cache_read = cached;
              usage.cache_write = written;
              // The write lifetimes, when the model reports them (they sum to the writes).
              const life = u.input_tokens_details?.cache_write_tokens_details;
              if (life) { usage.cache_write_30m = life.ttl_30m_tokens || undefined; usage.cache_write_12h = life.ttl_12h_tokens || undefined; }
              usage.output = u.output_tokens ?? 0;
              if (typeof ev.response?.service_tier === "string") served = ev.response.service_tier;
              // Items the done events did not carry (some servers send them only here).
              (ev.response?.output ?? []).forEach((it: any, k: number) => { if (!items[k]) items[k] = it; });
              if (ev.type === "response.incomplete") {
                const r = ev.response?.incomplete_details?.reason ?? "incomplete";
                stop = r === "max_output_tokens" ? "max_tokens" : r === "content_filter" ? "refusal" : r;
              }
              finished = true;
              break;
            }
            case "response.failed": {
              const err = ev.response?.error ?? {};
              fail(err.code ?? "failed", err.message ?? "the response failed");
              break;
            }
            case "error": {
              if (typeof ev.error === "string") fail(ev.code ?? "error", ev.error);
              const err = ev.error ?? ev;
              fail(err.code ?? err.type ?? "error", err.message ?? e.data);
            }
          }
        },
        result() {
          const blocks: AssistantBlock[] = [];
          for (const it of items) {
            if (!it) continue;
            if (it.type === "message") {
              const text = (it.content ?? []).filter((c: any) => c.type === "output_text").map((c: any) => c.text).join("");
              if (text) blocks.push({ type: "text", text });
            } else if (it.type === "reasoning") {
              const thinking = (it.summary ?? []).map((s: any) => s.text).join("\n\n");
              // The item id is not replayed: with `store: false` the server keeps no record of it.
              const opaque = typeof it.encrypted_content === "string"
                ? dialect === "xai" ? it : { type: "reasoning", summary: it.summary ?? [], encrypted_content: it.encrypted_content }
                : undefined;
              if (thinking || opaque) blocks.push({ type: "thinking", thinking, opaque, origin: ctx.origin });
            } else if (it.type === "custom_tool_call") {
              blocks.push({ type: "tool_use", id: it.call_id ?? it.id, name: it.name, input: { input: String(it.input ?? "") }, origin: ctx.origin });
            } else if (it.type === "function_call") {
              blocks.push({ type: "tool_use", id: it.call_id ?? it.id, name: localName(dialect, calledName(it)), input: parseArgs(it.arguments ?? ""), origin: ctx.origin });
            } else if (it.type === "tool_search_call" && it.execution === "client") {
              // A search the model asked Keel to run: the family's search tool.
              const s = searchOf(req);
              const args = typeof it.arguments === "string" ? parseArgs(it.arguments) : it.arguments ?? {};
              if (s) blocks.push({ type: "tool_use", id: it.call_id ?? it.id, name: s.name, input: args, origin: ctx.origin });
            }
          }
          if (stop === "end_turn" && blocks.some((b) => b.type === "tool_use")) stop = "tool_use";
          return { blocks, usage, stop, model: req.model, served };
        },
      };
    },
  };
}
