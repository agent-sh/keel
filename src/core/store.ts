import { keyShaped, keyShapedDeep } from "./conceal.ts";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ErrorRecord, EventKind, ImageBlock, QueueItem, Session, StoredEvent, Usage } from "./types.ts";
import { addUsage, emptyUsage } from "./types.ts";
import { totalmem } from "node:os";
import { forgetSession } from "./session-map.ts";
import { asker, asking } from "./asker.ts";
import { labelled } from "./statement-label.ts";
import { holdStore, storePath } from "./store-files.ts";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
-- A statement inside a transaction that changes many pages keeps their old
-- content until it ends (an event's row, its indexes and its search entry
-- pass the 64 KB at which SQLite moves that to a file): kept in memory, an
-- append creates, writes and removes no temporary file. The same setting
-- keeps a sort no index serves, and a temporary table, in memory too: on
-- this connection that must stay a small one. A read that sorts or groups a
-- whole table (a report, a search, a sum over every event) belongs on the
-- read thread, whose connection keeps the default and sorts in a file.
PRAGMA temp_store = MEMORY;
-- The pages this connection keeps in its own memory: 16 MB. Working sessions
-- write to a few megabytes of pages (the ends of the tables and indexes they
-- append to, and the way down to them). With those kept, a step reads the
-- file about as seldom as with any larger cache: counted on the loop's
-- thread with twelve sessions at work, 16, 64, 128 and 256 MB read the same,
-- and SQLite's default of 2 MB, which is below that set, a quarter more.
-- What a step still reads are pages the connection never had (a session not
-- touched for long, a table read whole): no size of cache spares a first read.
PRAGMA cache_size = -16384;
-- What the log is held to when no checkpoint thread works (checkpoint.ts):
-- SQLite checkpoints it at 1,000 pages (4.1 MB), it grows past that only
-- while a long read holds it (the read thread, a backup), and this gives the
-- file back to that size at the first write after such a read. With the
-- thread the file is kept at 16 MB and holds up to 64 MB under load (the
-- thread raises this limit while it works and puts it back when it stops).
PRAGMA journal_size_limit = 4194304;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  workspace TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'idle',
  archived INTEGER NOT NULL DEFAULT 0,
  usage TEXT NOT NULL DEFAULT '{}'
);
-- The session list: one partition (active or archived), newest activity first.
CREATE INDEX IF NOT EXISTS sessions_list ON sessions(archived, updated DESC);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  ts INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE TABLE IF NOT EXISTS errors (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  context TEXT
);
CREATE INDEX IF NOT EXISTS errors_ts ON errors(ts DESC);
CREATE TABLE IF NOT EXISTS queue (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  steer INTEGER NOT NULL DEFAULT 0,
  pos REAL NOT NULL,
  created INTEGER NOT NULL
);
`;

type EventRow = Omit<StoredEvent, "data"> & { data: string };
// Fields of event data that hold the id of another event of the same session.
export const EVENT_REFS = ["covered", "undo_head", "from_event", "replaced_head"] as const;
const rowToEvent = (r: EventRow): StoredEvent => ({ ...r, parent: r.parent ?? null, kind: r.kind as EventKind, data: JSON.parse(r.data) });

// Cached events are shared by every reader: frozen, so a reader that changes
// one fails loudly instead of changing what the next reader sees.
function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as any)[k]);
  }
  return v;
}

// Where the events after a cursor start in a list in seq order (a binary search).
function firstAfter(events: readonly StoredEvent[], afterSeq: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid]!.seq > afterSeq) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// An event without its body: what a lineage is walked by.
type Bare = { id: string; seq: number; parent: string | null; kind: string; ts: number };
// The bodies of one run of consecutive events of a session, parsed.
type Run = { data: unknown[]; bytes: number; used: number };
// Bodies are read and given back by runs of this many events.
const RUN = 64;

// The events of one session, as kept in memory. Every event is there, without
// its body; `data` reads the body from the run it is in, which is read from the
// table and parsed when a reader first asks for it and may be given back when
// memory is short. So a long session costs what its events' ids cost until
// someone reads what was said, and then only for the part that is read.
type Kept = {
  id: string;
  // Every event, all branches, in seq order.
  all: StoredEvent[];
  // The seq of the first event when the seqs have no gap (an event's place is
  // then its seq less this), else -1 and a place is searched for.
  first: number;
  // The bodies read so far, by run.
  runs: (Run | undefined)[];
  // What it is charged against the budget: its events and the runs it holds.
  bytes: number;
  // The branch the session shows, as it was last read: its events from the
  // first to the head. Walked once, it grows by each event appended at its
  // head, and is walked again only when the session shows another branch.
  // `more`: the events appended at its head since it was last read; they
  // join `events` when it is next read (Store.lineage), so an append does
  // nothing that grows with the branch's length.
  line?: { head: string; events: readonly StoredEvent[]; more: StoredEvent[] };
  // Every event as one array handed to readers (Store.events), until the next append.
  whole?: readonly StoredEvent[];
  // The owner-side messages that share a parent with another (the versions of
  // a prompt are among them), by that parent: for a reader that shows a part
  // of a branch with the count of versions on each prompt. Made from the
  // events without their bodies the first time it is asked for, and kept up
  // by each message appended. It goes with the session, so it never holds
  // less than the session does.
  forks?: Map<string | null, StoredEvent[]>;
  // When it was last read or appended to.
  at: number;
  // Dropped from the store: an event of it still held reads its body from the table.
  gone?: boolean;
  // The getter every event of the session shares.
  body: (this: StoredEvent) => unknown;
};

// What a kept event costs in memory, measured on generated sessions of 30,000
// events with every body read: resident memory grew by 2.4 to 2.5 times the
// characters of the stored JSON (the parsed objects, their strings, and what
// a parse leaves behind), and an event without its body takes about a quarter
// of a kilobyte.
const BODY_COST = 2.5;
const BARE_COST = 256;

// How much memory kept events may take: a thirty-second of the memory this
// process may use (the machine's, or its control group's limit when that is
// lower), between 64 MB and 512 MB; KEEL_EVENTS_MEMORY_MB sets another. The
// bound is on memory, not on a count of sessions, because sessions differ a
// thousand times in size.
export function eventsBudget(): number {
  const set = Number(process.env.KEEL_EVENTS_MEMORY_MB);
  if (Number.isFinite(set) && set > 0) return set * 1e6;
  const limit = Number((process as { constrainedMemory?: () => number }).constrainedMemory?.()) || Infinity;
  return Math.min(512e6, Math.max(64e6, Math.min(totalmem(), limit) / 32));
}
// What a session keeps in memory, and for how long.
// - The bodies it read: an idle session gives them back after IDLE_KEPT_MS
//   unread (a working one after fifteen times that: a turn inside one long
//   tool call reads them again when the call ends). They are most of what a
//   session costs: BODY_COST times the stored text.
// - Its events without their bodies (the rows every reader walks: a
//   branch, a count, the last event): for as long as anything reads the
//   session, and BARE_KEPT_MS after its last read. They cost BARE_COST an
//   event (15 MB for a session of 60,000), and bringing them back is a read
//   of the whole session's index, on the loop when the reader cannot wait.
//   A session others keep reading (a coordinator its agents report to every
//   few seconds, with nobody at its page) is therefore never given back
//   and read again; one that nobody has read for an hour is.
// Both are within the budget (eventsBudget): when it is passed, bodies go
// before rows, and idle sessions before working ones (trim).
// KEEL_EVENTS_IDLE_MS sets the first, and the second stays thirty times it
// (a test of what is read when a session comes back sets it short).
export const IDLE_KEPT_MS = Number(process.env.KEEL_EVENTS_IDLE_MS) > 0 ? Number(process.env.KEEL_EVENTS_IDLE_MS) : 120_000;
export const BARE_KEPT_MS = 30 * IDLE_KEPT_MS;

// Dropping at least this much (as charged) is worth asking the collector for.
const GIVE_BACK_BYTES = 8e6;
// Asks the runtime's collector: for a whole collection now, or for one when it sees fit.
const collect = (whole: boolean) => (globalThis as { Bun?: { gc(whole: boolean): void } }).Bun?.gc(whole);

const pause = () => new Promise<void>((r) => setImmediate(r));
// KEEL_TRACE_COLD=1: each whole-session read made on the loop is a line of the log, with who asked; =stack: and its call stack.
const TRACE_COLD = process.env.KEEL_TRACE_COLD;

export type ColdReads = { n: number; rows: number; ms: number; by: { who: string; n: number; rows: number; ms: number }[] };
type SessionRow = Omit<Session, "archived" | "usage" | "settings"> & { archived: number; usage: string; settings: string };

function rowToSession(r: SessionRow): Session {
  const s: Session = {
    ...r,
    head: r.head ?? null,
    archived: !!r.archived,
    usage: { ...emptyUsage(), ...JSON.parse(r.usage || "{}") },
    settings: JSON.parse(r.settings || "{}"),
  };
  // A folder of this machine that is no longer on disk (deleted, a removed
  // worktree): every view says so instead of failing on it.
  if (!r.machine && !existsSync(r.workspace)) s.workspace_gone = true;
  return s;
}

// Numbers, hex ids and quoted paths vary between repeats of one failure.
export function fingerprint(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .slice(0, 300);
}

// The session an error belongs to, from what its catcher put in the context.
export function sessionOf(ctx: any): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const v = ctx.session ?? ctx.session_id ?? ctx.sessionId;
  if (typeof v === "string") return v;
  const m = typeof ctx.url === "string" ? /^\/s\/([^/?#]+)/.exec(ctx.url) : null;
  return m?.[1];
}

function errorRow(r: any): ErrorRecord {
  return {
    id: r.id, ts: r.ts, first_ts: r.first_ts ?? r.ts, count: r.count ?? 1, source: r.source, message: r.message,
    stack: r.stack ?? undefined, context: r.context ? JSON.parse(r.context) : undefined,
    session_id: r.session_id ?? undefined, turn_event: r.turn_event ?? undefined, span_id: r.span_id ?? undefined, resolved_ts: r.resolved_ts ?? undefined, read_ts: r.read_ts ?? undefined,
  };
}

const queueRow = (r: any): QueueItem => {
  const { images, anchor, meta, ...rest } = r;
  return { ...rest, steer: !!r.steer, ...(images ? { images: JSON.parse(images) } : {}), ...(anchor ? { anchor } : {}), ...(meta ? { meta: JSON.parse(meta) } : {}) };
};

export class Store {
  readonly db: Database;
  // Sessions whose turn was open, or owed to a prompt just accepted, when the
  // last daemon stopped.
  bootWorking: string[] = [];
  // The events of the sessions in use. A turn reads its session before each
  // model call and the page and routes read it too; events never change once
  // written, so each is read once and an appended event joins what is held.
  // What is held is charged in memory against a budget. When it is passed,
  // idle sessions go first, the longest unread first; then the bodies read
  // longest ago, whoever they belong to, so a session a turn runs in keeps its
  // place in memory (its events, and the bodies its requests read) however
  // long it is and however many others work. An idle session unread for
  // IDLE_KEPT_MS goes by itself, so a daemon at rest holds none.
  private kept = new Map<string, Kept>();
  private keptBytes = 0;
  private budget = eventsBudget();
  private sweeper: ReturnType<typeof setInterval> | undefined;
  // Counts body reads: a run's `used` is the count when it was last read.
  private tick = 0;
  // What dropped sessions were charged since the last whole collection.
  private owed = 0;

  // A read made ahead on the read thread (src/server/reads.ts, readAhead), set
  // by the daemon: what it reads is then in the operating system's memory
  // for the loop. It resolves when that is so, or when it is not worth waiting for.
  offLoop?: (sql: string, params: (string | number | null)[]) => Promise<unknown>;

  constructor(readonly stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    // From here this process holds locks on the store's files: nothing but SQLite opens them (store-files.ts).
    holdStore(stateDir);
    this.db = new Database(storePath(stateDir), { create: true, strict: true });
    this.db.exec(SCHEMA);
    // Each statement says which one it is while it runs: a stall in the database is named by its query (statement-label.ts).
    labelled(this.db);
    // The event tree (edit, fork, branches) and per-session settings. One
    // transaction: a start that fails part way leaves the database as it was,
    // and the next start does all of it.
    this.db.transaction(() => {
      if (!this.columnExists("events", "parent")) this.db.exec("ALTER TABLE events ADD COLUMN parent TEXT");
      if (!this.columnExists("sessions", "head")) this.db.exec("ALTER TABLE sessions ADD COLUMN head TEXT");
      // A session from before the tree is one line: each event follows the one
      // before, and the last is its head. Each half is filled when it is
      // empty in the whole database (the columns were just added, or an older
      // start, which did these as separate steps, was cut before one of them):
      // a database the tree has been used in always has a parent and a head.
      const none = (where: string) => !!this.db.query<{ n: number }, []>(`SELECT EXISTS(SELECT 1 FROM events) AND NOT EXISTS(${where}) AS n`).get()!.n;
      if (none("SELECT 1 FROM events WHERE parent IS NOT NULL")) this.db.exec(`UPDATE events SET parent = (SELECT e2.id FROM events e2 WHERE e2.session_id = events.session_id AND e2.seq < events.seq ORDER BY e2.seq DESC LIMIT 1)`);
      if (none("SELECT 1 FROM sessions WHERE head IS NOT NULL")) this.db.exec(`UPDATE sessions SET head = (SELECT id FROM events WHERE session_id = sessions.id ORDER BY seq DESC LIMIT 1)`);
    }).immediate();
    // Images of a queued or steered prompt (JSON), so a queued screenshot is not lost.
    if (!this.columnExists("queue", "images")) this.db.exec("ALTER TABLE queue ADD COLUMN images TEXT");
    // The session's head when the prompt was queued: the branch it was written on.
    if (!this.columnExists("queue", "anchor")) this.db.exec("ALTER TABLE queue ADD COLUMN anchor TEXT");
    if (!this.columnExists("queue", "meta")) this.db.exec("ALTER TABLE queue ADD COLUMN meta TEXT");
    if (!this.columnExists("sessions", "settings")) this.db.exec("ALTER TABLE sessions ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
    // Bumped by every change of the session row: a reply that carries an older
    // revision than what a page holds does not undo the newer change.
    if (!this.columnExists("sessions", "rev")) this.db.exec("ALTER TABLE sessions ADD COLUMN rev INTEGER NOT NULL DEFAULT 0");
    for (const [col, type] of [["fingerprint", "TEXT"], ["count", "INTEGER NOT NULL DEFAULT 1"], ["first_ts", "INTEGER"], ["session_id", "TEXT"], ["turn_event", "TEXT"], ["resolved_ts", "INTEGER"], ["span_id", "TEXT"], ["read_ts", "INTEGER"]] as const) {
      if (!this.columnExists("errors", col)) this.db.exec(`ALTER TABLE errors ADD COLUMN ${col} ${type}`);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS errors_fp ON errors(fingerprint)");
    // A session's events without their bodies are read from an index that
    // holds exactly those columns. Without it the read walks the table's
    // rows, where each event's body lies before its time: every page of the
    // session is read to bring back five small columns (134 MB for a session
    // of 50,000 events, against 7 MB from the index; 3.9 s against 0.16 s
    // with the file's pages not in memory). It costs about 130 bytes an event
    // on disk and one more page written with an append. A store from before
    // it has it built once, at this start, in one pass over the events.
    if (!this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'events_bare'").get()) {
      const n = this.db.query<{ n: number }, []>("SELECT COALESCE(MAX(rowid), 0) AS n FROM events").get()!.n;
      const t0 = performance.now();
      if (n > 50_000) console.log(`[store] building the index of the events' rows, once (about ${n} events)`);
      this.db.exec("CREATE INDEX IF NOT EXISTS events_bare ON events(session_id, seq, id, parent, kind, ts)");
      if (n > 50_000) console.log(`[store] the index is built (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    }
    // Sessions left "working" by a crash or restart: no turn runs in them now.
    // The mark itself is the list. It stays until the engine has closed the
    // session's cut turn (Engine.closeCut, then bootSettled), so a daemon
    // killed during its own start leaves it for the next one; and whichever
    // build starts next clears it, so a mark is never older than one start.
    this.bootWorking = this.db.query<{ id: string }, []>("SELECT id FROM sessions WHERE phase = 'working'").all().map((r) => r.id);
  }

  // What the last daemon left open in this session is closed (or is not
  // looked at: a client's daemon recovers nothing): it is idle. False when it
  // no longer carried the mark.
  bootSettled(session_id: string): boolean {
    return this.db.query("UPDATE sessions SET phase = 'idle', rev = rev + 1 WHERE id = ? AND phase = 'working'").run(session_id).changes > 0;
  }

  // A feature module's tables: run once per start, statements must be idempotent
  // (CREATE ... IF NOT EXISTS; ALTER guarded by columnExists).
  // What is written may be rewritten first (secrets are kept out of history).
  // `kind` is the event kind, or "title", "queue", "error". Identity by default.
  redact: (sessionId: string | null, kind: string, value: any) => any = (_s, _k, v) => v;

  migrate(sql: string) {
    this.db.exec(sql);
  }

  // Several writes of one session as one: all of them are stored or none,
  // also when the daemon is killed in between. A throw undoes them, and the
  // session's parsed events are read from the table again.
  atomic<T>(session_id: string, fn: () => T): T {
    try {
      return this.db.transaction(fn)();
    } catch (e) {
      this.forget(session_id);
      throw e;
    }
  }

  columnExists(table: string, column: string): boolean {
    return this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  }

  createSession(s: { title?: string; model: string; workspace: string; settings?: Session["settings"] }): Session {
    const now = Date.now();
    const id = Bun.randomUUIDv7();
    this.db
      .query("INSERT INTO sessions (id, title, model, workspace, created, updated, settings) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, this.redact(null, "title", s.title ?? ""), s.model, s.workspace, now, now, JSON.stringify(s.settings ?? {}));
    // (It has no event: that is kept, so its first reader reads nothing.)
    this.keep(id, []);
    return this.session(id)!;
  }

  session(id: string): Session | undefined {
    const r = this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
    return r ? rowToSession(r) : undefined;
  }

  sessions(opts: { archived?: boolean } = {}): Session[] {
    return this.db
      .query<SessionRow, [number]>("SELECT * FROM sessions WHERE archived = ? ORDER BY updated DESC")
      .all(opts.archived ? 1 : 0)
      .map(rowToSession);
  }

  // The unarchived sessions whose shown branch ends in a turn a daemon
  // restart cut, newest activity first. Each session's last event is looked up
  // by its id (the head), so a start reads one small row a session and
  // parses no session to find the few it has to continue.
  cutSessions(): Session[] {
    return this.db
      .query<SessionRow, []>(`SELECT s.* FROM sessions s JOIN events e ON e.id = s.head
        WHERE s.archived = 0 AND e.kind = 'turn_end' AND json_extract(e.data, '$.reason') = 'restart' ORDER BY s.updated DESC`)
      .all()
      .map(rowToSession);
  }

  // `updated` is the session's last activity (lists sort by it, "the last
  // session" is the newest by it): a rename or a settings change is not work,
  // so it moves `rev` only.
  updateSession(id: string, patch: Partial<Pick<Session, "title" | "model" | "phase" | "archived" | "usage" | "workspace" | "head" | "settings">>): Session {
    const sets: string[] = ["rev = rev + 1"];
    const vals: (string | number)[] = [];
    let activity = false;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      if (k !== "title" && k !== "settings") activity = true;
      if (k === "title") { vals.push(this.redact(id, "title", v)); continue; }
      vals.push(k === "usage" || k === "settings" ? JSON.stringify(v) : k === "archived" ? (v ? 1 : 0) : (v as string));
    }
    if (activity) {
      sets.push("updated = ?");
      vals.push(Date.now());
    }
    this.db.query(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.session(id)!;
  }

  // Merge keys into the session's settings (null or undefined removes one)
  // without moving it in the list: a mark is not new work.
  mergeSettings(id: string, patch: Record<string, unknown>): Session | undefined {
    const s = this.session(id);
    if (!s) return undefined;
    const next: Record<string, unknown> = { ...s.settings };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined) delete next[k];
      else next[k] = v;
    }
    this.db.query("UPDATE sessions SET settings = ?, rev = rev + 1 WHERE id = ?").run(JSON.stringify(next), id);
    return this.session(id);
  }

  // A session's subagent sessions and theirs, nearest first.
  descendants(id: string): string[] {
    return this.db
      .query<{ id: string }, [string]>("WITH RECURSIVE d(id) AS (SELECT id FROM sessions WHERE parent_id = ?1 UNION SELECT s.id FROM sessions s JOIN d ON s.parent_id = d.id) SELECT id FROM d")
      .all(id)
      .map((r) => r.id);
  }

  // What a deleted session never read of what others sent it (its queued rows
  // that name a sender go with it): told to whoever set this, after the delete.
  queueGone?: (rows: QueueItem[], session: Session) => void;

  deleteSession(id: string) {
    const unread = this.queueGone ? this.queue(id).filter((q) => q.meta) : [];
    const session = unread.length ? this.session(id) : undefined;
    this.db.query("DELETE FROM sessions WHERE id = ?").run(id);
    this.forget(id);
    forgetSession(id);
    if (session) this.queueGone?.(unread, session);
  }

  // A new event at the head of the session's branch (or after `parent`, which
  // starts a new branch there: an edited prompt). It becomes the head.
  // `at`: when it happened, for an event copied from another store; the
  // session's last activity is still now.
  append(session_id: string, kind: EventKind, data: unknown, parent?: string | null, at?: number): StoredEvent {
    data = this.redact(session_id, kind, data);
    const id = Bun.randomUUIDv7();
    const text = JSON.stringify(data);
    const now = Date.now();
    const ts = at ?? now;
    const tx = this.db.transaction(() => {
      const { n } = this.db
        .query<{ n: number }, [string]>("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE session_id = ?")
        .get(session_id)!;
      const p = parent !== undefined
        ? parent
        : (this.db.query<{ head: string | null }, [string]>("SELECT head FROM sessions WHERE id = ?").get(session_id)?.head ?? null);
      this.db
        .query("INSERT INTO events (id, session_id, seq, parent, kind, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, session_id, n, p, kind, text, ts);
      this.db.query("UPDATE sessions SET updated = ?, head = ? WHERE id = ?").run(now, id, session_id);
      return { n, p };
    });
    const { n, p } = tx();
    const ev: StoredEvent = { id, session_id, seq: n, parent: p, kind, data, ts };
    const k = this.kept.get(session_id);
    if (k) {
      const at = k.all.length;
      if (at === 0) k.first = n;
      else if (k.first >= 0 && n !== k.first + at) k.first = -1;
      const held = this.bare(k, { id, seq: n, parent: p, kind, ts });
      k.all.push(held);
      this.charge(k, BARE_COST);
      // Its body joins the run it falls in when that run is in memory (or
      // starts one); else it is read with its run when someone asks.
      // The kept copy is what a read from the table would give (a JSON round trip).
      const run = at % RUN === 0 ? (k.runs[at / RUN] = { data: [], bytes: 0, used: ++this.tick }) : k.runs[Math.floor(at / RUN)];
      if (run && run.data.length === at % RUN) {
        run.data.push(deepFreeze(JSON.parse(text)));
        run.bytes += text.length * BODY_COST;
        run.used = ++this.tick;
        this.charge(k, text.length * BODY_COST);
      } else if (run) {
        this.drop(k, Math.floor(at / RUN));
      }
      // The branch that ended at its parent now ends at it. An event on another
      // parent starts a branch, which is walked when it is asked for.
      // (A reader that holds the branch as it was keeps it: see lineage.)
      if (k.line?.head === p) { k.line.more.push(held); k.line.head = id; }
      else k.line = undefined;
      k.whole = undefined;
      // A message under a parent that already has several joins them. One under
      // the newest event starts nothing (nothing else is stored there yet); one
      // under any other event may be a second version: the map is made again
      // when it is next asked for.
      if (k.forks && kind === "user") {
        const versions = k.forks.get(p);
        if (versions) k.forks.set(p, [...versions, held]);
        else if (p !== (k.all[at - 1]?.id ?? null)) k.forks = undefined;
      }
      this.touch(session_id, k);
      this.trim(k, Math.floor(at / RUN));
    }
    return ev;
  }

  private forget(session_id: string) {
    const k = this.kept.get(session_id);
    if (!k) return;
    this.keptBytes -= k.bytes;
    this.owed += k.bytes;
    k.gone = true;
    k.runs = [];
    this.kept.delete(session_id);
    if (!this.kept.size) this.rest();
  }
  // The bodies a kept session read are given back; its events stay.
  private dropBodies(k: Kept) {
    for (let i = 0; i < k.runs.length; i++) {
      const run = k.runs[i];
      if (!run) continue;
      this.owed += run.bytes;
      this.drop(k, i);
    }
  }

  private charge(k: Kept, bytes: number) {
    k.bytes += bytes;
    this.keptBytes += bytes;
  }

  // Read or written now: the last in line to go.
  private touch(session_id: string, k: Kept) {
    k.at = Date.now();
    this.kept.delete(session_id);
    this.kept.set(session_id, k);
  }

  private working(): Set<string> {
    return new Set(this.db.query<{ id: string }, []>("SELECT id FROM sessions WHERE phase = 'working'").all().map((r) => r.id));
  }

  // An event of a kept session: its body is read through the session's runs.
  private bare(k: Kept, r: Bare): StoredEvent {
    const e = { id: r.id, session_id: k.id, seq: r.seq, parent: r.parent ?? null, kind: r.kind as EventKind } as StoredEvent;
    Object.defineProperty(e, "data", { enumerable: true, get: k.body });
    e.ts = r.ts;
    return Object.freeze(e);
  }

  // The body of the event with this seq, from its run.
  private bodyOf(k: Kept, seq: number): unknown {
    let at = k.first >= 0 ? seq - k.first : firstAfter(k.all, seq - 1);
    if (k.all[at]?.seq !== seq) at = firstAfter(k.all, seq - 1);
    const i = Math.floor(at / RUN);
    const run = k.runs[i] ?? this.read(k, i);
    run.used = ++this.tick;
    return run.data[at % RUN];
  }

  // Reads and parses the bodies of one run, and keeps them with the session,
  // charged. For a session dropped since the event was handed out, the one
  // run read last stays with what was handed out and is charged to no one.
  private read(k: Kept, i: number): Run {
    const end = Math.min(k.all.length, (i + 1) * RUN);
    const rows = this.db
      .query<{ data: string }, [string, number, number]>("SELECT data FROM events WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq")
      .all(k.id, k.all[i * RUN]!.seq, k.all[end - 1]!.seq);
    if (rows.length !== end - i * RUN) {
      // What is held is not what the table holds (the session was deleted, or
      // a write was undone outside atomic): it is read again from the table.
      this.forget(k.id);
      throw new Error(`events ${k.all[i * RUN]!.seq} to ${k.all[end - 1]!.seq} of session ${k.id} are not stored as they were read`);
    }
    const run: Run = { data: [], bytes: 0, used: ++this.tick };
    for (const r of rows) {
      run.data.push(deepFreeze(JSON.parse(r.data)));
      run.bytes += r.data.length * BODY_COST;
    }
    if (k.gone) {
      k.runs = [];
      k.runs[i] = run;
      return run;
    }
    k.runs[i] = run;
    this.charge(k, run.bytes);
    this.trim(k, i);
    return run;
  }

  private drop(k: Kept, i: number) {
    const run = k.runs[i];
    if (!run) return;
    k.runs[i] = undefined;
    this.charge(k, -run.bytes);
  }

  // Back within the budget, with a tenth to spare so the next reads do not
  // each come back here. What goes, in this order: the bodies idle sessions
  // read, the run read longest ago first; idle sessions whole, the longest
  // unread first; the bodies working sessions read; and only when events
  // without bodies alone pass the budget, working sessions. The session and
  // the run in hand stay.
  private trim(keep?: Kept, keepRun = -1) {
    if (this.keptBytes <= this.budget) return;
    const target = this.budget * 0.9;
    const working = this.working();
    const runsOf = (which: (id: string) => boolean) => {
      const runs: { k: Kept; i: number; used: number }[] = [];
      for (const [id, k] of this.kept) if (which(id)) k.runs.forEach((r, i) => { if (r && !(k === keep && i === keepRun)) runs.push({ k, i, used: r.used }); });
      return runs.sort((a, b) => a.used - b.used);
    };
    for (const r of runsOf((id) => !working.has(id))) {
      if (this.keptBytes <= target) return;
      this.drop(r.k, r.i);
    }
    for (const [id, k] of [...this.kept]) {
      if (this.keptBytes <= target) return;
      if (k !== keep && !working.has(id)) this.forget(id);
    }
    for (const r of runsOf((id) => working.has(id))) {
      if (this.keptBytes <= target) return;
      this.drop(r.k, r.i);
    }
    for (const [id, k] of [...this.kept]) {
      if (this.keptBytes <= this.budget) return;
      if (k !== keep) this.forget(id);
    }
  }

  // What was not read for long goes (see IDLE_KEPT_MS): the bodies of an
  // idle session unread for IDLE_KEPT_MS and of a working one unread for
  // fifteen times that; the whole of an idle session unread for BARE_KEPT_MS. The
  // check runs only while something is kept, and never holds the process open.
  private sweep() {
    const now = Date.now();
    const stale = [...this.kept].filter(([, k]) => now - k.at >= IDLE_KEPT_MS);
    if (!stale.length) return;
    let working: Set<string>;
    try {
      working = this.working();
    } catch {
      // The database is closed: nothing reads this store again.
      for (const id of [...this.kept.keys()]) this.forget(id);
      return;
    }
    for (const [id, k] of stale) {
      // (A session a turn runs in keeps its events however long its turn sits in one call: the turn reads them next, and cannot wait.)
      if (now - k.at >= BARE_KEPT_MS && !working.has(id)) this.forget(id);
      else if (!working.has(id) || now - k.at >= 15 * IDLE_KEPT_MS) this.dropBodies(k);
    }
    // No body is held any more: see rest. Else the collector is only asked to collect when it sees fit.
    if (this.kept.size && this.owed >= GIVE_BACK_BYTES) {
      let bodies = false;
      for (const k of this.kept.values()) if (k.runs.some(Boolean)) { bodies = true; break; }
      if (bodies) collect(false);
      else { this.owed = 0; collect(true); }
    }
  }

  // No body is kept any more (every session's were given back, or nothing
  // is kept at all). What was given back since the last whole collection is
  // mostly old to the collector, which looks at old objects only when the
  // heap grows, and a daemon at rest does not grow: seen after ten minutes
  // of twelve sessions, 80 to 100 MB stayed for as long as the daemon was
  // watched. So it is asked to look. No session has been read for two
  // minutes by then: a whole collection holds the loop some tens of
  // milliseconds while nobody waits on it.
  private rest() {
    clearInterval(this.sweeper);
    this.sweeper = undefined;
    if (this.owed < GIVE_BACK_BYTES) return;
    this.owed = 0;
    collect(true);
  }

  // How many sessions are kept and what they are charged, in bytes of memory,
  // against the budget (the resources report shows it).
  // `cold_reads`: the whole-session reads that were made on the loop (held), by who asked.
  keptEvents(): { sessions: number; bytes: number; budget: number; cold_reads: ReturnType<Store["coldReads"]> } {
    return { sessions: this.kept.size, bytes: this.keptBytes, budget: this.budget, cold_reads: this.coldReads() };
  }

  // A session's events as kept, from their rows without bodies.
  private keep(session_id: string, rows: Bare[]): Kept {
    const store = this;
    const k: Kept = {
      id: session_id, all: [], first: rows[0]?.seq ?? -1, runs: [], bytes: 0, at: Date.now(),
      body(this: StoredEvent) { return store.bodyOf(k, this.seq); },
    };
    for (let i = 0; i < rows.length; i++) {
      if (k.first >= 0 && rows[i]!.seq !== k.first + i) k.first = -1;
      k.all.push(this.bare(k, rows[i]!));
    }
    this.kept.set(session_id, k);
    this.charge(k, rows.length * BARE_COST);
    if (!this.sweeper) {
      this.sweeper = setInterval(() => this.sweep(), IDLE_KEPT_MS / 4);
      this.sweeper.unref?.();
    }
    this.trim(k);
    return k;
  }

  // The session's events, all branches, as kept: not a copy.
  // One that is not in memory is read here, whole and in one piece, on the
  // loop: tens of thousands of rows for a long session, from the disk when
  // its pages are not in the operating system's memory. A reader that can
  // wait brings the session in first (`warm`), and one that cannot asks for
  // less (`lastSeq`, `hasEvents`, a part by its cursor). Each read that still
  // lands here is counted with who asked (`coldReads`), and the stall
  // watcher is told who while it runs (src/core/asker.ts).
  private held(session_id: string): Kept {
    const k = this.kept.get(session_id);
    if (k) {
      this.touch(session_id, k);
      return k;
    }
    const who = asker();
    const t0 = performance.now();
    const rows = asking(who, () => this.db.query<Bare, [string]>("SELECT id, seq, parent, kind, ts FROM events WHERE session_id = ? ORDER BY seq").all(session_id));
    const ms = performance.now() - t0;
    // (Before the daemon answers, a read holds nobody: those are counted apart.)
    const c = this.serving ? this.cold : this.coldStart;
    c.n++; c.rows += rows.length; c.ms += ms;
    const by = c.by.get(who) ?? { n: 0, rows: 0, ms: 0 };
    by.n++; by.rows += rows.length; by.ms += ms;
    c.by.set(who, by);
    if (TRACE_COLD) console.log(`[store] a session of ${rows.length} events was read whole on the loop in ${ms.toFixed(1)} ms, asked by ${who}${TRACE_COLD === "stack" ? `\n${new Error("its callers").stack}` : ""}`);
    return this.keep(session_id, rows);
  }
  // The whole-session reads made on the loop since the start (held): how many, of how many events,
  // how long in all, and the same by who asked (a label of the code path: src/core/asker.ts).
  // `start`: the same for the reads made before the daemon answered (its modules' recovery at a start).
  private cold = { n: 0, rows: 0, ms: 0, by: new Map<string, { n: number; rows: number; ms: number }>() };
  private coldStart = { n: 0, rows: 0, ms: 0, by: new Map<string, { n: number; rows: number; ms: number }>() };
  // Set once the daemon answers: from here a read that holds the loop holds everyone.
  serving = false;
  coldReads(): ColdReads & { start: ColdReads } {
    const of = (c: Store["cold"]): ColdReads => ({ n: c.n, rows: c.rows, ms: Math.round(c.ms), by: [...c.by].map(([who, v]) => ({ who, n: v.n, rows: v.rows, ms: Math.round(v.ms) })).sort((a, b) => b.ms - a.ms) });
    return { ...of(this.cold), start: of(this.coldStart) };
  }
  // Whether the session's events are in memory (a reader that can wait brings them in first: warm).
  isKept(session_id: string): boolean { return this.kept.has(session_id); }

  // The session's newest seq, on any branch (0: it has no event). What a
  // reader that holds a part of the session resumes from.
  lastSeq(session_id: string): number {
    const k = this.kept.get(session_id);
    if (k) return k.all.at(-1)?.seq ?? 0;
    return this.db.query<{ n: number | null }, [string]>("SELECT MAX(seq) AS n FROM events WHERE session_id = ?").get(session_id)?.n ?? 0;
  }

  // The versions of the prompt stored under `parent` when it has several (the
  // owner's prompts with that parent, in order, as versions() of
  // src/core/tree.ts gives them); none for a prompt that is the only one.
  // Only the bodies of the messages stored under that parent are read.
  versions(session_id: string, parent: string | null): readonly StoredEvent[] {
    const k = this.held(session_id);
    if (!k.forks) {
      const by = new Map<string | null, StoredEvent[]>();
      for (const e of k.all) if (e.kind === "user") (by.get(e.parent) ?? by.set(e.parent, []).get(e.parent)!).push(e);
      k.forks = new Map([...by].filter(([, list]) => list.length > 1));
    }
    return (k.forks.get(parent) ?? []).filter((e) => !e.data.origin);
  }

  // Brings a session into memory without holding the loop: its events a few
  // thousand at a time, then their bodies while they fit, giving the loop back
  // in between. A reader that then asks for the whole session (the page
  // opening a long one) finds it there instead of reading it in one piece.
  // `bodies: false`: the events alone, for a reader that takes a part of the
  // session (it reads the bodies of that part, and no other).
  async warm(session_id: string, bodies = true): Promise<void> {
    let k = this.kept.get(session_id);
    if (!k) {
      // A session that is not in memory is read from the database file, and
      // after a start or a long idle time its pages are on the disk alone.
      // The read thread reads them first (every row, with its body: the
      // columns after the body lie behind it in the row), so what the loop
      // then reads comes from the operating system's memory and waits for no
      // disk. Whether that read is worth a wait is the read thread's to say
      // (Reads.readAhead: not when it is busy, not where it cannot run).
      // For the events alone that is the index of their rows, and no body.
      if (this.offLoop) {
        await this.offLoop(bodies
          ? "SELECT COUNT(*) AS n, SUM(LENGTH(data)) AS bytes, MAX(ts) AS ts FROM events WHERE session_id = ?"
          : "SELECT COUNT(*) AS n, MAX(ts) AS ts, MAX(LENGTH(id) + LENGTH(COALESCE(parent, '')) + LENGTH(kind)) AS w FROM events INDEXED BY events_bare WHERE session_id = ?", [session_id]).catch(() => {});
        k = this.kept.get(session_id);
      }
    }
    if (!k) {
      const rows: Bare[] = [];
      const page = this.db.query<Bare, [string, number]>("SELECT id, seq, parent, kind, ts FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT 4096");
      for (;;) {
        const part = page.all(session_id, rows.at(-1)?.seq ?? 0);
        for (const r of part) rows.push(r);
        if (part.length < 4096) break;
        await pause();
      }
      // Read by someone else meanwhile: theirs is the one kept.
      k = this.kept.get(session_id) ?? this.keep(session_id, rows);
    }
    if (!bodies) return;
    let t0 = performance.now();
    for (let i = 0; i * RUN < k.all.length && !k.gone; i++) {
      if (k.runs[i]) continue;
      if (this.keptBytes >= this.budget * 0.9) break;
      this.read(k, i);
      if (performance.now() - t0 < 4) continue;
      await pause();
      t0 = performance.now();
    }
    if (!k.gone) this.touch(session_id, k);
  }

  // The branch the session shows (the events from the first to its head),
  // oldest first: the same events, in the same order, as lineage() of
  // src/core/tree.ts gives over events(). The array is kept: the same one
  // comes back until the head moves, so a reader that asks again pays nothing.
  // It is shared, so its type is read-only and no reader changes it (it is
  // not frozen: freezing an array costs time for each of its elements on
  // every append, and reading a frozen one is slower). A walk goes back from the head by
  // position (a parent is always stored before its child), so it copies and
  // indexes nothing of the other branches.
  lineage(session_id: string): readonly StoredEvent[] {
    const head = this.db.query<{ head: string | null }, [string]>("SELECT head FROM sessions WHERE id = ?").get(session_id)?.head ?? null;
    if (!head) return [];
    const k = this.held(session_id);
    if (k.line?.head === head) {
      // What was appended at its head since it was read joins it, as a new
      // array: a reader that holds the branch as it was keeps it. One copy
      // for the appends between two reads, not one an append.
      if (k.line.more.length) k.line = { head, events: k.line.events.concat(k.line.more), more: [] };
      return k.line.events;
    }
    const all = k.all;
    const out: StoredEvent[] = [];
    let want: string | null = head;
    for (let at = all.length - 1; want; at--) {
      while (at >= 0 && all[at]!.id !== want) at--;
      if (at < 0) break;
      out.push(all[at]!);
      want = all[at]!.parent;
    }
    out.reverse();
    k.line = { head, events: out, more: [] };
    return out;
  }

  // Every event of the session, all branches, in seq order. With a cursor,
  // only the events after it: a reader that is catching up pays for what it
  // missed, not for the session. The whole is one array shared by the readers
  // between two appends (read-only: no reader changes it), and never one that
  // grows under a reader that holds it.
  events(session_id: string, afterSeq = 0): readonly StoredEvent[] {
    if (afterSeq > 0) {
      const k = this.kept.get(session_id);
      if (k) {
        this.touch(session_id, k);
        return k.all.slice(firstAfter(k.all, afterSeq));
      }
      // Not in memory: the (session_id, seq) index finds the rows after the
      // cursor and only they are parsed. A part is not kept as the session.
      return this.db
        .query<EventRow, [string, number]>("SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq")
        .all(session_id, afterSeq)
        .map((r) => deepFreeze(rowToEvent(r)));
    }
    const k = this.held(session_id);
    return (k.whole ??= k.all.slice());
  }

  // The last event of the branch the session shows, read by itself: for a
  // reader that needs to know how the session stands (its last turn ended,
  // and how) and not what was said in it.
  headEvent(session_id: string): StoredEvent | undefined {
    const r = this.db.query<EventRow, [string]>("SELECT e.* FROM sessions s JOIN events e ON e.id = s.head WHERE s.id = ?").get(session_id);
    return r ? rowToEvent(r) : undefined;
  }

  // Whether the session has an event of that kind, on any branch: asked of
  // the index when the session is not in memory, and nothing is brought in.
  hasKind(session_id: string, kind: EventKind): boolean {
    const k = this.kept.get(session_id);
    if (k) return k.all.some((e) => e.kind === kind);
    return !!this.db.query("SELECT 1 FROM events INDEXED BY events_bare WHERE session_id = ? AND kind = ? LIMIT 1").get(session_id, kind);
  }

  // Whether the session has any event: one index lookup, and nothing of the
  // session is read or parsed (a frame of a long session asks this).
  hasEvents(session_id: string): boolean {
    const k = this.kept.get(session_id);
    if (k) return k.all.length > 0;
    return !!this.db.query("SELECT 1 FROM events WHERE session_id = ? LIMIT 1").get(session_id);
  }

  event(id: string): StoredEvent | undefined {
    const r = this.db.query<EventRow, [string]>("SELECT * FROM events WHERE id = ?").get(id);
    return r ? rowToEvent(r) : undefined;
  }

  // A new session with its events, all or nothing (an import): each event keeps
  // the id and time it is given, chained in order with the last as the head.
  // A tree gives each event its `parent` (an event given before it, or null)
  // and names the `head` shown.
  createWithEvents(s: { title?: string; model: string; workspace: string }, events: { id: string; kind: EventKind; data: unknown; ts: number; parent?: string | null }[], head?: string | null): Session {
    const tx = this.db.transaction(() => {
      const ses = this.createSession(s);
      let prev: string | null = null;
      let seq = 0;
      for (const e of events) {
        this.db
          .query("INSERT INTO events (id, session_id, seq, parent, kind, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(e.id, ses.id, ++seq, e.parent !== undefined ? e.parent : prev, e.kind, JSON.stringify(this.redact(ses.id, e.kind, e.data)), e.ts);
        prev = e.id;
      }
      this.db.query("UPDATE sessions SET head = ? WHERE id = ?").run(head !== undefined ? head : prev, ses.id);
      return ses.id;
    });
    const id = tx();
    this.forget(id);
    return this.session(id)!;
  }

  // Copy a lineage into another session under new ids (fork). Returns the new head.
  // An event that names another one (a checkpoint's `covered`, a clear's
  // `undo_head`, a summary's `from_event`) names the copy of it; a name that
  // points outside the copied line is dropped, never left pointing at the source.
  copyEvents(session_id: string, events: readonly StoredEvent[]): string | null {
    let prev: string | null = null;
    const ids = new Map(events.map((e) => [e.id, Bun.randomUUIDv7()] as const));
    const tx = this.db.transaction(() => {
      let seq = 0;
      for (const e of events) {
        const id = ids.get(e.id)!;
        let data = e.data as Record<string, unknown>;
        if (data && typeof data === "object" && EVENT_REFS.some((k) => typeof data[k] === "string")) {
          data = { ...data };
          for (const k of EVENT_REFS) {
            if (typeof data[k] !== "string") continue;
            const to = ids.get(data[k] as string);
            if (to) data[k] = to;
            else delete data[k];
          }
        }
        this.db
          .query("INSERT INTO events (id, session_id, seq, parent, kind, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, session_id, ++seq, prev, e.kind, JSON.stringify(this.redact(session_id, e.kind, data)), e.ts);
        prev = id;
      }
      this.db.query("UPDATE sessions SET head = ? WHERE id = ?").run(prev, session_id);
    });
    tx();
    this.forget(session_id);
    return prev;
  }

  // Queue: prompts waiting for the running turn (steer) or for the next one.
  queue(session_id: string): QueueItem[] {
    return this.db
      .query<any, [string]>("SELECT * FROM queue WHERE session_id = ? ORDER BY steer DESC, pos")
      .all(session_id)
      .map(queueRow);
  }

  // `meta`: who sent it when not the owner (an origin, a kind), stored with the prompt when it leaves the queue.
  enqueue(session_id: string, text: string, steer: boolean, images?: ImageBlock[], meta?: Record<string, unknown>): QueueItem {
    text = this.redact(session_id, "queue", text);
    const id = Bun.randomUUIDv7();
    const { p } = this.db.query<{ p: number }, [string]>("SELECT COALESCE(MAX(pos), 0) + 1 AS p FROM queue WHERE session_id = ?").get(session_id)!;
    const anchor = this.db.query<{ head: string | null }, [string]>("SELECT head FROM sessions WHERE id = ?").get(session_id)?.head ?? null;
    this.db.query("INSERT INTO queue (id, session_id, text, steer, pos, created, images, anchor, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, session_id, text, steer ? 1 : 0, p, Date.now(), images?.length ? JSON.stringify(images) : null, anchor, meta ? JSON.stringify(meta) : null);
    return this.queue(session_id).find((q) => q.id === id)!;
  }

  queueItem(id: string): QueueItem | undefined {
    const r = this.db.query<any, [string]>("SELECT * FROM queue WHERE id = ?").get(id);
    return r ? queueRow(r) : undefined;
  }

  // True when the row was still there to change.
  updateQueueItem(id: string, patch: { text?: string; steer?: boolean; pos?: number; anchor?: string | null }): boolean {
    const q = this.queueItem(id);
    if (!q) return false;
    const text = patch.text !== undefined ? this.redact(q.session_id, "queue", patch.text) : q.text;
    const anchor = patch.anchor !== undefined ? patch.anchor : q.anchor ?? null;
    const r = this.db.query("UPDATE queue SET text = ?, steer = ?, pos = ?, anchor = ? WHERE id = ?").run(text, (patch.steer ?? q.steer) ? 1 : 0, patch.pos ?? q.pos, anchor, id);
    return r.changes > 0;
  }

  // True when this call removed the row (a claim: two callers never both get it).
  dequeue(id: string): boolean {
    return this.db.query("DELETE FROM queue WHERE id = ?").run(id).changes > 0;
  }

  // One row per kind of failure: the same source and message (numbers and ids
  // folded) bumps the row's count and time instead of adding one. A resolved
  // or read row that happens again opens again, unread. The row's session,
  // turn and span are this occurrence's, as its catcher gave them: a repeat
  // that names none leaves none of an earlier one's behind.
  // `group`: what repeats of this failure share, when the message alone does not say (ErrorPlace).
  recordError(raw: Omit<ErrorRecord, "id" | "ts">, group?: string): ErrorRecord {
    const ts = Date.now();
    // Kept like events: a secret in a failure's text is its placeholder. And what only looks like a key
    // (one Keel does not know: a tool printed it, a provider echoed it) is hidden here, where the row is made.
    const e = { ...raw, message: keyShaped(String(this.redact(null, "error", raw.message))), stack: raw.stack && keyShaped(String(this.redact(null, "error", raw.stack))), context: raw.context && keyShapedDeep(this.redact(null, "error", raw.context)) };
    const fp = `${e.source}\u0000${fingerprint(group ?? e.message)}`;
    const session_id = e.session_id ?? sessionOf(e.context);
    const live = session_id ? this.session(session_id) : undefined;
    const sid = live ? live.id : null;
    // A turn is kept only as a turn_start of that session.
    const turn = sid && e.turn_event && this.db.query("SELECT 1 FROM events WHERE id = ? AND session_id = ? AND kind = 'turn_start'").get(e.turn_event, sid) ? e.turn_event : null;
    const ctx = e.context ? JSON.stringify(e.context) : null;
    const row = this.db.query<{ id: string }, [string]>("SELECT id FROM errors WHERE fingerprint = ?").get(fp);
    if (row) {
      this.db
        .query("UPDATE errors SET ts = ?, count = count + 1, message = ?, stack = ?, context = ?, session_id = ?, turn_event = ?, span_id = ?, resolved_ts = NULL, read_ts = NULL WHERE id = ?")
        .run(ts, e.message, e.stack ?? null, ctx, sid, turn, e.span_id ?? null, row.id);
      return this.error(row.id)!;
    }
    const id = Bun.randomUUIDv7();
    this.db
      .query("INSERT INTO errors (id, ts, first_ts, source, message, stack, context, fingerprint, session_id, turn_event, span_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, ts, ts, e.source, e.message, e.stack ?? null, ctx, fp, sid, turn, e.span_id ?? null);
    return this.error(id)!;
  }

  error(id: string): ErrorRecord | undefined {
    const r = this.db.query<any, [string]>("SELECT * FROM errors WHERE id = ?").get(id);
    return r ? errorRow(r) : undefined;
  }

  // `session`: only the kinds that last happened in that session or in an agent of it.
  errors(limit = 200, opts: { resolved?: boolean; read?: boolean; session?: string } = {}): ErrorRecord[] {
    const conds = [
      opts.resolved === undefined ? "" : opts.resolved ? "resolved_ts IS NOT NULL" : "resolved_ts IS NULL",
      opts.read === undefined ? "" : opts.read ? "read_ts IS NOT NULL" : "read_ts IS NULL",
      opts.session === undefined ? "" : "(session_id = ?1 OR session_id IN (SELECT id FROM sessions WHERE parent_id = ?1))",
    ].filter(Boolean);
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    return this.db.query<any, [string | null, number]>(`SELECT * FROM errors ${where} ORDER BY ts DESC LIMIT ?2`).all(opts.session ?? null, limit).map(errorRow);
  }

  // Seen by the owner: out of the counts, still on the list. Happening again makes it unread.
  readError(id: string, read: boolean): ErrorRecord | undefined {
    this.db.query("UPDATE errors SET read_ts = ? WHERE id = ?").run(read ? Date.now() : null, id);
    return this.error(id);
  }

  resolveError(id: string, resolved: boolean): ErrorRecord | undefined {
    this.db.query("UPDATE errors SET resolved_ts = ? WHERE id = ?").run(resolved ? Date.now() : null, id);
    return this.error(id);
  }

  addUsage(id: string, u: Usage) {
    const s = this.session(id);
    if (!s) return;
    this.updateSession(id, { usage: addUsage(s.usage, u) });
  }
}
