// Code mode: the model writes one JavaScript program that calls its other
// tools as functions, and only what the program prints or returns comes back
// into the context. The intermediate results stay in the program.
//
// The program runs in a Bun child process (this binary acting as bun), started
// through the session's confinement like a shell command of the session. Its
// tool calls come back over Bun's IPC channel and each one runs as a call of
// its own (ctx.callTool): the permission gate, the hooks, the dispatcher. A
// refused or failed call throws ToolError inside the program.
//
// Sources (read 2026-11-19): Claude Code's Code Mode (JavaScript; each call the
// code makes meets the deny and ask rules and the PreToolUse hooks under the
// tool's own name), Codex's `exec` (JavaScript in a fresh isolate, nested tools
// on a global `tools` object, output only what the code emits), Anthropic's
// programmatic tool calling (async functions taking one input, returning the
// result text; not on Bedrock) and Cloudflare's Code Mode (tools as a typed
// API, results by console.log).
import type { ToolResultBlock } from "../core/types.ts";
import { logDir, shq } from "./shell.ts";
import { codeJob, endCodeJob, sessionScope, toolEnv, UNREAD_CAP, type Job } from "./jobs.ts";
import { spill } from "./spill.ts";
import { fail, ok, type Tool, type ToolContext, type ToolOutput } from "./types.ts";
import { appendFileSync } from "node:fs";
import { pump } from "../core/proc.ts";
import { begin } from "../admin/activity.ts";

export const RUN_CODE = "run_code";

// What the program printed, its own output streams and its error are each held
// to the head a running command's unread output keeps; the result the model
// gets is bounded again by spill().
const KEPT = UNREAD_CAP;
// How long after a program's exit its output streams are still read to their end.
const STREAMS_GRACE_MS = 500;

// The program's side. Runs as `bun -e`; the program's source is the first IPC
// message. console output is collected (not written to a stream), so nothing the
// program or its commands print reaches the channel.
const PRELUDE = `
const KEPT = ${KEPT};
const enc = new TextEncoder();
let printed = "", held = 0, dropped = 0;
const keep = (s) => {
  const b = enc.encode(s);
  const take = Math.max(0, Math.min(b.length, KEPT - held));
  if (take === b.length) printed += s;
  else if (take > 0) printed += new TextDecoder().decode(b.subarray(0, take)).replace(/\\uFFFD$/, "");
  held += take;
  dropped += b.length - take;
  if (liveAt >= 0) liveTimer ??= setTimeout(flush, 250);
};
const show = (v) => typeof v === "string" ? v : Bun.inspect(v, { depth: 6 });
const log = (...a) => keep(a.map(show).join(" ") + "\\n");
console.log = console.info = console.debug = console.warn = console.error = console.trace = log;
globalThis.print = log;
class ToolError extends Error { constructor(m) { super(m); this.name = "ToolError"; } }
globalThis.ToolError = ToolError;
const pending = new Map();
let seq = 0;
const call = (tool, input) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  process.send({ call: id, tool: String(tool), input: input ?? {} });
});
globalThis.tools = new Proxy({}, {
  get(_, name) {
    if (typeof name !== "string" || name === "then") return undefined;
    if (name === "call") return call;
    return (input) => call(name, input);
  },
});
// The daemon went away (a restart, a crash): nothing reads this program's calls or its end any more.
process.on("disconnect", () => process.exit(143));
process.on("unhandledRejection", (e) => keep("[unhandled rejection] " + show(e?.stack ?? e) + "\\n"));
// Once the program goes on in the background, what it prints reaches the daemon as it prints (the job's log
// shows it live): from the character the call's result stopped at, at most four times a second.
let liveAt = -1, liveTimer = null;
const flush = () => {
  liveTimer = null;
  if (liveAt < 0 || printed.length <= liveAt) return;
  process.send({ print: printed.slice(liveAt), from: liveAt, to: printed.length });
  liveAt = printed.length;
};
const finish = (error) => { clearTimeout(liveTimer); flush(); process.send({ done: true, printed, dropped, error }); };
process.on("message", async (m) => {
  if (m?.snap) { process.send({ snap: true, printed, dropped }); return; }
  if (typeof m?.live === "number") { liveAt = m.live; liveTimer ??= setTimeout(flush, 250); return; }
  if (typeof m?.code === "string") {
    let error = null;
    try {
      const AsyncFunction = (async () => {}).constructor;
      const fn = new AsyncFunction("tools", "ToolError", "require", m.code);
      const r = await fn(globalThis.tools, ToolError, require);
      if (r !== undefined) keep(show(r) + "\\n");
    } catch (e) {
      error = e instanceof Error ? (e.name + ": " + e.message) : "Thrown: " + show(e);
      if (error.length > KEPT) error = error.slice(0, KEPT) + " [cut]";
    }
    finish(error);
    return;
  }
  const p = pending.get(m?.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m.output); else p.reject(new ToolError(m.output));
});
`;

// The shell command a program is judged as: what running it directly would be.
export const asShellCommand = (code: string) => `bun -e ${shq(code)}`;

// A nested result as the program reads it: its text (images are named, not sent).
export function resultText(r: ToolResultBlock): string {
  if (typeof r.content === "string") return r.content;
  return r.content.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
}

// One call a program made, as the owner's page shows it under the program.
export type CodeCall = { id: string; parent: string; seq: number; tool: string; input: any; result?: ToolResultBlock; started: number; ended?: number };

export type CodeRecorder = { start(sessionId: string, c: CodeCall): void; end(sessionId: string, c: CodeCall): void };

type Outcome = { printed: string; dropped: number; error: string | null; output: string; outputDropped: number; calls: number; finished: boolean; exit: number | null };
// A program that outlived its wait: the job it goes on as, and what it had printed when the call returned.
export type Moved = Outcome & { moved?: Job };

// Reads a stream, keeping its head; the rest is read and counted so the child
// never blocks on a full pipe. `text(from)` is what was kept so far, from a byte on.
function collect(stream: ReadableStream<Uint8Array> | undefined) {
  const parts: Uint8Array[] = [];
  let held = 0, dropped = 0;
  const done = stream ? pump(stream, (chunk) => {
    const take = Math.min(chunk.length, KEPT - held);
    if (take > 0) { parts.push(chunk.subarray(0, take)); held += take; }
    dropped += chunk.length - take;
  }, "run_code output") : Promise.resolve();
  return { done, held: () => held, dropped: () => dropped, text: (from = 0) => new TextDecoder().decode(Buffer.concat(parts).subarray(from)) };
}

// `waitMs`: past it the program goes on in the background (the call returns with `moved` set), unless the
// turn was stopped (then it is killed, as always). Without it the call waits for the program.
export async function runProgram(code: string, ctx: ToolContext, rec: CodeRecorder, waitMs?: number): Promise<Moved> {
  const argv = [process.execPath, "-e", PRELUDE];
  let calls = 0;
  let done: { printed: string; dropped: number; error: string | null } | null = null;
  let resolveDone!: () => void;
  const doneP = new Promise<void>((r) => (resolveDone = r));
  let snapped: ((m: { printed: string; dropped: number } | null) => void) | undefined;
  // Once the program is a job: what it printed that was appended to the job's log as it came (the character
  // the log has reached, in the program's printed text), and the log to append to.
  let live: { log: string; at: number } | undefined;
  // What a call of the program runs under: the turn's own stop, until the program goes on past its turn.
  let signal: AbortSignal | undefined;
  // In a scope of its own, as a shell command is (else in a process group and session of its own): a
  // request it makes to the daemon's API has its session's authority only (src/server/peer-scope.ts).
  const scope = sessionScope("code", ctx.wrapSpawn ? ctx.wrapSpawn(argv) : argv, ctx.sessionId);
  const proc = Bun.spawn(scope.argv, {
    cwd: ctx.cwd,
    env: toolEnv(ctx.sessionId, { BUN_BE_BUN: "1", NO_COLOR: "1", ...scope.env }),
    stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: !scope.cgroup,
    ipc(m: any) {
      if (m?.done) { done = m; resolveDone(); return; }
      if (m?.snap) { snapped?.(m); return; }
      if (typeof m?.print === "string") {
        if (live && m.from === live.at) { try { appendFileSync(live.log, m.print); live.at = m.to; } catch { /* the log is gone: the end says it all */ } }
        return;
      }
      if (typeof m?.call !== "number") return;
      const n = ++calls;
      void (async () => {
        const c: CodeCall = { id: `${ctx.callId}~${n}`, parent: ctx.callId ?? "", seq: n, tool: String(m.tool), input: m.input ?? {}, started: Date.now() };
        rec.start(ctx.sessionId, c);
        let r: ToolResultBlock;
        if (c.tool === RUN_CODE) r = { type: "tool_result", tool_use_id: c.id, is_error: true, content: "A program cannot start another program." };
        else if (!ctx.callTool) r = { type: "tool_result", tool_use_id: c.id, is_error: true, content: "Tools cannot be called from here." };
        else {
          const run = (tool: string, input: any) => ctx.callTool!(tool, input, c.id, signal).catch((e) => ({ type: "tool_result" as const, tool_use_id: c.id, is_error: true, content: `Tool failed: ${(e as Error).message}` }));
          r = await run(c.tool, c.input);
          // A catalog tool's own name (server__tool, as search_tools lists it) runs as the
          // session declares it: mcp__server__tool where tools load natively, else through mcp_call.
          if (r.is_error && typeof r.content === "string" && r.content.startsWith(`No tool named ${c.tool}.`) && c.tool.includes("__")) {
            const native = c.tool.startsWith("mcp__") ? null : `mcp__${c.tool}`;
            const viaNative = native ? await run(native, c.input) : r;
            if (native && !(typeof viaNative.content === "string" && viaNative.content.startsWith(`No tool named ${native}.`))) { c.tool = native; r = viaNative; }
            else {
              c.input = { tool: c.tool.replace(/^mcp__/, ""), arguments: c.input };
              c.tool = "mcp_call";
              r = await run(c.tool, c.input);
            }
          }
        }
        c.result = r;
        c.ended = Date.now();
        rec.end(ctx.sessionId, c);
        // A program that already ended reads no answers.
        try { proc.send({ id: m.call, ok: !r.is_error, output: resultText(r) }); } catch {}
      })();
    },
  });
  const release = scope.hold(proc.pid);
  const endCounted = begin("run_code");
  void proc.exited.then(endCounted, endCounted);
  void proc.exited.then(release, release);
  const onAbort = () => proc.kill("SIGKILL");
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  const out = collect(proc.stdout), err = collect(proc.stderr);
  const streams = Promise.all([out.done, err.done]);
  // What the program printed and its commands wrote, from the given points on.
  const outcome = (exit: number | null, from = { printed: 0, dropped: 0, out: 0, err: 0, outDropped: 0, errDropped: 0 }): Outcome => {
    const d = done as { printed: string; dropped: number; error: string | null } | null;
    const output = [out.text(from.out), err.text(from.err)].filter((t) => t.trim()).join("\n");
    return {
      printed: d?.printed.slice(from.printed) ?? "", dropped: Math.max(0, (d?.dropped ?? 0) - from.dropped), error: d?.error ?? null,
      output, outputDropped: out.dropped() - from.outDropped + err.dropped() - from.errDropped, calls, finished: !!d, exit: d ? 0 : exit,
    };
  };
  const ended = (async () => {
    await Promise.race([doneP, proc.exited]);
    // Unawaited work of a finished program is dropped with it.
    if (done) proc.kill("SIGKILL");
    const exit = await proc.exited;
    // The streams end with the program, unless a child it left behind holds them open: a program that
    // has ended is not kept running for that.
    await Promise.race([streams, Bun.sleep(STREAMS_GRACE_MS)]);
    return { exit };
  })();
  let keep = false;
  try {
    proc.send({ code });
    let timer: Timer | undefined;
    const late = waitMs === undefined ? undefined : new Promise<"late">((r) => { timer = setTimeout(() => r("late"), waitMs); });
    const first = await Promise.race([ended, late].filter((p): p is NonNullable<typeof p> => !!p));
    clearTimeout(timer);
    if (first !== "late") return outcome(first.exit);
    // The turn was stopped as the wait ran out: the program goes with it.
    if (ctx.signal.aborted) return outcome((await ended).exit);
    // Its wait is over: what it printed so far is asked of the program (one stuck in a loop of its own
    // answers nothing, and the call says what its commands wrote).
    const snap = await Promise.race([
      new Promise<{ printed: string; dropped: number } | null>((r) => { snapped = r; try { proc.send({ snap: true }); } catch { r(null); } setTimeout(() => r(null), 500); }),
      ended.then(() => null),
    ]);
    if (done || proc.exitCode !== null || proc.signalCode !== null) return outcome((await ended).exit);
    const given = { printed: snap?.printed.length ?? 0, dropped: snap?.dropped ?? 0, out: out.held(), err: err.held(), outDropped: out.dropped(), errDropped: err.dropped() };
    const sofar: Outcome = { printed: snap?.printed ?? "", dropped: snap?.dropped ?? 0, error: null, output: [out.text(), err.text()].filter((t) => t.trim()).join("\n"), outputDropped: out.dropped() + err.dropped(), calls, finished: true, exit: null };
    const first_ = code.trim().split("\n")[0]!.slice(0, 80);
    const job = codeJob({ sessionId: ctx.sessionId, command: `run_code: ${first_}`, cwd: ctx.cwd, logDir: logDir(ctx), callId: ctx.callId, proc, cgroup: scope.cgroup });
    // From here the program is the job's: the turn's stop is not its stop, and its calls stop with it.
    const own = new AbortController();
    signal = own.signal;
    ctx.signal.removeEventListener("abort", onAbort);
    keep = true;
    // What it prints from here on goes to the job's log as it comes.
    live = { log: job.log, at: given.printed };
    try { proc.send({ live: given.printed }); } catch { /* it ended: its end writes the log */ }
    void ended.then(({ exit }) => {
      const rest = outcome(exit, given);
      // The log already has what streamed: only the rest is appended (the wake carries it all).
      const streamed = live!.at > given.printed;
      const tail = outcome(exit, { ...given, printed: live!.at });
      const quiet = streamed && !tail.printed && !tail.dropped && !tail.output.trim() && !tail.error && tail.finished;
      // (A program that finished was ended by us, with a kill: that is no signal of its own.)
      const sig = rest.finished || proc.signalCode == null ? null : String(proc.signalCode);
      endCodeJob(job, { code: rest.finished ? (rest.error ? 1 : 0) : exit, signal: sig, text: `${render(rest)}\n`, log: quiet ? "" : `${render(tail)}\n` });
      if (job.stopReason) own.abort();
    }, () => {});
    return { ...sofar, moved: job };
  } finally {
    if (!keep) ctx.signal.removeEventListener("abort", onAbort);
  }
}

// The text the model gets back.
export function render(o: Outcome): string {
  const parts: string[] = [];
  const cut = (n: number, what: string) => (n > 0 ? `\n[${n} more bytes of ${what} were not kept]` : "");
  const printed = o.printed.trimEnd();
  if (printed || o.dropped) parts.push(printed + cut(o.dropped, "printed output"));
  if (o.output.trim()) parts.push(`[output of commands]\n${o.output.trimEnd()}${cut(o.outputDropped, "command output")}`);
  if (o.error) parts.push(o.error);
  if (!o.finished) parts.push(`The program ended without finishing (exit ${o.exit}).`);
  if (!parts.length) parts.push(`(the program printed nothing; ${o.calls} tool call${o.calls === 1 ? "" : "s"})`);
  return parts.join("\n\n");
}

export function runCodeTool(rec: CodeRecorder): Tool {
  return {
    name: RUN_CODE,
    description:
      "Run JavaScript (Bun) in the workspace with your other tools callable from it: `await tools.<name>(input)` (or `await tools.call(\"<name>\", input)`) takes the same input as a direct call of that tool, returns its text output, and throws `ToolError` when the call fails or is refused; a tool your tool search found is called by its listed name, `await tools[\"mcp__server__tool\"](arguments)`. " +
      "Each call goes through the same permissions as a direct call and is shown to the owner as its own call; the program itself is checked like a shell command of this session and runs in its sandbox. " +
      "The code is the body of an async function: `await` and `return` work at the top level; run independent calls together with `Promise.all`. " +
      "Only what the program prints (`console.log`) and the value it returns come back to you: the tool results it reads stay out of your context, so filter, count and summarize in code. " +
      "Use it to batch several calls into one step or to cut large results down; make single calls directly. " +
      "A program still running at its timeout (default 120000 ms, max 600000) goes on in the background instead of being killed: you get its ID and what it printed so far, " +
      "and its end wakes you with what it printed since and its value, so do not wait for it or run it again. Its calls still go through the same permissions.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript source: the body of an async function." },
        timeout: { type: "number", description: "Optional wait in milliseconds (default 120000, max 600000): a program still running then goes on in the background" },
      },
      required: ["code"],
      additionalProperties: false,
    },
    readOnly: false,
    inputAlso: ["sandbox_permissions"], // read by the gate: an escalation asked for gets the card of a shell command's
    cwdOf: (ctx) => ctx.cwd,
    // The gate judges the program as the command it is; one that asks to run
    // outside the sandbox gets the card a shell command's escalation gets.
    async target(input) {
      const code = typeof input?.code === "string" ? input.code : "";
      const escalate = input?.sandbox_permissions === "require_escalated" || undefined;
      return { name: RUN_CODE, readOnly: false, input, cls: { kind: "shell", command: asShellCommand(code), escalate } };
    },
    async run(input, ctx): Promise<ToolOutput> {
      const code = typeof input?.code === "string" ? input.code : "";
      if (!code.trim()) return fail("Give the program in `code`.");
      const timeout = Math.min(Math.max(Number(input?.timeout) || 120_000, 1000), 600_000);
      const o = await runProgram(code, ctx, rec, timeout);
      if (o.moved) {
        const j = o.moved;
        const sofar = [o.printed.trimEnd(), o.output.trim() ? `[output of commands]\n${o.output.trimEnd()}` : ""].filter(Boolean).join("\n\n");
        const head = `The program did not finish within its ${Math.round(timeout / 1000)}s timeout and went on in the background with ID: ${j.id} (pid ${j.pid}). `
          + `You are told when it ends, with what it printed since and its value: do not run it again. It is listed with your other background tasks; stop it with TaskStop (ID ${j.id}) if you have that tool, or the owner can. `
          + `What it prints from now on is written to ${j.log} as it prints.`;
        return ok(await spill(sofar ? `${head}\n\nPrinted so far:\n${sofar}` : head, ctx.spillDir, "run_code"));
      }
      const text = await spill(render(o), ctx.spillDir, "run_code");
      return o.error || !o.finished ? fail(text) : ok(text);
    },
  };
}
