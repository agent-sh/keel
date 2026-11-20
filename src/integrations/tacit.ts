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
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import { SessionMap } from "../core/session-map.ts";
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

type ProcessOutcome = "ok" | "timeout" | "failure";
type ProcessResult = { outcome: ProcessOutcome; text: string | null };

// One deadline covers stdin, stdout and exit; on timeout the process group is killed.
async function runBoundedResult(argv: string[], stdin: string, ms: number): Promise<ProcessResult> {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(argv, { stdin: Buffer.from(stdin), stdout: "pipe", stderr: "ignore", detached: true });
  } catch {
    return { outcome: "failure", text: null };
  }
  const kill = () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} };
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; kill(); }, ms);
  try {
    const [out, code] = await Promise.all([readText(p.stdout, "tacit").catch(() => null), p.exited]);
    if (timedOut) return { outcome: "timeout", text: null };
    if (code !== 0 || out === null) return { outcome: "failure", text: null };
    return { outcome: "ok", text: out.trim() || null };
  } catch {
    kill();
    return { outcome: timedOut ? "timeout" : "failure", text: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function runBounded(argv: string[], stdin: string, ms: number): Promise<string | null> {
  return (await runBoundedResult(argv, stdin, ms)).text;
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
type Hook = "session-start" | "prompt" | "pre-tool" | "pre-compact";
type HookOutcome = ProcessOutcome | "hit" | "empty";
const totals = () => ({ total: 0, max: 0 });
function add(stat: ReturnType<typeof totals>, value: number) {
  stat.total += value;
  stat.max = Math.max(stat.max, value);
}
const hookStats = () => ({
  outcomes: { hit: 0, empty: 0, failure: 0, timeout: 0, ok: 0 } satisfies Record<HookOutcome, number>,
  duration_ms: totals(),
  context_bytes: totals(),
});

// A missing, replaced or edited file cannot witness the cached version.
function fileStamp(path: string): string | undefined {
  try {
    const f = lstatSync(path, { throwIfNoEntry: false });
    if (f?.isFile()) return `${f.dev}:${f.ino}:${f.size}:${f.mtimeMs}:${f.ctimeMs}`;
  } catch {
    // Without a stamp, try rebuilding rather than trusting the path.
  }
}

function writeTranscript(path: string, bytes: Buffer) {
  // Hooks may already be reading this path. Publish a complete file at once.
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, bytes, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

export class Tacit {
  bin: string | null;
  private start = new Map<string, Promise<string | null>>();
  private done = new Set<string>(); // user events already answered
  private preTool = new Map<string, Promise<string | null>>();
  // One version per session, no transcript bytes kept here. Store deletion
  // clears SessionMaps; evicting an idle one just costs a rebuild next time.
  private transcriptVersions = new SessionMap<{ head: Session["head"]; model: string; workspace: string; stamp: string }>(64);
  private readonly metrics = {
    since_ms: Date.now(),
    hooks: { "session-start": hookStats(), prompt: hookStats(), "pre-tool": hookStats(), "pre-compact": hookStats() } satisfies Record<Hook, ReturnType<typeof hookStats>>,
    transcript: { reused: 0, rebuilt: 0, failed: 0, duration_ms: totals(), bytes: totals() },
  };

  constructor(private store: Store, private bus: Bus, private errors: ErrorTracker, bin = findBin("TACIT_BIN", "tacit")) {
    this.bin = bin;
    store.migrate(`CREATE TABLE IF NOT EXISTS memory_flags (session_id TEXT PRIMARY KEY, use_memory INTEGER NOT NULL DEFAULT 1, feed_memory INTEGER NOT NULL DEFAULT 1);`);
  }

  stats() {
    return this.metrics;
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
    if (!next.feed_memory) this.transcriptVersions.delete(id);
    this.bus.emit({ t: "feature", name: "memory", session_id: id, data: next });
    return next;
  }

  // The transcript tacit reads: the session in Claude Code's format, or a path
  // that names no file for a session kept away from memory.
  transcriptPath(s: Session): string {
    return this.transcriptFile(this.flags(s.id).feed_memory ? s.id : undefined);
  }

  private transcriptFile(id?: string): string {
    return join(this.store.stateDir, "transcripts", id ? `${id}.jsonl` : "not-fed-to-memory");
  }

  transcript(s: Session): string {
    if (!this.flags(s.id).feed_memory) return this.transcriptFile();
    const path = this.transcriptFile(s.id);
    const started = performance.now();
    const stat = this.metrics.transcript;
    try {
      // Hook callers can hold an old head. Use the current head for both the
      // cache and the lineage, with the caller's metadata as in the encoder.
      const current = this.store.session(s.id);
      if (!current) return this.transcriptFile();
      const { head } = current;
      const { model, workspace } = s;
      const cached = this.transcriptVersions.get(s.id);
      if (cached && cached.head === head && cached.model === model && cached.workspace === workspace && cached.stamp === fileStamp(path)) {
        stat.reused++;
        return path;
      }
      this.transcriptVersions.delete(s.id);
      mkdirSync(dirname(path), { recursive: true });
      // Encode once for the write and reuse its byte length.
      const bytes = Buffer.from(toJsonl(toClaudeRecords(s, lineage(this.store.events(s.id), head))));
      writeTranscript(path, bytes);
      const stamp = fileStamp(path);
      if (stamp !== undefined) this.transcriptVersions.set(s.id, { head, model, workspace, stamp });
      stat.rebuilt++;
      add(stat.bytes, bytes.length);
    } catch (e) {
      stat.failed++;
      this.errors.capture("server", e, { at: "tacit transcript", session: s.id });
      // Keep the hook fail-open without handing it a previous version.
      return this.transcriptFile();
    } finally {
      add(stat.duration_ms, performance.now() - started);
    }
    return path;
  }

  private async hook(hook: Hook, payload: unknown, ms: number): Promise<string | null> {
    if (!this.bin) return null;
    const started = performance.now();
    const argv = [this.bin, "hook", hook];
    if (hook !== "pre-compact") argv.push("--mcp");
    const result = await runBoundedResult(argv, JSON.stringify(payload), ms);
    let outcome: HookOutcome = result.outcome;
    let text = hook === "pre-compact" ? null : result.text;
    if (outcome === "ok" && hook !== "pre-compact") {
      if (hook === "pre-tool" && text) {
        try {
          const context = JSON.parse(text)?.hookSpecificOutput?.additionalContext;
          text = typeof context === "string" ? context.trim() || null : null;
        } catch {
          outcome = "failure";
          text = null;
        }
      }
      if (outcome === "ok") outcome = text ? "hit" : "empty";
    }
    const stat = this.metrics.hooks[hook];
    stat.outcomes[outcome]++;
    add(stat.duration_ms, performance.now() - started);
    if (text) add(stat.context_bytes, Buffer.byteLength(text.slice(0, MEMORY_CAP)));
    return text;
  }

  // Fetched once per session (prefetched when the session appears).
  startBlock(s: Session) {
    let p = this.start.get(s.id);
    if (!p) {
      p = this.hook("session-start", { session_id: s.id, cwd: s.workspace, transcript_path: this.transcript(s), source: "keel" }, 6000);
      this.start.set(s.id, p);
    }
    return p;
  }

  promptBlock(s: Session, prompt: string) {
    return this.hook("prompt", { session_id: s.id, cwd: s.workspace, prompt, transcript_path: this.transcript(s) }, 2200);
  }

  async preToolBlock(s: Session, tool: string, args: any): Promise<string | null> {
    const call = tacitToolCall(tool, args);
    if (!call) return null;
    return this.hook("pre-tool", { session_id: s.id, cwd: s.workspace, transcript_path: this.transcript(s), ...call }, 900);
  }

  // Before compaction, and when a session is archived: tacit dreams it.
  async preCompact(s: Session) {
    if (!this.bin || !this.flags(s.id).use_memory || !this.flags(s.id).feed_memory) return;
    await this.hook("pre-compact", { session_id: s.id, cwd: s.workspace, transcript_path: this.transcript(s) }, 4000);
  }

  lineage(id: string) {
    return lineage(this.store.events(id), this.store.session(id)?.head ?? null);
  }

  forget(id: string) {
    this.start.delete(id);
    this.transcriptVersions.delete(id);
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
