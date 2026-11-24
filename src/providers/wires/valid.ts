// The structural rules each wire refuses a request over, as checks of a built
// body. For tests: a request Keel builds from any history must pass its wire's
// check (valid.test.ts builds random histories). Each check is that wire's own
// rule, from the source cited where the wire driver states it (ANTHROPIC_RULES,
// RESPONSES_RULES, CHAT_RULES, GEMINI_RULES and the declared-name patterns
// beside them); a form whose refusal is not established for a wire is not
// checked on it. Nothing here is sent anywhere, and nothing is about a model.
import { imageType } from "../project.ts";
import { ANTHROPIC_RULES, TOOL_NAME } from "./anthropic.ts";
import { FUNCTION_NAME as GEMINI_NAME, GEMINI_RULES } from "./gemini.ts";
import { FUNCTION_NAME as RESPONSES_NAME, RESERVED_NAMESPACES, RESPONSES_RULES, type ResponsesDialect } from "./responses.ts";
import { schemaRefusals } from "./schema-fit.ts";

// A replayed call's name under a wire's rule: its length, and none of the
// characters the wire refuses.
const nameFits = (name: unknown, rule: { max: number; bad?: RegExp }) =>
  typeof name === "string" && name.length >= 1 && name.length <= rule.max && !(rule.bad && name.replace(rule.bad, "") !== name);
// ToolUseBlockParam.id: `pattern: ^[a-zA-Z0-9_-]+$` (api/messages/create).
const ID = /^[a-zA-Z0-9_-]+$/;
const isObject = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);

// "The image was specified using the image/jpeg media type, but the image
// appears to be a image/png image": a label that is not what the bytes are
// (the Anthropic wire's answer; not checked on the others).
function mislabeled(type: unknown, data: unknown): string | null {
  if (typeof type !== "string" || typeof data !== "string") return "an image without a type or data";
  const real = imageType({ media_type: "", data });
  return real && real !== type ? `an image labelled ${type} whose bytes are ${real}` : null;
}

// Anthropic Messages.
export function anthropicProblems(body: any): string[] {
  const out: string[] = [];
  const say = (at: string, what: string) => void out.push(`${at}: ${what}`);
  const messages: any[] = body.messages ?? [];
  const tools: any[] = body.tools ?? [];
  const declared = new Set<string>();
  for (const t of tools) {
    if (!TOOL_NAME.test(String(t.name))) say("tools", `the name ${JSON.stringify(t.name)} is outside ${TOOL_NAME.source}`);
    if (declared.has(t.name)) say("tools", `two tools are named ${t.name}`);
    declared.add(t.name);
    if (!isObject(t.input_schema)) say("tools", `${t.name} has no input_schema object`);
    // What the API refuses in an input schema (schema-fit.ts SCHEMA_RULES, its sources).
    else for (const p of schemaRefusals(t.input_schema, "anthropic_messages")) say("tools", `${t.name}: ${p}`);
  }
  let marks = (body.system ?? []).filter((b: any) => b?.cache_control).length + tools.filter((t) => t.cache_control).length;
  const image = (at: string, b: any) => {
    if (b.source?.type !== "base64") return;
    const bad = mislabeled(b.source.media_type, b.source.data);
    if (bad) say(at, bad);
    if (!/^image\/(png|jpeg|gif|webp)$/.test(String(b.source.media_type))) say(at, `an image of type ${b.source.media_type}`);
  };
  messages.forEach((m, i) => {
    if (m.role !== "user" && m.role !== "assistant") say(`messages.${i}`, `role ${m.role}`);
    if (!Array.isArray(m.content) || !m.content.length) return say(`messages.${i}`, "no content");
    const prev = messages[i - 1];
    // "Each `tool_result` block must have a corresponding `tool_use` block in the previous message".
    const calls: string[] = prev?.role === "assistant" ? prev.content.filter((b: any) => b.type === "tool_use").map((b: any) => b.id) : [];
    const answered = new Set<string>();
    const ids = new Set<string>(); // the ids of this message's calls
    let other = false;
    m.content.forEach((b: any, k: number) => {
      const at = `messages.${i}.content.${k}`;
      if (b.cache_control) marks++;
      if (b.type === "text") {
        // "text content blocks must be non-empty"; in a user message, "must contain non-whitespace text".
        if (typeof b.text !== "string" || !(m.role === "user" ? b.text.trim() : b.text)) say(at, "an empty text block");
      } else if (b.type === "image") image(at, b);
      else if (b.type === "thinking") {
        if (!b.signature) say(at, "thinking without a signature");
      } else if (b.type === "tool_use") {
        if (m.role !== "assistant") say(at, "a tool_use in a user message");
        if (!ID.test(String(b.id))) say(at, `the call id ${JSON.stringify(b.id)}`);
        // "`tool_use` ids must be unique": within one assistant message.
        if (ids.has(b.id)) say(at, `the call id ${b.id} is used twice in one message`);
        ids.add(b.id);
        if (!nameFits(b.name, ANTHROPIC_RULES.name!)) say(at, `the tool name ${JSON.stringify(b.name)}`);
        // "tool_use.input: Input should be a valid dictionary".
        if (!isObject(b.input)) say(at, "a call's input is not an object");
      } else if (b.type === "tool_result") {
        if (m.role !== "user") say(at, "a tool_result in an assistant message");
        if (!calls.includes(b.tool_use_id)) say(at, `unexpected tool_use_id ${b.tool_use_id}: no tool_use in the previous message`);
        if (answered.has(b.tool_use_id)) say(at, `two results for ${b.tool_use_id}`);
        answered.add(b.tool_use_id);
        // "tool_result blocks must come first in the content".
        if (other) say(at, "a tool_result after another kind of block");
        if (Array.isArray(b.content)) b.content.forEach((c: any, j: number) => {
          if (c.type === "text" && !c.text) say(`${at}.content.${j}`, "an empty text block");
          else if (c.type === "image") image(`${at}.content.${j}`, c);
          else if (c.type === "tool_reference" && !declared.has(c.tool_name)) say(`${at}.content.${j}`, `a reference to ${c.tool_name}, which is not declared`);
          else if (!["text", "image", "tool_reference"].includes(c.type)) say(`${at}.content.${j}`, `a ${c.type} block in a result`);
        });
        else if (typeof b.content !== "string") say(at, "a result without content");
      }
      if (b.type !== "tool_result") other = true;
    });
    // "`tool_use` ids were found without `tool_result` blocks immediately after".
    if (m.role === "assistant") {
      const next = messages[i + 1];
      const got = new Set(next?.role === "user" ? next.content.filter((b: any) => b.type === "tool_result").map((b: any) => b.tool_use_id) : []);
      for (const b of m.content) if (b.type === "tool_use" && !got.has(b.id)) say(`messages.${i}`, `the call ${b.id} has no tool_result in the next message`);
    }
  });
  if (marks > 4) say("cache_control", `${marks} breakpoints (4 at most)`);
  return out;
}

// OpenAI Responses (and the ChatGPT and xAI dialects of it).
const CALLS: Record<string, string> = { function_call_output: "function_call", custom_tool_call_output: "custom_tool_call", tool_search_output: "tool_search_call" };
const XAI_RESERVED = new Set(["web_search", "tool_search", "x_search", "code_execution"]);
export function responsesProblems(body: any, dialect: ResponsesDialect = "openai"): string[] {
  const out: string[] = [];
  const say = (at: string, what: string) => void out.push(`${at}: ${what}`);
  const fn = (at: string, t: any) => {
    if (!RESPONSES_NAME.test(String(t.name))) say(at, `the function name ${JSON.stringify(t.name)}`);
    if (dialect === "xai" && XAI_RESERVED.has(t.name)) say(at, `${t.name} is a name xAI keeps for its own tools`);
    if (t.parameters !== undefined) for (const p of schemaRefusals(t.parameters, "openai_responses")) say(at, `${t.name}: ${p}`);
  };
  // "Function 'web.websearch' is not allowed in reserved namespace 'web'."
  const space = (at: string, t: any) => {
    if (RESERVED_NAMESPACES.has(t.name)) say(at, `the reserved namespace ${t.name}`);
    // NamespaceToolParam: `name: minLength: 1`, `tools: minItems: 1`.
    if (!t.name) say(at, "a namespace without a name");
    if (!Array.isArray(t.tools) || !t.tools.length) say(at, `the namespace ${t.name} is empty`);
    for (const x of t.tools ?? []) fn(`${at}.${t.name}`, x);
  };
  for (const t of body.tools ?? []) {
    if (t.type === "function") fn("tools", t);
    else if (t.type === "namespace") space("tools", t);
  }
  const input: any[] = body.input ?? [];
  // The calls not answered yet, by call id (an id two calls share is not refused here).
  const open = new Map<string, string[]>();
  input.forEach((it, i) => {
    const at = `input.${i}`;
    if (it.type === "function_call" || it.type === "custom_tool_call" || it.type === "tool_search_call") {
      // `call_id: maxLength: 64, minLength: 1` (the output items' reference).
      if (typeof it.call_id !== "string" || !it.call_id || it.call_id.length > 64) say(at, `the call id ${JSON.stringify(it.call_id)}`);
      if (it.type === "function_call" && !nameFits(it.name, RESPONSES_RULES.name!)) say(at, `the function name ${JSON.stringify(it.name)}`);
      if (it.namespace !== undefined && RESERVED_NAMESPACES.has(it.namespace)) say(at, `the reserved namespace ${JSON.stringify(it.namespace)}`);
      // FunctionToolCall.arguments: "A JSON string of the arguments".
      if (it.type === "function_call" && typeof it.arguments !== "string") say(at, "arguments that are not a string");
      open.set(it.call_id, [...(open.get(it.call_id) ?? []), it.type]);
    } else if (CALLS[it.type]) {
      // "No tool call found for function call output with call_id ...".
      const calls = open.get(it.call_id) ?? [];
      const k = calls.indexOf(CALLS[it.type]!);
      if (k < 0) say(at, `no ${CALLS[it.type]} found for the ${it.type} with call_id ${it.call_id}`);
      else calls.splice(k, 1);
      if (it.type === "tool_search_output") for (const t of it.tools ?? []) (t.type === "namespace" ? space : fn)(at, t);
    }
  });
  // "No tool output found for function call ...".
  for (const [id, calls] of open) if (calls.length) say("input", `the call ${id} has no output`);
  return out;
}

// OpenAI-compatible Chat Completions: the pairing of calls and tool messages
// (no rule for a name is established for the servers that speak this wire).
export function chatProblems(body: any): string[] {
  const out: string[] = [];
  const say = (at: string, what: string) => void out.push(`${at}: ${what}`);
  for (const t of body.tools ?? []) if (t.function?.parameters !== undefined) for (const p of schemaRefusals(t.function.parameters, "chat_completions")) say("tools", `${t.function.name}: ${p}`);
  const messages: any[] = body.messages ?? [];
  let open: string[] = [];
  messages.forEach((m, i) => {
    const at = `messages.${i}`;
    if (m.role === "tool") {
      // "messages with role 'tool' must be a response to a preceeding message with 'tool_calls'".
      const k = open.indexOf(m.tool_call_id);
      if (k < 0) say(at, `a tool message for ${m.tool_call_id}, which the assistant message before did not call`);
      else open.splice(k, 1);
      return;
    }
    // "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'".
    for (const id of open) say(at, `the call ${id} has no tool message before this message`);
    open = [];
    if (m.role !== "assistant") return;
    for (const c of m.tool_calls ?? []) {
      // ChatCompletionMessageToolCall.function.arguments: a string.
      if (typeof c.function?.arguments !== "string") say(at, "arguments that are not a string");
      open.push(c.id);
    }
  });
  for (const id of open) say("messages", `the call ${id} has no tool message`);
  return out;
}

// Gemini generateContent.
export function geminiProblems(body: any): string[] {
  const out: string[] = [];
  const say = (at: string, what: string) => void out.push(`${at}: ${what}`);
  for (const t of body.tools ?? []) for (const f of t.functionDeclarations ?? []) {
    if (!GEMINI_NAME.test(String(f.name))) say("tools", `the function name ${JSON.stringify(f.name)}`);
    if (f.parametersJsonSchema !== undefined) for (const p of schemaRefusals(f.parametersJsonSchema, "gemini_generate_content")) say("tools", `${f.name}: ${p}`);
  }
  const contents: any[] = body.contents ?? [];
  const count = (c: any, key: string) => (c?.parts ?? []).filter((p: any) => p[key]).length;
  contents.forEach((c, i) => {
    const at = `contents.${i}`;
    // "Please ensure that the number of function response parts is equal to
    // the number of function call parts of the function call turn."
    const prev = contents[i - 1];
    const calls = prev?.role === "model" ? count(prev, "functionCall") : 0;
    if (c.role === "user" && count(c, "functionResponse") !== calls) say(at, `${count(c, "functionResponse")} function responses for ${calls} function calls`);
    for (const p of c.parts ?? []) {
      if (!p.functionCall) continue;
      if (!nameFits(p.functionCall.name, GEMINI_RULES.name!)) say(at, `the function name ${JSON.stringify(p.functionCall.name)}`);
      // FunctionCall.args: `type: object`.
      if (!isObject(p.functionCall.args)) say(at, "a call's args are not an object");
    }
  });
  return out;
}
