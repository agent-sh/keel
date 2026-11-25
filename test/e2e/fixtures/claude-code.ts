#!/usr/bin/env bun
// A stand-in for the owner's `claude` in print mode, for the in-place answer of
// a Claude Code session (src/integrations/outside/claude-code.ts). It speaks the
// part of the stream-json wire Keel uses, in the shapes the Agent SDK's types
// and Claude Code's own code give (src/integrations/outside/claude-wire.ts):
// control_request initialize and interrupt answered by control_response, user
// messages on stdin, stream_event deltas, can_use_tool asked of the host and
// its answer read back, a result per turn naming the messages it answered. It
// finds the session's transcript under $CLAUDE_CONFIG_DIR by its id, appends
// what Claude Code writes for a turn, and with KEEL_STANDIN_RECORD=1 keeps a
// record of itself in $CLAUDE_CONFIG_DIR/sessions/<pid>.json while it runs, as
// an interactive Claude Code does (whether a print run keeps one is not known;
// off by default, since a folder with records tells the mirror that a session
// with none has ended, which would change what later specs see).
// No model: the prompt says what it does.
//   - "ask me ...": AskUserQuestion with one question, then a reply naming the answer.
//   - "plan ...": ExitPlanMode with a plan, then a reply naming the decision.
//   - "wait ...": works until an interrupt, then the turn ends interrupted.
//   - "edit ...": an Edit of a.ts in its folder, then a reply naming the decision.
//   - anything else: Bash `make test`, then a reply naming the decision.
// It refuses to run without --permission-prompt-tool stdio, stream-json both ways
// and --resume. What it was started with (its arguments and the names of the
// route variables in its environment, never a value) and every line it read go to
// <transcript>.standin.log.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const config = process.env.CLAUDE_CONFIG_DIR ?? "";
const id = flag("--resume") ?? "";
const model = flag("--model") ?? "claude-standin";
let mode = flag("--permission-mode") ?? "default";
const out = (m: object) => process.stdout.write(JSON.stringify(m) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function find(dir: string, depth = 0): string | undefined {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return undefined; }
  for (const n of names) if (n === `${id}.jsonl`) return join(dir, n);
  if (depth < 3) for (const n of names) if (!n.includes(".") && n !== "sessions") { const f = find(join(dir, n), depth + 1); if (f) return f; }
  return undefined;
}
const transcript = id ? find(config) : undefined;
const log = (m: object) => { if (transcript) appendFileSync(`${transcript}.standin.log`, JSON.stringify(m) + "\n"); };
const needs = ["--permission-prompt-tool", "--input-format", "--output-format"].every((f) => flag(f)) && flag("--permission-prompt-tool") === "stdio" && flag("--input-format") === "stream-json" && flag("--output-format") === "stream-json";
if (!transcript || !needs || !args.includes("-p")) {
  out({ type: "result", subtype: "error_during_execution", is_error: true, errors: [transcript ? "the stand-in needs -p, stream-json both ways and --permission-prompt-tool stdio" : `No conversation found with session ID: ${id}`], session_id: id, uuid: crypto.randomUUID() });
  process.exit(1);
}
const routeVars = Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_USE_|AWS_BEARER_TOKEN_BEDROCK|CLAUDECODE$)/.test(k)).sort();
log({ argv: args, env: routeVars, cwd: process.cwd() });

const cwd = process.cwd();
let parent: string | null = null;
try {
  const lines = readFileSync(transcript, "utf8").trim().split("\n");
  parent = JSON.parse(lines.at(-1) ?? "{}").uuid ?? null;
} catch {}
const record = (r: object) => {
  const uuid = (r as any).uuid ?? crypto.randomUUID();
  appendFileSync(transcript, JSON.stringify({ parentUuid: parent, isSidechain: false, userType: "external", cwd, sessionId: id, version: "2.1.999", entrypoint: "sdk-cli", timestamp: new Date().toISOString(), ...r, uuid }) + "\n");
  parent = uuid;
};

// Its own record, as Claude Code keeps one for a running session.
const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
const procStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
const own = join(config, "sessions", `${process.pid}.json`);
const keeps = process.env.KEEL_STANDIN_RECORD === "1";
if (keeps) mkdirSync(join(config, "sessions"), { recursive: true });
const status = (s: string) => { if (keeps) writeFileSync(own, JSON.stringify({ pid: process.pid, sessionId: id, cwd, startedAt: Date.now(), procStart, kind: "interactive", entrypoint: "sdk-cli", status: s })); };
status("idle");
const bye = (code = 0) => { if (keeps) try { rmSync(own, { force: true }); } catch {} process.exit(code); };
process.on("SIGTERM", () => bye(0));

const waits = new Map<string, (r: any) => void>();
const ask = (request: object) => new Promise<any>((ok) => { const rid = crypto.randomUUID(); waits.set(rid, ok); out({ type: "control_request", request_id: rid, request }); });
let turn: { uuids: string[]; stop?: () => void; stopped?: boolean } | undefined;
const queue: any[] = [];

async function reply(text: string) {
  const mid = `msg_${crypto.randomUUID().slice(0, 8)}`;
  const ev = (event: object) => out({ type: "stream_event", event, parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: id });
  ev({ type: "message_start", message: { id: mid, type: "message", role: "assistant", model, content: [] } });
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const w of text.split(/(?<= )/)) { ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: w } }); await sleep(25); }
  ev({ type: "content_block_stop", index: 0 });
  ev({ type: "message_stop" });
  const message = { id: mid, type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } };
  record({ type: "assistant", message });
  out({ type: "assistant", message, parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: id });
}

async function toolCall(name: string, input: any): Promise<any> {
  const tid = `toolu_${crypto.randomUUID().slice(0, 8)}`;
  record({ type: "assistant", message: { id: `msg_${tid}`, role: "assistant", model, content: [{ type: "tool_use", id: tid, name, input }], stop_reason: "tool_use" } });
  status("waiting");
  const r = await ask({ subtype: "can_use_tool", tool_name: name, display_name: name, input, tool_use_id: tid, description: name === "Bash" ? "Run the tests" : undefined, decision_reason: name === "Bash" ? "It runs the project's tests" : undefined });
  status("busy");
  const allowed = r?.behavior === "allow";
  record({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: allowed ? "ok" : String(r?.message ?? "denied"), is_error: !allowed }] } });
  return r;
}

function finish(error = false) {
  const t = turn!;
  turn = undefined;
  status("idle");
  out({ type: "result", subtype: error ? "error_during_execution" : "success", is_error: error, num_turns: 1, result: "", session_id: id, uuid: crypto.randomUUID(), user_message_uuids: t.uuids, ...(error ? { errors: ["interrupted"] } : {}) });
  const next = queue.shift();
  if (next) void run(next);
}

async function run(m: any) {
  const content = m.message?.content;
  const text = typeof content === "string" ? content : (content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
  turn = { uuids: [m.uuid] };
  status("busy");
  record({ type: "user", uuid: m.uuid, message: { role: "user", content: text }, permissionMode: mode, promptSource: "sdk" });
  await sleep(80);
  if (/^wait\b/i.test(text)) {
    await reply("Working on it.");
    await new Promise<void>((ok) => { if (turn!.stopped) ok(); else turn!.stop = ok; });
    record({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    return finish(true);
  }
  if (/^ask me\b/i.test(text)) {
    const questions = [{ question: "Which color should the button be?", header: "Color", multiSelect: false, options: [{ label: "Blue", description: "The brand color" }, { label: "Green", description: "Calm" }] }];
    const r = await toolCall("AskUserQuestion", { questions });
    const picked = r?.behavior === "allow" ? r.updatedInput?.answers?.["Which color should the button be?"] ?? "nothing" : "nothing";
    await reply(`You picked ${picked}.`);
    return finish();
  }
  if (/^plan\b/i.test(text)) {
    const r = await toolCall("ExitPlanMode", { plan: "1. Rename the loader\n2. Run the tests" });
    const set = r?.updatedPermissions?.find((p: any) => p?.type === "setMode");
    if (set) mode = set.mode;
    await reply(r?.behavior === "allow" ? `The plan was approved; going on in ${mode} mode.` : `The plan was sent back: ${r?.message ?? ""}`);
    return finish();
  }
  if (/^edit\b/i.test(text)) {
    const r = await toolCall("Edit", { file_path: join(cwd, "a.ts"), old_string: "const a = 1;", new_string: "const a = 2;" });
    await reply(`The change was ${r?.behavior === "allow" ? "allowed" : "declined"}: ${text}`);
    return finish();
  }
  await reply("Running the tests first.");
  const r = await toolCall("Bash", { command: "make test", description: "Run the tests" });
  await reply(`The command was ${r?.behavior === "allow" ? "allowed" : "declined"}: ${text}`);
  finish();
}

let rest = "";
process.stdin.on("data", (c) => {
  rest += c.toString();
  const lines = rest.split("\n");
  rest = lines.pop() ?? "";
  for (const l of lines) {
    if (!l.trim()) continue;
    const m = JSON.parse(l);
    log({ in: m.type, ...(m.type === "control_request" ? { subtype: m.request?.subtype } : {}), ...(m.type === "control_response" ? { response: m.response?.response } : {}), ...(m.type === "user" ? { uuid: m.uuid, content: m.message?.content } : {}) });
    if (m.type === "control_response") { const w = waits.get(m.response?.request_id); waits.delete(m.response?.request_id); w?.(m.response?.response); continue; }
    if (m.type === "control_request") {
      const ok = (response: object = {}) => out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
      if (m.request?.subtype === "initialize") {
        ok({ commands: [], models: [], account: {}, pending_permission_requests: [] });
        out({ type: "system", subtype: "init", session_id: id, model, permissionMode: mode, cwd, tools: [], mcp_servers: [], slash_commands: [], skills: [], plugins: [], apiKeySource: "none", claude_code_version: "2.1.999", output_style: "default", uuid: crypto.randomUUID() });
      } else if (m.request?.subtype === "interrupt") {
        if (turn) { turn.stopped = true; turn.stop?.(); }
        ok({ still_queued: [] });
      } else out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: `unknown ${m.request?.subtype}` } });
      continue;
    }
    if (m.type === "user") {
      if (turn) { queue.push(m); continue; }
      void run(m);
    }
  }
});
process.stdin.on("end", async () => {
  while (turn || queue.length) await sleep(20);
  bye(0);
});
