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
  // (A context suffix, `[1m]`, is Claude Code's own and names no route.)
  model = model?.replace(/\[[^\]]*\]$/, "");
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
// What the daemon's own environment carries that is no part of the owner's terminal: Keel's model default, the
// marks of a Claude Code that started the daemon (which session, job, host, bridge or remote it runs as: a child
// would take that session's place), Claude Code's folder (set only as the mirror reads it), and Node options the
// SDK clears too. (C: the names Claude Code 2.1.332 reads for these.)
const NOT_THE_TERMINALS = new RegExp("^(" + [
  "ANTHROPIC_DEFAULT_MODEL", "NODE_OPTIONS", "CLAUDECODE", "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_(ENTRYPOINT|SSE_PORT|AGENT|FORCE_SESSION_PERSISTENCE|TMUX_SESSION|CHILD_SESSION|CHILD_\\w+|SESSION_\\w+|SESSIONS_\\w+|REMOTE\\w*|BRIDGE_\\w+|HOST_\\w+|WORKER_\\w+|MESSAGING_\\w+)",
  "CLAUDE_(JOB_DIR|BG_\\w+|BRIDGE_\\w+|SESSION_\\w+|AGENT_SDK_\\w+)",
].join("|") + ")$");

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

// A record of the session's own thread: a subagent's (a sidechain) has its own folder, model and mode.
const main = (r: Json) => !!r && typeof r === "object" && !r.isSidechain;
export const modelOf = (r: Json): string | undefined => (main(r) && r.type === "assistant" && typeof r.message?.model === "string" && r.message.model && r.message.model !== "<synthetic>" ? r.message.model : undefined);

// The folder name Claude Code keeps a project's transcripts under: the path with every character but a letter or a
// digit as "-", a long one cut at 200 and a hash of the path added (C: 2.1.332's project folder name).
const SLUG_MAX = 200;
export function namesFolder(cwd: string, folder: string): boolean {
  const s = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return s.length <= SLUG_MAX ? s === folder : folder.startsWith(`${s.slice(0, SLUG_MAX)}-`);
}
// The session's project folder: the first folder its records name that its transcript's folder is named after (where
// it was started; a shell that moved writes another cwd later). Never the folder it last stood in.
export function projectOf(records: Json[], folder: string): string | undefined {
  for (const r of records) if (main(r) && typeof r.cwd === "string" && r.cwd && namesFolder(r.cwd, folder)) return r.cwd;
  return undefined;
}

// Claude Code's window for a model with no context suffix: a request over it ran with `[1m]` (D: model
// configuration docs, the `[1m]` suffix for the 1M window).
export const BASE_WINDOW = 200_000;
// What the transcript's records say from its end back: the model of the last reply and the context it was sent, the
// mode of the last user record that names one (none: default), and whether its last turn is open (a prompt or a tool
// result with no reply after it, or a reply that called a tool).
export class Back {
  model?: string;
  context?: number;
  mode?: string;
  open?: boolean;
  private seen = { model: false, mode: false, last: false };
  // Takes the next record back; true once it knows all three.
  take(r: Json): boolean {
    if (!main(r)) return this.done();
    if (!this.seen.model && modelOf(r)) {
      this.seen.model = true;
      this.model = modelOf(r);
      const u = r.message?.usage;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      if (u && typeof u === "object") this.context = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
    }
    if (!this.seen.mode && r.type === "user" && typeof r.permissionMode === "string" && r.permissionMode) { this.seen.mode = true; this.mode = r.permissionMode; }
    if (!this.seen.last && (r.type === "assistant" || (r.type === "user" && !r.isMeta && !r.isCompactSummary))) {
      this.seen.last = true;
      this.open = r.type === "assistant" ? r.message?.stop_reason === "tool_use" : !INTERRUPTED.test(promptText(r)?.trim() ?? "");
    }
    return this.done();
  }
  private done() { return this.seen.model && this.seen.mode && this.seen.last; }
  // The model the child is started with: the session's, with the 1M window when its last request was over the base.
  modelArg(): string | undefined { return this.model && (this.context ?? 0) > BASE_WINDOW && !/\[[^\]]*\]$/.test(this.model) ? `${this.model}[1m]` : this.model; }
}

// The route's own switch or address in the environment Claude Code will have (the daemon's, and the `env` of
// Claude Code's user settings, which it applies itself): a Bedrock, Vertex or gateway session goes on only there.
const truthy = (v?: string) => !!v && /^(1|true|yes|on)$/i.test(v.trim());
export function routeMissing(route: ClaudeRoute | undefined, env: Record<string, string | undefined>): string | undefined {
  if (route === "bedrock" && !truthy(env.CLAUDE_CODE_USE_BEDROCK)) return "it ran on Amazon Bedrock, and CLAUDE_CODE_USE_BEDROCK is not set here";
  if (route === "vertex" && !truthy(env.CLAUDE_CODE_USE_VERTEX)) return "it ran on Google Vertex, and CLAUDE_CODE_USE_VERTEX is not set here";
  if (route === "gateway" && !env.ANTHROPIC_BASE_URL?.trim()) return "it ran through a gateway, and ANTHROPIC_BASE_URL is not set here";
  return undefined;
}

// Whether Claude Code's own trust record covers a folder: `projects[<path>].hasTrustDialogAccepted` in its global
// config for the folder or a folder above it, not above the git repository it is in (C: 2.1.332's trust check). A
// print run asks nothing: an untrusted folder's settings, hooks and MCP servers would load unasked.
export function trusted(config: Json, cwd: string, repoRoot?: string): boolean {
  const projects = config && typeof config === "object" ? config.projects : undefined;
  if (!projects || typeof projects !== "object") return false;
  for (let p = cwd.replace(/\/+$/, "") || "/"; ; ) {
    if (projects[p]?.hasTrustDialogAccepted === true) return true;
    if (p === repoRoot || p === "/") return false;
    const up = p.slice(0, p.lastIndexOf("/")) || "/";
    if (up === p) return false;
    p = up;
  }
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

// What a call Claude Code asks about is, for the gate's one-call card: a command, a file change, or another tool. The
// card holds the whole input the allow answers (the gate cuts what it shows and says it did).
export type CardOf = { tool: { name: string; kind?: "shell" | "edit"; input_schema?: Json }; input: Json; name: string; why: string; shown?: string };
const COMMAND_KEYS = new Set(["command", "description", "timeout"]);
export function cardOf(toolName: string, input: Json, cwd: string): CardOf {
  const i = input && typeof input === "object" ? input : {};
  if (toolName === "Bash" || toolName === "PowerShell") {
    const command = typeof i.command === "string" ? i.command : "";
    // What else the call asks for (to run in the background, outside Claude Code's sandbox) is said with it.
    const more = Object.keys(i).filter((k) => !COMMAND_KEYS.has(k)).map((k) => `${k}: ${JSON.stringify(i[k])}`);
    const shown = !command.trim() ? "Claude Code asks to run a command it does not name" : more.length ? `${command}\nClaude Code also asks for ${more.join(", ")}` : undefined;
    return { tool: { name: "Claude Code command", kind: "shell", input_schema: { properties: { command: {} } } }, input: { command, cwd }, name: "Claude Code command", why: "Claude Code runs this command in the session if you allow it", ...(shown ? { shown } : {}) };
  }
  const file = typeof i.file_path === "string" ? i.file_path : typeof i.notebook_path === "string" ? i.notebook_path : "";
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(toolName) && file.trim()) {
    // A MultiEdit's replacements as one text of what goes and what comes (the card reads the others' own fields).
    const edits: Json[] = toolName === "MultiEdit" && Array.isArray(i.edits) ? i.edits : [];
    const patch = edits.length ? edits.map((e) => `- ${String(e?.old_string ?? "").split("\n").join("\n- ")}\n+ ${String(e?.new_string ?? "").split("\n").join("\n+ ")}`).join("\n\n") : undefined;
    return { tool: { name: "Claude Code file change", kind: "edit" }, input: { ...i, file_path: file, ...(patch !== undefined ? { patch } : {}) }, name: "Claude Code file change", why: "Claude Code writes this change if you allow it" };
  }
  // Another tool, and a file change that names no file: its input as it is.
  return { tool: { name: `Claude Code ${toolName}` }, input: i, name: `Claude Code ${toolName}`, why: `Claude Code runs its ${toolName} tool if you allow it` };
}

// AskUserQuestion's questions as Keel's question card, each by its place; and the owner's answers as the
// tool's input wants them: the question's text to the label picked (several joined with ", "), or the words
// typed for Other (D: user-input docs; SDK types AskUserQuestionInput.answers).
export type ClaudeQuestion = { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean };
// Undefined when the input is not questions Keel can show whole: none, one with no words, or an option with no label
// (Claude Code is told so, never shown part of what it asked).
export function questionsOf(input: Json): ClaudeQuestion[] | undefined {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  if (!qs.length) return undefined;
  const out: ClaudeQuestion[] = [];
  for (const q of qs) {
    const options = Array.isArray(q?.options) ? q.options : undefined;
    if (typeof q?.question !== "string" || !q.question.trim() || !options || options.some((o: Json) => typeof o?.label !== "string" || !o.label.trim())) return undefined;
    out.push({
      question: q.question,
      header: typeof q.header === "string" && q.header ? q.header : undefined,
      options: options.map((o: Json) => ({ label: o.label, description: typeof o.description === "string" && o.description ? o.description : undefined })),
      multiSelect: q.multiSelect === true || undefined,
    });
  }
  return out;
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
