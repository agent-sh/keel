// Answering a Claude Code session in place: the composer of a Claude Code
// session's row sends to that same session, same id, through the owner's own
// `claude` in print mode: `claude -p --resume ID` with stream-json in and out,
// its permission prompts to Keel over the control channel (claude-wire.ts says
// the wire and where each shape comes from). The child starts in the session's
// folder with the model of its last reply and the mode of its last prompt (a
// resumed print run restores neither), and an environment that keeps only the
// route that model names. Keel is the writer only while nothing else holds the
// session (writer.ts: a live Claude Code record of it, read right before the
// child starts) and only for the turn and the sends that come while it runs:
// Claude Code takes no lock, so the one-writer rule is Keel's.
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
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
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
import { headTail, scanBack } from "../import/files.ts";
import { splitGrown } from "./facts.ts";
import { alive, claudeRecordOf, holderChain, procOf, type Proc } from "./writer.ts";
import { merged, reap, SCHEMA, type Answered, type CardGate, type Send, type SendState } from "./codex-app.ts";
import type { Answer as PlanAnswer, PlanCard } from "../../server/routes/plan.ts";
import { answerLine, answersOf, argsOf, cardOf, childEnv, holdsMessage, modelOf, modeFor, planMode, questionsOf, readOut, refusalLine, requestLine, sessionFacts, turnEnded, userLine } from "./claude-wire.ts";

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
  interrupting?: boolean;
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

// The records of the transcript from a byte offset on (the bytes a send started at): what the session gained since.
function records(path: string, offset: number): Json[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const from = Math.max(0, Math.min(offset, size));
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    return splitGrown("", buf.toString("utf8") + "\n").records;
  } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }
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
  private said = new Map<string, string[]>();
  private closed = false;
  private off: () => void;

  constructor(private d: ClaudeCodeDeps) {
    // The outbox and the children's table are the Codex route's (codex-app.ts), one for both harnesses.
    d.store.migrate(SCHEMA);
    this.off = d.bus.on((f) => {
      if (f.t !== "session" || !f.deleted) return;
      this.said.delete(f.session.id);
      if (this.runs.has(f.session.id)) void this.interrupt(f.session.id).catch((e) => d.trouble(e, "stopping a deleted session's Claude Code turn"));
    });
  }

  ours(sessionId: string): boolean { return this.runs.has(sessionId); }
  running(sessionId: string): boolean { return (this.runs.get(sessionId)?.open.size ?? 0) > 0; }

  // What a send does now: resume the session (free), add to the turn Keel runs, nothing (another process
  // holds it, or there is no claude program here).
  route(sessionId: string, holder = this.d.outside.holderNow(sessionId)): "resume" | "steer" | "held" | "missing" {
    if (this.ours(sessionId)) return "steer";
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
  notes(sessionId: string): string[] { return this.said.get(sessionId) ?? []; }
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
    const had = this.notes(sessionId);
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

  // A send by the owner. Answered once the send is stored (or refused before it is): `key` stores it once.
  send(sessionId: string, text: string, key: string, again?: string): { send: Send } | { error: string; status: number; holder?: Holder } {
    const s = this.d.store.session(sessionId);
    const row = this.d.outside.row(sessionId);
    if (!s?.outside || !row) return { error: "not a session of another harness", status: 404 };
    if (row.harness !== "claude") return { error: "not a Claude Code session", status: 409 };
    if (!text.trim()) return { error: "nothing to send", status: 400 };
    const had = this.one(sessionId, key);
    if (had) return { send: had };
    const holder = this.d.outside.holderNow(sessionId) ?? { kind: "free" as const };
    const mine = holder.kind === "keel";
    if (!mine && holder.kind !== "free") return { error: `${holderSaid(holder, "Claude Code")}: answer it there. Keel sends nothing to a session another process holds.`, status: 409, holder };
    if (!mine && !this.d.bin()) return { error: "no claude program here: Keel answers a Claude Code session with the claude on your PATH (or KEEL_CLAUDE_BIN)", status: 409 };
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

  // The owner's Stop: Claude Code's turn is interrupted over the control channel (its open cards withdrawn).
  async interrupt(sessionId: string): Promise<boolean> {
    const r = this.runs.get(sessionId);
    if (!r) return false;
    for (const c of r.cards.values()) c.abort();
    if (r.interrupting) { void this.kill(r); return true; }
    if (!r.open.size) { void this.end(r); return true; }
    r.interrupting = true;
    const ok = await bounded(r.child.request({ subtype: "interrupt" }), "Stop").then(() => true, () => false);
    if (!ok) { void this.kill(r); return true; }
    // Taken, the turn ends with its result soon: a child still in it a few seconds later is ended.
    const t = setTimeout(() => { if (this.runs.get(sessionId) === r && r.interrupting && r.open.size) void this.kill(r); }, RPC_MS);
    (t as any).unref?.();
    return true;
  }

  private async deliver(sessionId: string, id: string) {
    let r = this.runs.get(sessionId);
    // A child that is ending is waited out, and so is what held the session under it; then the one child in runs
    // is taken (a send that came meanwhile may have started it), never a second one beside it.
    while (r?.ending || r?.killing) {
      await r.over;
      if (this.closed) return;
      r = this.runs.get(sessionId);
    }
    if (!r) {
      // Read again right before the child starts: another process may have taken the session since.
      const holder = this.d.outside.holderNow(sessionId);
      if (holder && holder.kind !== "free" && holder.kind !== "keel") return this.set(id, "failed", { said: `${holderSaid(holder, "Claude Code")}: it did not go` });
      const begun = this.begin(sessionId);
      if (typeof begun === "string") return this.set(id, "failed", { said: begun });
      r = begun;
    }
    const run = r;
    const ready = await run.ready;
    // A daemon that stopped meanwhile marks nothing: the send stays stored, and the next one sends it.
    if (this.closed) return;
    if (!ready) {
      if (this.byId(id)?.state === "stored") this.set(id, "failed", { said: "Claude Code did not resume the session" });
      return;
    }
    const send = this.byId(id);
    if (!send || send.state !== "stored") return;
    let size = 0;
    try { size = statSync(run.path).size; } catch {}
    // Started before it goes: a restart from here on looks for it in the transcript, never sends it again.
    this.set(id, "started", { offset: size });
    run.given.add(id);
    run.open.add(id);
    run.interrupting = false;
    if (!run.child.write(userLine(send.text, send.id))) {
      run.given.delete(id);
      run.open.delete(id);
      this.set(id, "lost", { said: "Claude Code ended before it took it: send it again" });
      return;
    }
    this.d.outside.retell(sessionId);
  }

  // The child for a turn: started and initialized (ready says whether it is); else why not.
  private begin(sessionId: string): Run | string {
    const row = this.d.outside.row(sessionId);
    const bin = this.d.bin();
    if (!row || !bin || !existsSync(row.path)) return "its transcript is no longer where it was";
    const { head, tail } = headTail(row.path, 64 * 1024);
    const f = sessionFacts([...head, ...tail]);
    f.model = sessionFacts(tail).model ?? scanBack(row.path, modelOf) ?? f.model;
    const isDir = (p?: string) => { try { return !!p && statSync(p).isDirectory(); } catch { return false; } };
    // The session's folder is gone (a worktree cleaned up): Claude Code would look for it in another one.
    if (f.cwd && !isDir(f.cwd)) return `its folder ${f.cwd} is gone: Claude Code would work somewhere else. It did not go`;
    const cwd = f.cwd ?? homeDir();
    const m = modeFor(f.mode);
    if (m.note) this.note(sessionId, m.note);
    const env = childEnv(this.d.env?.() ?? process.env, f.model, this.d.configDir());
    const child = new Child(argsOf(bin, row.source_id, { model: f.model, mode: m.mode }), cwd, env, (msg) => this.d.trouble(new Error(msg), "claude in print mode"));
    let isOver = () => {};
    const over = new Promise<void>((r) => { isOver = r; });
    const run: Run = { sessionId, claudeId: row.source_id, path: row.path, cwd, child, ready: Promise.resolve(false), open: new Set(), given: new Set(), blocks: new Map(), cards: new Map(), stopped: new AbortController(), nonce: Bun.randomUUIDv7().slice(-12), under: [], over, isOver };
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
        run.interrupting = false;
        run.blocks.clear();
        run.message = undefined;
        if (o.error && o.said) this.note(run.sessionId, `Claude Code ended the turn with an error: ${o.said}`);
        this.check(run);
        if (!run.open.size && !this.sends(run.sessionId).some((s) => s.state === "stored")) void this.end(run);
        else this.d.outside.retell(run.sessionId);
        return;
      }
    }
  }

  private check(run: Run, last = false) {
    for (const id of [...run.given]) {
      const s = this.byId(id);
      if (!s || s.state !== "started") { run.given.delete(id); continue; }
      if (holdsMessage(records(run.path, s.offset ?? 0), s.text, s.id)) { this.set(id, "delivered"); run.given.delete(id); }
      else if (last) { this.set(id, "lost", { said: "Claude Code ended before the session held it: send it again" }); run.given.delete(id); }
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
        const askId = crypto.randomUUID();
        const text = qs.map((q) => q.question).join("\n") || "Claude Code asks a question";
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

  // The process whose record says it runs the session (sessions/<pid>.json, its start time compared) and its
  // ancestors under the child: a launcher's native claude. Nothing when the child itself holds it, or the holder
  // is not under the child. Never a process found by its arguments.
  private writers(run: Run): Proc[] {
    const r = claudeRecordOf(this.d.runningDir(), run.claudeId);
    return holderChain(run.child.pid, r?.pid);
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
      const r = id ? claudeRecordOf(this.d.runningDir(), id) : undefined;
      left = merged(left, [{ pid: c.pid, start: c.start }, ...holderChain(c.pid, r?.pid)]);
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
      if (this.runs.get(run.sessionId) === run) this.runs.delete(run.sessionId);
      if (!run.ending && run.open.size) this.note(run.sessionId, `Claude Code ended in the middle of the turn${run.child.why() ? `: ${run.child.why()}` : ""}`);
      this.check(run, true);
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
    const owed: Send[] = [];
    const rows = this.d.store.db.query<Send, []>("SELECT s.* FROM outside_sends s JOIN outside_sessions o ON o.session_id = s.session_id WHERE o.harness = 'claude' AND s.state IN ('stored', 'started') ORDER BY s.created").all();
    for (const s of rows) {
      const row = this.d.outside.row(s.session_id);
      if (!row) { this.set(s.id, "lost", { said: "its session is no longer followed" }); continue; }
      if (s.state === "started") {
        const after = records(row.path, s.offset ?? 0);
        if (holdsMessage(after, s.text, s.id)) this.set(s.id, turnEnded(after, s.text, s.id) ? "delivered" : "cut", turnEnded(after, s.text, s.id) ? {} : { said: CUT });
        else this.set(s.id, "lost", { said: "Keel restarted while it went, and the session does not hold it: send it again" });
        continue;
      }
      owed.push(s);
    }
    // Read now: a child this daemon starts from here on is not one an earlier daemon left.
    const left = this.d.store.db.query<ProcRow, []>("SELECT p.session_id, p.pid, p.start FROM outside_procs p JOIN outside_sessions o ON o.session_id = p.session_id WHERE o.harness = 'claude'").all();
    void this.orphans(left).catch((e) => this.d.trouble(e, "ending a Claude Code child an earlier daemon left")).then(() => {
      if (this.closed) return;
      for (const s of owed) void this.deliver(s.session_id, s.id).catch((e) => this.d.trouble(e, "answering a Claude Code session in place"));
    });
  }

  stop() {
    this.closed = true;
    this.off();
    for (const r of [...this.runs.values()]) void this.kill(r);
    this.runs.clear();
  }
}
