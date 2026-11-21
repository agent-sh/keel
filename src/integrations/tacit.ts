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
// What a turn pays for it is kept small and measured (memory-meter.ts):
// - a line the context already holds is not added again, whatever the store
//   remembers of what it gave;
// - a turn's blocks stay within one budget, whole lines, the first ones kept
//   (the store lists what it ranks best first);
// - the prompt is sent to the store when it asks for work (the owner's words,
//   an agent's task, a peer's message), not for what the harness delivers (a
//   report, a wake, a loop run);
// - a turn waits for the store at most the prompt hook's own deadline. When
//   the store did not answer in time the session is told once, and nothing
//   waits for it until it answers in time again: what arrives while a tool
//   runs is used, and a block that arrives late joins the next prompt.
import { appendFileSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

// Claude Code caps a hook's context at 10,000 characters; so does Keel. The
// session's start block has that much, once; the blocks of one turn (its
// prompt's and its tool calls') share that much between them.
export const MEMORY_CAP = 10_000;
export const memoryBlock = (hook: string, text: string) =>
  `<memory source="tacit" hook="${hook}">\nFrom the owner's memory store (facts, rules and past decisions it judged relevant). Context for you, not a message from the owner.\n${text.trim().slice(0, MEMORY_CAP)}\n</memory>`;

// How long a turn's first request waits for the store: the prompt hook's own deadline.
export const PROMPT_WAIT_MS = 2200;

// What a block adds to a turn: the lines the context does not hold yet
// (`shown`: the fact lines it holds), within `room` characters, whole lines,
// in the store's order. Lines that are not facts (a title, a closing remark)
// stay with the facts they frame. Nothing when every fact was shown already
// or none fits.
export function fitMemory(text: string, shown: ReadonlySet<string>, room: number): { text: string | null; lines: string[]; repeats: number; cut: number } {
  const all = text.trim().split("\n");
  const isFact = (l: string) => /^\s*-\s/.test(l);
  const facts = all.filter(isFact);
  const fresh = all.filter((l) => !isFact(l) || !shown.has(l.trim()));
  const repeats = all.length - fresh.length;
  if (facts.length && repeats === facts.length) return { text: null, lines: [], repeats, cut: 0 };
  const kept: string[] = [];
  let used = 0;
  let at = 0;
  for (; at < fresh.length; at++) {
    const n = fresh[at]!.length + 1;
    if (used + n > room) break;
    kept.push(fresh[at]!);
    used += n;
  }
  // One line longer than the room (a block that is one long text): its start.
  if (!kept.length && room > 0 && fresh.length && !isFact(fresh[0]!)) { kept.push(fresh[0]!.slice(0, room)); at = 1; }
  let cut = facts.length ? fresh.slice(at).filter(isFact).length : fresh.length - at;
  // The line that says facts were left out is part of the block: it fits the room too.
  const more = () => `[${cut} more left out: over this turn's memory budget]`;
  while (facts.length && cut && used + more().length + 1 > room && kept.some(isFact)) {
    const last = kept.pop()!;
    used -= last.length + 1;
    if (isFact(last)) cut++;
  }
  const lines = kept.filter(isFact);
  if (!kept.length || (facts.length && !lines.length)) return { text: null, lines: [], repeats, cut };
  if (cut && facts.length) kept.push(more());
  return { text: kept.join("\n"), lines: lines.map((l) => l.trim()), repeats, cut };
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

export class Tacit {
  bin: string | null;
  private start = new Map<string, Running>();
  private done = new Set<string>(); // user events already answered
  private preTool = new Map<string, Running>();
  // The store did not answer a call in time: nothing waits for it until one
  // does. `told`: the sessions that were told, once each while it lasts.
  private slow = false;
  private failing = false;
  private told = new Set<string>();
  // Blocks that arrived after their turn stopped waiting: they join the session's next prompt.
  private late = new Map<string, { hook: "session-start" | "prompt"; text: string; row: number }[]>();
  // The fact lines each session's context holds (since its last summary), read
  // on from the last event looked at; and what each running turn has added.
  private shown = new SessionMap<{ head: string; checkpoint: string | null; lines: Set<string> }>(64);
  private spent = new Map<string, number>();
  private meter: MemoryMeter;
  // One version per session, no transcript bytes kept here. Store deletion
  // clears SessionMaps; evicting an idle one just costs a rebuild next time.
  // `last`: the uuid of the file's last record, which the next ones hang under.
  private transcriptVersions = new SessionMap<{ head: Session["head"]; model: string; workspace: string; stamp: string; last: string | null }>(64);
  private readonly metrics = {
    since_ms: Date.now(),
    hooks: { "session-start": hookStats(), prompt: hookStats(), "pre-tool": hookStats(), "pre-compact": hookStats() } satisfies Record<Hook, ReturnType<typeof hookStats>>,
    transcript: { reused: 0, appended: 0, rebuilt: 0, failed: 0, duration_ms: totals(), bytes: totals() },
  };

  constructor(private store: Store, private bus: Bus, private errors: ErrorTracker, bin = findBin("TACIT_BIN", "tacit")) {
    this.bin = bin;
    this.meter = memoryMeter(store);
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

  private async hook(hook: Hook, payload: unknown, ms: number): Promise<HookResult> {
    if (!this.bin) return NOTHING;
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
    if (hook !== "pre-compact") this.health(outcome);
    return { outcome, text };
  }

  // An answer in time ends an outage; a call that timed out or failed starts one.
  private health(outcome: HookOutcome) {
    if (outcome === "timeout") {
      if (!this.slow) this.errors.capture("server", new Error("the memory store did not answer in time: turns go on without it until it does"), { at: "tacit hook" });
      this.slow = true;
    } else if (outcome === "failure") {
      if (!this.failing) this.errors.capture("server", new Error("the memory store failed to answer: turns go on without it"), { at: "tacit hook" });
      this.failing = true;
    } else {
      this.slow = this.failing = false;
      this.told.clear();
    }
  }

  // Said in the session once while the store is out: a line for the owner, not for the model.
  private tell(id: string, outcome: HookOutcome) {
    if ((outcome !== "timeout" && outcome !== "failure") || this.told.has(id)) return;
    this.told.add(id);
    const text = outcome === "timeout"
      ? "Memory did not answer in time. This turn goes on without it, and nothing waits for it until it answers again."
      : "Memory failed to answer. This turn goes on without it.";
    this.bus.emit({ t: "event", event: this.store.append(id, "note", { kind: "memory_out", text }) });
  }

  // Fetched once per session (prefetched when the session appears).
  private startCall(s: Session): Running {
    let p = this.start.get(s.id);
    if (!p) {
      p = running(this.hook("session-start", { session_id: s.id, cwd: s.workspace, transcript_path: this.transcript(s), source: "keel" }, 6000));
      this.start.set(s.id, p);
    }
    return p;
  }
  private promptCall(s: Session, prompt: string): Running {
    return running(this.hook("prompt", { session_id: s.id, cwd: s.workspace, prompt, transcript_path: this.transcript(s) }, PROMPT_WAIT_MS));
  }
  private preToolCall(s: Session, tool: string, args: any): Running | null {
    const call = tacitToolCall(tool, args);
    return call ? running(this.hook("pre-tool", { session_id: s.id, cwd: s.workspace, transcript_path: this.transcript(s), ...call }, 900)) : null;
  }

  async startBlock(s: Session) {
    return (await this.startCall(s).done).text;
  }
  async promptBlock(s: Session, prompt: string) {
    return (await this.promptCall(s, prompt).done).text;
  }
  async preToolBlock(s: Session, tool: string, args: any): Promise<string | null> {
    return (await (this.preToolCall(s, tool, args)?.done ?? NOTHING)).text;
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

  // One block as the turn gets it, and its row in the measurements: the lines
  // the context lacks, within the room the turn has left.
  // `row`: the row of this ask, when it was written before the answer came.
  private admit(id: string, path: MemoryPath, hook: string, r: HookResult, shown: Set<string>, room: number, waitMs: number, row?: number): string | null {
    if (!r.text) {
      this.meter.record(id, path, { outcome: r.outcome === "timeout" || r.outcome === "failure" ? r.outcome : "empty", waitMs }, row);
      return null;
    }
    // The room is for the block as the turn gets it, its frame included.
    const fit = fitMemory(r.text, shown, room - memoryBlock(hook, "").length);
    if (!fit.text) {
      this.meter.record(id, path, { outcome: fit.cut ? "empty" : "repeat", repeats: fit.repeats, cut: fit.cut, waitMs }, row);
      return null;
    }
    for (const l of fit.lines) shown.add(l);
    const block = memoryBlock(hook, fit.text);
    this.meter.record(id, path, { outcome: "added", text: block, facts: fit.lines.map(factOf), repeats: fit.repeats, cut: fit.cut, waitMs }, row);
    return block;
  }

  // A call the turn did not wait for: its row says so until the call ends.
  // With a block, the block joins the session's next prompt; without one, the
  // row gets how the call ended.
  private keepLate(id: string, hook: "session-start" | "prompt", call: Running, waitMs: number) {
    const path: MemoryPath = hook === "prompt" ? "store_prompt" : "store_start";
    const row = this.meter.record(id, path, { outcome: "late", waitMs });
    call.done.then((r) => {
      if (!this.store.session(id)) return;
      if (r.text) this.late.set(id, [...(this.late.get(id) ?? []), { hook, text: r.text, row }]);
      else this.meter.record(id, path, { outcome: r.outcome === "timeout" || r.outcome === "failure" ? r.outcome : "empty" }, row);
    });
  }

  lineage(id: string) {
    return lineage(this.store.events(id), this.store.session(id)?.head ?? null);
  }

  forget(id: string) {
    this.start.delete(id);
    this.transcriptVersions.delete(id);
    this.late.delete(id);
    this.spent.delete(id);
    this.told.delete(id);
    this.meter.forget(id);
  }

  install() {
    const t = this;
    registerHooks({
      // A turn's blocks share one budget.
      turnStart: (s) => void t.spent.delete(s.id),
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
        const asks = asksMemory(last.data);
        const began = performance.now();
        const start = first ? t.startCall(s) : null;
        const prompt = asks ? t.promptCall(s, last.data.text ?? "") : null;
        // The request waits for the prompt's answer (the hook's own deadline
        // bounds that) and, within the same time, for a start block still on
        // its way. While the store is not answering in time it does not wait
        // at all: what is there is used, the rest joins the next prompt.
        if (!t.slow) {
          const window = Bun.sleep(PROMPT_WAIT_MS);
          if (prompt) await prompt.done;
          if (start && !start.got) await Promise.race([start.done, window]);
        }
        const waited = performance.now() - began;
        if (start && !start.got) t.keepLate(s.id, "session-start", start, prompt ? 0 : waited);
        if (prompt && !prompt.got) t.keepLate(s.id, "prompt", prompt, waited);
        for (const c of [start, prompt]) if (c?.got) t.tell(s.id, c.got.outcome);
        if (t.slow && prompt && !prompt.got) t.tell(s.id, "timeout");

        const shown = t.shownIn(s.id, events);
        const parts: string[] = [];
        const hooks: string[] = [];
        const put = (hook: "session-start" | "prompt", path: MemoryPath, r: HookResult, room: number, waitMs: number, row?: number) => {
          const block = t.admit(s.id, path, hook, r, shown, room, waitMs, row);
          if (!block) return;
          if (path === "store_prompt") t.spent.set(s.id, (t.spent.get(s.id) ?? 0) + block.length);
          parts.push(block);
          if (!hooks.includes(hook)) hooks.push(hook);
        };
        const room = () => MEMORY_CAP - (t.spent.get(s.id) ?? 0);
        // What an earlier turn did not wait for.
        const late = t.late.get(s.id) ?? [];
        t.late.delete(s.id);
        for (const l of late) put(l.hook, l.hook === "prompt" ? "store_prompt" : "store_start", { outcome: "hit", text: l.text }, l.hook === "prompt" ? room() : MEMORY_CAP, 0, l.row);
        if (start?.got) put("session-start", "store_start", start.got, MEMORY_CAP, prompt ? 0 : waited);
        if (prompt?.got) put("prompt", "store_prompt", prompt.got, room(), waited);
        else if (!prompt) t.meter.record(s.id, "store_prompt", { outcome: "skipped" });
        if (!parts.length) return req;
        const ev = t.store.append(s.id, "note", { text: parts.join("\n\n"), model: true, memory: { source: "tacit", hooks } });
        t.bus.emit({ t: "event", event: ev });
        return { ...req, messages: toMessages(t.lineage(s.id)) };
      },
      beforeCompact: (s) => t.preCompact(s),
      beforeTool(s, call) {
        if (!t.bin || !t.flags(s.id).use_memory) return;
        // Runs beside the tool; its answer joins the result.
        const p = t.preToolCall(s, call.tool.name, call.input);
        if (p) t.preTool.set(call.id, p);
      },
      async afterTool(s, call, result) {
        const p = t.preTool.get(call.id);
        if (!p) return;
        t.preTool.delete(call.id);
        // The tool is done. A store that answers in time is waited for (its own
        // deadline bounds that); one that does not is used only when it already answered.
        const began = performance.now();
        if (!p.got && t.slow) return void t.meter.record(s.id, "store_tool", { outcome: "skipped" });
        const got = p.got ?? (await p.done.catch((): HookResult => ({ outcome: "failure", text: null })));
        t.tell(s.id, got.outcome);
        const shown = got.text ? t.shownIn(s.id, t.lineage(s.id)) : new Set<string>();
        const block = t.admit(s.id, "store_tool", "pre-tool", got, shown, MEMORY_CAP - (t.spent.get(s.id) ?? 0), performance.now() - began);
        if (!block) return;
        t.spent.set(s.id, (t.spent.get(s.id) ?? 0) + block.length);
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
