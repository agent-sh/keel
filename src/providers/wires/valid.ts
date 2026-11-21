// The structural rules each wire refuses a request over, as checks of a built
// body. For tests: a request Keel builds from any history must pass its wire's
// check (valid.test.ts builds random histories). Each rule names the provider
// answer it stands for. Nothing here is sent anywhere, and nothing is about a
// model.
import { imageType } from "../project.ts";
import { RESERVED_NAMESPACES, type ResponsesDialect } from "./responses.ts";

// Function and tool names: OpenAI and Anthropic take `[a-zA-Z0-9_-]`, at most
// 64 (the Anthropic API takes longer ones today; 64 is what every host takes).
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
// Gemini: starts with a letter or underscore, then also dots and colons.
const GEMINI_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isObject = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);

// "The image was specified using the image/jpeg media type, but the image
// appears to be a image/png image": a label that is not what the bytes are.
function mislabeled(type: unknown, data: unknown): string | null {
  if (typeof type !== "string" || typeof data !== "string") return "an image without a type or data";
  const real = imageType({ media_type: "", data });
  return real && real !== type ? `an image labelled ${type} whose bytes are ${real}` : null;
}
const dataUrl = (url: unknown): string | null => {
  const m = typeof url === "string" ? /^data:([^;,]*);base64,(.*)$/s.exec(url) : null;
  return m ? mislabeled(m[1], m[2]) : "an image that is not a base64 data URL";
};

// Anthropic Messages.
export function anthropicProblems(body: any): string[] {
  const out: string[] = [];
  const say = (at: string, what: string) => void out.push(`${at}: ${what}`);
  const messages: any[] = body.messages ?? [];
  const tools: any[] = body.tools ?? [];
  const declared = new Set<string>();
  for (const t of tools) {
    if (!NAME.test(String(t.name))) say("tools", `the name ${JSON.stringify(t.name)} is outside [a-zA-Z0-9_-]{1,64}`);
    if (declared.has(t.name)) say("tools", `two tools are named ${t.name}`);
    declared.add(t.name);
    if (!isObject(t.input_schema)) say("tools", `${t.name} has no input_schema object`);
  }
  if (messages[0] && messages[0].role !== "user") say("messages.0", "the first message is not the user's");
  const ids = new Set<string>();
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
    let other = false;
    m.content.forEach((b: any, k: number) => {
      const at = `messages.${i}.content.${k}`;
      if (b.cache_control) marks++;
      if (b.type === "text") {
        if (typeof b.text !== "string" || !b.text) say(at, "an empty text block");
      } else if (b.type === "image") image(at, b);
      else if (b.type === "thinking") {
        if (!b.signature) say(at, "thinking without a signature");
      } else if (b.type === "tool_use") {
        if (m.role !== "assistant") say(at, "a tool_use in a user message");
        if (!ID.test(String(b.id))) say(at, `the call id ${JSON.stringify(b.id)}`);
        // "`tool_use` ids must be unique".
        if (ids.has(b.id)) say(at, `the call id ${b.id} is used twice`);
        ids.add(b.id);
        if (!NAME.test(String(b.name))) say(at, `the tool name ${JSON.stringify(b.name)}`);
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
  const fn = (at: string, t: any, inside?: string) => {
    if (!NAME.test(String(t.name))) say(at, `the function name ${JSON.stringify(t.name)}`);
    if (dialect === "xai" && XAI_RESERVED.has(t.name)) say(at, `${t.name} is a name xAI keeps for its own tools`);
    void inside;
  };
  // "Function 'web.websearch' is not allowed in reserved namespace 'web'."
  const space = (at: string, t: any) => {
    if (!NAME.test(String(t.name))) say(at, `the namespace name ${JSON.stringify(t.name)}`);
    if (RESERVED_NAMESPACES.has(t.name)) say(at, `the reserved namespace ${t.name}`);
    if (!Array.isArray(t.tools) || !t.tools.length) say(at, `the namespace ${t.name} is empty`);
    for (const x of t.tools ?? []) fn(`${at}.${t.name}`, x, t.name);
  };
  const seen = new Set<string>();
  for (const t of body.tools ?? []) {
    if (t.type === "function" || t.type === "custom") {
      fn("tools", t);
      if (seen.has(t.name)) say("tools", `two tools are named ${t.name}`);
      seen.add(t.name);
    } else if (t.type === "namespace") space("tools", t);
  }
  const input: any[] = body.input ?? [];
  const open = new Map<string, string>(); // call id -> the kind of call
  const answered = new Set<string>();
  const image = (at: string, c: any) => { const bad = dataUrl(c.image_url); if (bad) say(at, bad); };
  input.forEach((it, i) => {
    const at = `input.${i}`;
    if (it.type === "message") {
      if (!Array.isArray(it.content) || !it.content.length) say(at, "a message without content");
      for (const c of it.content ?? []) {
        if (c.type === "input_image") image(at, c);
        else if ((c.type === "input_text" || c.type === "output_text") && !c.text) say(at, "an empty text part");
      }
    } else if (it.type === "function_call" || it.type === "custom_tool_call" || it.type === "tool_search_call") {
      if (!it.call_id || typeof it.call_id !== "string") say(at, "a call without a call_id");
      if (it.type !== "tool_search_call" && !NAME.test(String(it.name))) say(at, `the function name ${JSON.stringify(it.name)}`);
      if (it.namespace !== undefined && (!NAME.test(String(it.namespace)) || RESERVED_NAMESPACES.has(it.namespace))) say(at, `the namespace ${JSON.stringify(it.namespace)}`);
      if (it.type === "function_call" && typeof it.arguments !== "string") say(at, "arguments that are not a string");
      if (it.type === "custom_tool_call" && typeof it.input !== "string") say(at, "a custom call's input that is not a string");
      open.set(it.call_id, it.type);
    } else if (CALLS[it.type]) {
      // "No tool call found for function call output with call_id ...".
      if (open.get(it.call_id) !== CALLS[it.type]) say(at, `no ${CALLS[it.type]} found for the ${it.type} with call_id ${it.call_id}`);
      if (answered.has(it.call_id)) say(at, `two outputs for ${it.call_id}`);
      answered.add(it.call_id);
      if (it.type === "tool_search_output") for (const t of it.tools ?? []) (t.type === "namespace" ? space : fn)(at, t);
      else if (Array.isArray(it.output)) for (const c of it.output) { if (c.type === "input_image") image(at, c); }
      else if (typeof it.output !== "string") say(at, "an output that is neither text nor parts");
    }
  });
  // "No tool output found for function call ...".
  for (const [id] of open) if (!answered.has(id)) say("input", `the call ${id} has no output`);
  return out;
}

// OpenAI-compatible Chat Completions.
export function chatProblems(body: any): string[] {
  const out: string[] = [];
  const say = (at: string, what: string) => void out.push(`${at}: ${what}`);
  for (const t of body.tools ?? []) if (!NAME.test(String(t.function?.name))) say("tools", `the function name ${JSON.stringify(t.function?.name)}`);
  const messages: any[] = body.messages ?? [];
  let open: string[] = [];
  messages.forEach((m, i) => {
    const at = `messages.${i}`;
    if (m.role === "tool") {
      // "messages with role 'tool' must be a response to a preceding message with 'tool_calls'".
      const k = open.indexOf(m.tool_call_id);
      if (k < 0) say(at, `a tool message for ${m.tool_call_id}, which the assistant message before did not call`);
      else open.splice(k, 1);
      if (typeof m.content !== "string" || !m.content) say(at, "a tool message without text");
      return;
    }
    // "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'".
    for (const id of open) say(at, `the call ${id} has no tool message before this message`);
    open = [];
    if (m.role === "assistant") {
      if (m.content === null && !m.tool_calls?.length) say(at, "an assistant message with neither text nor calls");
      for (const c of m.tool_calls ?? []) {
        if (!c.id) say(at, "a call without an id");
        if (!NAME.test(String(c.function?.name))) say(at, `the function name ${JSON.stringify(c.function?.name)}`);
        if (typeof c.function?.arguments !== "string") say(at, "arguments that are not a string");
        open.push(c.id);
      }
    } else if (m.role === "user" && Array.isArray(m.content)) {
      for (const p of m.content) if (p.type === "image_url") { const bad = dataUrl(p.image_url?.url); if (bad) say(at, bad); }
    }
  });
  for (const id of open) say("messages", `the call ${id} has no tool message`);
  return out;
}

// Gemini generateContent.
export function geminiProblems(body: any): string[] {
  const out: string[] = [];
  const say = (at: string, what: string) => void out.push(`${at}: ${what}`);
  for (const t of body.tools ?? []) for (const f of t.functionDeclarations ?? []) if (!GEMINI_NAME.test(String(f.name))) say("tools", `the function name ${JSON.stringify(f.name)}`);
  const contents: any[] = body.contents ?? [];
  contents.forEach((c, i) => {
    const at = `contents.${i}`;
    if (!Array.isArray(c.parts) || !c.parts.length) return say(at, "no parts");
    if (contents[i - 1]?.role === c.role) say(at, `two ${c.role} turns in a row`);
    const prev = contents[i - 1];
    const calls: any[] = prev?.role === "model" ? prev.parts.filter((p: any) => p.functionCall).map((p: any) => p.functionCall) : [];
    const answers: any[] = c.parts.filter((p: any) => p.functionResponse).map((p: any) => p.functionResponse);
    if (c.role === "user") {
      // "Please ensure that the number of function response parts is equal to
      // the number of function call parts of the function call turn."
      if (answers.length !== calls.length) say(at, `${answers.length} function responses for ${calls.length} function calls`);
      for (const a of answers) {
        const call = calls.find((x) => x.id === a.id);
        if (!call) say(at, `a function response for ${a.id}, which the turn before did not call`);
        else if (call.name !== a.name) say(at, `the response for ${a.id} is named ${a.name}, its call ${call.name}`);
      }
    } else if (answers.length) say(at, "a function response in a model turn");
    for (const p of c.parts) {
      if (p.functionCall) {
        if (c.role !== "model") say(at, "a function call in a user turn");
        if (!GEMINI_NAME.test(String(p.functionCall.name))) say(at, `the function name ${JSON.stringify(p.functionCall.name)}`);
        if (!isObject(p.functionCall.args)) say(at, "a call's args are not an object");
      }
      if (p.functionResponse && !GEMINI_NAME.test(String(p.functionResponse.name))) say(at, `the function name ${JSON.stringify(p.functionResponse.name)}`);
      if (p.inlineData && String(p.inlineData.mimeType).startsWith("image/")) { const bad = mislabeled(p.inlineData.mimeType, p.inlineData.data); if (bad) say(at, bad); }
    }
    if (c.role === "model" && c.parts.some((p: any) => p.functionCall) && contents[i + 1]?.role !== "user") say(at, "function calls with no user turn after them");
  });
  return out;
}
