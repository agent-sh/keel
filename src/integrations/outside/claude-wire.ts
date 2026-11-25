// The wire of Claude Code's print mode with stream-json in and out, as Keel
// speaks it to answer a Claude Code session in place (claude-code.ts). Pure:
// the command line, the child's environment, the lines Keel writes, what a
// line Claude Code writes is, and what its transcript says of the session.
//
// Sources, per shape (D documented, C read from the installed package's own
// code, U unknown; the table is in the lane's report):
// - stdin user message {type:"user", message, parent_tool_use_id, uuid}: D (Agent SDK
//   types SDKUserMessage; streaming input docs). A uuid the session already holds is
//   skipped by Claude Code (C: print mode's skipDuplicate), so a resend is harmless.
// - control_request / control_response / control_cancel_request envelopes: D (SDK
//   types SDKControlRequest, SDKControlResponse, SDKControlCancelRequest).
// - can_use_tool {tool_name, input, tool_use_id, ...}: D (SDK types
//   SDKControlPermissionRequest), C (the CLI's request builder in 2.1.332).
// - its answer {behavior: allow, updatedInput} / {behavior: deny, message}: D (SDK
//   types PermissionResult; user-input docs), C (the CLI's result schema; the SDK adds
//   toolUseID).
// - interrupt {subtype:"interrupt"}: D (SDK types), its turn ends in an
//   error_during_execution result: D (streaming input docs).
// - initialize {subtype:"initialize"}: D (SDK types; every field optional), C (the SDK
//   sends it before the first message).
// - --permission-prompt-tool stdio: C (the SDK passes --permission-prompt-tool=stdio when
//   a canUseTool callback is set; the CLI routes "stdio" to the SDK host). Not in --help.
// - stream_event (partial messages) and result with user_message_uuids: D (SDK types,
//   headless docs, streaming input docs).
import { basename } from "node:path";

type Json = any;

// Which route a model id names: the first party (sign-in), Amazon Bedrock (an inference profile or a
// Bedrock model id), Google Vertex (a "@date" version), or a gateway (any other id: a base URL's own names).
export type ClaudeRoute = "first-party" | "bedrock" | "vertex" | "gateway";
export function routeOf(model?: string): ClaudeRoute | undefined {
  if (!model) return undefined;
  if (/^arn:aws(-[a-z]+)?:bedrock:/.test(model) || /^([a-z]{2,6}\.)?anthropic\./.test(model)) return "bedrock";
  if (/^claude-[\w.-]+@\d{8}$/.test(model)) return "vertex";
  if (/^claude-[a-z0-9.-]+$/.test(model)) return "first-party";
  return "gateway";
}

// The variables that choose a route or carry its key. Each route keeps its own and loses the others':
// a session that answered on the first party goes on signed in, whatever key the daemon's environment holds.
const ROUTE_VARS: Record<Exclude<ClaudeRoute, "first-party">, RegExp> = {
  gateway: /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_CUSTOM_HEADERS)$/,
  bedrock: /^(CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_SKIP_BEDROCK_AUTH|AWS_BEARER_TOKEN_BEDROCK|ANTHROPIC_BEDROCK_BASE_URL|ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION)$/,
  vertex: /^(CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_SKIP_VERTEX_AUTH|ANTHROPIC_VERTEX_PROJECT_ID|ANTHROPIC_VERTEX_BASE_URL|CLOUD_ML_REGION|VERTEX_REGION_\w+)$/,
};
// Foundry and any other cloud switch: no model id names them yet, so no session goes on there.
const OTHER_ROUTES = /^(CLAUDE_CODE_USE_FOUNDRY|ANTHROPIC_FOUNDRY_\w+|CLAUDE_CODE_USE_\w+)$/;
// Model defaults name a model of one route: kept only when they name the session's.
const MODEL_VARS = /^(ANTHROPIC_MODEL|ANTHROPIC_DEFAULT_\w+_MODEL|ANTHROPIC_SMALL_FAST_MODEL|CLAUDE_CODE_SUBAGENT_MODEL)$/;
// What the daemon's own environment carries that is no part of the owner's terminal: Keel's model default, a
// Claude Code that started the daemon (its nesting marks), and Node options the SDK clears too.
const NOT_THE_TERMINALS = /^(ANTHROPIC_DEFAULT_MODEL|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|NODE_OPTIONS)$/;

// The child's environment: the daemon's, less the variables of every route but the one the session's last
// model names. `configDir`: Claude Code's folder, when it is not its default (CLAUDE_CONFIG_DIR).
export function childEnv(env: Record<string, string | undefined>, model: string | undefined, configDir?: string): Record<string, string> {
  const route = routeOf(model) ?? "first-party";
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || NOT_THE_TERMINALS.test(k)) continue;
    const of = (Object.keys(ROUTE_VARS) as (keyof typeof ROUTE_VARS)[]).find((r) => ROUTE_VARS[r].test(k));
    if (of && of !== route) continue;
    if (!of && OTHER_ROUTES.test(k)) continue;
    if (MODEL_VARS.test(k) && routeOf(v) !== route) continue;
    out[k] = v;
  }
  if (configDir) out.CLAUDE_CONFIG_DIR = configDir;
  return out;
}

// Claude Code's permission modes. Keel passes the session's own, never bypassPermissions: a session that
// ran with it goes on asking (and the bar says so).
const MODES = new Set(["default", "acceptEdits", "auto", "plan", "dontAsk"]);
export const BYPASS_NOTE = "This session ran in Claude Code with permission prompts bypassed. Keel answers it asking for each call instead: Keel never turns the bypass on.";
export function modeFor(m?: string): { mode: string; note?: string } {
  if (m === "bypassPermissions") return { mode: "default", note: BYPASS_NOTE };
  return { mode: m && MODES.has(m) ? m : "default" };
}

// What the transcript's records say: the folder, the model of the last reply, the mode of the last prompt.
export type SessionFacts = { cwd?: string; model?: string; mode?: string };
export const modelOf = (r: Json): string | undefined => (r?.type === "assistant" && typeof r.message?.model === "string" && r.message.model && r.message.model !== "<synthetic>" ? r.message.model : undefined);
export function sessionFacts(records: Json[]): SessionFacts {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  let cwd: string | undefined, model: string | undefined, mode: string | undefined;
  for (const r of records) {
    cwd = str(r?.cwd) ?? cwd;
    model = modelOf(r) ?? model;
    if (r?.type === "user") mode = str(r.permissionMode) ?? mode;
  }
  return { cwd, model, mode };
}

// The command line: the session resumed by its id, stream-json both ways with the partial messages,
// permission prompts to Keel over the control channel, the model and the mode passed (a resumed print run
// restores neither). The text goes on standard input, never here.
export function argsOf(bin: string, sessionId: string, f: { model?: string; mode: string }): string[] {
  return [
    bin, "-p", "--resume", sessionId,
    "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--permission-prompt-tool", "stdio",
    ...(f.model ? ["--model", f.model] : []),
    "--permission-mode", f.mode,
  ];
}

// The lines Keel writes.
const line = (m: Json) => JSON.stringify(m) + "\n";
export const userLine = (text: string, uuid: string) => line({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, uuid });
export const requestLine = (id: string, request: Json) => line({ type: "control_request", request_id: id, request });
export const answerLine = (id: string, response: Json) => line({ type: "control_response", response: { subtype: "success", request_id: id, response } });
export const refusalLine = (id: string, error: string) => line({ type: "control_response", response: { subtype: "error", request_id: id, error } });

// What a line Claude Code writes is, for the driver.
export type Out =
  | { kind: "ask"; id: string; request: Json }
  | { kind: "answer"; id: string; ok: boolean; response?: Json; error?: string }
  | { kind: "cancel"; id: string }
  | { kind: "message"; id: string }
  | { kind: "delta"; index: number; text: string }
  | { kind: "result"; uuids?: string[]; error: boolean; said?: string }
  | { kind: "other" };
export function readOut(m: Json): Out {
  switch (m?.type) {
    case "control_request":
      return typeof m.request_id === "string" && m.request && typeof m.request === "object" ? { kind: "ask", id: m.request_id, request: m.request } : { kind: "other" };
    case "control_response": {
      const r = m.response ?? {};
      if (typeof r.request_id !== "string") return { kind: "other" };
      return r.subtype === "success" ? { kind: "answer", id: r.request_id, ok: true, response: r.response } : { kind: "answer", id: r.request_id, ok: false, error: String(r.error ?? "Claude Code refused it") };
    }
    case "control_cancel_request":
      return typeof m.request_id === "string" ? { kind: "cancel", id: m.request_id } : { kind: "other" };
    case "stream_event": {
      // A subagent's stream is its own: the row's reply is the main thread's.
      if (m.parent_tool_use_id) return { kind: "other" };
      const e = m.event ?? {};
      if (e.type === "message_start" && typeof e.message?.id === "string") return { kind: "message", id: e.message.id };
      if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && typeof e.delta.text === "string" && e.delta.text) return { kind: "delta", index: Number(e.index) || 0, text: e.delta.text };
      return { kind: "other" };
    }
    case "result": {
      const uuids = Array.isArray(m.user_message_uuids) ? m.user_message_uuids.filter((u: unknown) => typeof u === "string") : typeof m.user_message_uuid === "string" ? [m.user_message_uuid] : undefined;
      const error = m.is_error === true || (typeof m.subtype === "string" && m.subtype !== "success");
      const said = Array.isArray(m.errors) ? m.errors.filter((x: unknown) => typeof x === "string").join("; ").slice(0, 400) : undefined;
      return { kind: "result", ...(uuids ? { uuids } : {}), error, ...(said ? { said } : {}) };
    }
  }
  return { kind: "other" };
}

// The words of a user record, when it is a prompt (not a tool result, a meta record or a summary).
function promptText(r: Json): string | undefined {
  if (r?.type !== "user" || r.isMeta || r.isCompactSummary) return undefined;
  const c = r.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c) || c.some((b: Json) => b?.type === "tool_result")) return undefined;
  return c.filter((b: Json) => b?.type === "text").map((b: Json) => String(b.text ?? "")).join("\n");
}

// Whether the transcript's records hold the owner's message: a prompt with its words, or the record Claude
// Code kept under the uuid Keel gave it.
export function holdsMessage(records: Json[], text: string, uuid?: string): boolean {
  return records.some((r) => (uuid && r?.type === "user" && r.uuid === uuid) || promptText(r)?.trim() === text.trim());
}

const INTERRUPTED = /^\[Request interrupted by user/;
// Whether the turn the message is in ended in the records: a reply that stopped for good, or its interrupt.
export function turnEnded(records: Json[], text: string, uuid?: string): boolean {
  const at = records.findIndex((r) => holdsMessage([r], text, uuid));
  if (at < 0) return false;
  return records.slice(at + 1).some((r) => {
    if (r?.type === "assistant") { const s = r.message?.stop_reason; return typeof s === "string" && s !== "tool_use"; }
    return INTERRUPTED.test(promptText(r)?.trim() ?? "");
  });
}

// What a call Claude Code asks about is, for the gate's one-call card: a command, a file change, or another tool.
export type CardOf = { tool: { name: string; kind?: "shell" | "edit"; input_schema?: Json }; input: Json; name: string; why: string; shown?: string };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
export function cardOf(toolName: string, input: Json, cwd: string): CardOf {
  const i = input && typeof input === "object" ? input : {};
  if (toolName === "Bash" || toolName === "PowerShell") {
    const command = typeof i.command === "string" ? i.command : "";
    return { tool: { name: "Claude Code command", kind: "shell", input_schema: { properties: { command: {} } } }, input: { command, cwd }, name: "Claude Code command", why: "Claude Code runs this command in the session if you allow it", ...(command ? {} : { shown: "Claude Code asks to run a command it does not name" }) };
  }
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(toolName)) {
    const file = String(i.file_path ?? i.notebook_path ?? "");
    const edits: Json[] = toolName === "MultiEdit" && Array.isArray(i.edits) ? i.edits : toolName === "Edit" ? [i] : [];
    const body = edits.length
      ? edits.map((e) => `- ${String(e?.old_string ?? "").split("\n").join("\n- ")}\n+ ${String(e?.new_string ?? "").split("\n").join("\n+ ")}`).join("\n\n")
      : typeof i.content === "string" ? i.content : typeof i.new_source === "string" ? i.new_source : "";
    return { tool: { name: "Claude Code file change", kind: "edit" }, input: { file_path: file }, name: "Claude Code file change", why: "Claude Code writes this change if you allow it", shown: clip(`${file}\n${body}`.trim(), 8000) };
  }
  return { tool: { name: `Claude Code ${toolName}` }, input: i, name: `Claude Code ${toolName}`, why: `Claude Code runs its ${toolName} tool if you allow it`, shown: clip(`${toolName} ${JSON.stringify(i)}`, 4000) };
}

// AskUserQuestion's questions as Keel's question card, each by its place; and the owner's answers as the
// tool's input wants them: the question's text to the label picked (several joined with ", "), or the words
// typed for Other (D: user-input docs; SDK types AskUserQuestionInput.answers).
export type ClaudeQuestion = { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean };
export function questionsOf(input: Json): ClaudeQuestion[] {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  return qs.map((q: Json) => ({
    question: String(q?.question ?? ""),
    header: typeof q?.header === "string" && q.header ? q.header : undefined,
    options: (Array.isArray(q?.options) ? q.options : []).map((o: Json) => ({ label: String(o?.label ?? ""), description: typeof o?.description === "string" && o.description ? o.description : undefined })),
    multiSelect: q?.multiSelect === true || undefined,
  })).filter((q: ClaudeQuestion) => q.question);
}
export function answersOf(qs: ClaudeQuestion[], reply: Record<string, { picked: string[]; other?: string; skipped?: true }>): Record<string, string> {
  const out: Record<string, string> = {};
  qs.forEach((q, i) => {
    const a = reply[String(i)];
    if (!a || a.skipped) return;
    const words = [...a.picked, ...(a.other ? [a.other] : [])].filter(Boolean);
    if (words.length) out[q.question] = words.join(", ");
  });
  return out;
}

// Keel's mode an approved plan goes on in, as Claude Code's: never its bypass.
const PLAN_MODES: Record<string, string> = { ask: "default", "auto-edits": "acceptEdits", auto: "auto" };
export const planMode = (keel: string): { mode: string; note?: string } =>
  PLAN_MODES[keel] ? { mode: PLAN_MODES[keel]! } : { mode: "default", note: `Claude Code goes on asking for each call: Keel's ${keel} mode has no Claude Code mode it would turn on` };

// The session id a transcript's file is named by.
export const idOfPath = (path: string) => basename(path, ".jsonl");
