// The terminals an ACP agent runs through Keel (ACP v1 terminals: create,
// output, wait_for_exit, kill, release). A terminal is a job of the session,
// as a command of its own model's shell is: it goes through the owner's hooks
// and the gate as that command (what is judged is the text that runs, its
// variables included), runs confined as the session's commands do, is kept
// with its log, listed in the terminal pane, and stopped when the owner stops
// the turn or the agent ends. A command the agent asked about and was allowed
// in this turn opens no second card (the gate's answeredOnce).
//
// Spec: agentclientprotocol.com/protocol/v1/terminals.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { contains, realOf } from "../core/paths.ts";
import type { Session, ToolResultBlock } from "../core/types.ts";
import type { Tool } from "../tools/types.ts";
import { shellText } from "../safety/policy.ts";
import { cleanTerm, stopJob, toolEnv, UNREAD_CAP, type Job } from "../tools/jobs.ts";
import { ABORTED_TEXT, startHeld, takeFor } from "../tools/heavy.ts";
import { shq } from "../tools/shell.ts";

type Json = any;

// Runs a tool of Keel's for the agent through the engine's chain (the owner's hooks, the gate, the tool).
export type RunTool = (tool: Tool, input: unknown, id: string) => Promise<ToolResultBlock>;

const fail = (message: string, code = -32000) => Object.assign(new Error(message), { code });

// The command line a terminal runs, as one text for bash: the agent's
// variables first, then the program and its arguments, each word quoted.
// A program with no arguments is taken as the command line it is
// (`npm test`), as editors run it.
export function commandLine(p: { command?: unknown; args?: unknown; env?: unknown }): string {
  const command = typeof p.command === "string" ? p.command : "";
  if (!command.trim()) throw fail("command is required", -32602);
  const args = Array.isArray(p.args) ? p.args.map(String) : [];
  const env = Array.isArray(p.env) ? p.env.filter((v: Json) => v && typeof v.name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name)) : [];
  const vars = env.map((v: Json) => `${v.name}=${shq(String(v.value ?? ""))}`);
  const line = args.length ? shellText({ command: [command, ...args] })! : command;
  return [...vars, line].join(" ");
}

// The end of `text` within `limit` bytes, cut at a character's start.
export function keepEnd(text: string, limit: number): { output: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return { output: text, truncated: false };
  let from = bytes.length - limit;
  while (from < bytes.length && (bytes[from]! & 0xc0) === 0x80) from++;
  return { output: bytes.subarray(from).toString("utf8"), truncated: true };
}

type Term = { job: Job; limit: number; command: string };

// One agent connection's terminals.
export class AcpTerminals {
  private terms = new Map<string, Term>();
  constructor(private stateDir: string) {}

  async create(s: Session, p: Json, run: RunTool): Promise<{ terminalId: string }> {
    const command = commandLine(p);
    const given = typeof p.cwd === "string" && p.cwd ? p.cwd : s.workspace;
    if (!isAbsolute(given)) throw fail("cwd must be absolute", -32602);
    const cwd = realOf(given);
    // (A terminal starts in the session's folder or under it: the root the session was given.)
    const underRoot = () => contains(realOf(s.workspace), cwd);
    if (!underRoot()) throw fail(`${given} is outside this session's folder ${s.workspace}: Keel runs an agent's commands only there`);
    const id = `term-${crypto.randomUUID()}`;
    // What is kept of its output: the agent's limit, at most what Keel hands over of a command's output at once.
    const limit = Number.isFinite(p.outputByteLimit) && p.outputByteLimit >= 0 ? Math.min(Math.floor(p.outputByteLimit), UNREAD_CAP) : UNREAD_CAP;
    const tool: Tool = {
      name: "Bash", kind: "shell", readOnly: false, answeredBefore: true,
      description: "A command an ACP agent runs in a terminal of Keel's.",
      input_schema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] },
      cwdOf: () => cwd,
      run: async (_input, ctx) => {
        // (The folder is the one judged: a name that leads elsewhere by now runs nothing.)
        if (realOf(given) !== cwd || !underRoot()) return { content: `${given} is not the folder that was judged any more: nothing ran.`, is_error: true };
        // A heavy command waits for its slot (src/tools/heavy.ts).
        const slot = await takeFor(ctx, command);
        if (slot === "aborted") return { content: ABORTED_TEXT, is_error: true };
        const job = startHeld({ sessionId: s.id, command, cwd, logDir: join(this.stateDir, "spill", s.id, "jobs"), env: toolEnv(s.id), vars: true, wrap: ctx.wrapSpawn, description: "run by the ACP agent" }, slot);
        this.terms.set(id, { job, limit, command });
        return { content: `Started in a terminal of Keel's (${id}).` };
      },
    };
    const r = await run(tool, { command, cwd }, id);
    if (r.is_error || !this.terms.has(id)) throw fail(typeof r.content === "string" ? r.content : r.content.map((b: Json) => b.text ?? "").join("") || "the command did not start");
    return { terminalId: id };
  }

  private get(p: Json): Term {
    const t = this.terms.get(String(p?.terminalId ?? ""));
    if (!t) throw fail(`no terminal ${p?.terminalId}`, -32602);
    return t;
  }

  // What it printed, its end within its limit (read from the end of its log), and how it ended once it did.
  private text(t: Term): { output: string; truncated: boolean } {
    let fd: number | undefined;
    try {
      fd = openSync(t.job.log, "r");
      const size = fstatSync(fd).size;
      // (A few bytes more than the limit: a character cut at the start is dropped by keepEnd, not shown broken.)
      const want = Math.min(size, t.limit + 4);
      const buf = Buffer.alloc(want);
      readSync(fd, buf, 0, want, size - want);
      const r = keepEnd(cleanTerm(buf.toString("utf8")), t.limit);
      return { output: r.output, truncated: r.truncated || size - want > 0 };
    } catch {
      return { output: "", truncated: false };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private exit(t: Term) {
    return t.job.ended === undefined ? undefined : { exitCode: t.job.exitCode ?? null, signal: t.job.signal ?? null };
  }

  output(p: Json) {
    const t = this.get(p);
    const exitStatus = this.exit(t);
    return { ...this.text(t), ...(exitStatus ? { exitStatus } : {}) };
  }

  async waitForExit(p: Json, signal: AbortSignal) {
    const t = this.get(p);
    if (t.job.ended === undefined) {
      await Promise.race([t.job.exited, new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }))]);
      if (t.job.ended === undefined) throw fail("the turn was stopped while the command ran", -32800);
      await Bun.sleep(5); // (what the process wrote last reaches its log)
    }
    return this.exit(t)!;
  }

  async kill(p: Json) {
    await stopJob(this.get(p).job, "was stopped by the agent");
    return {};
  }

  async release(p: Json) {
    const t = this.get(p);
    this.forget(String(p.terminalId));
    this.terms.delete(String(p.terminalId));
    if (t.job.ended === undefined) await stopJob(t.job, "was released by the agent");
    return {};
  }

  // What a tool call that embeds a terminal shows: its output as it is now.
  shown(id: string): string | undefined {
    const t = this.terms.get(id) ?? this.gone.get(id);
    if (!t) return undefined;
    const { output, truncated } = this.text(t);
    const e = this.exit(t);
    const how = e ? (e.signal ? ` (killed by ${e.signal})` : e.exitCode !== null && e.exitCode !== 0 ? ` (exit code ${e.exitCode})` : "") : " (still running)";
    return `$ ${t.command}${how}\n${truncated ? "[earlier output cut]\n" : ""}${output}`;
  }

  // Released terminals are still shown in the calls that embed them (the spec asks a client to), the newest few.
  private gone = new Map<string, Term>();
  private forget(id: string) {
    const t = this.terms.get(id);
    if (!t) return;
    this.gone.set(id, t);
    for (const k of this.gone.keys()) { if (this.gone.size <= 64) break; this.gone.delete(k); }
  }

  // The owner stopped the turn: what its terminals still run stops (they stay readable until released).
  async stopRunning() {
    await Promise.all([...this.terms.values()].map((t) => (t.job.ended === undefined ? stopJob(t.job, "was stopped with the turn") : undefined)));
  }

  // The agent's connection ended: its commands end with it.
  async closeAll() {
    const all = [...this.terms.values()];
    this.terms.clear();
    await Promise.all(all.map((t) => (t.job.ended === undefined ? stopJob(t.job, "ended with its agent") : undefined)));
  }
}
