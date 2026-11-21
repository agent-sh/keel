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
//
// The store gives a session each fact once: it marks a fact as given before
// it prints it. So a fact the store printed must reach the model, and saving
// tokens never costs one (memory-meter.ts measures both):
// - a line the context already holds is not added again (it is there);
// - a block is at most one hook's cap, whole lines, the store's first ones
//   first. The lines that did not fit are owed to the session: kept in the
//   state, and added with the turn's next request (a note after that step's
//   results) or the next prompt, until none is left;
// - the store is asked about what asks for work (the owner's words, a task,
//   a loop's own prompt, a goal's objective), not about what the harness
//   delivers (a report, a wait's wake, a failure notice, a digest);
// - a call that did not answer by its deadline starts an outage of its kind
//   (asking: session-start and prompt; tool: pre-tool). While it lasts the
//   session is told once, calls of that kind are still made but not waited
//   for, and what one answers is owed to its session like a line that did
//   not fit. A probe of its own (a call that asks nothing) ends the outage
//   when the store answers again, so the next real prompt waits as usual;
// - after a summary or a clear the store is told (session-start with that
//   source), so what it gave before the context was replaced can come again.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import { SessionMap } from "../core/session-map.ts";
import type { Store } from "../core/store.ts";
import type { Session, StoredEvent } from "../core/types.ts";
import { checkpointAt } from "../engine/compact.ts";
import { registerHooks } from "../engine/hooks.ts";
import { toMessages } from "../engine/turn.ts";
import { lineage } from "../core/tree.ts";
import { toClaudeRecords, toJsonl } from "./claude-format.ts";
import { readText } from "../core/proc.ts";
import { asksMemory, factLines, factOf, memoryMeter, type MemoryMeter, type MemoryPath } from "./memory-meter.ts";

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

// Claude Code caps a hook's context at 10,000 characters; so does Keel, per
// block: what a block cannot hold is owed, never dropped.
export const MEMORY_CAP = 10_000;
export const memoryBlock = (hook: string, text: string) =>
  `<memory source="tacit" hook="${hook}">\nFrom the owner's memory store (facts, rules and past decisions it judged relevant). Context for you, not a message from the owner.\n${text.trim().slice(0, MEMORY_CAP)}\n</memory>`;
// What the frame around a block's text takes of its cap.
const FRAME = memoryBlock("session-start", "").length;

// The hooks' own deadlines. A turn's first request waits for the prompt's
// answer and, on a session's first prompt or after a summary, for the start
// block; a tool's result waits for its hook.
export const START_WAIT_MS = 6000;
export const PROMPT_WAIT_MS = 2200;
export const TOOL_WAIT_MS = 900;
// While a kind of call is not answering, its probe runs again after its own
// deadline, then after twice as long each time, up to this: a store that came
// back is noticed within a minute, and one that is gone costs one short
// process a minute.
export const PROBE_MAX_MS = 60_000;

// Hook processes alive at once: no more than the machine has threads. A call
// a turn waits for queues for a place; one nothing waits for is not made.
export const HOOK_PROCESSES = availableParallelism();

const isFact = (l: string) => /^\s*-\s/.test(l);
const CUT = "[the line above is cut: it is longer than a block]";

// What a block adds: the lines the context does not hold yet (`shown`: the
// fact lines it holds), within `room` characters, whole lines, in the store's
// order. Lines that are not facts (a title, a closing remark) stay with the
// facts they frame. `owed`: the lines that did not fit, in order, for a later
// block; the block ends with a line that says how many follow. A block with
// anything new always carries at least its first new line (cut at the room
// and saying so when that one line is longer), so what is owed always
// shrinks. Nothing when the context holds every fact already.
export function fitMemory(text: string, shown: ReadonlySet<string>, room: number): { text: string | null; lines: string[]; repeats: number; owed: string[] } {
  const all = text.trim().split("\n").filter((l) => l.trim());
  const facts = all.filter(isFact);
  const fresh = all.filter((l) => !isFact(l) || !shown.has(l.trim()));
  const repeats = all.length - fresh.length;
  if (!fresh.length || (facts.length && repeats === facts.length)) return { text: null, lines: [], repeats, owed: [] };
  const follow = (n: number) => `[${n} more ${n === 1 ? "line follows" : "lines follow"} with the next step: this block is full]`;
  const size = (list: string[]) => list.reduce((n, l) => n + l.length + 1, 0);
  let kept = fresh.length;
  // Everything, or as many lines as fit together with the line that says more follow.
  while (kept > 0 && size(fresh.slice(0, kept)) + (kept < fresh.length ? follow(fresh.length - kept).length + 1 : 0) > room) kept--;
  // A title alone is no block: the first fact goes with it.
  const first = Math.max(0, fresh.findIndex(isFact));
  const least = first + 1;
  let lines = fresh.slice(0, Math.max(kept, least));
  const owed = fresh.slice(lines.length);
  if (kept < least) {
    const one = fresh[first]!;
    const tail = owed.length ? follow(owed.length).length + 1 : 0;
    // No room for the title with it: the first new line alone. Longer than
    // the room by itself: its start, and a line saying it was cut.
    if (one.length + 1 + tail <= room) lines = [one];
    else lines = [one.slice(0, Math.max(0, room - tail - CUT.length - 2)), CUT];
  }
  const out = owed.length ? [...lines, follow(owed.length)] : lines;
  return { text: out.join("\n"), lines: lines.filter(isFact).map((l) => l.trim()), repeats, owed };
}

// The fact lines of the memory blocks in a text (a stored note, a tool result).
const BLOCK = /<memory source="tacit" hook="[a-z-]+">\n([\s\S]*?)\n<\/memory>/g;
export function shownLines(text: string): string[] {
  if (!text.includes('<memory source="tacit"')) return [];
  return [...text.matchAll(BLOCK)].flatMap((m) => factLines(m[1]!)).map((l) => l.trim());
}

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

type HookResult = { outcome: HookOutcome; text: string | null };
// A hook call that may still be running: `got` is set when it ended.
type Running = { got?: HookResult; done: Promise<HookResult> };
const running = (done: Promise<HookResult>): Running => {
  const r: Running = { done };
  done.then((got) => { r.got = got; });
  return r;
};
const NOTHING: HookResult = { outcome: "empty", text: null };
const SKIPPED: Running = { got: NOTHING, done: Promise.resolve(NOTHING) };

// The two kinds of call a turn waits for: asking (session-start and prompt
// go through the store's query) and a tool's push. Each has its own outage.
type Kind = "ask" | "tool";
const kindOf = (hook: Hook): Kind | null => (hook === "pre-tool" ? "tool" : hook === "pre-compact" ? null : "ask");
const WAIT: Record<Kind, number> = { ask: PROMPT_WAIT_MS, tool: TOOL_WAIT_MS };
type OwedHook = "session-start" | "prompt" | "pre-tool";
const PATH_OF: Record<OwedHook, MemoryPath> = { "session-start": "store_start", prompt: "store_prompt", "pre-tool": "store_tool" };
// The session id the probes call the store with: no session of Keel's.
const PROBE_SESSION = "keel-probe";

export class Tacit {
  bin: string | null;
  private start = new Map<string, Running>();
  private done = new Set<string>(); // user events already answered
  private preTool = new Map<string, Running>();
  // A kind of call that did not answer in time is out until one does: its
  // calls are made and not waited for. `failing`: its calls end in an error.
  private out: Record<Kind, boolean> = { ask: false, tool: false };
  private failing: Record<Kind, boolean> = { ask: false, tool: false };
  private probing: Record<Kind, ReturnType<typeof setTimeout> | true | null> = { ask: null, tool: null };
  // Sessions told that memory is not answering, with the kinds of their calls
  // that went unanswered: one line while any of them is (a store that hangs
  // whole is one line, not two), until a call of each such kind answers in
  // time again (a prompt that answers does not end a tool hook's outage).
  private told = new Map<string, Set<Kind>>();
  // Calls nothing waits for, one at a time per session and kind ("<session> <kind>").
  private flying = new Set<string>();
  // Hook processes alive, and the calls waiting for a place.
  private procs = 0;
  private waiting: (() => void)[] = [];
  // The fact lines each session's context holds (since its last summary), read
  // on from the last event looked at.
  private shown = new SessionMap<{ head: string; checkpoint: string | null; lines: Set<string> }>(64);
  private meter: MemoryMeter;
  // The store drops a deleted session out of every SessionMap, whatever
  // deleted it: this one takes the session's transcript file with it.
  private files = new (class extends SessionMap<true> {
    constructor(private gone: (id: string) => void) { super(1); }
    override delete(id: string) { this.gone(id); return super.delete(id); }
  })((id) => this.removeTranscript(id));
  // One version per session, no transcript bytes kept here. Store deletion
  // clears SessionMaps; evicting an idle one just costs a rebuild next time.
  // `last`: the uuid of the file's last record, which the next ones hang under.
  private transcriptVersions = new SessionMap<{ head: Session["head"]; model: string; workspace: string; stamp: string; last: string | null }>(64);
  private readonly metrics = {
    since_ms: Date.now(),
    hooks: { "session-start": hookStats(), prompt: hookStats(), "pre-tool": hookStats(), "pre-compact": hookStats() } satisfies Record<Hook, ReturnType<typeof hookStats>>,
    transcript: { reused: 0, appended: 0, rebuilt: 0, failed: 0, removed: 0, duration_ms: totals(), bytes: totals() },
    // Hook processes: the most alive at once, calls not made because one of
    // their session and kind was already out unanswered, and probes run.
    processes: { max: 0, limit: 0, not_started: 0, probes: 0 },
  };

  constructor(private store: Store, private bus: Bus, private errors: ErrorTracker, bin = findBin("TACIT_BIN", "tacit")) {
    this.bin = bin;
    this.meter = memoryMeter(store);
    void this.files;
    this.metrics.processes.limit = HOOK_PROCESSES;
    // memory_owed: lines the store gave that have not reached the model yet
    // (a block was full, or the answer came after its request went). They
    // outlive a restart: the store will not give them again.
    // memory_sessions: the checkpoint the store was last told of.
    store.migrate(`CREATE TABLE IF NOT EXISTS memory_flags (session_id TEXT PRIMARY KEY, use_memory INTEGER NOT NULL DEFAULT 1, feed_memory INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS memory_owed (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, hook TEXT NOT NULL, line TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS memory_owed_session ON memory_owed(session_id, id);
CREATE TABLE IF NOT EXISTS memory_sessions (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, checkpoint TEXT);`);
  }

  // `out`: the kinds of call the store is not answering in time right now.
  stats() {
    return { ...this.metrics, out: { ...this.out } };
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
      // Hook callers can hold an old session snapshot. Use one current
      // snapshot for the cache key and all the fields the encoder reads.
      const current = this.store.session(s.id);
      if (!current) return this.transcriptFile();
      const { head, model, workspace } = current;
      const cached = this.transcriptVersions.get(s.id);
      if (cached && cached.head === head && cached.model === model && cached.workspace === workspace && cached.stamp === fileStamp(path)) {
        stat.reused++;
        return path;
      }
      this.transcriptVersions.delete(s.id);
      const line = lineage(this.store.events(s.id), head);
      // The branch only grew since the file was written (the usual case: a
      // prompt, a reply, a tool result): the new events are appended, as the
      // format's own writer does, and the file is not encoded and written
      // whole again on every hook call.
      const at = cached && cached.model === model && cached.workspace === workspace && cached.stamp === fileStamp(path) ? line.findLastIndex((e) => e.id === cached.head) : -1;
      if (cached && at >= 0) {
        const records = toClaudeRecords(current, line.slice(at + 1), s.id, { parent: cached.last });
        const bytes = Buffer.from(toJsonl(records));
        if (bytes.length) appendFileSync(path, bytes);
        const stamp = fileStamp(path);
        if (stamp !== undefined) this.transcriptVersions.set(s.id, { head, model, workspace, stamp, last: (records.at(-1)?.uuid as string | undefined) ?? cached.last });
        stat.appended++;
        add(stat.bytes, bytes.length);
        return path;
      }
      mkdirSync(dirname(path), { recursive: true });
      // Encode once for the write and reuse its byte length.
      const records = toClaudeRecords(current, line);
      const bytes = Buffer.from(toJsonl(records));
      writeTranscript(path, bytes);
      const stamp = fileStamp(path);
      if (stamp !== undefined) this.transcriptVersions.set(s.id, { head, model, workspace, stamp, last: (records.at(-1)?.uuid as string | undefined) ?? null });
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

  // A place among the hook processes. A call something waits for queues for
  // one (its deadline starts when it runs); one nothing waits for is not made
  // when there is none.
  private async place(wait: boolean): Promise<boolean> {
    if (this.procs >= HOOK_PROCESSES) {
      if (!wait) return false;
      await new Promise<void>((go) => this.waiting.push(go));
    } else this.procs++;
    this.metrics.processes.max = Math.max(this.metrics.processes.max, this.procs);
    return true;
  }
  private leave() {
    const next = this.waiting.shift();
    if (next) next(); // the place goes to the next in line
    else this.procs--;
  }

  // One hook process. `session`: whose call it is (a probe's is nobody's).
  private async hook(hook: Hook, payload: unknown, ms: number, session?: string, wait = true): Promise<HookResult> {
    if (!this.bin) return NOTHING;
    if (!(await this.place(wait))) { this.metrics.processes.not_started++; return NOTHING; }
    const started = performance.now();
    const argv = [this.bin, "hook", hook];
    if (hook !== "pre-compact") argv.push("--mcp");
    const result = await runBoundedResult(argv, JSON.stringify(payload), ms).finally(() => this.leave());
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
    if (session !== PROBE_SESSION) {
      const stat = this.metrics.hooks[hook];
      stat.outcomes[outcome]++;
      add(stat.duration_ms, performance.now() - started);
      if (text) add(stat.context_bytes, Buffer.byteLength(text.slice(0, MEMORY_CAP)));
    }
    const kind = kindOf(hook);
    if (kind) this.health(kind, outcome, session);
    return { outcome, text };
  }

  // A call that timed out starts an outage of its kind, and the probe that
  // ends it; an answer in time ends it. A failing store answers at once, so
  // nothing waits long for it: it is recorded once, and told.
  private health(kind: Kind, outcome: HookOutcome, session?: string) {
    if (outcome === "timeout") {
      if (!this.out[kind]) {
        this.errors.capture("server", new Error(kind === "ask" ? "the memory store did not answer in time: turns go on without it until it does" : "the memory store did not answer a tool call in time: tool results go on without it until it does"), { at: "tacit hook" });
        this.out[kind] = true;
      }
      this.probe(kind, WAIT[kind]);
      return;
    }
    if (outcome === "failure") {
      if (!this.failing[kind]) this.errors.capture("server", new Error("the memory store failed to answer: turns go on without it"), { at: "tacit hook" });
      this.failing[kind] = true;
    } else {
      this.failing[kind] = false;
      const kinds = session ? this.told.get(session) : undefined;
      if (kinds?.delete(kind) && !kinds.size) this.told.delete(session!);
    }
    this.out[kind] = false;
    const t = this.probing[kind];
    if (t && t !== true) clearTimeout(t);
    if (t !== true) this.probing[kind] = null;
  }

  // The probe of a kind that is out: a call that asks the store nothing (an
  // empty prompt, an unnamed tool) for no session of Keel's, so nothing is
  // given to anyone by it. Now, then after `delay`, doubling up to a minute.
  private probe(kind: Kind, delay: number) {
    if (this.probing[kind] || !this.bin) return;
    const run = async (next: number) => {
      this.probing[kind] = true;
      this.metrics.processes.probes++;
      const base = { session_id: PROBE_SESSION, cwd: this.store.stateDir, transcript_path: this.transcriptFile() };
      const r = await (kind === "ask"
        ? this.hook("prompt", { ...base, prompt: "" }, WAIT.ask, PROBE_SESSION, false)
        : this.hook("pre-tool", { ...base, tool_name: "", tool_input: {} }, WAIT.tool, PROBE_SESSION, false)).catch((): HookResult => ({ outcome: "failure", text: null }));
      this.probing[kind] = null;
      // health() ended the outage on any answer in time; a timeout scheduled nothing (a probe ran).
      if (r.outcome !== "timeout" || !this.out[kind]) return;
      const t = setTimeout(() => void run(Math.min(PROBE_MAX_MS, next * 2)), next);
      (t as { unref?: () => void }).unref?.();
      this.probing[kind] = t;
    };
    void run(delay);
  }

  // Said in the session once while its calls go unanswered: a line for the
  // owner, not for the model.
  private tell(id: string, kind: Kind, outcome: HookOutcome) {
    if (outcome !== "timeout" && outcome !== "failure") return;
    const kinds = this.told.get(id);
    if (kinds) return void kinds.add(kind);
    this.told.set(id, new Set([kind]));
    const text = outcome === "failure" ? "Memory failed to answer. This turn goes on without it."
      : kind === "ask" ? "Memory did not answer in time. This turn goes on without it; what it answers later joins the next step."
        : "Memory did not answer in time for a tool call. The turn goes on without it; what it answers later joins the next step.";
    this.bus.emit({ t: "event", event: this.store.append(id, "note", { kind: "memory_out", text }) });
  }

  // A call of a session. With its kind out it is made and not waited for,
  // one at a time per session and kind: what it answers is owed to the session.
  private call(s: Session, hook: OwedHook, payload: Record<string, unknown>, ms: number): Running {
    const kind = kindOf(hook)!;
    // The fields in the order they always had (a prompt before its transcript).
    const body = hook === "prompt" ? { session_id: s.id, cwd: s.workspace, ...payload, transcript_path: this.transcript(s) } : { session_id: s.id, cwd: s.workspace, transcript_path: this.transcript(s), ...payload };
    if (!this.out[kind]) return running(this.hook(hook, body, ms, s.id));
    const key = `${s.id} ${kind}`;
    if (this.flying.has(key)) { this.metrics.processes.not_started++; return SKIPPED; }
    this.flying.add(key);
    const r = running(this.hook(hook, body, ms, s.id, false).finally(() => this.flying.delete(key)));
    return r;
  }

  // Fetched once per session (prefetched when the session appears).
  private startCall(s: Session): Running {
    let p = this.start.get(s.id);
    if (!p) {
      p = this.call(s, "session-start", { source: "startup" }, START_WAIT_MS);
      this.start.set(s.id, p);
    }
    return p;
  }

  async startBlock(s: Session) {
    return (await this.startCall(s).done).text;
  }
  async promptBlock(s: Session, prompt: string) {
    return (await this.call(s, "prompt", { prompt }, PROMPT_WAIT_MS).done).text;
  }
  async preToolBlock(s: Session, tool: string, args: any): Promise<string | null> {
    const call = tacitToolCall(tool, args);
    return call ? (await this.call(s, "pre-tool", call, TOOL_WAIT_MS).done).text : null;
  }

  // Before compaction, and when a session is archived: tacit dreams it.
  async preCompact(s: Session) {
    if (!this.bin || !this.flags(s.id).use_memory || !this.flags(s.id).feed_memory) return;
    await this.hook("pre-compact", { session_id: s.id, cwd: s.workspace, transcript_path: this.transcript(s) }, 4000);
  }

  // The fact lines the session's context holds: those of the memory notes and
  // tool results since its last summary. Read once, then only the events that
  // came since; a new summary or another branch starts over.
  private shownIn(id: string, events: readonly StoredEvent[]): Set<string> {
    const cp = checkpointAt(events);
    const checkpoint = cp.at >= 0 ? events[cp.at]!.id : null;
    const c = this.shown.get(id);
    const at = c && c.checkpoint === checkpoint ? events.findLastIndex((e) => e.id === c.head) : -1;
    const lines = c && at >= 0 ? c.lines : new Set<string>();
    for (const e of events.slice(at >= 0 ? at + 1 : cp.keepFrom)) {
      if (e.kind === "note" && e.data.memory?.source === "tacit") for (const l of shownLines(String(e.data.text ?? ""))) lines.add(l);
      else if (e.kind === "tool_result") {
        for (const r of e.data.results ?? []) {
          const text = typeof r.content === "string" ? r.content : Array.isArray(r.content) ? r.content.map((b: any) => (b.type === "text" ? b.text : "")).join("\n") : "";
          for (const l of shownLines(text)) lines.add(l);
        }
      }
    }
    if (events.length) this.shown.set(id, { head: events.at(-1)!.id, checkpoint, lines });
    return lines;
  }

  // --- what is owed ------------------------------------------------------------

  private owe(id: string, hook: OwedHook, lines: string[]) {
    if (!lines.length || !this.store.session(id)) return;
    const q = this.store.db.query("INSERT INTO memory_owed (session_id, hook, line) VALUES (?, ?, ?)");
    this.store.db.transaction(() => { for (const l of lines) q.run(id, hook, l); })();
  }
  owed(id: string): number {
    return this.store.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM memory_owed WHERE session_id = ?").get(id)?.n ?? 0;
  }

  // A call nothing waited for: what it answers, when it does, is owed.
  private oweLater(id: string, hook: OwedHook, call: Running) {
    call.done.then((r) => { if (r.text) this.owe(id, hook, r.text.trim().split("\n").filter((l) => l.trim())); }).catch(() => {});
  }

  // One block as the turn gets it, and its row in the measurements: the lines
  // the context lacks, within a block's cap; what did not fit is owed.
  private admit(id: string, hook: OwedHook, r: HookResult, shown: Set<string>, waitMs: number): string | null {
    const path = PATH_OF[hook];
    if (!r.text) {
      this.meter.record(id, path, { outcome: r.outcome === "timeout" || r.outcome === "failure" ? r.outcome : "empty", waitMs });
      return null;
    }
    const fit = fitMemory(r.text, shown, MEMORY_CAP - FRAME);
    if (!fit.text) {
      this.meter.record(id, path, { outcome: "repeat", repeats: fit.repeats, waitMs });
      return null;
    }
    this.owe(id, hook, fit.owed);
    for (const l of fit.lines) shown.add(l);
    const block = memoryBlock(hook, fit.text);
    this.meter.record(id, path, { outcome: "added", text: block, facts: fit.lines.map(factOf), repeats: fit.repeats, cut: fit.owed.filter(isFact).length, waitMs });
    return block;
  }

  // What is owed to the session, as blocks for a note: as much as one block's
  // cap holds, oldest first, under the hook each line came from. The lines
  // that went (and those the context holds by now) leave the table; the rest
  // stays for the next request.
  private payOwed(id: string, shown: Set<string>): { hook: OwedHook; block: string }[] {
    const rows = this.store.db.query<{ id: number; hook: OwedHook; line: string }, [string]>("SELECT id, hook, line FROM memory_owed WHERE session_id = ? ORDER BY id").all(id);
    const out: { hook: OwedHook; block: string }[] = [];
    const gone: number[] = [];
    let room = MEMORY_CAP;
    for (let at = 0; at < rows.length;) {
      // A run of lines from one hook is one block.
      let end = at;
      while (end < rows.length && rows[end]!.hook === rows[at]!.hook) end++;
      const run = rows.slice(at, end);
      const hook = run[0]!.hook;
      const fit = fitMemory(run.map((r) => r.line).join("\n"), shown, room - FRAME);
      // After the first block, a line that fits no more waits whole for the next note.
      if (out.length && (room <= FRAME || fit.text?.includes(CUT))) break;
      // The rows that stay are the ones the fit left owed (matched from the end).
      const stay = new Map<string, number>();
      for (const l of fit.owed) stay.set(l, (stay.get(l) ?? 0) + 1);
      for (const r of run.toReversed()) {
        const n = stay.get(r.line) ?? 0;
        if (n) stay.set(r.line, n - 1);
        else gone.push(r.id);
      }
      if (fit.text) {
        for (const l of fit.lines) shown.add(l);
        const block = memoryBlock(hook, fit.text);
        out.push({ hook, block });
        room -= block.length;
        this.meter.record(id, "store_owed", { outcome: "added", text: block, facts: fit.lines.map(factOf), repeats: fit.repeats, cut: fit.owed.filter(isFact).length });
      }
      if (fit.owed.length) break;
      at = end;
    }
    if (gone.length) {
      const q = this.store.db.query("DELETE FROM memory_owed WHERE id = ?");
      this.store.db.transaction(() => { for (const g of gone) q.run(g); })();
    }
    return out;
  }

  // The checkpoint the store was last told of (a summary or a clear replaced the context).
  private toldCheckpoint(id: string): string | null {
    return this.store.db.query<{ checkpoint: string | null }, [string]>("SELECT checkpoint FROM memory_sessions WHERE session_id = ?").get(id)?.checkpoint ?? null;
  }
  private setCheckpoint(id: string, checkpoint: string) {
    this.store.db.query("INSERT INTO memory_sessions (session_id, checkpoint) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET checkpoint = excluded.checkpoint").run(id, checkpoint);
  }

  lineage(id: string) {
    return lineage(this.store.events(id), this.store.session(id)?.head ?? null);
  }

  forget(id: string) {
    this.start.delete(id);
    this.transcriptVersions.delete(id);
    this.told.delete(id);
    this.meter.forget(id);
  }

  // A deleted session's transcript goes with it (see `files` above); at start,
  // so do those of sessions deleted while no daemon ran.
  private removeTranscript(id: string) {
    const path = this.transcriptFile(id);
    try {
      if (!existsSync(path)) return;
      rmSync(path, { force: true });
      this.metrics.transcript.removed++;
    } catch (e) {
      this.errors.capture("server", e, { at: "tacit transcript remove", session: id });
    }
  }
  private sweepTranscripts() {
    let names: string[];
    try { names = readdirSync(dirname(this.transcriptFile("x"))); } catch { return; }
    for (const n of names) if (n.endsWith(".jsonl") && !this.store.session(n.slice(0, -".jsonl".length))) this.removeTranscript(n.slice(0, -".jsonl".length));
  }

  install() {
    const t = this;
    this.sweepTranscripts();
    registerHooks({
      async beforeRequest(s, req) {
        // Memory for a prompt joins the turn request that answers it. A summary
        // or side request sent first keeps its own messages: rebuilding them
        // from the branch would drop its ask and send the prompt in its place.
        if (req.purpose !== "turn" || !t.bin || !t.flags(s.id).use_memory) return req;
        const events = t.lineage(s.id);
        const began = performance.now();
        const blocks: string[] = [];
        const hooks: string[] = [];
        const add = (hook: OwedHook, block: string | null) => {
          if (!block) return;
          blocks.push(block);
          if (!hooks.includes(hook)) hooks.push(hook);
        };

        // A summary or a clear replaced the context since the store last heard:
        // it is told first (it then counts nothing as given), and answers with
        // the start block again. Before the prompt is asked, so that asks anew.
        const cp = checkpointAt(events);
        const checkpoint = cp.at >= 0 ? events[cp.at]! : null;
        let again: Running | null = null;
        if (checkpoint && t.toldCheckpoint(s.id) !== checkpoint.id) {
          again = t.call(s, "session-start", { source: checkpoint.data.mode === "clear" ? "clear" : "compact" }, START_WAIT_MS);
          // Told once it was really called (a call not made is made at the next request).
          if (again !== SKIPPED) t.setCheckpoint(s.id, checkpoint.id);
          if (!t.out.ask) await again.done;
        }

        // The prompt this request answers: the newest user message, with no reply after it yet.
        // (A compaction at the turn's start is stored after the prompt it leaves whole.)
        let i = events.length - 1;
        while (i >= 0 && (events[i]!.kind === "turn_start" || events[i]!.kind === "compaction" || (events[i]!.kind === "note" && !events[i]!.data.model))) i--;
        const last = events[i];
        const fresh = last?.kind === "user" && !t.done.has(last.id);
        let start: Running | null = null;
        let prompt: Running | null = null;
        if (fresh) {
          t.done.add(last.id);
          // A session's first prompt gets its start block: waited for up to
          // the start hook's own deadline, so the standing rules are in.
          if (!again && !events.slice(0, i).some((e) => e.kind === "user")) start = t.startCall(s);
          if (asksMemory(last.data)) prompt = t.call(s, "prompt", { prompt: last.data.text ?? "" }, PROMPT_WAIT_MS);
          else t.meter.record(s.id, "store_prompt", { outcome: "skipped" });
          if (!t.out.ask) await Promise.all([start?.done, prompt?.done]);
        }
        const waited = performance.now() - began;

        const shown = t.shownIn(s.id, events);
        // What earlier steps owe comes first: it was given first.
        for (const p of t.payOwed(s.id, shown)) add(p.hook, p.block);
        const settle = (hook: "session-start" | "prompt", c: Running | null, waitMs: number) => {
          if (!c) return;
          // Not made: one of this session's calls is still out unanswered. The store was not asked.
          if (c === SKIPPED) return void t.meter.record(s.id, PATH_OF[hook], { outcome: "skipped" });
          if (!c.got) {
            // Not waited for (its kind is out): what it answers is owed.
            t.meter.record(s.id, PATH_OF[hook], { outcome: "late", waitMs });
            t.oweLater(s.id, hook, c);
            t.tell(s.id, "ask", "timeout");
            return;
          }
          t.tell(s.id, "ask", c.got.outcome);
          add(hook, t.admit(s.id, hook, c.got, shown, waitMs));
        };
        settle("session-start", again ?? start, prompt ? 0 : waited);
        settle("prompt", prompt, waited);
        if (!blocks.length) return req;
        const ev = t.store.append(s.id, "note", { text: blocks.join("\n\n"), model: true, memory: { source: "tacit", hooks } });
        t.bus.emit({ t: "event", event: ev });
        return { ...req, messages: toMessages(t.lineage(s.id)) };
      },
      beforeCompact: (s) => t.preCompact(s),
      beforeTool(s, call) {
        if (!t.bin || !t.flags(s.id).use_memory) return;
        // Runs beside the tool; its answer joins the result.
        const input = tacitToolCall(call.tool.name, call.input);
        if (input) t.preTool.set(call.id, t.call(s, "pre-tool", input, TOOL_WAIT_MS));
      },
      async afterTool(s, call, result) {
        const p = t.preTool.get(call.id);
        if (!p) return;
        t.preTool.delete(call.id);
        if (p === SKIPPED) return void t.meter.record(s.id, "store_tool", { outcome: "skipped" });
        // The tool is done. A store that answers its tool calls in time is
        // waited for (the hook's deadline bounds that); while it does not,
        // an answer already there is used and one still to come is owed.
        const began = performance.now();
        if (!p.got && t.out.tool) {
          t.meter.record(s.id, "store_tool", { outcome: "late" });
          t.oweLater(s.id, "pre-tool", p);
          t.tell(s.id, "tool", "timeout");
          return;
        }
        const got = p.got ?? (await p.done.catch((): HookResult => ({ outcome: "failure", text: null })));
        t.tell(s.id, "tool", got.outcome);
        const shown = got.text ? t.shownIn(s.id, t.lineage(s.id)) : new Set<string>();
        const block = t.admit(s.id, "pre-tool", got, shown, performance.now() - began);
        if (!block) return;
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
        this.startCall(f.session);
      }
    });
  }
}
