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
// - a turn waits for a call only so long (each hook's own wait), and no
//   store process is killed before the store's own hook timeout: it may be
//   syncing its clone or recording what it gave. A call the turn stopped
//   waiting for starts an outage of its kind (asking: session-start and
//   prompt; tool: pre-tool). While it lasts the session is told once, calls
//   of that kind are still made but not waited for, and what any call
//   answers late is owed to its session like a line that did not fit. A
//   probe of its own (a call that asks nothing) ends the outage when the
//   store answers within the wait again, so the next real prompt waits as
//   usual; it is asked only while calls of that kind are being made;
// - after a summary or a clear the store is told (session-start with that
//   source), so what it gave before the context was replaced can come again;
// - one call a turn stopped waiting for is one late call, counted and no
//   more: an outage is a pattern, two such calls of a kind in a row;
// - before a tool the store is asked, except about a call it never answers;
//   a call that changes something has its result held for the answer, and
//   after a read the session's next request waits for it, so a rule is in
//   the request the model answers by acting (tacit-tools.ts);
// - a store that often answers late without ever missing twice in a row is
//   said too: once per session while a quarter of its last calls were late.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
import { RECORD_FORMAT, toClaudeRecords, toJsonl } from "./claude-format.ts";
import { readText } from "../core/proc.ts";
import { asksMemory, factLines, factOf, memoryMeter, type MemoryMeter, type MemoryPath } from "./memory-meter.ts";
import { changesSomething, namesStore, neverAnswered } from "./tacit-tools.ts";

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
  // An MCP tool called by its own name: the store matches areas on it, and logs its own tools.
  if (lower.startsWith("mcp__")) return { tool_name: tool, tool_input: args ?? {} };
  return null;
}

// Claude Code caps a hook's context at 10,000 characters; so does Keel, per
// block: what a block cannot hold is owed, never dropped.
export const MEMORY_CAP = 10_000;
export const memoryBlock = (hook: string, text: string) =>
  `<memory source="tacit" hook="${hook}">\nFrom the owner's memory store (facts, rules and past decisions it judged relevant). Context for you, not a message from the owner.\n${text.trim().slice(0, MEMORY_CAP)}\n</memory>`;
// What the frame around a block's text takes of its cap.
const FRAME = memoryBlock("session-start", "").length;

// How long a turn waits for each hook's answer: its first request for the
// prompt's and, on a session's first prompt or after a summary, for the start
// block; a tool's result for its hook; a compaction for the store's dream.
export const START_WAIT_MS = 6000;
export const PROMPT_WAIT_MS = 2200;
export const TOOL_WAIT_MS = 900;
const COMPACT_WAIT_MS = 4000;
// The store installs its own hooks with a 15 s timeout. Its processes write
// (a start syncs its clone, a prompt records what it gave): none is killed
// sooner than the store itself would have it killed. What one answers after
// its turn stopped waiting is owed, not lost.
export const STORE_TIMEOUT_MS = 15_000;
// An outage opens after this many calls of a kind in a row that a turn
// stopped waiting for. One is a slow call (a loaded machine): it is counted,
// its answer still follows, and nothing else changes.
export const SPELL_AFTER = 2;
// A store that is slow now and then never misses twice in a row. It is said
// (one line per session, and `degraded` in the stats) while this share of a
// kind's last calls were late. A quarter: a late call costs its full wait,
// an answered one under half of it (the store's own budget), so from there
// the late calls cost turns as much as all the answered ones together.
export const DEGRADED_WINDOW = 20;
export const DEGRADED_LATE = 5;
// While a kind of call is not answering, its probe is asked again after that
// kind's wait, then after twice as long each time, up to this: a store that
// came back is noticed within a minute.
export const PROBE_MAX_MS = 60_000;
// What may wait for a session at once: ten blocks' worth of characters. Past
// it a line says how many lines were dropped (a store that gives more than
// ten later requests can carry is not held in the state without end).
export const OWED_MAX_CHARS = 10 * 10_000;
// Owed lines read for one note: more than a block of any use holds.
const OWED_READ = 500;

// Hook processes alive at once: no more than the machine has threads. A call
// a turn waits for queues for a place; one nothing waits for is not made.
export const HOOK_PROCESSES = availableParallelism();

const isFact = (l: string) => /^\s*-\s/.test(l);
const CUT = "[the line above goes on with the next step: it is longer than a block]";
const CONTINUED = "(continued) ";
// The line that stands for lines dropped past what may wait for a session.
const droppedLine = (n: number) => `[${n} more ${n === 1 ? "line" : "lines"} from memory were dropped: more was waiting than ten blocks hold]`;
const DROPPED_LIKE = "[% from memory were dropped: more was waiting than ten blocks hold]";

// What a block adds: the lines the context does not hold yet (`shown`: the
// fact lines it holds), within `room` characters, whole lines, in the store's
// order. Lines that are not facts (a title, a closing remark) stay with the
// facts they frame. `owed`: the lines that did not fit, in order, for a later
// block; the block ends with a line that says how many follow. A block with
// anything new always carries at least its first new line, so what is owed
// always shrinks: a line longer than the room goes in parts, its start here
// and the rest owed first. Nothing when the context holds every fact already.
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
  // A title alone is no block: the first fact goes with it (or the rest of a
  // long line, which is part of a fact and never left behind as a title is).
  const first = Math.max(0, fresh.findIndex((l) => isFact(l) || l.startsWith(CONTINUED)));
  const least = first + 1;
  let lines = fresh.slice(0, Math.max(kept, least));
  let owed = fresh.slice(lines.length);
  if (kept < least) {
    owed = fresh.slice(first + 1);
    const one = fresh[first]!;
    const tail = owed.length ? follow(owed.length).length + 1 : 0;
    // No room for the title with it: the first new line alone. Longer than
    // the room by itself: its start and a line saying it goes on; the rest is owed first.
    if (one.length + 1 + tail <= room) lines = [one];
    else {
      const head = Math.max(1, room - CUT.length - 2 - follow(owed.length + 1).length - 1);
      lines = [one.slice(0, head), CUT];
      owed.unshift(CONTINUED + one.slice(head).replace(/^(\(continued\) )+/, ""));
    }
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
// skipped: the call was not made (no process place, or one of the same
// session and hook was still out): the store was not asked.
type HookOutcome = ProcessOutcome | "hit" | "empty" | "skipped";
const totals = () => ({ total: 0, max: 0 });
function add(stat: ReturnType<typeof totals>, value: number) {
  stat.total += value;
  stat.max = Math.max(stat.max, value);
}
const hookStats = () => ({
  outcomes: { hit: 0, empty: 0, failure: 0, timeout: 0, ok: 0 } satisfies Record<Exclude<HookOutcome, "skipped">, number>,
  duration_ms: totals(),
  context_bytes: totals(),
  // Calls that did not answer within the hook's wait: a turn waited that
  // long and went on, or nobody waited and the answer came later than that.
  late: 0,
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

type TranscriptMark = { head: Session["head"]; model: string; workspace: string; stamp: string; last: string | null };
type HookResult = { outcome: HookOutcome; text: string | null; ms?: number };
// The answers one request waits for; `counted`: their lateness was counted.
type StepAnswers = { answers: { call: Running; owed: Promise<unknown> }[]; counted?: boolean };
// A hook call that may still be running: `got` is set when it ended; `at`: when it was made.
type Running = { got?: HookResult; done: Promise<HookResult>; at: number };
const running = (done: Promise<HookResult>): Running => {
  const r: Running = { done, at: performance.now() };
  done.then((got) => { r.got = got; });
  return r;
};
const NOTHING: HookResult = { outcome: "empty", text: null };
const NOT_MADE: HookResult = { outcome: "skipped", text: null };
const SKIPPED: Running = { got: NOT_MADE, done: Promise.resolve(NOT_MADE), at: 0 };
// Waits for a call's answer at most `ms`: `got` is set when it came in time.
const within = (c: Running, ms: number): Promise<unknown> => (c.got ? Promise.resolve() : Promise.race([c.done, Bun.sleep(ms)]));

// The two kinds of call a turn waits for: asking (session-start and prompt
// go through the store's query) and a tool's push. Each has its own outage.
type Kind = "ask" | "tool";
const kindOf = (hook: Hook): Kind | null => (hook === "pre-tool" ? "tool" : hook === "pre-compact" ? null : "ask");
const WAIT_OF: Record<Hook, number> = { "session-start": START_WAIT_MS, prompt: PROMPT_WAIT_MS, "pre-tool": TOOL_WAIT_MS, "pre-compact": COMPACT_WAIT_MS };
// What a kind's probe waits: the wait of its quick hook.
const PROBE_WAIT: Record<Kind, number> = { ask: PROMPT_WAIT_MS, tool: TOOL_WAIT_MS };
type OwedHook = "session-start" | "prompt" | "pre-tool";
const PATH_OF: Record<OwedHook, MemoryPath> = { "session-start": "store_start", prompt: "store_prompt", "pre-tool": "store_tool" };
// The session id the probes call the store with: no session of Keel's.
const PROBE_SESSION = "keel-probe";

export class Tacit {
  bin: string | null;
  private start = new Map<string, Running>();
  private done = new Set<string>(); // user events already answered
  // A tool call's hook, and whether its result is held for the answer.
  private preTool = new Map<string, { call: Running; holds: Promise<boolean> }>();
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
  // Calls nothing waits for, one at a time per session and hook ("<session> <hook>"):
  // a prompt goes out beside the start call it came with.
  private flying = new Set<string>();
  // Whether a call of each kind was made since its last probe: a probe is
  // asked again only while someone is asking.
  private called: Record<Kind, boolean> = { ask: false, tool: false };
  // Sessions whose start call was not made (no place for it): made with their next request.
  private startOwed = new Set<string>();
  // Calls of each kind in a row that a turn stopped waiting for.
  private misses: Record<Kind, number> = { ask: 0, tool: 0 };
  // Per session, the answers of one step's reads still on their way: its
  // next request waits for them. One step's late answers are one missed wait.
  private toolAnswers = new Map<string, StepAnswers>();
  // Whether each kind's last calls were late, newest last; and the sessions
  // told that a kind answers slowly, until that kind no longer does.
  private recent: Record<Kind, boolean[]> = { ask: [], tool: [] };
  private slowTold: Record<Kind, Set<string>> = { ask: new Set(), tool: new Set() };
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
  // What each session's transcript file holds: the branch end it was written
  // up to, the model and folder it was encoded with, and the file as it was
  // left (`stamp`). `last`: the uuid of the file's last record, which the next
  // ones hang under. No transcript bytes are kept here. The same is kept on
  // disk beside the file (`<id>.mark`), so a daemon that starts, or a session
  // that dropped out of this map, goes on appending to the file it finds
  // instead of encoding and writing the whole session again.
  private transcriptVersions = new SessionMap<TranscriptMark>(64);
  private readonly metrics = {
    since_ms: Date.now(),
    hooks: { "session-start": hookStats(), prompt: hookStats(), "pre-tool": hookStats(), "pre-compact": hookStats() } satisfies Record<Hook, ReturnType<typeof hookStats>>,
    transcript: { reused: 0, appended: 0, rebuilt: 0, failed: 0, removed: 0, duration_ms: totals(), bytes: totals() },
    // Hook processes: the most alive at once, calls not made because one of
    // their session and kind was already out unanswered, and probes run.
    processes: { max: 0, limit: 0, not_started: 0, probes: 0 },
    // Lines dropped because more was owed to a session than may wait for it.
    owed_dropped: 0,
    // Tool calls the store was not asked about (it never answers such a
    // call), and results not held for an answer that had not come (the call
    // changed nothing). `request_waits`: requests that waited for a read's
    // answer still on its way, and how long in all.
    tools: { never_answered: 0, not_held: 0, request_waits: 0, request_wait_ms: 0 },
  };

  // `speed`: every wait and deadline is divided by it. 1 in use; the unit
  // tests run the same rules against a stand-in in a fraction of the time.
  constructor(private store: Store, private bus: Bus, private errors: ErrorTracker, bin = findBin("TACIT_BIN", "tacit"), private speed = 1) {
    this.bin = bin;
    this.meter = memoryMeter(store);
    void this.files;
    this.metrics.processes.limit = HOOK_PROCESSES;
    // memory_owed: lines the store gave that have not reached the model yet
    // (a block was full, or the answer came after its request went). They
    // outlive a restart: the store will not give them again. `answer` marks
    // the lines of one answer no block has carried yet: it gets a block of
    // its own, as it would have had in its tool result.
    // memory_sessions: the checkpoint the store was last told of.
    store.migrate(`CREATE TABLE IF NOT EXISTS memory_flags (session_id TEXT PRIMARY KEY, use_memory INTEGER NOT NULL DEFAULT 1, feed_memory INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS memory_owed (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, hook TEXT NOT NULL, line TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS memory_owed_session ON memory_owed(session_id, id);
CREATE TABLE IF NOT EXISTS memory_sessions (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, checkpoint TEXT);`);
    if (!store.db.query<{ name: string }, []>("PRAGMA table_info(memory_owed)").all().some((c) => c.name === "answer")) store.db.exec("ALTER TABLE memory_owed ADD COLUMN answer INTEGER");
  }

  // `out`: the kinds of call the store is not answering in time right now;
  // `degraded`: the kinds a quarter of whose last calls were late.
  stats() {
    return { ...this.metrics, out: { ...this.out }, degraded: { ask: this.degraded("ask"), tool: this.degraded("tool") } };
  }

  flags(id: string): Flags {
    const r = this.store.db.query<{ use_memory: number; feed_memory: number }, [string]>("SELECT use_memory, feed_memory FROM memory_flags WHERE session_id = ?").get(id);
    return { use_memory: r ? !!r.use_memory : true, feed_memory: r ? !!r.feed_memory : true };
  }

  setFlags(id: string, patch: Partial<Flags>): Flags | { error: string } {
    const now = this.flags(id);
    // Fixed once the first message is sent: what the model saw stays what it saw.
    if (patch.use_memory !== undefined && patch.use_memory !== now.use_memory && this.store.hasKind(id, "user"))
      return { error: "memory use is fixed once the first message is sent" };
    const next = { ...now, ...patch };
    this.store.db
      .query("INSERT INTO memory_flags (session_id, use_memory, feed_memory) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET use_memory = excluded.use_memory, feed_memory = excluded.feed_memory")
      .run(id, next.use_memory ? 1 : 0, next.feed_memory ? 1 : 0);
    if (!next.feed_memory) this.dropMark(id);
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

  // Where the session's transcript stands: from memory, else from the mark
  // beside the file (read once, then held here).
  private markFile(id: string): string {
    return join(this.store.stateDir, "transcripts", `${id}.mark`);
  }
  private markOf(id: string): TranscriptMark | undefined {
    const held = this.transcriptVersions.get(id);
    if (held) return held;
    let m: any;
    try { m = JSON.parse(readFileSync(this.markFile(id), "utf8")); } catch { return undefined; }
    // (A mark from before the format was kept is of the first one.)
    if (!m || (m.format ?? 1) !== RECORD_FORMAT) return undefined;
    if (typeof m.model !== "string" || typeof m.workspace !== "string" || typeof m.stamp !== "string" || (m.head !== null && typeof m.head !== "string") || (m.last !== null && typeof m.last !== "string")) return undefined;
    const mark: TranscriptMark = { head: m.head, model: m.model, workspace: m.workspace, stamp: m.stamp, last: m.last };
    this.transcriptVersions.set(id, mark);
    return mark;
  }
  // Written after the file: a daemon killed between the two finds a mark
  // that is not the file's, and writes the transcript whole.
  private setMark(id: string, mark: TranscriptMark) {
    this.transcriptVersions.set(id, mark);
    // Whole or not at all: a file of its own, then its name (a reader never finds half a mark).
    const path = this.markFile(id), tmp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ format: RECORD_FORMAT, ...mark }), { mode: 0o600, flag: "wx" });
      renameSync(tmp, path);
    } catch {
      // Without it the next daemon writes the transcript whole, as before marks were kept.
      try { rmSync(tmp, { force: true }); } catch {}
    }
  }
  private dropMark(id: string) {
    this.transcriptVersions.delete(id);
    try { rmSync(this.markFile(id), { force: true }); } catch {}
  }

  // The bodies transcript() is about to read (the events stored since the file was written, or all
  // of them for a file it writes whole), read off the loop first: a session at rest holds none, and
  // read back on the loop they wait for the disk. Nothing is read for a file that is up to date.
  private async warmTranscript(s: Session) {
    try {
      if (!this.flags(s.id).feed_memory) return;
      const current = this.store.session(s.id);
      if (!current) return;
      const stamp = fileStamp(this.transcriptFile(s.id));
      const cached = stamp === undefined ? undefined : this.markOf(s.id);
      const same = !!cached && cached.model === current.model && cached.workspace === current.workspace && cached.stamp === stamp;
      if (cached && same && cached.head === current.head) return;
      await this.store.warm(s.id, false);
      const line = this.store.lineage(s.id);
      let at = -1;
      if (cached && same) for (let i = line.length - 1; i >= 0; i--) if (line[i]!.id === cached.head) { at = i; break; }
      const from = line[at + 1];
      if (from) await this.store.warmBodies(s.id, from.seq);
    } catch {
      // What could not be read ahead is read by transcript(), as it was.
    }
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
      const stamp = fileStamp(path);
      const cached = stamp === undefined ? undefined : this.markOf(s.id);
      const same = !!cached && cached.model === model && cached.workspace === workspace && cached.stamp === stamp;
      if (cached && same && cached.head === head) {
        stat.reused++;
        return path;
      }
      // The branch only grew since the file was written (the usual case: a
      // prompt, a reply, a tool result): the new events are appended, as the
      // format's own writer does, and the file is not encoded and written
      // whole again on every hook call. Where the file ends is looked for
      // from the branch's end back, on the branch as the store keeps it: a
      // call costs the events that came since, not the session's length.
      const line = this.store.lineage(s.id);
      let at = -1;
      if (cached && same) for (let i = line.length - 1; i >= 0; i--) if (line[i]!.id === cached.head) { at = i; break; }
      if (cached && at >= 0) {
        const records = toClaudeRecords(current, line.slice(at + 1), s.id, { parent: cached.last });
        const bytes = Buffer.from(toJsonl(records));
        if (bytes.length) appendFileSync(path, bytes);
        const after = fileStamp(path);
        if (after !== undefined) this.setMark(s.id, { head, model, workspace, stamp: after, last: (records.at(-1)?.uuid as string | undefined) ?? cached.last });
        else this.dropMark(s.id);
        stat.appended++;
        add(stat.bytes, bytes.length);
        return path;
      }
      this.dropMark(s.id);
      mkdirSync(dirname(path), { recursive: true });
      // Encode once for the write and reuse its byte length.
      const records = toClaudeRecords(current, line);
      const bytes = Buffer.from(toJsonl(records));
      writeTranscript(path, bytes);
      const written = fileStamp(path);
      if (written !== undefined) this.setMark(s.id, { head, model, workspace, stamp: written, last: (records.at(-1)?.uuid as string | undefined) ?? null });
      stat.rebuilt++;
      add(stat.bytes, bytes.length);
    } catch (e) {
      stat.failed++;
      this.errors.capture("server", e, { at: "tacit transcript", session: s.id });
      // Keep the hook fail-open without handing it a previous version.
      this.dropMark(s.id);
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

  // One hook process, killed no sooner than the store's own timeout.
  // `session`: whose call it is (a probe's is nobody's). `wait`: a call
  // something waits for queues for a place; one nothing waits for is not made
  // when there is none.
  private async hook(hook: Hook, payload: unknown, session?: string, wait = true): Promise<HookResult> {
    if (!this.bin) return NOTHING;
    if (!(await this.place(wait))) { this.metrics.processes.not_started++; return NOT_MADE; }
    const started = performance.now();
    const argv = [this.bin, "hook", hook];
    if (hook !== "pre-compact") argv.push("--mcp");
    const result = await runBoundedResult(argv, JSON.stringify(payload), STORE_TIMEOUT_MS / this.speed).finally(() => this.leave());
    let outcome: Exclude<HookOutcome, "skipped"> = result.outcome;
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
    const ms = performance.now() - started;
    if (session !== PROBE_SESSION) {
      const stat = this.metrics.hooks[hook];
      stat.outcomes[outcome]++;
      add(stat.duration_ms, ms);
      if (text) add(stat.context_bytes, Buffer.byteLength(text.slice(0, MEMORY_CAP)));
    }
    const kind = kindOf(hook);
    if (kind) this.ended(kind, outcome, ms <= this.waitOf(hook), session);
    return { outcome, text, ms };
  }

  // How long a turn waits for a hook's answer.
  private waitOf(hook: Hook): number {
    return WAIT_OF[hook] / this.speed;
  }

  // A call did not answer within its wait: one late call, counted. Two of a
  // kind in a row, with no answer in time between them, open an outage. Many
  // among answered ones are said to the session they held up (`session`).
  private miss(kind: Kind, hook: Hook, session?: string) {
    this.metrics.hooks[hook].late++;
    this.seen(kind, true);
    if (++this.misses[kind] >= SPELL_AFTER) this.markOut(kind);
    else if (session && this.degraded(kind) && !this.slowTold[kind].has(session)) {
      this.slowTold[kind].add(session);
      const late = this.recent[kind].filter(Boolean).length;
      this.bus.emit({ t: "event", event: this.store.append(session, "note", { kind: "memory_slow", text: `Memory is answering slowly: ${late} of its last ${DEGRADED_WINDOW} ${kind === "ask" ? "answers to prompts" : "answers before a tool"} came later than a turn waits. Turns go on without the late ones; what they answer follows.` }) });
    }
  }
  private seen(kind: Kind, late: boolean) {
    const r = this.recent[kind];
    r.push(late);
    if (r.length > DEGRADED_WINDOW) r.shift();
    if (!this.degraded(kind)) this.slowTold[kind].clear();
  }
  private degraded(kind: Kind): boolean {
    return this.recent[kind].length >= DEGRADED_WINDOW && this.recent[kind].filter(Boolean).length >= DEGRADED_LATE;
  }
  // The answers a request may wait for came late: one missed wait, however
  // many they are, whoever finds out first (the request, or their own clock).
  private lateOnce(session: string, group: StepAnswers) {
    if (group.counted) return;
    group.counted = true;
    this.miss("tool", "pre-tool", session);
  }

  // A kind of call is out: recorded once, and its probe starts.
  private markOut(kind: Kind) {
    if (!this.out[kind]) {
      this.errors.capture("server", new Error(kind === "ask" ? "the memory store did not answer in time: turns go on without it until it does" : "the memory store did not answer a tool call in time: tool results go on without it until it does"), { at: "tacit hook" });
      this.out[kind] = true;
    }
    this.probe(kind);
  }

  // How a call ended. An answer within its hook's wait ends an outage; one
  // that came later is owed by whoever made the call and changes nothing
  // (the store still takes longer than a turn waits). A failing store answers
  // at once, so nothing waits long for it: it is recorded once, and told.
  private ended(kind: Kind, outcome: HookOutcome, inTime: boolean, session?: string) {
    // Late, or ended by the store's own timeout: whoever waited for it counted it.
    if (outcome === "timeout" || !inTime || outcome === "skipped") return;
    this.misses[kind] = 0;
    this.seen(kind, false);
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
  // given to anyone by it. Now, then after that kind's wait, doubling up to a
  // minute, and only while calls of that kind are being made: with nobody
  // asking, nothing waits to know, and the next real call starts it again.
  private probe(kind: Kind) {
    if (this.probing[kind] || !this.bin) return;
    const run = async (next: number) => {
      this.probing[kind] = true;
      this.metrics.processes.probes++;
      this.called[kind] = false;
      const base = { session_id: PROBE_SESSION, cwd: this.store.stateDir, transcript_path: this.transcriptFile() };
      const c = running((kind === "ask"
        ? this.hook("prompt", { ...base, prompt: "" }, PROBE_SESSION, false)
        : this.hook("pre-tool", { ...base, tool_name: "", tool_input: {} }, PROBE_SESSION, false)).catch((): HookResult => ({ outcome: "failure", text: null })));
      await within(c, PROBE_WAIT[kind] / this.speed);
      this.probing[kind] = null;
      if (!this.out[kind]) return; // answered within the wait (ended() saw it), or a real call did
      const t = setTimeout(() => {
        this.probing[kind] = null;
        if (this.out[kind] && this.called[kind]) void run(Math.min(PROBE_MAX_MS / this.speed, next * 2));
      }, next);
      (t as { unref?: () => void }).unref?.();
      this.probing[kind] = t;
    };
    void run(PROBE_WAIT[kind] / this.speed);
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
  // one at a time per session and hook: what it answers is owed to the session.
  // While its kind answers, a call queues for a process place: it is never left out.
  private call(s: Session, hook: OwedHook, payload: Record<string, unknown>): Running {
    const kind = kindOf(hook)!;
    this.called[kind] = true;
    // The fields in the order they always had (a prompt before its transcript).
    const body = hook === "prompt" ? { session_id: s.id, cwd: s.workspace, ...payload, transcript_path: this.transcript(s) } : { session_id: s.id, cwd: s.workspace, transcript_path: this.transcript(s), ...payload };
    if (!this.out[kind]) return running(this.hook(hook, body, s.id));
    // Out with nobody probing (no call was made for a while): this call starts it again.
    this.probe(kind);
    const key = `${s.id} ${hook}`;
    if (this.flying.has(key)) { this.metrics.processes.not_started++; return SKIPPED; }
    this.flying.add(key);
    return running(this.hook(hook, body, s.id, false).finally(() => this.flying.delete(key)));
  }

  // Fetched once per session (prefetched when the session appears). A call
  // that was not made is not kept: the session's next request makes it.
  private startCall(s: Session): Running {
    let p = this.start.get(s.id);
    if (p) return p;
    p = this.call(s, "session-start", { source: "startup" });
    if (p === SKIPPED) { this.startOwed.add(s.id); return p; }
    this.start.set(s.id, p);
    p.done.then((r) => {
      if (r.outcome === "skipped") { this.start.delete(s.id); this.startOwed.add(s.id); } else this.startOwed.delete(s.id);
    });
    return p;
  }

  // One hook's answer for a session, waited for as a turn waits for it.
  private async answer(c: Running, hook: OwedHook, id: string): Promise<string | null> {
    await within(c, this.waitOf(hook));
    if (c.got) return c.got.text;
    this.miss(kindOf(hook)!, hook);
    this.oweLater(id, hook, c);
    return null;
  }
  startBlock(s: Session) {
    return this.answer(this.startCall(s), "session-start", s.id);
  }
  async promptBlock(s: Session, prompt: string) {
    await this.warmTranscript(s);
    return this.answer(this.call(s, "prompt", { prompt }), "prompt", s.id);
  }
  async preToolBlock(s: Session, tool: string, args: any): Promise<string | null> {
    const call = tacitToolCall(tool, args);
    if (call) await this.warmTranscript(s);
    return call ? this.answer(this.call(s, "pre-tool", call), "pre-tool", s.id) : null;
  }

  // Before compaction, and when a session is archived: tacit dreams it. The
  // compaction waits for it so long; the process may go on.
  async preCompact(s: Session) {
    if (!this.bin || !this.flags(s.id).use_memory || !this.flags(s.id).feed_memory) return;
    await this.warmTranscript(s);
    await within(running(this.hook("pre-compact", { session_id: s.id, cwd: s.workspace, transcript_path: this.transcript(s) })), this.waitOf("pre-compact"));
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

  // Lines the store gave that wait for a later request. What may wait is
  // bounded: past it the lines are dropped and one line, owed like the rest,
  // says how many (a store that gives more than ten later requests can carry).
  // `whole`: the lines are one answer no block has carried yet.
  private owe(id: string, hook: OwedHook, lines: string[], whole = false) {
    if (!lines.length || !this.store.session(id)) return;
    const db = this.store.db;
    let have = db.query<{ n: number }, [string]>("SELECT COALESCE(SUM(LENGTH(line)), 0) AS n FROM memory_owed WHERE session_id = ?").get(id)?.n ?? 0;
    const q = db.query("INSERT INTO memory_owed (session_id, hook, line, answer) VALUES (?, ?, ?, ?)");
    let dropped = 0;
    db.transaction(() => {
      // An answer is named by the row of its first line.
      let answer: number | null = null;
      for (const l of lines) {
        if (have + l.length > OWED_MAX_CHARS) { dropped++; continue; }
        const row: number = Number(q.run(id, hook, l, answer).lastInsertRowid);
        if (whole && answer === null) {
          answer = row;
          db.query("UPDATE memory_owed SET answer = ? WHERE id = ?").run(row, row);
        }
        have += l.length;
      }
      if (!dropped) return;
      // One line for all that was dropped, last in the queue.
      const old = db.query<{ id: number; line: string }, [string]>(`SELECT id, line FROM memory_owed WHERE session_id = ? AND line LIKE '${DROPPED_LIKE}' ORDER BY id DESC LIMIT 1`).get(id);
      if (old) db.query("DELETE FROM memory_owed WHERE id = ?").run(old.id);
      q.run(id, hook, droppedLine(dropped + Number(/\d+/.exec(old?.line ?? "")?.[0] ?? 0)), null);
    })();
    if (dropped) this.metrics.owed_dropped += dropped;
  }
  owed(id: string): number {
    return this.store.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM memory_owed WHERE session_id = ?").get(id)?.n ?? 0;
  }

  // A call nothing waited for: what it answers, when it does, is owed.
  private oweLater(id: string, hook: OwedHook, call: Running): Promise<unknown> {
    return call.done.then((r) => { if (r.text) this.owe(id, hook, r.text.trim().split("\n").filter((l) => l.trim()), true); }).catch(() => {});
  }

  // One block as the turn gets it, and its row in the measurements: the lines
  // the context lacks, within a block's cap; what did not fit is owed.
  // `by`: what the block answers (the prompt's event, the tool and its call),
  // kept with each fact's name for the list of what the session was given.
  private admit(id: string, hook: OwedHook, r: HookResult, shown: Set<string>, waitMs: number, by: { hook?: string; call?: string; ref?: string } = {}): string | null {
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
    this.meter.record(id, path, { outcome: "added", text: block, facts: fit.lines.map(factOf), repeats: fit.repeats, cut: fit.owed.filter(isFact).length, waitMs, by: { hook, ...by } });
    return block;
  }

  // What is owed to the session, as blocks for a note, oldest first, under
  // the hook each line came from. An answer no block has carried yet gets a
  // block of its own, as it would have had in its tool result or its note:
  // nothing waits a step because another answer took the room. The lines
  // left over from blocks that were full share one block's cap. The lines
  // that went (and those the context holds by now) leave the table; the rest
  // stays for the next request.
  private payOwed(id: string, shown: Set<string>): { hook: OwedHook; block: string }[] {
    const rows = this.store.db.query<{ id: number; hook: OwedHook; line: string; answer: number | null }, [string, number]>("SELECT id, hook, line, answer FROM memory_owed WHERE session_id = ? ORDER BY id LIMIT ?").all(id, OWED_READ);
    const out: { hook: OwedHook; block: string }[] = [];
    const gone: number[] = [];
    const parts: { id: number; line: string }[] = [];
    // The room the left-over lines share, the blocks they made, and whether they have to wait from here.
    let room = MEMORY_CAP, shared = 0, full = false;
    for (let at = 0, end = 0; at < rows.length; at = end) {
      // A run of lines from one hook, and of one answer, is one block.
      end = at;
      while (end < rows.length && rows[end]!.hook === rows[at]!.hook && rows[end]!.answer === rows[at]!.answer) end++;
      const run = rows.slice(at, end);
      const hook = run[0]!.hook;
      const own = run[0]!.answer !== null;
      if (!own && full) continue;
      const fit = fitMemory(run.map((r) => r.line).join("\n"), shown, (own ? MEMORY_CAP : room) - FRAME);
      // After their first block, left-over lines that fit no more wait whole for the next note.
      if (!own && shared && (room <= FRAME || fit.text?.includes(CUT))) { full = true; continue; }
      // The rows that stay are the ones the fit left owed (matched from the end).
      const stay = new Map<string, number>();
      for (const l of fit.owed) stay.set(l, (stay.get(l) ?? 0) + 1);
      const went: typeof run = [];
      for (const r of run.toReversed()) {
        const n = stay.get(r.line) ?? 0;
        if (n) stay.set(r.line, n - 1);
        else went.unshift(r);
      }
      // A line longer than the block went in part: its row keeps the rest.
      const rest = fit.owed.find((l) => l.startsWith(CONTINUED) && (stay.get(l) ?? 0) > 0);
      const cut = rest ? went.find((r) => r.line.endsWith(rest.slice(CONTINUED.length))) : undefined;
      if (rest && cut) parts.push({ id: cut.id, line: rest });
      for (const r of went) if (r !== cut) gone.push(r.id);
      if (fit.text) {
        for (const l of fit.lines) shown.add(l);
        const block = memoryBlock(hook, fit.text);
        out.push({ hook, block });
        if (!own) { room -= block.length; shared++; }
        this.meter.record(id, "store_owed", { outcome: "added", text: block, facts: fit.lines.map(factOf), repeats: fit.repeats, cut: fit.owed.filter(isFact).length, by: { hook } });
      }
      if (!own && fit.owed.length) full = true;
    }
    if (gone.length || parts.length) {
      const del = this.store.db.query("DELETE FROM memory_owed WHERE id = ?");
      const upd = this.store.db.query("UPDATE memory_owed SET line = ? WHERE id = ?");
      this.store.db.transaction(() => {
        for (const g of gone) del.run(g);
        for (const p of parts) upd.run(p.line, p.id);
      })();
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

  // The branch the session shows, as the store keeps it (the same events in the same order as a walk over every event).
  lineage(id: string): readonly StoredEvent[] {
    return this.store.lineage(id);
  }

  forget(id: string) {
    this.start.delete(id);
    this.transcriptVersions.delete(id);
    this.told.delete(id);
    this.startOwed.delete(id);
    this.toolAnswers.delete(id);
    this.slowTold.ask.delete(id);
    this.slowTold.tool.delete(id);
    this.meter.forget(id);
  }

  // A deleted session's transcript goes with it (see `files` above); at start,
  // so do those of sessions deleted while no daemon ran.
  private removeTranscript(id: string) {
    const path = this.transcriptFile(id);
    try {
      rmSync(this.markFile(id), { force: true });
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
    for (const n of names) for (const end of [".jsonl", ".mark"]) if (n.endsWith(end) && !this.store.session(n.slice(0, -end.length))) this.removeTranscript(n.slice(0, -end.length));
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
        // The answers of the last step's reads still on their way: the model
        // is about to act on what it read, so a rule that came with a read
        // must be in this request. Each is waited for what is left of the
        // hook's wait since its call was made (it ran beside its tool, so
        // usually nothing is left to wait).
        const pending = t.toolAnswers.get(s.id);
        if (pending) {
          t.toolAnswers.delete(s.id);
          if (!t.out.tool) {
            const t0 = performance.now(), toolWait = t.waitOf("pre-tool");
            await Promise.all(pending.answers.map((e) => Promise.race([e.owed, Bun.sleep(Math.max(0, toolWait - (performance.now() - e.call.at)))])));
            t.metrics.tools.request_waits++;
            t.metrics.tools.request_wait_ms += performance.now() - t0;
            if (pending.answers.some((e) => !e.call.got)) {
              t.lateOnce(s.id, pending);
              if (t.out.tool) t.tell(s.id, "tool", "timeout");
            }
          }
        }
        const events = t.lineage(s.id);
        const began = performance.now();
        const blocks: string[] = [];
        const hooks: string[] = [];
        const add = (hook: OwedHook, block: string | null) => {
          if (!block) return;
          blocks.push(block);
          if (!hooks.includes(hook)) hooks.push(hook);
        };

        // Whether this request waits for asking calls: not while the store is not answering them in time.
        const waits = !t.out.ask;
        // A summary or a clear replaced the context since the store last heard:
        // it is told first (it then counts nothing as given), and answers with
        // the start block again. Before the prompt is asked, so that asks anew.
        const cp = checkpointAt(events);
        const checkpoint = cp.at >= 0 ? events[cp.at]! : null;
        let again: Running | null = null;
        if (checkpoint && t.toldCheckpoint(s.id) !== checkpoint.id) {
          const source = checkpoint.data.mode === "clear" ? "clear" : "compact";
          again = t.call(s, "session-start", { source });
          if (again !== SKIPPED) {
            // Told once the call answered: one that did not is made again with the next request.
            again.done.then((r) => { if (r.outcome === "hit" || r.outcome === "empty") t.setCheckpoint(s.id, checkpoint.id); }).catch(() => {});
            // After a clear the store counts nothing as given and gives it
            // again when asked: what was owed from before is not carried into the fresh context.
            if (source === "clear") t.store.db.query("DELETE FROM memory_owed WHERE session_id = ?").run(s.id);
            if (waits) await within(again, t.waitOf("session-start"));
          }
        }

        // The prompt this request answers: the newest user message, with no reply after it yet.
        // (A compaction at the turn's start is stored after the prompt it leaves whole.)
        let i = events.length - 1;
        while (i >= 0 && (events[i]!.kind === "turn_start" || events[i]!.kind === "compaction" || (events[i]!.kind === "note" && !events[i]!.data.model))) i--;
        const last = events[i];
        const fresh = last?.kind === "user" && !t.done.has(last.id);
        let start: Running | null = null;
        let prompt: Running | null = null;
        // A session's first prompt gets its start block (waited for up to the
        // start hook's own wait, so the standing rules are in); so does one
        // whose start call could not be made before.
        if (!again && ((fresh && !events.slice(0, i).some((e) => e.kind === "user")) || t.startOwed.has(s.id))) start = t.startCall(s);
        if (fresh) {
          t.done.add(last.id);
          if (asksMemory(last.data)) prompt = t.call(s, "prompt", { prompt: last.data.text ?? "" });
          else t.meter.record(s.id, "store_prompt", { outcome: "skipped" });
        }
        if (waits) await Promise.all([start && within(start, t.waitOf("session-start")), prompt && within(prompt, t.waitOf("prompt"))]);
        const waited = performance.now() - began;

        const shown = t.shownIn(s.id, events);
        // What earlier steps owe comes first: it was given first.
        for (const p of t.payOwed(s.id, shown)) add(p.hook, p.block);
        const settle = (hook: "session-start" | "prompt", c: Running | null, waitMs: number, by?: { hook?: string; ref?: string }) => {
          if (!c) return;
          // Not made: one of this session's calls of this hook is still out. The store was not asked.
          if (c === SKIPPED || c.got?.outcome === "skipped") return void t.meter.record(s.id, PATH_OF[hook], { outcome: "skipped" });
          if (!c.got) {
            // The turn goes on without it: what it answers is owed. Waited for
            // and not there in time, it starts an outage of asking.
            // Measured as a timeout when the turn waited its full wait for it,
            // as late when it did not wait at all (asking was already out).
            if (waits) t.miss("ask", hook, s.id);
            t.meter.record(s.id, PATH_OF[hook], { outcome: waits ? "timeout" : "late", waitMs });
            t.oweLater(s.id, hook, c);
            if (t.out.ask) t.tell(s.id, "ask", "timeout");
            return;
          }
          t.tell(s.id, "ask", c.got.outcome);
          add(hook, t.admit(s.id, hook, c.got, shown, waitMs, by));
        };
        // A start block that came again says why: the context was summarized, or cleared.
        settle("session-start", again ?? start, prompt ? 0 : waited, again ? { hook: `session-start:${checkpoint?.data.mode === "clear" ? "clear" : "compact"}` } : undefined);
        settle("prompt", prompt, waited, fresh ? { ref: last.id } : undefined);
        if (!blocks.length) return req;
        const ev = t.store.append(s.id, "note", { text: blocks.join("\n\n"), model: true, memory: { source: "tacit", hooks } });
        t.bus.emit({ t: "event", event: ev });
        return { ...req, messages: toMessages(t.lineage(s.id)) };
      },
      beforeCompact: (s) => t.preCompact(s),
      beforeTool(s, call) {
        if (!t.bin || !t.flags(s.id).use_memory) return;
        const input = tacitToolCall(call.tool.name, call.input);
        if (!input) return;
        // Not asked about a call the store never answers. Every other call is
        // asked, every time: nothing says when the store last changed, so an
        // empty answer is not remembered. A call the store records as a step
        // in itself is always made.
        if (!namesStore(input) && neverAnswered(s.workspace, input)) {
          t.metrics.tools.never_answered++;
          return void t.meter.record(s.id, "store_tool", { outcome: "skipped" });
        }
        // Whether the call changes something, where that is known now (a
        // dispatched MCP tool's server says so a moment later).
        const direct = input.tool_name.startsWith("mcp__") && !call.tool.target;
        const changes = direct ? !call.tool.readOnly : changesSomething(input);
        // Runs beside the tool; its answer joins the result, or the next request.
        const p = t.call(s, "pre-tool", input);
        // Whether the result is held for the answer: only for a call that changes something.
        const holds = call.tool.target ? call.tool.target(call.input, s.id).then((x) => changesSomething(input, x), () => true) : Promise.resolve(changes);
        t.preTool.set(call.id, { call: p, holds });
      },
      async afterTool(s, call, result) {
        const entry = t.preTool.get(call.id);
        if (!entry) return;
        t.preTool.delete(call.id);
        const p = entry.call;
        if (p === SKIPPED) return void t.meter.record(s.id, "store_tool", { outcome: "skipped" });
        // The tool is done. A call that changed something has its result held
        // for the answer, the hook's own wait, while the store answers its
        // tool calls in time: its rule is in that result. A read's result is
        // not held: an answer already there is used, one still to come is
        // owed, and the session's next request waits for it.
        const began = performance.now();
        const holds = p.got ? false : await entry.holds;
        const waits = holds && !t.out.tool;
        const toolWait = t.waitOf("pre-tool");
        if (waits) await within(p, toolWait);
        if (p.got?.outcome === "skipped") return void t.meter.record(s.id, "store_tool", { outcome: "skipped" });
        // A call slower than the hook's wait is a late call whoever waited.
        const slow = (r: HookResult) => r.outcome === "timeout" || (r.outcome !== "skipped" && (r.ms ?? 0) > toolWait);
        if (!p.got) {
          t.meter.record(s.id, "store_tool", { outcome: waits ? "timeout" : "late", waitMs: performance.now() - began });
          const owed = t.oweLater(s.id, "pre-tool", p);
          if (waits) {
            t.miss("tool", "pre-tool", s.id);
            if (t.out.tool) t.tell(s.id, "tool", "timeout");
            return;
          }
          if (!holds) t.metrics.tools.not_held++;
          // Counted as late when its wait runs out, by the next request or, with none, by its own clock.
          let group: StepAnswers = { answers: [] };
          if (!holds && !t.out.tool) {
            group = t.toolAnswers.get(s.id) ?? group;
            group.answers.push({ call: p, owed });
            t.toolAnswers.set(s.id, group);
          }
          within(p, Math.max(0, toolWait - (performance.now() - p.at))).then(() => { if (!p.got || slow(p.got)) t.lateOnce(s.id, group); }).catch(() => {});
          return;
        }
        const got = p.got;
        if (slow(got)) t.miss("tool", "pre-tool", s.id);
        t.tell(s.id, "tool", got.outcome);
        const shown = got.text ? t.shownIn(s.id, t.lineage(s.id)) : new Set<string>();
        const block = t.admit(s.id, "pre-tool", got, shown, performance.now() - began, { call: call.tool.name, ref: call.id });
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
      } else if (!this.start.has(f.session.id) && this.flags(f.session.id).use_memory && !this.store.hasEvents(f.session.id)) {
        this.startCall(f.session);
      }
    });
  }
}
