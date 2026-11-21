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
import { shq } from "./shell.ts";
import { toolEnv, UNREAD_CAP } from "./jobs.ts";
import { spill } from "./spill.ts";
import { fail, ok, type Tool, type ToolContext, type ToolOutput } from "./types.ts";
import { pump } from "../core/proc.ts";

export const RUN_CODE = "run_code";

// What the program printed, its own output streams and its error are each held
// to the head a running command's unread output keeps; the result the model
// gets is bounded again by spill().
const KEPT = UNREAD_CAP;

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
process.on("unhandledRejection", (e) => keep("[unhandled rejection] " + show(e?.stack ?? e) + "\\n"));
const finish = (error) => process.send({ done: true, printed, dropped, error });
process.on("message", async (m) => {
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

// Reads a stream, keeping its head; the rest is read and counted so the child
// never blocks on a full pipe.
async function head(stream: ReadableStream<Uint8Array> | undefined): Promise<{ text: string; dropped: number }> {
  if (!stream) return { text: "", dropped: 0 };
  const parts: Uint8Array[] = [];
  let held = 0, dropped = 0;
  await pump(stream, (chunk) => {
    const take = Math.min(chunk.length, KEPT - held);
    if (take > 0) { parts.push(chunk.subarray(0, take)); held += take; }
    dropped += chunk.length - take;
  }, "run_code output");
  return { text: new TextDecoder().decode(Buffer.concat(parts)), dropped };
}

export async function runProgram(code: string, ctx: ToolContext, rec: CodeRecorder): Promise<Outcome> {
  const argv = [process.execPath, "-e", PRELUDE];
  let calls = 0;
  let done: { printed: string; dropped: number; error: string | null } | null = null;
  let resolveDone!: () => void;
  const doneP = new Promise<void>((r) => (resolveDone = r));
  const proc = Bun.spawn(ctx.wrapSpawn ? ctx.wrapSpawn(argv) : argv, {
    cwd: ctx.cwd,
    env: toolEnv(ctx.sessionId, { BUN_BE_BUN: "1", NO_COLOR: "1" }),
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
    ipc(m: any) {
      if (m?.done) { done = m; resolveDone(); return; }
      if (typeof m?.call !== "number") return;
      const n = ++calls;
      void (async () => {
        const c: CodeCall = { id: `${ctx.callId}~${n}`, parent: ctx.callId ?? "", seq: n, tool: String(m.tool), input: m.input ?? {}, started: Date.now() };
        rec.start(ctx.sessionId, c);
        let r: ToolResultBlock;
        if (c.tool === RUN_CODE) r = { type: "tool_result", tool_use_id: c.id, is_error: true, content: "A program cannot start another program." };
        else if (!ctx.callTool) r = { type: "tool_result", tool_use_id: c.id, is_error: true, content: "Tools cannot be called from here." };
        else {
          const run = (tool: string, input: any) => ctx.callTool!(tool, input, c.id).catch((e) => ({ type: "tool_result" as const, tool_use_id: c.id, is_error: true, content: `Tool failed: ${(e as Error).message}` }));
          r = await run(c.tool, c.input);
          // A catalog tool's own name (server__tool, as search_tools lists it) runs as the
          // session declares it: mcp__server__tool where tools load natively, else through mcp_call.
          if (r.is_error && r.content === `No tool named ${c.tool}.` && c.tool.includes("__")) {
            const native = c.tool.startsWith("mcp__") ? null : `mcp__${c.tool}`;
            const viaNative = native ? await run(native, c.input) : r;
            if (native && viaNative.content !== `No tool named ${native}.`) { c.tool = native; r = viaNative; }
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
  const onAbort = () => proc.kill("SIGKILL");
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  const streams = Promise.all([head(proc.stdout), head(proc.stderr)]);
  try {
    proc.send({ code });
    await Promise.race([doneP, proc.exited]);
    // Unawaited work of a finished program is dropped with it.
    if (done) proc.kill("SIGKILL");
    const exit = await proc.exited;
    const [out, err] = await streams;
    const output = [out.text, err.text].filter((t) => t.trim()).join("\n");
    const d = done as { printed: string; dropped: number; error: string | null } | null;
    return {
      printed: d?.printed ?? "", dropped: d?.dropped ?? 0, error: d?.error ?? null,
      output, outputDropped: out.dropped + err.dropped, calls, finished: !!d, exit: d ? 0 : exit,
    };
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
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
      "Use it to batch several calls into one step or to cut large results down; make single calls directly.",
    input_schema: {
      type: "object",
      properties: { code: { type: "string", description: "JavaScript source: the body of an async function." } },
      required: ["code"],
      additionalProperties: false,
    },
    readOnly: false,
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
      const o = await runProgram(code, ctx, rec);
      const text = await spill(render(o), ctx.spillDir, "run_code");
      return o.error || !o.finished ? fail(text) : ok(text);
    },
  };
}
