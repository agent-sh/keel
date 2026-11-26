// Answering a Codex session in place: the composer of a Codex session's row
// sends to that same thread through Codex's own server, `codex app-server`
// over stdio, started for the turn with the thread's own Codex home, provider,
// folder, approval policy and sandbox. Keel is the thread's writer only while
// nothing else holds it (src/integrations/outside/writer.ts, read right before
// the child starts) and only for the turn: the child ends when the turn ends,
// since Codex keeps the thread's writer lock for as long as its process lives
// and would lock the owner's terminal out.
//
//   initialize, thread/resume (excludeTurns), turn/start; turn/steer while the
//   turn runs; turn/interrupt for Stop; then the child's input closes.
//
// What Codex asks while it works becomes a Keel card, answered once: a command
// to run, a file change, more permissions (the gate's one-call card, which the
// phone gets as any card), and a question (requestUserInput, a question card).
// Nothing here is stored as the session's events: the rollout stays the only
// record, and the mirror (service.ts) stores what Codex writes there, the
// owner's message and the reply included. The reply's words stream as delta
// frames until the mirror stores the reply.
//
// A send is stored before its sender is answered and given to Codex once:
// stored, then started (the rollout's size kept with it, before the request
// goes), then delivered when the rollout holds the message. A send a restart
// cut after it started is looked for in the rollout from that size: found, it
// was delivered; not found, it says so and waits for the owner to send it
// again. One that never started goes when the daemon is back, if the thread is
// still free.
import { existsSync, readFileSync, statSync } from "node:fs";
import { AcpConnection } from "../../acp/rpc.ts";
import type { Bus } from "../../core/bus.ts";
import type { Store } from "../../core/store.ts";
import type { Holder } from "../../core/types.ts";
import type { Gate } from "../../safety/gate.ts";
import { holderSaid } from "../../core/watch.ts";
import { homeDir } from "../../core/paths.ts";
import type { ToolCall } from "../../engine/hooks.ts";
import { allPendingQuestions, askFor, DECLINED, type Answers } from "../../tools/interact.ts";
import type { Tool, ToolContext } from "../../tools/types.ts";
import { headTail } from "../import/files.ts";
import { alive, codexKeepsLocks, descendants, procOf, type Proc } from "./writer.ts";

type Json = any;
type ProcRow = { session_id: string; pid: number; start: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outside_sends (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL,
  offset INTEGER,
  said TEXT,
  created INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS outside_sends_key ON outside_sends(session_id, key);
-- Keel's own children (codex app-server) and the processes under them (a launcher's native codex), by their pid
-- and start time: one a daemon that ended left running is ended by the next one (the thread's writer lock is held
-- while it lives).
CREATE TABLE IF NOT EXISTS outside_procs (
  session_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  start TEXT NOT NULL,
  PRIMARY KEY (session_id, pid)
);
`;

// stored: taken, not yet given to Codex. started: given (turn/start or turn/steer written). delivered: the
// rollout holds it. lost: it was given and the rollout does not hold it, or Codex refused it: sent again
// only by the owner. failed: refused before it went (`said` says why). cut: the rollout holds it and the
// turn it started stopped with a restart of Keel's (Keel's child ended with the daemon), said until put away.
export type SendState = "stored" | "started" | "delivered" | "lost" | "failed" | "cut";
const KEEP_MS = 24 * 3600_000;
const CUT = "Keel restarted while Codex worked: the turn stopped there";
const UNLOCKED = "this Codex keeps no writer locks (a Codex before 0.172), so Keel cannot tell whether a terminal has the session open: it sends nothing. Answer it in Codex, or update Codex";
export type Send = { id: string; session_id: string; key: string; text: string; state: SendState; offset: number | null; said: string | null; created: number };

// What of the gate the driver uses: the one-call card, and the open cards it closes at a start.
export type Answered = { state: "allowed" | "denied"; reason?: string };
export type CardGate = Pick<Gate, "askOnce" | "approvals" | "settled">;

export type CodexAppDeps = {
  store: Store;
  bus: Bus;
  outside: {
    row(sessionId: string): { harness: string; source_id: string; path: string } | undefined;
    holderNow(sessionId: string): Holder | undefined;
    retell(sessionId: string): void;
  };
  gate: () => CardGate | undefined;
  // The codex program and the Codex home the mirror reads (read when used).
  bin: () => string | undefined;
  home: () => string;
  trouble: (e: unknown, at: string) => void;
  // A question Codex asks is an alert like the model's own (the turn hooks' ownerAsked and ownerAnswered).
  asked?: (sessionId: string, callId: string, text: string, askId: string) => void;
  answered?: (sessionId: string, callId: string, answered: boolean, askId: string) => void;
  // At a start: the alerts of the questions a child of an earlier daemon asked are closed, not answered (the
  // question went with that child; alerts.ts closeAsks).
  cutAsks?: () => void;
};

// What the rollout says of the thread: its provider (a resume under another is refused with
// modelProviderMismatch), its folder, and the approval policy and sandbox its last turn ran with.
export type ThreadFacts = { provider?: string; cwd?: string; approval?: string; sandbox?: string };
const SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const APPROVALS = new Set(["untrusted", "on-failure", "on-request", "never"]);
export function threadFacts(head: Json[], tail: Json[]): ThreadFacts {
  const meta = head.find((r) => r?.type === "session_meta")?.payload ?? {};
  const ctx = [...head, ...tail].filter((r) => r?.type === "turn_context").at(-1)?.payload ?? {};
  const kebab = (v: unknown) => (typeof v === "string" ? v.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/_/g, "-") : undefined);
  const sandbox = kebab(ctx.sandbox_policy?.type ?? ctx.sandbox_policy?.mode ?? ctx.sandbox_policy);
  const approval = kebab(ctx.approval_policy);
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    provider: str(meta.model_provider),
    cwd: str(ctx.cwd) ?? str(meta.cwd),
    ...(approval && APPROVALS.has(approval) ? { approval } : {}),
    ...(sandbox && SANDBOXES.has(sandbox) ? { sandbox } : {}),
  };
}

// Whether the records Codex wrote hold the owner's message: its user_message event or its user item.
export function holdsMessage(records: Json[], text: string): boolean {
  const want = text.trim();
  const texts = (c: Json) => (Array.isArray(c) ? c.filter((p: Json) => p?.type === "input_text" || p?.type === "text").map((p: Json) => String(p.text ?? "")).join("\n") : "");
  return records.some((r) => {
    const p = r?.payload;
    if (r?.type === "event_msg" && p?.type === "user_message") return String(p.message ?? "").trim() === want;
    if (r?.type === "response_item" && p?.type === "message" && p.role === "user") return texts(p.content).trim() === want;
    return false;
  });
}

// Whether the turn the message is in ended in the records: a task_complete or turn_aborted after it.
export function turnEnded(records: Json[], text: string): boolean {
  const at = records.findIndex((r) => holdsMessage([r], text));
  return at >= 0 && records.slice(at + 1).some((r) => r?.type === "event_msg" && (r.payload?.type === "task_complete" || r.payload?.type === "turn_aborted"));
}

// The last record of a type in a JSONL file, read back from its end a part at a time until one is found
// (a long thread's last turn can have begun far before the file's tail). The bytes are searched as bytes and only a
// line that holds the type's mark is decoded; each part is read off the loop, so a long thread holds it for no part.
export async function lastRecord(path: string, type: string, part = 1024 * 1024): Promise<Json | undefined> {
  try {
    let end = statSync(path).size;
    const file = Bun.file(path);
    const mark = Buffer.from(`"type":"${type}"`);
    let rest = Buffer.alloc(0);
    while (end > 0) {
      const from = Math.max(0, end - part);
      const got = Buffer.from(await file.slice(from, end).arrayBuffer());
      end = from;
      // The part's first line may be cut (a character too): its bytes are kept and read with the part before it.
      const buf = rest.length ? Buffer.concat([got, rest]) : got;
      const cut = from > 0 ? buf.indexOf(10) : -1;
      if (from > 0 && cut < 0) { rest = buf; continue; }
      for (let at = buf.length; at > cut + 1; ) {
        at = buf.lastIndexOf(mark, at - 1);
        if (at <= cut) break;
        const s = buf.lastIndexOf(10, at) + 1;
        const e = buf.indexOf(10, at);
        try { const r = JSON.parse(buf.subarray(s, e < 0 ? buf.length : e).toString("utf8")); if (r?.type === type) return r; } catch {}
        at = s;
      }
      rest = from > 0 ? buf.subarray(0, cut) : Buffer.alloc(0);
    }
    return undefined;
  } catch { return undefined; }
}

// What a send's delivery is read from: the user's messages and the turn's end. A line that holds none of these
// marks is never decoded (a long turn's tool output is most of a rollout's bytes).
const MARKS = ['"type":"user_message"', '"role":"user"', '"type":"task_complete"', '"type":"turn_aborted"'].map((m) => Buffer.from(m));

// The records of a file from a byte offset on (the bytes a send started at) that say a message or a turn's end:
// what the thread gained since. Read a part at a time off the loop; the bytes are searched as bytes and only a
// line with a mark is decoded, so a long thread holds the loop for no part.
export async function recordsFrom(path: string, offset: number, part = 1024 * 1024): Promise<Json[]> {
  try {
    const file = Bun.file(path);
    const size = statSync(path).size;
    let at = Math.max(0, Math.min(offset, size));
    const out: Json[] = [];
    let rest = Buffer.alloc(0);
    while (at < size) {
      const end = Math.min(size, at + part);
      const got = Buffer.from(await file.slice(at, end).arrayBuffer());
      at = end;
      const buf = rest.length ? Buffer.concat([rest, got]) : got;
      // A part's last line may be cut (a character too): its bytes are read with the next part. The file's end
      // is read whole (a last line still being written parses when it is whole).
      const whole = at >= size ? buf.length : buf.lastIndexOf(10) + 1;
      marked(buf.subarray(0, whole), out);
      rest = Buffer.from(buf.subarray(whole));
    }
    return out;
  } catch { return []; }
}

function marked(buf: Buffer, out: Json[]) {
  const starts = new Set<number>();
  for (const m of MARKS) for (let i = buf.indexOf(m); i >= 0; i = buf.indexOf(m, i + m.length)) starts.add(buf.lastIndexOf(10, i) + 1);
  for (const s of [...starts].sort((a, b) => a - b)) {
    const e = buf.indexOf(10, s);
    try { out.push(JSON.parse(buf.subarray(s, e < 0 ? buf.length : e).toString("utf8"))); } catch {}
  }
}

// How long a request that only moves the child along (initialize, turn/interrupt, thread/unsubscribe) may take
// before the child is taken as not answering, and how long a child that was told to end may take to end.
const RPC_MS = 5000;
const END_MS = 2000;
const bounded = <T>(p: Promise<T>, what: string, ms = RPC_MS): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, no) => { t = setTimeout(() => no(new Error(`Codex did not answer ${what} in ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(t));
};

type Run = {
  sessionId: string;
  threadId: string;
  path: string;
  conn: AcpConnection;
  ready: Promise<boolean>;
  turn?: string;
  ending?: Promise<void>;
  // The reply's items by their id, each a block of the streaming draft.
  items: Map<string, number>;
  // A file change's files and diff, from its item, for the card that asks about it.
  changes: Map<string, { path: string; kind?: Json; diff?: string }[]>;
  // The cards open now, by the request's id: withdrawn when Codex says it resolved one, or the turn stops.
  cards: Map<string | number, AbortController>;
  stopped: AbortController;
  // This child's own mark in the ids of its cards and questions: a child's request ids start again at each
  // start, so an id of an earlier turn's card never names one of this turn's.
  nonce: string;
  // The owner's Stop was asked of Codex: a second Stop ends the child.
  interrupting?: boolean;
  // Sends given to this child whose delivery is checked at the turn's end.
  given: Set<string>;
  // The processes under the child that serve the protocol, learned once it resumed and again when it is ended: a
  // launcher (the npm package's codex.js) runs the native codex as its child, and the native holds the writer lock.
  // Nothing else under it (Codex's MCP servers, a job of the owner's turn) is Keel's to end.
  under: Proc[];
  exited: boolean;
  // The child is ending or ended: a send waits for `over` (it is gone, and so is the native under it) and goes
  // with the next one.
  closing?: boolean;
  killing?: Promise<void>;
  over: Promise<void>;
  isOver: () => void;
};

export class CodexApp {
  private runs = new Map<string, Run>();
  // A child being prepared (its rollout read for the thread's facts): a second send waits for the same one.
  private starting = new Map<string, Promise<Run | string>>();
  // What the bar says of the session's last turn besides its sends (a form Keel declined), until the next send.
  private said = new Map<string, string[]>();
  private closed = false;

  private off: () => void;

  constructor(private d: CodexAppDeps) {
    d.store.migrate(SCHEMA);
    // A row the owner deletes while Keel runs its turn: the turn is stopped and the child ends (its sends went
    // with the row).
    this.off = d.bus.on((f) => {
      if (f.t !== "session" || !f.deleted) return;
      this.said.delete(f.session.id);
      const r = this.runs.get(f.session.id);
      if (r) void this.interrupt(f.session.id).catch((e) => d.trouble(e, "stopping a deleted session's Codex turn"));
    });
  }

  // Keel's own child holds the session now (until it has ended: it holds the writer lock until then).
  ours(sessionId: string): boolean {
    return this.runs.has(sessionId) || this.starting.has(sessionId);
  }

  running(sessionId: string): boolean {
    return !!this.runs.get(sessionId)?.turn;
  }

  // What a send does now: resume the thread (free), steer the turn Keel runs, nothing (another process
  // holds it, there is no codex program here, or the Codex home keeps no writer locks: an older Codex, whose
  // open terminal nothing shows, so a thread that reads as free may not be).
  route(sessionId: string, holder = this.d.outside.holderNow(sessionId)): "resume" | "steer" | "held" | "missing" | "unlocked" {
    if (this.ours(sessionId)) return "steer";
    if (!this.d.bin()) return "missing";
    if (!codexKeepsLocks(this.d.home())) return "unlocked";
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

  notes(sessionId: string): string[] {
    return this.said.get(sessionId) ?? [];
  }

  // What the owner answered on the cards of Codex's calls, by the call's id in the rollout (its item id): the
  // call's line in the mirror says it (the rollout itself says only what the call returned).
  answers(sessionId: string): Record<string, Answered> {
    const out: Record<string, Answered> = {};
    for (const a of this.d.gate()?.approvals({ session: sessionId }) ?? []) {
      if (!a.call_id.startsWith("codex-") || typeof a.input?.item !== "string") continue;
      if (a.state === "allowed") out[a.input.item] = { state: "allowed" };
      else if (a.state === "denied") out[a.input.item] = { state: "denied", ...(a.reason ? { reason: a.reason } : {}) };
    }
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
  // `again`: a send that was lost, sent again now as this one (it goes in the same write).
  send(sessionId: string, text: string, key: string, again?: string): { send: Send } | { error: string; status: number; holder?: Holder } {
    const s = this.d.store.session(sessionId);
    const row = this.d.outside.row(sessionId);
    if (!s?.outside || !row) return { error: "not a session of another harness", status: 404 };
    if (row.harness !== "codex") return { error: "Keel answers only Codex sessions in place for now", status: 409 };
    if (!text.trim()) return { error: "nothing to send", status: 400 };
    const had = this.one(sessionId, key);
    if (had) return { send: had };
    const holder = this.d.outside.holderNow(sessionId) ?? { kind: "free" as const };
    const mine = holder.kind === "keel";
    if (!mine && holder.kind !== "free") return { error: `${holderSaid(holder, "Codex")}: answer it there. Keel sends nothing to a session another process holds.`, status: 409, holder };
    if (!mine && !this.d.bin()) return { error: "no codex program here: Keel answers a Codex session with the codex on your PATH (or KEEL_CODEX_BIN)", status: 409 };
    if (!mine && !codexKeepsLocks(this.d.home())) return { error: UNLOCKED, status: 409 };
    const send: Send = { id: Bun.randomUUIDv7(), session_id: sessionId, key, text, state: "stored", offset: null, said: null, created: Date.now() };
    this.said.delete(sessionId);
    this.prune();
    this.d.store.db.transaction(() => {
      if (again) this.d.store.db.query("DELETE FROM outside_sends WHERE id = ? AND session_id = ? AND state IN ('lost', 'failed')").run(again, sessionId);
      this.d.store.db.query("INSERT INTO outside_sends (id, session_id, key, text, state, offset, said, created) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)").run(send.id, sessionId, key, text, "stored", send.created);
    })();
    this.told(sessionId);
    void this.deliver(sessionId, send.id).catch((e) => { this.d.trouble(e, "answering a Codex session in place"); this.set(send.id, "lost", { said: `it could not go to Codex: ${(e as Error).message}` }); });
    return { send };
  }

  private prune() {
    this.d.store.db.query("DELETE FROM outside_sends WHERE state = 'delivered' AND created < ?").run(Date.now() - KEEP_MS);
  }

  // A lost or refused send, put away by the owner.
  dismiss(sessionId: string, id: string): boolean {
    const n = this.d.store.db.query("DELETE FROM outside_sends WHERE id = ? AND session_id = ? AND state IN ('lost', 'failed', 'cut')").run(id, sessionId).changes;
    if (n) this.told(sessionId);
    return n > 0;
  }

  // The owner's Stop: the turn Keel runs is interrupted (its open cards are withdrawn with it).
  async interrupt(sessionId: string): Promise<boolean> {
    const r = this.runs.get(sessionId);
    if (!r) return false;
    for (const c of r.cards.values()) c.abort();
    // A second Stop, a Stop of a child that is ending, or a Codex that does not answer the first in a few
    // seconds: the child ends. (The bar sends no second Stop while its first is out: a double press is one.)
    if (r.interrupting || r.closing) { void this.kill(r); return true; }
    if (!r.turn) { void this.end(r); return true; }
    r.interrupting = true;
    const turn = r.turn;
    const ok = await bounded(r.conn.request("turn/interrupt", { threadId: r.threadId, turnId: turn }), "Stop").then(() => true, () => false);
    if (!ok) { void this.kill(r); return true; }
    // Taken, the turn ends soon: one that is still open a few seconds later is ended with the child.
    const t = setTimeout(() => { if (this.runs.get(sessionId) === r && r.turn === turn) void this.kill(r); }, RPC_MS);
    (t as any).unref?.();
    return true;
  }

  private async deliver(sessionId: string, id: string) {
    let r = this.runs.get(sessionId);
    // A child that is ending: the send goes with the next one, which only one send starts (the others, and
    // the one that ending child's end starts for what was stored meanwhile, take it from `runs`).
    while (r?.closing) {
      await r.over;
      if (this.closed) return;
      r = this.runs.get(sessionId);
    }
    if (!r) {
      let begun = this.starting.get(sessionId);
      if (!begun) {
        // Read again right before the child starts: another process may have taken the thread since.
        const holder = this.d.outside.holderNow(sessionId);
        if (holder && holder.kind !== "free" && holder.kind !== "keel") return this.set(id, "failed", { said: `${holderSaid(holder, "Codex")}: it did not go` });
        begun = this.begin(sessionId).finally(() => this.starting.delete(sessionId));
        this.starting.set(sessionId, begun);
      }
      const got = await begun;
      if (typeof got === "string") { if (this.byId(id)?.state === "stored") this.set(id, "failed", { said: got }); return; }
      r = got;
    }
    const run = r;
    if (!(await run.ready)) {
      if (this.byId(id)?.state === "stored") this.set(id, "failed", { said: "Codex did not resume the session" });
      return;
    }
    const send = this.byId(id);
    if (!send || send.state !== "stored") return;
    const input = [{ type: "text", text: send.text, text_elements: [] }];
    let size = 0;
    try { size = statSync(run.path).size; } catch {}
    // Started before it goes: a restart from here on looks for it in the rollout, never sends it again.
    this.set(id, "started", { offset: size });
    run.given.add(id);
    if (run.turn) {
      const steered = await run.conn.request("turn/steer", { threadId: run.threadId, input, expectedTurnId: run.turn, clientUserMessageId: id }).then(() => true, () => false);
      if (steered) return;
    }
    try {
      const res = await run.conn.request("turn/start", { threadId: run.threadId, input, clientUserMessageId: id });
      if (typeof res?.turn?.id === "string" && res.turn.status === "inProgress") run.turn = res.turn.id;
      this.d.outside.retell(sessionId);
    } catch (e) {
      run.given.delete(id);
      this.set(id, "lost", { said: `Codex did not take it: ${(e as Error).message}` });
      if (!run.turn) void this.end(run);
    }
  }

  // The child for a turn: started, initialized and resumed on the thread (ready says whether it is); else why not.
  private async begin(sessionId: string): Promise<Run | string> {
    const row = this.d.outside.row(sessionId);
    const bin = this.d.bin();
    if (!row || !bin || !existsSync(row.path)) return "its rollout is no longer where it was";
    const { head } = headTail(row.path, 64 * 1024);
    const ctx = await lastRecord(row.path, "turn_context");
    if (this.closed) return "Keel is stopping";
    // Taken while the rollout was read (another process): the look is made again right before the start.
    const holder = this.d.outside.holderNow(sessionId);
    if (holder && holder.kind !== "free" && holder.kind !== "keel") return `${holderSaid(holder, "Codex")}: it did not go`;
    const f = threadFacts(head, ctx ? [ctx] : []);
    const home = this.d.home();
    const isDir = (p?: string) => { try { return !!p && statSync(p).isDirectory(); } catch { return false; } };
    // The thread's folder is gone (removed, a worktree cleaned up): Codex would work in another one.
    if (f.cwd && !isDir(f.cwd)) return `its folder ${f.cwd} is gone: Codex would work somewhere else. It did not go`;
    const cwd = f.cwd ?? homeDir();
    // The owner's own coding agent, as an ACP agent is: the whole environment (it signs in from it), with the Codex
    // home the mirror reads.
    const conn = new AcpConnection([bin, "app-server"], { cwd, env: { CODEX_HOME: home } }, (m) => this.d.trouble(new Error(m), "codex app-server"));
    let isOver = () => {};
    const over = new Promise<void>((r) => { isOver = r; });
    const run: Run = { sessionId, threadId: row.source_id, path: row.path, conn, ready: Promise.resolve(false), nonce: Bun.randomUUIDv7().slice(-12), items: new Map(), changes: new Map(), cards: new Map(), stopped: new AbortController(), given: new Set(), under: [], exited: false, over, isOver };
    this.runs.set(sessionId, run);
    const self = procOf(conn.pid);
    if (self) this.keep(sessionId, [self]);
    conn.onNotification = (method, p) => this.heard(run, method, p);
    conn.onRequest = (method, p, rid) => this.asked(run, method, p, rid);
    void conn.exited.then(() => { run.exited = true; return this.gone(run); }).catch((e) => this.d.trouble(e, "a Codex child that ended"));
    run.ready = (async () => {
      try {
        await bounded(conn.request("initialize", { clientInfo: { name: "keel", title: "Keel", version: "1" }, capabilities: { experimentalApi: false, requestAttestation: false } }), "initialize");
        conn.notify("initialized", undefined);
        await conn.request("thread/resume", {
          threadId: run.threadId, excludeTurns: true,
          ...(f.provider ? { modelProvider: f.provider } : {}), ...(f.cwd ? { cwd: f.cwd } : {}),
          ...(f.approval ? { approvalPolicy: f.approval } : {}), ...(f.sandbox ? { sandbox: f.sandbox } : {}),
        });
        // What serves under the child now (a launcher's native codex, which holds the lock): kept, so a next
        // daemon ends it too when this one could not.
        run.under = servers(conn.pid);
        if (run.under.length) this.keep(sessionId, run.under);
        this.d.outside.retell(sessionId);
        return true;
      } catch (e) {
        const msg = (e as Error).message;
        // Another process became its writer between the look and the resume: Codex refuses, and says so.
        const holder = /active writer/i.test(msg) ? this.d.outside.holderNow(sessionId) : undefined;
        const said = holder && holder.kind !== "free" && holder.kind !== "keel" ? `${holderSaid(holder, "Codex")}: it did not go` : `Codex did not resume the session: ${msg}`;
        for (const s of this.sends(sessionId)) if (s.state === "stored") this.set(s.id, "failed", { said });
        void this.end(run);
        return false;
      }
    })();
    return run;
  }

  private heard(run: Run, method: string, p: Json) {
    if (p?.threadId && p.threadId !== run.threadId) return;
    switch (method) {
      case "turn/started":
        if (typeof p?.turn?.id === "string") run.turn = p.turn.id;
        return;
      case "item/started":
        if (p?.item?.type === "fileChange" && Array.isArray(p.item.changes)) run.changes.set(String(p.item.id), p.item.changes);
        return;
      case "item/agentMessage/delta": {
        const item = String(p?.itemId ?? "");
        let index = run.items.get(item);
        if (index === undefined) run.items.set(item, (index = run.items.size));
        if (typeof p?.delta === "string" && p.delta) this.d.bus.emit({ t: "delta", session_id: run.sessionId, index, kind: "text", text: p.delta });
        return;
      }
      case "serverRequest/resolved":
        run.cards.get(p?.requestId)?.abort();
        return;
      case "turn/completed":
        if (!p?.turn?.id || p.turn.id === run.turn) {
          run.turn = undefined;
          // The Stop was for this turn: a Stop of the next one asks Codex first again.
          run.interrupting = false;
          run.items.clear();
          void this.check(run).catch((e) => this.d.trouble(e, "checking a Codex send"));
          // A send that came while the turn ended goes in a turn of its own; else the child ends now.
          if (!this.sends(run.sessionId).some((s) => s.state === "stored")) void this.end(run);
        }
        return;
    }
  }

  // Each send given to this child: delivered when the rollout holds it.
  private async check(run: Run, last = false) {
    for (const id of [...run.given]) {
      const s = this.byId(id);
      if (!s || s.state !== "started") { run.given.delete(id); continue; }
      const held = holdsMessage(await recordsFrom(run.path, s.offset ?? 0), s.text);
      // A daemon that stopped while the rollout was read checks nothing more (its store may be closed).
      if (this.closed) return;
      if (this.byId(id)?.state !== "started") { run.given.delete(id); continue; }
      if (held) { this.set(id, "delivered"); run.given.delete(id); }
      else if (last) { this.set(id, "lost", { said: "Codex ended before the session held it: send it again" }); run.given.delete(id); }
    }
  }

  private async asked(run: Run, method: string, p: Json, rid: number | string): Promise<Json> {
    const s = this.d.store.session(run.sessionId);
    const gate = this.d.gate();
    const ac = new AbortController();
    run.cards.set(rid, ac);
    const signal = AbortSignal.any([ac.signal, run.stopped.signal]);
    const cwd = typeof p?.cwd === "string" ? p.cwd : s?.workspace ?? homeDir();
    const ctx = { sessionId: run.sessionId, cwd, signal, seen: new Map(), spillDir: "" } as unknown as ToolContext;
    const call = (tool: Partial<Tool> & { name: string }, input: Json): ToolCall => ({ id: `codex-${run.nonce}-${String(p?.itemId ?? rid)}-${String(p?.approvalId ?? rid)}`, tool: { description: "", input_schema: {}, readOnly: false, run: async () => ({ content: "" }), ...tool } as Tool, input, ctx });
    // Why the card asks is said in Keel's words; what Codex gave as its reason is shown apart, as Codex's.
    const says = typeof p?.reason === "string" && p.reason.trim() ? `Codex says: ${p.reason.trim().slice(0, 500)}` : undefined;
    // The card's input names the call's item, as the rollout's call id: its line says the answer.
    const item = typeof p?.itemId === "string" && p.itemId ? { item: p.itemId } : {};
    const ask = async (tool: Partial<Tool> & { name: string }, input: Json, name: string, why: string, shown?: string) => {
      if (!s || !gate) return false;
      const v = await gate.askOnce(s, call(tool, { ...input, ...item }), name, why, "harness", shown, says);
      if (!this.closed) this.told(run.sessionId);
      return !v && !signal.aborted;
    };
    try {
      switch (method) {
        case "item/commandExecution/requestApproval": {
          const command = typeof p?.command === "string" ? p.command : "";
          const ok = await ask({ name: "Codex command", kind: "shell", input_schema: { properties: { command: {} } } }, { command, cwd }, "Codex command", "Codex runs this command in the session if you allow it, under the sandbox its turn has", command ? undefined : "Codex asks to run a command it does not name");
          return { decision: ok ? "accept" : signal.aborted ? "cancel" : "decline" };
        }
        case "item/fileChange/requestApproval": {
          const changes = run.changes.get(String(p?.itemId)) ?? [];
          const paths = changes.map((c) => String(c.path));
          const shown = changes.length ? changes.map((c) => `${c.path}\n${c.diff ?? ""}`.trim()).join("\n\n") : `Codex asks to change files${p?.grantRoot ? ` under ${p.grantRoot}` : ""}`;
          const ok = await ask({ name: "Codex file change", kind: "edit" }, { file_path: paths[0] ?? p?.grantRoot ?? cwd, paths, diff: changes.map((c) => c.diff ?? "").join("\n") }, "Codex file change", "Codex writes these changes if you allow them", shown);
          return { decision: ok ? "accept" : signal.aborted ? "cancel" : "decline" };
        }
        case "item/permissions/requestApproval": {
          const want = p?.permissions ?? {};
          const lines = [
            ...(want.network?.enabled ? ["the network"] : []),
            ...((want.fileSystem?.write ?? []) as string[]).map((x) => `write to ${x}`),
            ...((want.fileSystem?.read ?? []) as string[]).map((x) => `read ${x}`),
          ];
          const ok = await ask({ name: "Codex permissions" }, want, "Codex permissions", "Codex gets more than its sandbox gives for the rest of this turn if you allow it", `Codex asks for ${lines.join(", ") || "more permissions"} for this turn`);
          const granted = ok ? { ...(want.network ? { network: want.network } : {}), ...(want.fileSystem ? { fileSystem: want.fileSystem } : {}) } : {};
          return { permissions: granted, scope: "turn" };
        }
        case "item/tool/requestUserInput": {
          const qs = (Array.isArray(p?.questions) ? p.questions : []) as Json[];
          // Unique for each question asked: the answer names it (interact.ts answer: an answer for another is stale).
          const askId = crypto.randomUUID();
          const callId = `codex-${run.nonce}-${String(p?.itemId ?? rid)}`;
          const text = qs.map((q) => String(q?.question ?? "")).filter(Boolean).join("\n") || "Codex asks a question";
          this.d.asked?.(run.sessionId, callId, text, askId);
          let reply: Answers | typeof DECLINED | null = null;
          try {
            reply = await askFor({ ...ctx, callId, questionChanged: () => this.d.bus.emit({ t: "questions", pending: allPendingQuestions() }) } as ToolContext, {
              id: askId, from: "Codex", message: "Codex asks", sensitive: qs.some((q) => q?.isSecret) || undefined,
              questions: qs.map((q) => ({ id: String(q?.id ?? ""), header: q?.header || undefined, question: String(q?.question ?? ""), options: (Array.isArray(q?.options) ? q.options : []).map((o: Json) => ({ label: String(o?.label ?? ""), description: o?.description || undefined })), secret: q?.isSecret || undefined })),
            });
          } finally {
            this.d.answered?.(run.sessionId, callId, !!reply && reply !== DECLINED, askId);
          }
          const answers: Record<string, { answers: string[] }> = {};
          if (reply && reply !== DECLINED) for (const [qid, a] of Object.entries(reply)) if (!a.skipped) answers[qid] = { answers: [...a.picked, ...(a.other ? [a.other] : [])] };
          return { answers };
        }
        case "mcpServer/elicitation/request": {
          // (A form of an MCP server's: not shown in this version. The bar says it was declined.)
          const server = typeof p?.serverName === "string" && p.serverName ? ` ${p.serverName.slice(0, 80)}` : "";
          this.note(run.sessionId, `Codex's MCP server${server} asked for a form, and Keel declined it: forms are not shown here yet. Ask in Codex if it needs one.`);
          return { action: "decline", content: null, _meta: null };
        }
      }
      throw Object.assign(new Error(`Keel does not answer ${method}`), { code: -32601 });
    } finally {
      run.cards.delete(rid);
    }
  }

  // The turn is over: the child's input closes and it ends (its writer lock with it).
  private end(run: Run): Promise<void> {
    run.closing = true;
    run.ending ??= (async () => {
      run.stopped.abort();
      this.d.outside.retell(run.sessionId);
      await bounded(run.conn.request("thread/unsubscribe", { threadId: run.threadId }), "thread/unsubscribe").catch(() => {});
      await run.conn.finish(RPC_MS);
      await this.kill(run);
    })();
    return run.ending;
  }

  // The child ends now, and the native under it: SIGTERM to the child (a launcher passes it on), then SIGKILL
  // to whatever of them is still there after END_MS. What Codex started (MCP servers, the turn's jobs) is left.
  private kill(run: Run): Promise<void> {
    run.closing = true;
    run.killing ??= (async () => {
      run.stopped.abort();
      run.under = merged(run.under, run.exited ? [] : servers(run.conn.pid));
      run.conn.close();
      const end = Date.now() + END_MS;
      while (Date.now() < end && (!run.exited || run.under.some((p) => alive(p.pid, p.start)))) await Bun.sleep(25);
      if (!run.exited) run.conn.close("SIGKILL");
      await reap(run.under, 0);
      await run.conn.exited;
    })();
    return run.killing;
  }

  // Processes kept with the session, until they ended.
  private keep(sessionId: string, procs: Proc[]) {
    const put = this.d.store.db.query("INSERT OR REPLACE INTO outside_procs (session_id, pid, start) VALUES (?, ?, ?)");
    for (const p of procs) put.run(sessionId, p.pid, p.start);
  }

  // A child an earlier daemon left running, or the native under it: the same pid, started at the same moment,
  // running app-server. Never a process Keel did not start, nor one Codex started. Resolves when every one has ended.
  private async orphans(rows: ProcRow[]): Promise<void> {
    let left: Proc[] = [];
    for (const c of rows) {
      if (!alive(c.pid, c.start) || !serves(c.pid)) continue;
      // What it started since its row was kept (a native the daemon did not live to see).
      left = merged(left, [{ pid: c.pid, start: c.start }, ...servers(c.pid)]);
    }
    await reap(left, END_MS);
    if (this.closed) return;
    // A row goes once its process is gone: one that outlived its SIGKILL is still there for the next look.
    this.forget(rows);
  }

  // The rows of processes that are gone (ended, or their pid taken again by another start).
  private forget(rows: ProcRow[]) {
    const del = this.d.store.db.query("DELETE FROM outside_procs WHERE session_id = ? AND pid = ? AND start = ?");
    for (const r of rows) if (!alive(r.pid, r.start)) del.run(r.session_id, r.pid, r.start);
  }

  private async gone(run: Run) {
    run.closing = true;
    run.stopped.abort();
    try {
      if (this.closed) return;
      // A launcher that ended leaves what it started (a native codex that holds the lock): it ends too.
      await reap(run.under, END_MS);
      if (this.closed) return;
      this.forget(this.d.store.db.query<ProcRow, [string]>("SELECT session_id, pid, start FROM outside_procs WHERE session_id = ?").all(run.sessionId));
      if (this.runs.get(run.sessionId) === run) this.runs.delete(run.sessionId);
      await this.check(run, true);
      if (this.closed) return;
      this.d.outside.retell(run.sessionId);
      // A send stored while this child ended goes with a new one (one child: the others wait on `over` and take it).
      for (const s of this.sends(run.sessionId)) if (s.state === "stored") void this.deliver(run.sessionId, s.id).catch((e) => this.d.trouble(e, "answering a Codex session in place"));
    } finally {
      run.isOver();
    }
  }

  // At the daemon's start: a send a restart cut after it started is looked for in the rollout (never sent
  // again by itself); one that never started goes now if the thread is free.
  start() {
    // A delivered send is kept a day, so its key still stores a resend once; then it goes.
    this.prune();
    // A card Codex raised before the restart answers nothing now: the child that asked ended with the daemon.
    const gate = this.d.gate();
    for (const a of gate?.approvals({ pending: true }) ?? []) {
      if (a.call_id.startsWith("codex-") && this.d.store.session(a.session_id)?.outside) gate!.settled(a.session_id, a.call_id, CUT);
    }
    // And so does a question it asked: its alert says it was not answered, and waits no more.
    try { this.d.cutAsks?.(); } catch (e) { this.d.trouble(e, "closing the questions a Codex child asked before the restart"); }
    const owed: Send[] = [];
    const started: { send: Send; path: string }[] = [];
    for (const s of this.d.store.db.query<Send, []>("SELECT * FROM outside_sends WHERE state IN ('stored', 'started') ORDER BY created").all()) {
      const row = this.d.outside.row(s.session_id);
      if (!row) { this.set(s.id, "lost", { said: "its session is no longer followed" }); continue; }
      if (s.state === "started") started.push({ send: s, path: row.path });
      else owed.push(s);
    }
    // Read now: a child this daemon starts from here on is not one an earlier daemon left.
    const left = this.d.store.db.query<ProcRow, []>("SELECT session_id, pid, start FROM outside_procs").all();
    const looked = (async () => {
      for (const { send: s, path } of started) {
        const after = await recordsFrom(path, s.offset ?? 0);
        if (this.closed || this.byId(s.id)?.state !== "started") continue;
        if (holdsMessage(after, s.text)) this.set(s.id, turnEnded(after, s.text) ? "delivered" : "cut", turnEnded(after, s.text) ? {} : { said: CUT });
        else this.set(s.id, "lost", { said: "Keel restarted while it went, and the session does not hold it: send it again" });
      }
    })().catch((e) => this.d.trouble(e, "looking for a Codex send in its rollout after a restart"));
    // A send that never started goes once Keel's own children an earlier daemon left have ended (their locks
    // with them).
    const ended = this.orphans(left).catch((e) => this.d.trouble(e, "ending a Codex child an earlier daemon left"));
    void Promise.all([looked, ended]).then(() => {
      if (this.closed) return;
      for (const s of owed) void this.deliver(s.session_id, s.id).catch((e) => this.d.trouble(e, "answering a Codex session in place"));
    });
  }

  stop() {
    this.closed = true;
    this.off();
    for (const r of [...this.runs.values()]) void this.kill(r);
    this.runs.clear();
  }
}

// Whether a process serves the app-server protocol: its arguments hold `app-server` (Keel's child, and the native
// codex a launcher starts with the same arguments). What Codex itself starts under it (an MCP server, a helper that
// server left, a job a command of the owner's turn put in the background) does not, and is never signalled.
function serves(pid: number): boolean {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes("app-server"); } catch { return false; }
}
// What under a child serves the protocol: a launcher's native, which holds the thread's writer lock.
const servers = (pid: number): Proc[] => descendants(pid).filter((p) => serves(p.pid));

const merged = (a: Proc[], b: Proc[]): Proc[] => [...a, ...b.filter((p) => !a.some((q) => q.pid === p.pid && q.start === p.start))];

// The processes that are still the ones listed end: SIGTERM, then SIGKILL after `ms` (at once with 0). A pid
// taken again since (another start time) is never signalled.
async function reap(procs: Proc[], ms: number): Promise<void> {
  const live = () => procs.filter((p) => alive(p.pid, p.start));
  if (!live().length) return;
  if (ms > 0) {
    for (const p of live()) try { process.kill(p.pid, "SIGTERM"); } catch {}
    const end = Date.now() + ms;
    while (live().length && Date.now() < end) await Bun.sleep(25);
  }
  for (const p of live()) try { process.kill(p.pid, "SIGKILL"); } catch {}
  const end = Date.now() + END_MS;
  while (live().length && Date.now() < end) await Bun.sleep(25);
}
