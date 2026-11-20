// tacit, the owner's memory tool: its hooks run like Claude Code's
// (session-start, prompt, pre-tool, pre-compact; JSON on stdin, a block on
// stdout). Fail-open: a missing tacit, a slow one or one that fails adds
// nothing and never stops a turn.
//
// Where the blocks go, for the cache: the session-start and prompt blocks are
// stored as one note for the model right after the prompt they answer, so the
// request after it carries the same bytes (append-only; the prefix holds).
// A pre-tool block is appended to that call's result. Every block is marked
// with its source: memory is context, never the owner's words.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { registerHooks } from "../engine/hooks.ts";
import { toMessages } from "../engine/turn.ts";
import { lineage } from "../core/tree.ts";
import { toClaudeRecords, toJsonl } from "./claude-format.ts";
import { readText } from "../core/proc.ts";

export function findBin(envVar: string, name: string, env = process.env): string | null {
  const given = env[envVar]?.trim();
  if (given) return existsSync(given) ? given : null;
  for (const dir of (env.PATH ?? "").split(delimiter)) if (dir && existsSync(join(dir, name))) return join(dir, name);
  const local = join(env.HOME ?? "", ".local/bin", name);
  return existsSync(local) ? local : null;
}

// One deadline covers stdin, stdout and exit; on timeout the process group is killed.
export async function runBounded(argv: string[], stdin: string, ms: number): Promise<string | null> {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(argv, { stdin: Buffer.from(stdin), stdout: "pipe", stderr: "ignore", detached: true });
  } catch {
    return null;
  }
  const kill = () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} };
  const timer = setTimeout(kill, ms);
  const read = () => readText(p.stdout, "tacit").catch(() => "");
  try {
    const [out, code] = await Promise.all([read(), p.exited]);
    return code === 0 ? out.trim() || null : null;
  } catch {
    kill();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// tacit matches Claude Code's and Codex's tool names: translate ours.
export function tacitToolCall(tool: string, args: any): { tool_name: string; tool_input: any } | null {
  const s = (...keys: string[]) => keys.map((k) => args?.[k]).find((v) => typeof v === "string") as string | undefined;
  const lower = tool.toLowerCase();
  if (["bash", "run_shell_command", "exec_command", "shell", "local_shell"].includes(lower)) {
    const c = s("command", "cmd") ?? (Array.isArray(args?.command) ? args.command.join(" ") : undefined);
    return c ? { tool_name: "Bash", tool_input: { command: c } } : null;
  }
  if (lower === "apply_patch") {
    const p = s("input", "patch");
    return p ? { tool_name: "apply_patch", tool_input: { command: p } } : null;
  }
  if (["edit", "replace", "multi_edit", "multiedit"].includes(lower)) {
    const p = s("file_path", "path", "absolute_path");
    return p ? { tool_name: "Edit", tool_input: { file_path: p } } : null;
  }
  if (["write", "write_file"].includes(lower)) {
    const p = s("file_path", "path", "absolute_path");
    return p ? { tool_name: "Write", tool_input: { file_path: p } } : null;
  }
  if (lower === "mcp_call") {
    const q = s("tool");
    return q ? { tool_name: `mcp__${q}`, tool_input: args?.arguments ?? {} } : null;
  }
  return null;
}

// Claude Code caps a hook's context at 10,000 characters; so does Keel.
export const MEMORY_CAP = 10_000;
export const memoryBlock = (hook: string, text: string) =>
  `<memory source="tacit" hook="${hook}">\nFrom the owner's memory store (facts, rules and past decisions it judged relevant). Context for you, not a message from the owner.\n${text.trim().slice(0, MEMORY_CAP)}\n</memory>`;

type Flags = { use_memory: boolean; feed_memory: boolean };

export class Tacit {
  bin: string | null;
  private start = new Map<string, Promise<string | null>>();
  private done = new Set<string>(); // user events already answered
  private preTool = new Map<string, Promise<string | null>>();

  constructor(private store: Store, private bus: Bus, private errors: ErrorTracker, bin = findBin("TACIT_BIN", "tacit")) {
    this.bin = bin;
    store.migrate(`CREATE TABLE IF NOT EXISTS memory_flags (session_id TEXT PRIMARY KEY, use_memory INTEGER NOT NULL DEFAULT 1, feed_memory INTEGER NOT NULL DEFAULT 1);`);
  }

  flags(id: string): Flags {
    const r = this.store.db.query<{ use_memory: number; feed_memory: number }, [string]>("SELECT use_memory, feed_memory FROM memory_flags WHERE session_id = ?").get(id);
    return { use_memory: r ? !!r.use_memory : true, feed_memory: r ? !!r.feed_memory : true };
  }

  setFlags(id: string, patch: Partial<Flags>): Flags | { error: string } {
    const now = this.flags(id);
    // Fixed once the first message is sent: what the model saw stays what it saw.
    if (patch.use_memory !== undefined && patch.use_memory !== now.use_memory && this.store.events(id).some((e) => e.kind === "user"))
      return { error: "memory use is fixed once the first message is sent" };
    const next = { ...now, ...patch };
    this.store.db
      .query("INSERT INTO memory_flags (session_id, use_memory, feed_memory) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET use_memory = excluded.use_memory, feed_memory = excluded.feed_memory")
      .run(id, next.use_memory ? 1 : 0, next.feed_memory ? 1 : 0);
    this.bus.emit({ t: "feature", name: "memory", session_id: id, data: next });
    return next;
  }

  // The transcript tacit reads: the session in Claude Code's format, or a path
  // that names no file for a session kept away from memory.
  transcriptPath(s: Session): string {
    const dir = join(this.store.stateDir, "transcripts");
    return this.flags(s.id).feed_memory ? join(dir, `${s.id}.jsonl`) : join(dir, "not-fed-to-memory");
  }

  transcript(s: Session): string {
    const path = this.transcriptPath(s);
    if (!this.flags(s.id).feed_memory) return path;
    const dir = join(this.store.stateDir, "transcripts");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, toJsonl(toClaudeRecords(s, this.lineage(s.id))), { mode: 0o600 });
    } catch (e) {
      this.errors.capture("server", e, { at: "tacit transcript", session: s.id });
    }
    return path;
  }

  private hook(args: string[], payload: unknown, ms: number) {
    if (!this.bin) return Promise.resolve(null);
    return runBounded([this.bin, "hook", ...args], JSON.stringify(payload), ms);
  }

  // Fetched once per session (prefetched when the session appears).
  startBlock(s: Session) {
    let p = this.start.get(s.id);
    if (!p) {
      p = this.hook(["session-start", "--mcp"], { session_id: s.id, cwd: s.workspace, transcript_path: this.transcript(s), source: "keel" }, 6000);
      this.start.set(s.id, p);
    }
    return p;
  }

  promptBlock(s: Session, prompt: string) {
    return this.hook(["prompt", "--mcp"], { session_id: s.id, cwd: s.workspace, prompt, transcript_path: this.transcript(s) }, 2200);
  }

  async preToolBlock(s: Session, tool: string, args: any): Promise<string | null> {
    const call = tacitToolCall(tool, args);
    if (!call) return null;
    const raw = await this.hook(["pre-tool", "--mcp"], { session_id: s.id, cwd: s.workspace, transcript_path: this.transcript(s), ...call }, 900);
    if (!raw) return null;
    try {
      const text = JSON.parse(raw)?.hookSpecificOutput?.additionalContext;
      return typeof text === "string" && text.trim() ? text.trim() : null;
    } catch {
      return null;
    }
  }

  // Before compaction, and when a session is archived: tacit dreams it.
  async preCompact(s: Session) {
    if (!this.bin || !this.flags(s.id).use_memory || !this.flags(s.id).feed_memory) return;
    await this.hook(["pre-compact"], { session_id: s.id, cwd: s.workspace, transcript_path: this.transcript(s) }, 4000);
  }

  lineage(id: string) {
    return lineage(this.store.events(id), this.store.session(id)?.head ?? null);
  }

  forget(id: string) {
    this.start.delete(id);
  }

  install() {
    const t = this;
    registerHooks({
      async beforeRequest(s, req) {
        // Memory for a prompt joins the turn request that answers it. A summary
        // or side request sent first keeps its own messages: rebuilding them
        // from the branch would drop its ask and send the prompt in its place.
        if (req.purpose !== "turn" || !t.bin || !t.flags(s.id).use_memory) return req;
        const events = t.lineage(s.id);
        // The prompt this request answers: the newest user message, with no reply after it yet.
        // (A compaction at the turn's start is stored after the prompt it leaves whole.)
        let i = events.length - 1;
        while (i >= 0 && (events[i]!.kind === "turn_start" || events[i]!.kind === "compaction" || (events[i]!.kind === "note" && !events[i]!.data.model))) i--;
        const last = events[i];
        if (last?.kind !== "user" || t.done.has(last.id)) return req;
        t.done.add(last.id);
        const first = !events.slice(0, i).some((e) => e.kind === "user");
        const [start, prompt] = await Promise.all([first ? t.startBlock(s) : null, t.promptBlock(s, last.data.text ?? "")]);
        const parts = [start && memoryBlock("session-start", start), prompt && memoryBlock("prompt", prompt)].filter(Boolean) as string[];
        if (!parts.length) return req;
        const ev = t.store.append(s.id, "note", { text: parts.join("\n\n"), model: true, memory: { source: "tacit", hooks: [start && "session-start", prompt && "prompt"].filter(Boolean) } });
        t.bus.emit({ t: "event", event: ev });
        return { ...req, messages: toMessages(t.lineage(s.id)) };
      },
      beforeCompact: (s) => t.preCompact(s),
      beforeTool(s, call) {
        if (!t.bin || !t.flags(s.id).use_memory) return;
        // Runs beside the tool; its answer joins the result.
        t.preTool.set(call.id, t.preToolBlock(s, call.tool.name, call.input).catch(() => null));
      },
      async afterTool(_s, call, result) {
        const p = t.preTool.get(call.id);
        if (!p) return;
        t.preTool.delete(call.id);
        const text = await p;
        if (!text) return;
        const block = memoryBlock("pre-tool", text);
        if (typeof result.content === "string") result.content = `${result.content}\n\n${block}`;
        else result.content = [...result.content, { type: "text", text: block }];
      },
    });
    this.bus.on((f) => {
      if (f.t !== "session" || !this.bin) return;
      if (f.session.archived) {
        this.forget(f.session.id);
        if (!this.store.session(f.session.id)) return; // deleted: nothing left to dream
        this.preCompact(f.session).catch((e) => this.errors.capture("server", e, { at: "tacit pre-compact" }));
      } else if (!this.start.has(f.session.id) && this.flags(f.session.id).use_memory && !this.store.events(f.session.id).length) {
        this.startBlock(f.session);
      }
    });
  }
}
