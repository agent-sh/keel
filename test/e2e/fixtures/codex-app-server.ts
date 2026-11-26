#!/usr/bin/env bun
// A stand-in for `codex app-server` over stdio, for the in-place answer of a
// Codex session (src/integrations/outside/codex-app.ts): it speaks the part
// of the protocol Keel uses (initialize, thread/resume, turn/start,
// turn/steer, turn/interrupt, thread/unsubscribe), finds the thread's rollout
// under $CODEX_HOME/sessions and writes to it what Codex writes for a turn,
// and asks the client what Codex asks. No model: the prompt says what it does.
//   - "ask me ...": one question with two choices, then a reply naming the pick.
//   - "wait ...": works until turn/interrupt, then the turn is interrupted.
//   - "stuck ...": a Codex that stops answering mid-turn: no reply to any request
//     after it, its input's end and SIGTERM ignored (only SIGKILL ends it).
//   - "form ...": its MCP server asks for a form (an elicitation), then a reply
//     naming what the client answered.
//   - "edit ...": a file change it asks to make (a.ts in its folder), then a
//     reply naming the decision.
//   - "wipe ...": a command it asks to run that deletes the home folder (rm -rf ~),
//     then a reply naming the decision.
//   - anything else: a command it asks to run (make test), then a reply naming
//     the decision.
// Every request it got is appended to <rollout>.standin.log, one JSON line each. A resume takes the thread's
// writer lock where $CODEX_HOME keeps them, as Codex does, and refuses a thread another process writes.
// With a file $CODEX_HOME/standin-helpers, it starts what a real Codex starts under it that is not Keel's to end:
// at its start a detached helper (as an MCP server leaves), and in each turn a background job (as a command of
// the turn puts in the background), each in a session of its own; their pids are appended to that file.
//   bun codex-app-server.ts app-server
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readdirSync } from "node:fs";
import { join } from "node:path";

const home = process.env.CODEX_HOME ?? "";
let rollout = "";
let thread = "";
let nextId = 1000;
const waits = new Map<number, (r: any) => void>();
let turn: { id: string; stop?: () => void; stopped?: boolean } | undefined;
let deaf = false;
process.on("SIGTERM", () => { if (!deaf) process.exit(0); });
const helpers = join(home, "standin-helpers");
const leave = (what: string) => {
  if (!existsSync(helpers)) return;
  // (Its arguments hold app-server, as a job of the turn's can: Keel tells its own by the lock, never by them.)
  const p = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)", "app-server"], { detached: true, stdio: "ignore" });
  p.unref();
  appendFileSync(helpers, `${what} ${p.pid}\n`);
};
leave("helper");

const out = (m: object) => process.stdout.write(JSON.stringify(m) + "\n");
const note = (method: string, params: object) => out({ method, params });
const ask = (method: string, params: object) => new Promise<any>((ok) => { const id = nextId++; waits.set(id, ok); out({ id, method, params }); });
const record = (type: string, payload: object) => appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// flock(2) on $CODEX_HOME/thread-writer-locks/<thread>.lock, where that folder is (a Codex that keeps locks).
// The descriptor stays open: the lock goes when this process does.
let lockFd: number | undefined;
function holdLock(id: string): boolean {
  const dir = join(home, "thread-writer-locks");
  if (lockFd !== undefined || !existsSync(dir)) return true;
  try {
    const { dlopen, FFIType } = require("bun:ffi");
    const libc = dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    const fd = openSync(join(dir, `${id}.lock`), "a");
    // LOCK_EX | LOCK_NB
    if (libc.symbols.flock(fd, 2 | 4) !== 0) { closeSync(fd); return false; }
    lockFd = fd;
  } catch {}
  return true;
}

function find(dir: string, id: string): string | undefined {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return undefined; }
  for (const n of names) {
    const p = join(dir, n);
    if (n.endsWith(`${id}.jsonl`)) return p;
    if (!n.includes(".")) { const f = find(p, id); if (f) return f; }
  }
  return undefined;
}

async function reply(turnId: string, item: string, text: string) {
  for (const w of text.split(/(?<= )/)) { note("item/agentMessage/delta", { threadId: thread, turnId, itemId: item, delta: w }); await sleep(30); }
  record("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
  record("event_msg", { type: "agent_message", message: text });
}

function finish(turnId: string, status: "completed" | "interrupted") {
  record("event_msg", status === "completed" ? { type: "task_complete", turn_id: turnId } : { type: "turn_aborted", turn_id: turnId, reason: "interrupted" });
  turn = undefined;
  note("turn/completed", { threadId: thread, turn: { id: turnId, items: [], status, error: null } });
}

async function run(turnId: string, text: string) {
  note("turn/started", { threadId: thread, turn: { id: turnId, items: [], status: "inProgress", error: null } });
  record("event_msg", { type: "task_started", turn_id: turnId });
  record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
  record("event_msg", { type: "user_message", message: text });
  leave("job");
  await sleep(100);
  if (/^stuck\b/i.test(text)) {
    deaf = true;
    // It lives on past its pipes too: a reader that went (a launcher killed above it) ends nothing.
    setInterval(() => {}, 1 << 30);
    process.stdout.on("error", () => {});
    await reply(turnId, "m1", "Stuck.");
    return;
  }
  if (/^wait\b/i.test(text)) {
    await reply(turnId, "m1", "Working on it.");
    // (An interrupt that came before this point stops it at once.)
    await new Promise<void>((ok) => { if (turn!.stopped) ok(); else turn!.stop = ok; });
    return finish(turnId, "interrupted");
  }
  if (/^ask me\b/i.test(text)) {
    const r = await ask("item/tool/requestUserInput", { threadId: thread, turnId, itemId: "q1", isBlocking: true, autoResolutionMs: null, questions: [{ id: "color", header: "Color", question: "Which color should the button be?", isOther: true, isSecret: false, options: [{ label: "Blue", description: "The brand color" }, { label: "Green", description: "" }] }] });
    const picked = r?.answers?.color?.answers?.join(", ") || "nothing";
    await reply(turnId, "m2", `You picked ${picked}.`);
    return finish(turnId, "completed");
  }
  if (/^form\b/i.test(text)) {
    const r = await ask("mcpServer/elicitation/request", { threadId: thread, turnId, serverName: "tickets", environmentId: null, mode: "form", _meta: null, message: "Which project?", requestedSchema: { type: "object", properties: { project: { type: "string" } } } });
    await reply(turnId, "m5", `The form came back as ${r?.action ?? "no answer"}.`);
    return finish(turnId, "completed");
  }
  if (/^edit\b/i.test(text)) {
    const changes = [{ path: join(process.cwd(), "a.ts"), kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;" }];
    note("item/started", { threadId: thread, turnId, item: { type: "fileChange", id: "f1", changes, status: "inProgress" } });
    const r = await ask("item/fileChange/requestApproval", { threadId: thread, turnId, itemId: "f1", startedAtMs: Date.now(), reason: "It fixes the constant", grantRoot: null });
    const decision = typeof r?.decision === "string" ? r.decision : "decline";
    if (decision === "cancel") return finish(turnId, "interrupted");
    await reply(turnId, "m4", `The change was ${decision === "accept" ? "allowed" : "declined"}: ${text}`);
    return finish(turnId, "completed");
  }
  const wipe = /^wipe\b/i.test(text);
  const command = wipe ? "rm -rf ~" : "make test";
  const item = wipe ? "c2" : "c1";
  await reply(turnId, "m1", wipe ? "Clearing it out." : "Running the tests first.");
  note("item/started", { threadId: thread, turnId, item: { type: "commandExecution", id: item, command, cwd: process.cwd(), status: "inProgress" } });
  const r = await ask("item/commandExecution/requestApproval", { kind: "command", threadId: thread, turnId, itemId: item, startedAtMs: Date.now(), environmentId: null, reason: wipe ? "It clears the home folder" : "It runs the project's tests", command, cwd: process.cwd() });
  const decision = typeof r?.decision === "string" ? r.decision : "decline";
  record("response_item", { type: "function_call", name: "shell", arguments: JSON.stringify({ command: command.split(" ") }), call_id: item });
  record("response_item", { type: "function_call_output", call_id: item, output: decision === "accept" ? "ok" : "the owner declined" });
  if (decision === "cancel") return finish(turnId, "interrupted");
  await reply(turnId, "m3", `The command was ${decision === "accept" ? "allowed" : "declined"}: ${text}`);
  finish(turnId, "completed");
}

async function handle(m: any) {
  if (deaf) return;
  if (m.id !== undefined && !m.method) { waits.get(m.id)?.(m.result); waits.delete(m.id); return; }
  if (m.id === undefined) return;
  if (rollout) appendFileSync(`${rollout}.standin.log`, JSON.stringify({ method: m.method, params: m.params }) + "\n");
  const ok = (result: unknown) => out({ id: m.id, result });
  const fail = (code: number, message: string) => out({ id: m.id, error: { code, message } });
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize": return ok({ userAgent: "codex-standin/0.0.0", codexHome: home, platformFamily: "unix", platformOs: "linux" });
    case "thread/resume": {
      const f = find(join(home, "sessions"), String(p.threadId));
      if (!f) return fail(-32600, `no rollout found for thread id ${p.threadId}`);
      // The thread's writer lock, as Codex 0.172 takes it: held while this process lives; a second writer is refused.
      if (!holdLock(String(p.threadId))) return fail(-32600, `thread ${p.threadId} already has an active writer`);
      rollout = f;
      thread = String(p.threadId);
      appendFileSync(`${rollout}.standin.log`, JSON.stringify({ method: m.method, params: p }) + "\n");
      return ok({ thread: { id: thread, path: f }, model: "standin", modelProvider: p.modelProvider ?? "openai", cwd: p.cwd ?? process.cwd(), approvalPolicy: p.approvalPolicy ?? "on-request", sandbox: { type: p.sandbox ?? "workspace-write" }, reasoningEffort: null });
    }
    case "turn/start": {
      if (!rollout) return fail(-32600, "no thread");
      const text = String(p.input?.[0]?.text ?? "");
      const id = `turn-${Date.now()}`;
      turn = { id };
      ok({ turn: { id, items: [], status: "inProgress", error: null } });
      return void run(id, text);
    }
    case "turn/steer": {
      if (!turn || p.expectedTurnId !== turn.id) return fail(-32600, "no active turn to steer");
      const text = String(p.input?.[0]?.text ?? "");
      record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
      record("event_msg", { type: "user_message", message: text });
      return ok({ turnId: turn.id });
    }
    case "turn/interrupt": {
      if (turn) turn.stopped = true;
      turn?.stop?.();
      return ok({});
    }
    case "thread/unsubscribe": return ok({ status: "unsubscribed" });
    default: return fail(-32601, `method not found: ${m.method}`);
  }
}

let rest = "";
process.stdin.on("data", (c) => {
  rest += c.toString();
  const lines = rest.split("\n");
  rest = lines.pop() ?? "";
  for (const l of lines) if (l.trim()) void handle(JSON.parse(l));
});
process.stdin.on("end", () => { if (!deaf) process.exit(0); });
