// Answering a Claude Code session in place: the composer of a Claude Code
// session's row sends to that same session, same id, through the owner's own
// `claude` in print mode: `claude -p --resume ID` with stream-json in and out,
// its permission prompts to Keel over the control channel (claude-wire.ts says
// the wire and where each shape comes from). The child starts in the session's
// project folder (where it was started, the folder its transcript is kept
// under) once Claude Code's own trust record covers it, with the model of its
// last reply (and its 1M window when it used it) and the mode of its last user
// record (a resumed print run restores neither), and an environment that keeps
// only the route that model names, which must be there. Keel is the writer
// only while nothing else holds the session (writer.ts: a live Claude Code
// record of it; and no write in the last seconds, nor an open turn written in
// the last minutes, that no record explains), read right before the child
// starts, and only for the turn and the sends that come while it runs: Claude
// Code takes no lock, so the one-writer rule is Keel's. A record of another
// process that appears while Keel's child runs stops the sends that follow.
//
// What Claude Code asks becomes a Keel card, answered once: a call to allow
// (the gate's one-call card), AskUserQuestion (a question card), ExitPlanMode
// (a plan card). Nothing is stored as the session's events: the transcript
// stays the only record, and the mirror (service.ts) stores what Claude Code
// writes there. The reply's words stream as delta frames until then.
//
// A send goes through the outbox the Codex route keeps (codex-app.ts): stored
// before its sender is answered, started (the transcript's size kept) before
// it goes, delivered when the transcript holds it. A restart that cut a started
// send looks for it in the transcript and never sends it again by itself.
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Bus } from "../../core/bus.ts";
import type { Store } from "../../core/store.ts";
import type { Holder } from "../../core/types.ts";
import { holderSaid } from "../../core/holder-words.ts";
import { homeDir } from "../../core/paths.ts";
import { pumpLines, pumpText } from "../../core/proc.ts";
import { begin as activity } from "../../admin/activity.ts";
import type { ToolCall } from "../../engine/hooks.ts";
import { allPendingQuestions, askFor, DECLINED, type Answers } from "../../tools/interact.ts";
import type { Tool, ToolContext } from "../../tools/types.ts";
import { headTail } from "../import/files.ts";
import { alive, claudeRecordsOf, foreignRecord, holderChain, procOf, recordHolder, type ClaudeRecord, type Proc } from "./writer.ts";
import { merged, reap, SCHEMA, type Answered, type CardGate, type Send, type SendState } from "./codex-app.ts";
import type { Answer as PlanAnswer, PlanCard } from "../../server/routes/plan.ts";
import { answerLine, answersOf, argsOf, Back, cardOf, childEnv, holdsMessage, modeFor, planMode, projectOf, questionsOf, readOut, refusalLine, requestLine, routeMissing, routeOf, trusted, turnEnded, userLine } from "./claude-wire.ts";

type Json = any;

const KEEP_MS = 24 * 3600_000;
const CUT = "Keel restarted while Claude Code worked: the turn stopped there";
// How long Claude Code may take to answer its initialize (it loads the session, its settings and MCP servers
// first), a Stop, and how long a child told to end may take to end.
const READY_MS = 60_000;
const RPC_MS = 5000;
const END_MS = 2000;
// The longest line Keel reads from the child: a reply's record is far smaller; a longer one is dropped.
const LINE_MAX = 8 * 1024 * 1024;
// A write to the transcript that no record of a running session explains: within FRESH_MS some process is in it (Claude
// Code writes its record a few seconds after it starts: up to 4 s seen), and within OPEN_MS of an open turn's last
// write a call of it may still run (Bash's longest timeout is 10 minutes, D: Claude Code's tools docs).
const FRESH_MS = 10_000;
const OPEN_MS = 10 * 60_000;
// A send the owner's Stop left in Claude Code's queue: the child ends after the stopped turn, so it never ran.
const STOPPED = "Not run: you stopped the turn before Claude Code took it";
// How much of the transcript is read at a time, off the loop between the parts.
const PART = 1024 * 1024;

export type ClaudeCodeDeps = {
  store: Store;
  bus: Bus;
  outside: {
    row(sessionId: string): { harness: string; source_id: string; path: string } | undefined;
    holderNow(sessionId: string): Holder | undefined;
    retell(sessionId: string): void;
  };
  gate: () => CardGate | undefined;
  // The claude program, and Claude Code's folder when it is not its default (read when used).
  bin: () => string | undefined;
  configDir: () => string | undefined;
  // Claude Code's folder of running sessions (its sessions/<pid>.json records), as the mirror reads it.
  runningDir: () => string;
  trouble: (e: unknown, at: string) => void;
  // A question or a plan Claude Code asks is an alert like the model's own (the turn hooks' ownerAsked and ownerAnswered).
  asked?: (sessionId: string, callId: string, text: string, askId: string) => void;
  answered?: (sessionId: string, callId: string, answered: boolean, askId: string) => void;
  // The plan card (src/server/routes/plan.ts), set when the routes load.
  plan?: (card: PlanCard, signal: AbortSignal) => Promise<PlanAnswer>;
  // The daemon's environment the child's is made from.
  env?: () => Record<string, string | undefined>;
  // At a start: the questions a child of the daemon before asked are closed (alerts.closeAsks).
  cutAsks?: () => void;
};

// The child: claude in print mode, its lines read as they come.
class Child {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly exited: Promise<number>;
  private stderr = "";
  private waits = new Map<string, { ok: (v: Json) => void; no: (e: Error) => void }>();
  onLine: (m: Json) => void = () => {};

  constructor(argv: string[], cwd: string, env: Record<string, string>, private log: (m: string) => void) {
    this.proc = Bun.spawn(argv, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const end = activity("acp_agents");
    void this.proc.exited.then(end, end);
    void pumpLines(this.proc.stdout as ReadableStream<Uint8Array>, (l) => this.line(l), "claude stdout", {
      max: LINE_MAX,
      over: (n) => this.log(`a line of ${n} characters from Claude Code was dropped (the most Keel reads in one is ${LINE_MAX})`),
    });
    void pumpText(this.proc.stderr as ReadableStream<Uint8Array>, (t) => { this.stderr = (this.stderr + t).slice(-4000); }, "claude stderr");
    this.exited = this.proc.exited.then((code) => {
      for (const w of this.waits.values()) w.no(new Error(`Claude Code exited (code ${code})${this.why() ? `: ${this.why()}` : ""}`));
      this.waits.clear();
      return code;
    });
  }

  get pid() { return this.proc.pid; }
  get alive() { return this.proc.exitCode === null && !this.proc.killed; }
  why() { return this.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400); }

  write(text: string) {
    if (!this.alive) return false;
    try {
      const sink = this.proc.stdin as import("bun").FileSink;
      sink.write(text);
      sink.flush();
      return true;
    } catch { return false; }
  }

  // A control request of Keel's, answered by its control_response.
  request(request: Json): Promise<Json> {
    const id = `keel-${crypto.randomUUID()}`;
    return new Promise((ok, no) => {
      this.waits.set(id, { ok, no });
      if (!this.write(requestLine(id, request))) { this.waits.delete(id); no(new Error("Claude Code is not running")); }
    });
  }

  private line(l: string) {
    if (!l.trim()) return;
    let m: Json;
    try { m = JSON.parse(l); } catch { return this.log(`not JSON from Claude Code: ${l.slice(0, 200)}`); }
    const o = readOut(m);
    if (o.kind === "answer") {
      const w = this.waits.get(o.id);
      if (!w) return;
      this.waits.delete(o.id);
      return o.ok ? w.ok(o.response ?? {}) : w.no(new Error(o.error));
    }
    this.onLine(m);
  }

  end() { try { (this.proc.stdin as import("bun").FileSink).end(); } catch {} }
  kill(signal?: "SIGKILL") { this.end(); try { signal ? this.proc.kill(signal) : this.proc.kill(); } catch {} }
}

const bounded = <T>(p: Promise<T>, what: string, ms = RPC_MS): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, no) => { t = setTimeout(() => no(new Error(`Claude Code did not answer ${what} in ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(t));
};

type Run = {
  sessionId: string;
  claudeId: string;
  path: string;
  cwd: string;
  child: Child;
  ready: Promise<boolean>;
  // The sends given to this child whose turn has not ended (by uuid, the send's id).
  open: Set<string>;
  // Sends given to this child whose delivery is checked when a turn ends.
  given: Set<string>;
  // The streaming reply: the message the next deltas belong to, and each of its blocks' place in the draft.
  message?: string;
  blocks: Map<string, number>;
  // The cards open now, by the request's id: withdrawn when Claude Code cancels one, or the turn stops.
  cards: Map<string, AbortController>;
  stopped: AbortController;
  nonce: string;
  // The mode the child works in (the session's, or the one an approved plan set): the bar says it.
  mode: string;
  // The owner stopped the turn: the child ends after it, and takes no send.
  stopping?: boolean;
  ending?: Promise<void>;
  killing?: Promise<void>;
  // What holds the session under the child, learned once it is ready and again when it is ended: the process
  // Claude Code's record names and its ancestors under the child (a launcher's native claude). Nothing else
  // under it (an MCP server, a job of the turn) is Keel's to end.
  under: Proc[];
  // The child is gone, and so is what held the session under it: a send waits for it before it starts another.
  over: Promise<void>;
  isOver: () => void;
};

// The transcript's records from a byte offset on, a part at a time with the loop free between (a long session's tool
// output is most of its bytes); `take` true stops the read. A last line still being written is left out.
async function forth(path: string, offset: number, take: (r: Json) => boolean | void): Promise<void> {
  try {
    const file = Bun.file(path);
    const size = statSync(path).size;
    let at = Math.max(0, Math.min(offset, size));
    let rest = Buffer.alloc(0);
    while (at < size) {
      const end = Math.min(size, at + PART);
      const got = Buffer.from(await file.slice(at, end).arrayBuffer());
      at = end;
      const buf = rest.length ? Buffer.concat([rest, got]) : got;
      const whole = buf.lastIndexOf(10) + 1;
      for (const l of buf.subarray(0, whole).toString("utf8").split("\n")) {
        if (!l.trim()) continue;
        let r: Json;
        try { r = JSON.parse(l); } catch { continue; }
        if (take(r)) return;
      }
      rest = Buffer.from(buf.subarray(whole));
    }
  } catch {}
}
// What the session gained since a send started: its prompts and replies.
async function recordsFrom(path: string, offset: number): Promise<Json[]> {
  const out: Json[] = [];
  await forth(path, offset, (r) => { if (r?.type === "user" || r?.type === "assistant") out.push(r); });
  return out;
}
// The records from the transcript's end back, a part at a time off the loop, until `take` says it has what it needs.
async function back(path: string, take: (r: Json) => boolean): Promise<void> {
  try {
    const file = Bun.file(path);
    let end = statSync(path).size;
    let rest = Buffer.alloc(0);
    while (end > 0) {
      const from = Math.max(0, end - PART);
      const got = Buffer.from(await file.slice(from, end).arrayBuffer());
      end = from;
      // The part's first line may be cut: its bytes are read with the part before it.
      const buf = rest.length ? Buffer.concat([got, rest]) : got;
      const cut = from > 0 ? buf.indexOf(10) : -1;
      if (from > 0 && cut < 0) { rest = buf; continue; }
      const lines = buf.subarray(cut + 1).toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]!.trim()) continue;
        let r: Json;
        try { r = JSON.parse(lines[i]!); } catch { continue; }
        if (take(r)) return;
      }
      rest = from > 0 ? Buffer.from(buf.subarray(0, cut)) : Buffer.alloc(0);
    }
  } catch {}
}

// Whether the transcript's last turn is open, from its tail (a turn whose end the tail does not show counts as open).
function openTail(path: string): boolean {
  const { tail } = headTail(path, 64 * 1024);
  const b = new Back();
  for (let i = tail.length - 1; i >= 0 && b.open === undefined; i--) b.take(tail[i]);
  return b.open !== false;
}

// The git repository a folder is in (the nearest folder above it with .git): Claude Code's trust is not looked for above it.
function repoOf(cwd: string): string | undefined {
  for (let p = cwd; ; ) {
    if (existsSync(join(p, ".git"))) return p;
    const up = dirname(p);
    if (up === p) return undefined;
    p = up;
  }
}

// The main repository of a linked worktree, as Claude Code resolves it (C: 2.1.332): the worktree's .git is a file
// "gitdir: <dir>", that dir's commondir names the common git folder, the dir sits in its worktrees/ folder, and its
// gitdir file points back at this worktree's .git. Every link of that chain must hold, else the folder is its own root.
// A common folder named .git is a main worktree's (its parent is the root); another is a bare repository's (its own
// root, unless it holds a .git of its own).
export function mainRootOf(root: string): string | undefined {
  const text = (p: string) => { try { return lstatSync(p).isFile() ? readFileSync(p, "utf8").trim() : undefined; } catch { return undefined; } };
  const real = (p: string) => { try { return realpathSync(p); } catch { return undefined; } };
  const dot = text(join(root, ".git"));
  if (!dot?.startsWith("gitdir:")) return undefined;
  const g = dot.slice(7).trim();
  if (!g) return undefined;
  const a = resolve(root, g);
  const common = text(join(a, "commondir"));
  if (!common) return undefined;
  const f = resolve(a, common);
  if (dirname(a) !== join(f, "worktrees")) return undefined;
  const back = text(join(a, "gitdir"));
  if (!back) return undefined;
  const r = real(root);
  if (!r || real(resolve(a, back)) !== join(r, ".git")) return undefined;
  if (basename(f) !== ".git") return existsSync(join(f, ".git")) ? undefined : f;
  return dirname(f);
}

// Whether a kept process is still claude in print mode answering over the control channel, by its arguments: a
// check of a row Keel kept (its pid and start time), never a way to find one.
function printChild(pid: number): boolean {
  let argv: string[] = [];
  try { argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { return false; }
  return argv.includes("--resume") && argv.includes("--permission-prompt-tool") && argv.includes("stdio");
}

type ProcRow = { session_id: string; pid: number; start: string };

export class ClaudeCode {
  private runs = new Map<string, Run>();
  // A child being started (its facts read, the session checked): a send that comes meanwhile waits for it.
  private starting = new Map<string, Promise<Run | string>>();
  // The transcript's size when Keel's last child in the session ended: a write that left it there was Keel's.
  private left = new Map<string, number>();
  private said = new Map<string, string[]>();
  private closed = false;
  private off: () => void;

  constructor(private d: ClaudeCodeDeps) {
    // The outbox and the children's table are the Codex route's (codex-app.ts), one for both harnesses.
    d.store.migrate(SCHEMA);
    this.off = d.bus.on((f) => {
      if (f.t !== "session" || !f.deleted) return;
      this.said.delete(f.session.id);
      this.left.delete(f.session.id);
      if (this.runs.has(f.session.id)) void this.interrupt(f.session.id).catch((e) => d.trouble(e, "stopping a deleted session's Claude Code turn"));
    });
  }

  ours(sessionId: string): boolean { return this.runs.has(sessionId) || this.starting.has(sessionId); }
  running(sessionId: string): boolean { return (this.runs.get(sessionId)?.open.size ?? 0) > 0; }

  // Who holds the session as a send decides: Keel while its child runs; else the record Claude Code keeps, else a
  // process no record names when the transcript was written by one in the last seconds, or its open turn in the
  // last minutes.
  holder(sessionId: string, base = this.d.outside.holderNow(sessionId)): Holder | undefined {
    if (!base) return base;
    if (this.ours(sessionId)) return { kind: "keel" };
    if (base.kind !== "free") return base;
    return this.unrecorded(sessionId) ? { kind: "process" } : base;
  }

  // What a send does now: resume the session (free), add to the turn Keel runs, nothing (another process
  // holds it, or there is no claude program here).
  route(sessionId: string, holder = this.holder(sessionId)): "resume" | "steer" | "held" | "missing" {
    const run = this.runs.get(sessionId);
    if (run) return this.others(run).length ? "held" : "steer";
    if (this.starting.has(sessionId)) return "steer";
    if (!this.d.bin()) return "missing";
    return !holder || holder.kind === "free" ? "resume" : "held";
  }

  sends(sessionId: string): Send[] {
    return this.d.store.db.query<Send, [string]>("SELECT * FROM outside_sends WHERE session_id = ? AND state != 'delivered' ORDER BY created").all(sessionId);
  }
  private one(sessionId: string, key: string): Send | undefined {
    return this.d.store.db.query<Send, [string, string]>("SELECT * FROM outside_sends WHERE session_id = ? AND key = ?").get(sessionId, key) ?? undefined;
  }
  private byId(id: string): Send | undefined {
    return this.d.store.db.query<Send, [string]>("SELECT * FROM outside_sends WHERE id = ?").get(id) ?? undefined;
  }
  // What the bar says besides the sends: what Keel noted, and the mode Keel's child works in now.
  notes(sessionId: string): string[] {
    const run = this.runs.get(sessionId);
    return [...(this.said.get(sessionId) ?? []), ...(run ? [`Claude Code works here in its ${run.mode} mode`] : [])];
  }
  // What the owner answered on the cards of Claude Code's calls, by the call's tool_use id in the transcript: the
  // call's line in the mirror says it (the transcript holds only what the call returned, or Keel's deny message).
  answers(sessionId: string): Record<string, Answered> {
    const out: Record<string, Answered> = {};
    for (const a of this.d.gate()?.harnessAnswers(sessionId, "claude-") ?? [])
      out[a.item] = a.state === "denied" && a.reason ? { state: "denied", reason: a.reason } : { state: a.state };
    return out;
  }
  private told(sessionId: string) {
    this.d.bus.emit({ t: "feature", name: "outside_sends", session_id: sessionId, data: { sends: this.sends(sessionId), notes: this.notes(sessionId), answers: this.answers(sessionId) } });
  }
  private note(sessionId: string, text: string) {
    const had = this.said.get(sessionId) ?? [];
    if (had.includes(text)) return;
    this.said.set(sessionId, [...had, text].slice(-5));
    this.told(sessionId);
  }
  private set(id: string, state: SendState, more: { offset?: number; said?: string } = {}) {
    const s = this.byId(id);
    if (!s) return;
    this.d.store.db.query("UPDATE outside_sends SET state = ?, offset = COALESCE(?, offset), said = ? WHERE id = ?").run(state, more.offset ?? null, more.said ?? null, id);
    this.told(s.session_id);
  }

  // A write to the transcript no record explains, and why it holds a send: written in the last seconds, or its turn
  // open and written in the last minutes. Not a write Keel's own child left.
  private unrecorded(sessionId: string): string | undefined {
    const row = this.d.outside.row(sessionId);
    if (!row) return undefined;
    let st;
    try { st = statSync(row.path); } catch { return undefined; }
    if (this.left.get(sessionId) === st.size) return undefined;
    const ago = Date.now() - st.mtimeMs;
    if (ago < FRESH_MS) return `Claude Code wrote to this session ${Math.max(0, Math.round(ago / 1000))} s ago and no record says which process runs it`;
    if (ago < OPEN_MS && openTail(row.path)) return `its last turn is open, written ${Math.max(1, Math.round(ago / 60_000))} min ago, and no record says which process runs it`;
    return undefined;
  }
  // What holds the session outside Keel now, read at this moment: a record of Claude Code's, or a write none explains.
  private stranger(sessionId: string, claudeId: string): { holder: Holder; said: string } | undefined {
    const r = claudeRecordsOf(this.d.runningDir(), claudeId)[0];
    if (r) { const h = recordHolder(r); return { holder: h, said: holderSaid(h, "Claude Code") }; }
    const why = this.unrecorded(sessionId);
    return why ? { holder: { kind: "process" }, said: why } : undefined;
  }
  // The records of the session that are not Keel's child or what runs it (a terminal that opened it meanwhile, a
  // record of another pid domain).
  private others(run: Run): ClaudeRecord[] {
    return claudeRecordsOf(this.d.runningDir(), run.claudeId).filter((r) =>
      foreignRecord(r) || (r.pid !== run.child.pid && !run.under.some((p) => p.pid === r.pid) && !holderChain(run.child.pid, r.pid).length));
  }

  // A send by the owner. Answered once the send is stored (or refused before it is): `key` stores it once.
  send(sessionId: string, text: string, key: string, again?: string): { send: Send } | { error: string; status: number; holder?: Holder } {
    const s = this.d.store.session(sessionId);
    const row = this.d.outside.row(sessionId);
    if (!s?.outside || !row) return { error: "not a session of another harness", status: 404 };
    if (row.harness !== "claude") return { error: "not a Claude Code session", status: 409 };
    if (!text.trim()) return { error: "nothing to send", status: 400 };
    const had = this.one(sessionId, key);
    if (had) return { send: had };
    const mine = this.ours(sessionId);
    if (!mine) {
      const held = this.stranger(sessionId, row.source_id);
      if (held) return { error: `${held.said}: answer it there. Keel sends nothing to a session another process holds.`, status: 409, holder: held.holder };
      if (!this.d.bin()) return { error: "no claude program here: Keel answers a Claude Code session with the claude on your PATH (or KEEL_CLAUDE_BIN)", status: 409 };
    } else {
      const run = this.runs.get(sessionId);
      const other = run ? this.others(run)[0] : undefined;
      if (other) { const h = recordHolder(other); return { error: `${holderSaid(h, "Claude Code")} too: Keel sends nothing more to a session another process has open`, status: 409, holder: h }; }
    }
    const send: Send = { id: Bun.randomUUIDv7(), session_id: sessionId, key, text, state: "stored", offset: null, said: null, created: Date.now() };
    if (!mine) this.said.delete(sessionId);
    this.d.store.db.query("DELETE FROM outside_sends WHERE state = 'delivered' AND created < ?").run(Date.now() - KEEP_MS);
    this.d.store.db.transaction(() => {
      if (again) this.d.store.db.query("DELETE FROM outside_sends WHERE id = ? AND session_id = ? AND state IN ('lost', 'failed')").run(again, sessionId);
      this.d.store.db.query("INSERT INTO outside_sends (id, session_id, key, text, state, offset, said, created) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)").run(send.id, sessionId, key, text, "stored", send.created);
    })();
    this.told(sessionId);
    void this.deliver(sessionId, send.id).catch((e) => { this.d.trouble(e, "answering a Claude Code session in place"); this.set(send.id, "lost", { said: `it could not go to Claude Code: ${(e as Error).message}` }); });
    return { send };
  }

  dismiss(sessionId: string, id: string): boolean {
    const n = this.d.store.db.query("DELETE FROM outside_sends WHERE id = ? AND session_id = ? AND state IN ('lost', 'failed', 'cut')").run(id, sessionId).changes;
    if (n) this.told(sessionId);
    return n > 0;
  }

  // The owner's Stop: Claude Code's turn is interrupted over the control channel (its open cards withdrawn), and the
  // child ends after the stopped turn: what it queued behind it does not run. A second Stop asks again; a child that
  // does not end its turn in a few seconds is ended.
  async interrupt(sessionId: string): Promise<boolean> {
    const r = this.runs.get(sessionId);
    // What the owner sent and Claude Code has not been given yet never runs after the Stop, also while the child is
    // only starting (no child yet, or one not initialized): it is marked not run, and begin and deliver go on for no
    // send that is not stored.
    const starting = this.starting.has(sessionId);
    const halted = this.stopStored(sessionId);
    if (!r) return starting || halted;
    for (const c of r.cards.values()) c.abort();
    if (!r.open.size) { void this.end(r); return true; }
    const first = !r.stopping;
    r.stopping = true;
    this.d.outside.retell(sessionId);
    // Claude Code cancels what it queued behind the turn with it (cancel_queued); one that does not know the field lists
    // what survives (still_queued), each withdrawn by itself (cancel_async_message). D: SDK types of both requests.
    const res: Json = await bounded(r.child.request({ subtype: "interrupt", cancel_queued: true }), "Stop").then((v) => v ?? {}, () => undefined);
    if (!res) { void this.kill(r); return true; }
    const uuids = (v: unknown) => (Array.isArray(v) ? v.filter((u): u is string => typeof u === "string") : []);
    const cancelled = uuids(res.cancelled);
    const survive = uuids(res.still_queued).filter((u) => !cancelled.includes(u) && r.given.has(u));
    const off = await Promise.all(survive.map((u) => bounded(r.child.request({ subtype: "cancel_async_message", message_uuid: u }), "a cancel").then((x: Json) => (x?.cancelled === true ? u : undefined), () => undefined)));
    for (const u of [...cancelled, ...off]) {
      if (!u || !r.given.has(u)) continue;
      r.given.delete(u);
      r.open.delete(u);
      if (this.byId(u)?.state === "started") this.set(u, "failed", { said: STOPPED });
    }
    if (first) {
      const t = setTimeout(() => { if (this.runs.get(sessionId) === r && r.open.size) void this.kill(r); }, RPC_MS);
      (t as any).unref?.();
    }
    return true;
  }

  // The sends still stored (taken, not yet given to Claude Code) are marked not run: the owner stopped first.
  private stopStored(sessionId: string): boolean {
    let n = 0;
    for (const s of this.sends(sessionId)) if (s.state === "stored") { this.set(s.id, "failed", { said: STOPPED }); n++; }
    return n > 0;
  }

  private async deliver(sessionId: string, id: string): Promise<void> {
    let r = this.runs.get(sessionId);
    // A child that is ending (or was stopped) is waited out, and so is what held the session under it; then the one
    // child in runs is taken (a send that came meanwhile may have started it), never a second one beside it.
    while (r?.ending || r?.killing || r?.stopping) {
      await r.over;
      if (this.closed) return;
      r = this.runs.get(sessionId);
    }
    if (!r) {
      let p = this.starting.get(sessionId);
      if (!p) {
        p = this.begin(sessionId).finally(() => this.starting.delete(sessionId));
        this.starting.set(sessionId, p);
      }
      const begun = await p;
      // A daemon that stopped meanwhile marks nothing: the send stays stored, and the next one sends it.
      if (this.closed) return;
      if (typeof begun === "string") {
        if (this.byId(id)?.state === "stored") this.set(id, "failed", { said: begun });
        return;
      }
      r = begun;
    }
    const run = r;
    const ready = await run.ready;
    if (this.closed) return;
    if (!ready) {
      if (this.byId(id)?.state === "stored") this.set(id, "failed", { said: "Claude Code did not resume the session" });
      return;
    }
    const send = this.byId(id);
    if (!send || send.state !== "stored") {
      // Stopped before it was given (and nothing else for this child): the child ends with nothing run.
      if (!run.open.size && !this.sends(sessionId).some((s) => s.state === "stored")) void this.end(run);
      return;
    }
    // Stopped or ending since: the send goes with the next child.
    if (run.stopping || run.ending || run.killing) return this.deliver(sessionId, id);
    // A terminal that opened the session while Keel's child runs: nothing more goes to it.
    const other = this.others(run)[0];
    if (other) return this.set(id, "failed", { said: `${holderSaid(recordHolder(other), "Claude Code")} too: it did not go` });
    let size = 0;
    try { size = statSync(run.path).size; } catch {}
    // Started before it goes: a restart from here on looks for it in the transcript, never sends it again.
    this.set(id, "started", { offset: size });
    run.given.add(id);
    run.open.add(id);
    if (!run.child.write(userLine(send.text, send.id))) {
      run.given.delete(id);
      run.open.delete(id);
      this.set(id, "lost", { said: "Claude Code ended before it took it: send it again" });
      return;
    }
    this.d.outside.retell(sessionId);
  }

  // Claude Code's global config (its trust records), as Claude Code finds it: <CLAUDE_CONFIG_DIR or home>/.claude.json,
  // else the older <config>/.config.json (C: 2.1.332).
  private async trusts(cwd: string): Promise<boolean> {
    const dir = this.d.configDir();
    const home = homeDir();
    for (const file of [join(dir ?? home, ".claude.json"), join(dir ?? join(home, ".claude"), ".config.json")]) {
      let config: Json;
      try { config = JSON.parse(await Bun.file(file).text()); } catch { continue; }
      const repo = repoOf(cwd);
      return trusted(config, cwd, repo, repo ? mainRootOf(repo) : undefined);
    }
    return false;
  }
  // The `env` of Claude Code's user settings: Claude Code applies it over the environment it starts with.
  private async settingsEnv(): Promise<Record<string, string>> {
    const file = join(this.d.configDir() ?? join(homeDir(), ".claude"), "settings.json");
    try {
      const e = JSON.parse(await Bun.file(file).text())?.env;
      return e && typeof e === "object" ? Object.fromEntries(Object.entries(e).filter((x): x is [string, string] => typeof x[1] === "string")) : {};
    } catch { return {}; }
  }

  // The child for a turn: its facts read off the loop, the session checked, started and initialized (ready says
  // whether it is); else why not.
  private async begin(sessionId: string): Promise<Run | string> {
    const row = this.d.outside.row(sessionId);
    const bin = this.d.bin();
    if (!row || !bin || !existsSync(row.path)) return "its transcript is no longer where it was";
    // Where it was started: the folder its transcript is kept under names it.
    const folder = basename(dirname(row.path));
    let cwd: string | undefined;
    await forth(row.path, 0, (r) => !!(cwd = projectOf([r], folder)));
    const isDir = (p?: string) => { try { return !!p && statSync(p).isDirectory(); } catch { return false; } };
    if (!cwd) return "Keel cannot tell the folder this session was started in (no record names the folder its transcript is kept under): it did not go";
    // The session's folder is gone (a worktree cleaned up): Claude Code would look for it in another one.
    if (!isDir(cwd)) return `its folder ${cwd} is gone: Claude Code would work somewhere else. It did not go`;
    // A print run shows no trust dialog: a folder Claude Code was never told to trust would load its settings, hooks
    // and MCP servers unasked.
    if (!(await this.trusts(cwd))) return `Claude Code's trust record does not cover ${cwd}: a print run would load its settings, hooks and MCP servers without asking. Open Claude Code there once and trust the folder, then send again`;
    const b = new Back();
    await back(row.path, (r) => b.take(r));
    const env = this.d.env?.() ?? process.env;
    const missing = routeMissing(routeOf(b.model), { ...env, ...(await this.settingsEnv()) });
    if (missing) return `Keel cannot answer it on the route it ran on: ${missing}. It did not go`;
    if (this.closed) return "Keel stopped before Claude Code started";
    // The owner's Stop came while this was read: nothing is left to send, and no child starts.
    if (!this.sends(sessionId).some((s) => s.state === "stored")) return STOPPED;
    // Read again right before the child starts: another process may have taken the session since.
    const held = this.stranger(sessionId, row.source_id);
    if (held) return `${held.said}: it did not go`;
    const m = modeFor(b.mode);
    if (m.note) this.note(sessionId, m.note);
    const child = new Child(argsOf(bin, row.source_id, { model: b.modelArg(), mode: m.mode }), cwd, childEnv(env, b.model, this.d.configDir()), (msg) => this.d.trouble(new Error(msg), "claude in print mode"));
    let isOver = () => {};
    const over = new Promise<void>((r) => { isOver = r; });
    const run: Run = { sessionId, claudeId: row.source_id, path: row.path, cwd, child, ready: Promise.resolve(false), open: new Set(), given: new Set(), blocks: new Map(), cards: new Map(), stopped: new AbortController(), nonce: Bun.randomUUIDv7().slice(-12), mode: m.mode, under: [], over, isOver };
    this.runs.set(sessionId, run);
    const self = procOf(child.pid);
    if (self) this.keep(sessionId, [self]);
    child.onLine = (msg) => this.heard(run, msg);
    void child.exited.then(() => this.gone(run)).catch((e) => this.d.trouble(e, "a Claude Code child that ended"));
    run.ready = (async () => {
      try {
        // (Every field of initialize is optional: Keel registers no hooks, servers or dialogs of its own.)
        await bounded(child.request({ subtype: "initialize" }), "initialize", READY_MS);
        // What holds the session under the child now (a launcher's native claude): kept, so a next daemon ends it
        // too when this one could not.
        run.under = this.writers(run);
        if (run.under.length) this.keep(sessionId, run.under);
        this.told(sessionId);
        this.d.outside.retell(sessionId);
        return true;
      } catch (e) {
        // A daemon that stopped meanwhile marks nothing: the send stays stored, and the next one sends it.
        if (this.closed) return false;
        const said = `Claude Code did not resume the session: ${(e as Error).message}`;
        for (const s of this.sends(sessionId)) if (s.state === "stored") this.set(s.id, "failed", { said });
        void this.end(run);
        return false;
      }
    })();
    return run;
  }

  private heard(run: Run, m: Json) {
    // (A child still writing while the daemon stops: nothing of it is read any more.)
    if (this.closed) return;
    const o = readOut(m);
    switch (o.kind) {
      case "ask":
        void this.asked(run, o.id, o.request);
        return;
      case "cancel":
        run.cards.get(o.id)?.abort();
        return;
      case "message":
        run.message = o.id;
        return;
      case "delta": {
        const key = `${run.message ?? ""}:${o.index}`;
        let index = run.blocks.get(key);
        if (index === undefined) run.blocks.set(key, (index = run.blocks.size));
        this.d.bus.emit({ t: "delta", session_id: run.sessionId, index, kind: "text", text: o.text });
        return;
      }
      case "result": {
        // The sends this turn answered (every open one, from a Claude Code that does not name them).
        for (const u of o.uuids ?? [...run.open]) run.open.delete(u);
        if (!o.uuids) run.open.clear();
        run.blocks.clear();
        run.message = undefined;
        // The turn the owner stopped is over: the child ends now, before it takes what it queued behind it.
        if (run.stopping) { void this.kill(run); return; }
        if (o.error && o.said) this.note(run.sessionId, `Claude Code ended the turn with an error: ${o.said}`);
        void this.check(run).then(() => {
          if (this.closed || this.runs.get(run.sessionId) !== run) return;
          if (!run.open.size && !this.sends(run.sessionId).some((s) => s.state === "stored")) void this.end(run);
          else this.d.outside.retell(run.sessionId);
        }).catch((e) => this.d.trouble(e, "a Claude Code turn that ended"));
        return;
      }
    }
  }

  // The sends given to the child that the transcript holds now are delivered; at the child's end the others are not
  // (a Stop's queue never ran; else they were lost on the way).
  private async check(run: Run, last = false) {
    for (const id of [...run.given]) {
      const s = this.byId(id);
      if (!s || s.state !== "started") { run.given.delete(id); continue; }
      const held = holdsMessage(await recordsFrom(run.path, s.offset ?? 0), s.text, s.id);
      if (!run.given.has(id) || this.closed) continue;
      if (held) { this.set(id, "delivered"); run.given.delete(id); }
      else if (last) { this.set(id, run.stopping ? "failed" : "lost", { said: run.stopping ? STOPPED : "Claude Code ended before the session held it: send it again" }); run.given.delete(id); }
    }
  }

  // A control request of Claude Code's: a permission prompt becomes a card; anything else is answered as Keel can.
  private async asked(run: Run, rid: string, req: Json) {
    const reply = (response: Json) => run.child.write(answerLine(rid, response));
    try {
      if (req?.subtype === "can_use_tool") return void reply(await this.permission(run, rid, req));
      if (req?.subtype === "elicitation") {
        const server = typeof req.mcp_server_name === "string" && req.mcp_server_name ? ` ${req.mcp_server_name.slice(0, 80)}` : "";
        this.note(run.sessionId, `Claude Code's MCP server${server} asked for a form, and Keel declined it: forms are not shown here yet. Ask in Claude Code if it needs one.`);
        return void reply({ action: "decline" });
      }
      run.child.write(refusalLine(rid, `Keel does not answer ${String(req?.subtype ?? "this request")}`));
    } catch (e) {
      this.d.trouble(e, "a request of Claude Code's");
      run.child.write(refusalLine(rid, (e as Error).message));
    }
  }

  private async permission(run: Run, rid: string, req: Json): Promise<Json> {
    const s = this.d.store.session(run.sessionId);
    const ac = new AbortController();
    run.cards.set(rid, ac);
    const signal = AbortSignal.any([ac.signal, run.stopped.signal]);
    const name = String(req.tool_name ?? "");
    const input = req.input && typeof req.input === "object" ? req.input : {};
    const toolUse = String(req.tool_use_id ?? rid);
    const callId = `claude-${run.nonce}-${toolUse}`;
    const ctx = { sessionId: run.sessionId, cwd: run.cwd, callId, signal, seen: new Map(), spillDir: "" } as unknown as ToolContext;
    const deny = (message: string) => ({ behavior: "deny", message, toolUseID: toolUse });
    try {
      if (name === "AskUserQuestion") {
        const qs = questionsOf(input);
        // Questions Keel cannot show whole are not shown in part.
        if (!qs) return deny("Keel cannot show these questions: each needs its words and options with labels. Ask them again in that form");
        const askId = crypto.randomUUID();
        const text = qs.map((q) => q.question).join("\n");
        this.d.asked?.(run.sessionId, callId, text, askId);
        let got: Answers | typeof DECLINED | null = null;
        try {
          got = await askFor({ ...ctx, questionChanged: () => this.d.bus.emit({ t: "questions", pending: allPendingQuestions() }) } as ToolContext, {
            id: askId, from: "Claude Code", message: "Claude Code asks",
            questions: qs.map((q, i) => ({ id: String(i), header: q.header, question: q.question, options: q.options, ...(q.multiSelect ? { multiSelect: true } : {}) })),
          });
        } finally {
          this.d.answered?.(run.sessionId, callId, !!got && got !== DECLINED, askId);
        }
        if (!got || got === DECLINED) return deny(signal.aborted ? "The question was withdrawn: the turn stopped" : "The owner declined to answer these questions");
        return { behavior: "allow", updatedInput: { ...input, answers: answersOf(qs, got) }, toolUseID: toolUse };
      }
      if (name === "ExitPlanMode") {
        const plan = typeof input.plan === "string" ? input.plan.trim() : "";
        if (!this.d.plan || !plan) return deny(plan ? "Keel cannot show the plan here: present it in Claude Code" : "The plan was empty");
        const card: PlanCard = { id: callId, session_id: run.sessionId, plan: plan.slice(0, 40_000), title: "Claude Code's plan", created: Date.now() };
        const a = await this.d.plan(card, signal);
        if (!a.approved) return deny(`The owner did not approve the plan${a.feedback ? `: ${a.feedback}` : "."} Stay in plan mode, change the plan, and present it again.`);
        const m = planMode(a.mode);
        if (m.note) this.note(run.sessionId, m.note);
        run.mode = m.mode;
        this.told(run.sessionId);
        // The mode the work goes on in is this child's alone (the session's destination, never the owner's settings).
        return { behavior: "allow", updatedInput: { ...input, plan: a.plan }, updatedPermissions: [{ type: "setMode", mode: m.mode, destination: "session" }], toolUseID: toolUse };
      }
      const gate = this.d.gate();
      if (!s || !gate) return deny("Keel could not ask the owner");
      const c = cardOf(name, input, run.cwd);
      // The card's input names the call's tool_use id, as the transcript's call id: its line says the answer.
      const item = typeof req.tool_use_id === "string" && req.tool_use_id ? { item: req.tool_use_id } : {};
      const call: ToolCall = { id: callId, tool: { description: "", input_schema: {}, readOnly: false, run: async () => ({ content: "" }), ...c.tool } as Tool, input: { ...c.input, ...item }, ctx };
      const says = typeof req.decision_reason === "string" && req.decision_reason.trim() ? `Claude Code says: ${req.decision_reason.replace(/\x1b\[[0-9;]*m/g, "").trim().slice(0, 500)}` : undefined;
      const v = await gate.askOnce(s, call, c.name, c.why, "harness", c.shown, says);
      if (!this.closed) this.told(run.sessionId);
      if (!v && !signal.aborted) return { behavior: "allow", updatedInput: input, toolUseID: toolUse };
      return deny(signal.aborted ? "The request was withdrawn: the turn stopped" : v?.deny || "The owner denied this call");
    } finally {
      run.cards.delete(rid);
    }
  }

  // The turn and the sends that came during it are over: the child's input closes and it ends.
  private end(run: Run): Promise<void> {
    run.ending ??= (async () => {
      run.stopped.abort();
      this.d.outside.retell(run.sessionId);
      run.child.end();
      let t: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([run.child.exited, new Promise<void>((r) => { t = setTimeout(r, RPC_MS); })]);
      clearTimeout(t);
      await this.kill(run);
    })();
    return run.ending;
  }

  // The child ends now, and what holds the session under it: SIGTERM to the child (a launcher passes it on), then
  // SIGKILL to whatever of them is still there after END_MS. What Claude Code started (MCP servers, the turn's
  // jobs) is left, whatever its arguments say.
  private kill(run: Run): Promise<void> {
    run.killing ??= (async () => {
      run.stopped.abort();
      if (run.child.alive) run.under = merged(run.under, this.writers(run));
      run.child.kill();
      const end = Date.now() + END_MS;
      while (Date.now() < end && (run.child.alive || run.under.some((p) => alive(p.pid, p.start)))) await Bun.sleep(25);
      if (run.child.alive) run.child.kill("SIGKILL");
      await reap(run.under, 0);
      await run.child.exited;
    })();
    return run.killing;
  }

  // The process whose record says it runs the session (sessions/<pid>.json of this pid domain, its start time
  // compared) and its ancestors under the child: a launcher's native claude. Nothing when the child itself holds it,
  // or no holder is under the child. Never a process found by its arguments.
  private writers(run: Run): Proc[] { return this.chainOf(run.child.pid, run.claudeId); }
  private chainOf(top: number, claudeId: string): Proc[] {
    for (const r of claudeRecordsOf(this.d.runningDir(), claudeId)) {
      if (foreignRecord(r)) continue;
      const c = holderChain(top, r.pid);
      if (c.length) return c;
    }
    return [];
  }

  // Processes kept with the session, until they ended.
  private keep(sessionId: string, procs: Proc[]) {
    const put = this.d.store.db.query("INSERT OR REPLACE INTO outside_procs (session_id, pid, start) VALUES (?, ?, ?)");
    for (const p of procs) put.run(sessionId, p.pid, p.start);
  }

  // The rows of processes that are gone (ended, or their pid taken again by another start).
  private forget(rows: ProcRow[]) {
    const del = this.d.store.db.query("DELETE FROM outside_procs WHERE session_id = ? AND pid = ? AND start = ?");
    for (const r of rows) if (!alive(r.pid, r.start)) del.run(r.session_id, r.pid, r.start);
  }

  // A child an earlier daemon left running, or what holds its session under it: the kept pid, started at the kept
  // moment, still claude answering over the control channel. Never a process Keel did not start, nor one Claude
  // Code started. Resolves when every one has ended.
  private async orphans(rows: ProcRow[]): Promise<void> {
    let left: Proc[] = [];
    for (const c of rows) {
      if (!alive(c.pid, c.start) || !printChild(c.pid)) continue;
      const id = this.d.store.session(c.session_id)?.outside?.source_id;
      left = merged(left, [{ pid: c.pid, start: c.start }, ...(id ? this.chainOf(c.pid, id) : [])]);
    }
    await reap(left, END_MS);
    if (this.closed) return;
    // A row goes once its process is gone: one that outlived its SIGKILL is still there for the next look.
    this.forget(rows);
  }

  private async gone(run: Run) {
    run.stopped.abort();
    try {
      // A launcher that ended leaves what it started (a native claude that holds the session): it ends too.
      await reap(run.under, END_MS);
      if (this.closed) return;
      this.forget(this.d.store.db.query<ProcRow, [string]>("SELECT session_id, pid, start FROM outside_procs WHERE session_id = ?").all(run.sessionId));
      // What the child wrote is Keel's: the next send does not take it for another process's write.
      try { this.left.set(run.sessionId, statSync(run.path).size); } catch {}
      if (this.runs.get(run.sessionId) === run) this.runs.delete(run.sessionId);
      if (!run.ending && !run.stopping && run.open.size) this.note(run.sessionId, `Claude Code ended in the middle of the turn${run.child.why() ? `: ${run.child.why()}` : ""}`);
      await this.check(run, true);
      if (this.closed) return;
      this.told(run.sessionId);
      this.d.outside.retell(run.sessionId);
      // A send stored while this child ended goes with a new one (one child: the others wait on `over` and take it).
      for (const s of this.sends(run.sessionId)) if (s.state === "stored") void this.deliver(run.sessionId, s.id).catch((e) => this.d.trouble(e, "answering a Claude Code session in place"));
    } finally {
      run.isOver();
    }
  }

  // At the daemon's start: the cards an earlier child raised are closed (it ended with the daemon), a send a
  // restart cut after it started is looked for in the transcript, one that never started goes if the session
  // is still free.
  start() {
    const gate = this.d.gate();
    for (const a of gate?.approvals({ pending: true }) ?? []) {
      if (a.call_id.startsWith("claude-") && this.d.store.session(a.session_id)?.outside) gate!.settled(a.session_id, a.call_id, CUT);
    }
    // And so does a question it asked: its alert says it was not answered, and waits no more.
    try { this.d.cutAsks?.(); } catch (e) { this.d.trouble(e, "closing the questions a Claude Code child asked before the restart"); }
    const rows = this.d.store.db.query<Send, []>("SELECT s.* FROM outside_sends s JOIN outside_sessions o ON o.session_id = s.session_id WHERE o.harness = 'claude' AND s.state IN ('stored', 'started') ORDER BY s.created").all();
    // Read now: a child this daemon starts from here on is not one an earlier daemon left.
    const left = this.d.store.db.query<ProcRow, []>("SELECT p.session_id, p.pid, p.start FROM outside_procs p JOIN outside_sessions o ON o.session_id = p.session_id WHERE o.harness = 'claude'").all();
    void this.restart(rows, left).catch((e) => this.d.trouble(e, "taking up the Claude Code sends an earlier daemon left"));
  }

  private async restart(rows: Send[], left: ProcRow[]) {
    const owed: Send[] = [];
    for (const s of rows) {
      const row = this.d.outside.row(s.session_id);
      if (!row) { this.set(s.id, "lost", { said: "its session is no longer followed" }); continue; }
      if (s.state === "started") {
        const after = await recordsFrom(row.path, s.offset ?? 0);
        if (this.closed) return;
        if (holdsMessage(after, s.text, s.id)) this.set(s.id, turnEnded(after, s.text, s.id) ? "delivered" : "cut", turnEnded(after, s.text, s.id) ? {} : { said: CUT });
        else this.set(s.id, "lost", { said: "Keel restarted while it went, and the session does not hold it: send it again" });
        continue;
      }
      owed.push(s);
    }
    await this.orphans(left).catch((e) => this.d.trouble(e, "ending a Claude Code child an earlier daemon left"));
    if (this.closed) return;
    // What an earlier daemon's child wrote is Keel's too.
    for (const sid of new Set(left.map((r) => r.session_id))) {
      const row = this.d.outside.row(sid);
      if (row) try { this.left.set(sid, statSync(row.path).size); } catch {}
    }
    for (const s of owed) void this.deliver(s.session_id, s.id).catch((e) => this.d.trouble(e, "answering a Claude Code session in place"));
  }

  stop() {
    this.closed = true;
    this.off();
    for (const r of [...this.runs.values()]) void this.kill(r);
    this.runs.clear();
  }
}
