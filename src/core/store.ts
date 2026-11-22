import { keyShaped, keyShapedDeep } from "./conceal.ts";
import { BARE_INDEX_SQL, bareBy, hasBareIndex, INDEX_NOW_ROWS } from "./bare-index.ts";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ErrorRecord, EventKind, ImageBlock, QueueItem, Session, StoredEvent, Usage } from "./types.ts";
import { addUsage, emptyUsage } from "./types.ts";
import { totalmem } from "node:os";
import { memoryLimits } from "./cgroup.ts";
import { forgetSession } from "./session-map.ts";
import { asker, asking } from "./asker.ts";
import { labelled } from "./statement-label.ts";
import { encodeOwed, OWED_FILE, OWED_FILE_MAX, OWED_V, owedLineKey, owedRefusal, owedSql, readOwed, type OwedLine, type OwedRecord, type OwedSql } from "./owed.ts";
import { holdStore, logBytes, storePath } from "./store-files.ts";
import { Side } from "./side.ts";
import type { SettleAsk, Settled } from "../engine/compact.ts";

// Every transaction of this connection begins as a writer (BEGIN IMMEDIATE).
// One that begins as a reader and writes later cannot wait for the write
// lock: when another connection holds it, or committed since the read,
// SQLite fails the write at once (isolation.html: SQLITE_BUSY_SNAPSHOT),
// whatever the busy timeout. The checkpoint thread is such a connection
// (checkpoint.ts). A transaction that begins as a writer waits for the lock
// and then sees what was committed.
export function immediate(db: Database) {
  const begin = db.transaction.bind(db);
  (db as { transaction: unknown }).transaction = (fn: (...args: unknown[]) => unknown) => {
    const t = begin(fn);
    const run = function (this: unknown, ...args: unknown[]) { return t.immediate.apply(this, args); };
    return Object.assign(run, { deferred: t.deferred, immediate: t.immediate, exclusive: t.exclusive });
  };
}

// How long a write of this connection waits for the write lock at a time. It waits a fifth of a
// second and is tried again (the statement wrapper, in the constructor) for as long as the lock's
// holder is not known to stand still (src/core/checkpoint.ts, lockedOut), thirty seconds in all:
// the loop is never inside one wait for longer than this, and whoever watches the holder is asked
// between the waits.
export const BUSY_MS = 200;

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
-- thread the file is as long as the thread lets the log grow (its own
-- connection's limit counts then, since it is the one that starts the log again).
PRAGMA journal_size_limit = 4194304;
-- A write waits for the write lock when another connection holds it (the
-- checkpoint thread while it starts the log again, a command of the owner's
-- that writes to the store): without this it fails at once.
PRAGMA busy_timeout = ${BUSY_MS};
-- The key the file of owed writes is marked with (src/core/owed.ts): made once, kept here, where
-- the file tools never read and a sandboxed command cannot write.
CREATE TABLE IF NOT EXISTS store_keys (name TEXT PRIMARY KEY, key BLOB NOT NULL);
INSERT OR IGNORE INTO store_keys (name, key) VALUES ('owed', randomblob(32));
INSERT OR IGNORE INTO store_keys (name, key) VALUES ('owed_generation', 0);
-- The one row the checkpoint thread writes when it starts the log again (checkpoint.ts).
CREATE TABLE IF NOT EXISTS log_starts (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO log_starts (id) VALUES (1);
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

// What a kept event costs in resident memory, so that what the store charges
// is what the process holds. Measured with every body read, on generated
// sessions: resident memory grew by 1.5 times the characters of the stored
// JSON where bodies are long strings and by 2.4 to 2.5 times where they are
// many small objects (the parsed objects, their strings, and what a parse
// leaves behind): the higher is charged. An event without its body takes
// 285 bytes of heap and, with what the allocator keeps around it, 320 to
// 560 resident (2,600 sessions of 155,000 events: 87 MB): 400 is charged
// (it was 256, a third under).
const BODY_COST = 2.5;
export const BARE_COST = 400;

// How much resident memory kept events may take. The bound is on memory,
// not on a count of sessions, because sessions differ a thousand times in
// size. It is the smallest of:
// - a thirty-second of the machine's memory;
// - an eighth of where the daemon's unit throttles it (MemoryHigh), when a
//   unit sets that: the unit's bound is on the daemon and the children it
//   keeps (src/admin/unit.ts), and the events are one part of the daemon;
// - a sixteenth of where the unit kills (MemoryMax, or a container's limit);
// and within 64 MB and 512 MB. A smaller ceiling was tried (384 MB) for a
// day of twelve working sessions and a coordinator: the daemon's resident
// memory did not fall (it is two to three times the heap under that work,
// and the heap is mostly what the turns allocate and drop, not what is kept
// here), and sessions were given back and read again more often.
// KEEL_EVENTS_MEMORY_MB sets another.
export const EVENTS_MIN = 64e6, EVENTS_MAX = 512e6;
export function eventsBudgetOf(o: { total: number; high?: number; max?: number; set?: number }): number {
  if (o.set !== undefined && Number.isFinite(o.set) && o.set > 0) return o.set * 1e6;
  const share = Math.min(o.total / 32, (o.high ?? Infinity) / 8, (o.max ?? Infinity) / 16);
  return Math.min(EVENTS_MAX, Math.max(EVENTS_MIN, share));
}
export function eventsBudget(): number {
  const limits = memoryLimits();
  const constrained = Number((process as { constrainedMemory?: () => number }).constrainedMemory?.()) || undefined;
  const max = Math.min(limits.max ?? Infinity, constrained ?? Infinity);
  return eventsBudgetOf({ total: totalmem(), high: limits.high, max: Number.isFinite(max) ? max : undefined, set: process.env.KEEL_EVENTS_MEMORY_MB ? Number(process.env.KEEL_EVENTS_MEMORY_MB) : undefined });
}
// What a session keeps in memory, and for how long.
// - The bodies it read: an idle session gives them back after IDLE_KEPT_MS
//   unread (a working one after fifteen times that: a turn inside one long
//   tool call reads them again when the call ends). They are most of what a
//   session costs: BODY_COST times the stored text.
// - Its events without their bodies (the rows every reader walks: a
//   branch, a count, the last event): for as long as anything reads the
//   session, and BARE_KEPT_MS after its last read. They cost BARE_COST an
//   event (22 MB for a session of 60,000), and bringing them back is a read
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

// A walk back over a session that is not in memory (Store.back) reads this
// many of its rows at a time, and brings the session in when it has read this
// many: a reader of a branch's end stops within its last turn, far before that.
const BACK_PART = 256;
const BACK_ROWS = 8192;
// And a look back over the events of one kind (Store.newest) reads this many of them at a time.
const NEWEST_PART = 32;

const pause = () => new Promise<void>((r) => setImmediate(r));
// KEEL_TRACE_COLD=1: each whole-session read made on the loop is a line of the log, with who asked; =stack: and its call stack.
const TRACE_COLD = process.env.KEEL_TRACE_COLD;
// SQLite's words for a write on a connection that takes none (PRAGMA query_only).
export const refusedWrite = (e: unknown) => /readonly database|SQLITE_READONLY/i.test(`${(e as { code?: string })?.code ?? ""} ${(e as Error)?.message ?? e}`);
// Writes owed while the store takes none: a turn's end, a card's answer, a phase. More than this many are not kept.
const OWED_MAX = 10_000;
// At a stop of the daemon: how long its file of owed writes may take to be written and given to the disk,
// and how long one write that is tried a last time waits for the write lock.
const OWED_EXIT_MS = 2_000;
const OWED_BUSY_MS = 250;
const BUSY_ALL_MS = 30_000;
// A log longer than this at a start is said while it is read.
const LOG_SAID_MB = 64;
// The longest a turn holds a write for the checkpoint thread's hold of the write lock (Store.clear):
// a start of the log on a slow disk is seven syncs, each of seconds. A thread that stands still for
// half a minute ends the wait before this (Checkpointer.pacing).
const PACE_MS = 300_000;
// What a write is told when the store takes none (in SQLite's own words for it, so every reader of such a failure knows it).
const refusedError = () => Object.assign(new Error("attempt to write a readonly database: the store takes no writes right now"), { code: "SQLITE_READONLY" });
// What a request that would write is answered meanwhile.
export const STORE_REFUSES = "the daemon's disk does not answer and its store takes no writes until it does or the daemon is restarted (see Errors). Sessions can still be read, a running turn stopped, a card answered and the daemon restarted.";
// SQLite's words, and the system's, for a disk with no room.
export const diskFull = (e: unknown) => /SQLITE_FULL|database or disk is full|ENOSPC|no space left/i.test(`${(e as { code?: string })?.code ?? ""} ${(e as Error)?.message ?? e}`);
const busyWrite = (e: unknown) => /SQLITE_BUSY|database is locked/i.test(`${(e as { code?: string })?.code ?? ""} ${(e as Error)?.message ?? e}`);
// `p`, or false when it has not settled within `ms`.
const within = <T>(p: Promise<T>, ms: number): Promise<T | false> => {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<false>((r) => { t = setTimeout(() => r(false), ms); })]).finally(() => clearTimeout(t));
};

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
  // About how many events the index of the events' rows is still to be built over (0: it is there).
  indexOwed = 0;
  // Counts body reads: a run's `used` is the count when it was last read.
  private tick = 0;
  // What dropped sessions were charged since the last whole collection.
  private owed = 0;

  // The writes that wait for the next commit (side.ts): spans, the telemetry
  // ledgers, the activity list. `sideFailed`: told of one that could not be made (set by the daemon).
  readonly side: Side;
  sideFailed?: (e: unknown, what: string) => void;

  // A read made ahead on the read thread (src/server/reads.ts, readAhead), set
  // by the daemon: what it reads is then in the operating system's memory
  // for the loop. It resolves when that is so, or when it is not worth waiting for.
  offLoop?: (sql: string, params: (string | number | null)[]) => Promise<unknown>;
  // A summary settled against its branch on the read thread (src/engine/settle-read.ts), set by the
  // daemon: without it the caller settles on the loop.
  settleOff?: (ask: SettleAsk) => Promise<Settled>;

  // The store takes no writes for now: its disk does not answer and its log
  // is at the ceiling, or the checkpoint thread holds the write lock in a
  // call that does not return (src/core/checkpoint.ts). What the owner must
  // always be able to do then (stop a turn, answer a card, stop or restart
  // the daemon) acts in memory, and the writes that go with it are owed:
  // `orLater` makes a write now, or keeps it when the store refuses it and
  // makes it when the store takes writes again (`refuse(false)`), in the
  // order they were owed.
  //
  // What is owed outlives the daemon that owes it. Each owed write that
  // matters after a restart has its record, appended as it is owed to a
  // small file in the state folder (src/core/owed.ts says what the file
  // may hold and why the next start can trust it): a write through the
  // operating system, off the loop, with no sync, so a restart or a kill
  // of the daemon keeps it (a loss of power may not: the disk is not
  // answering). A daemon that stops tries what it owes for a few seconds,
  // each write waiting for the write lock a quarter of a second at most
  // (the thread that does not return may hold it), and leaves the rest in
  // the file. The next start makes them before it reads anything else
  // (`applyOwed`), each once: an event is known by its id, a statement is
  // one that can be made twice. Then the file is removed.
  refusing = false;
  // Set by the checkpoint thread's owner: a write of this connection waited for the write lock
  // and did not get it. True: the store takes no writes from here (the holder stands still).
  lockedOut?: (waitedMs: number) => boolean;
  // Set by the checkpoint thread's owner: told when a write found the disk full.
  full?: () => void;
  // Set by the checkpoint thread's owner: true while a write would wait for the thread's hold of
  // the write lock (a start of the log on a slow disk), or be refused because of it.
  pacing?: () => boolean;
  // A turn asks before it writes, at a place it can wait: resolves when the hold is over, at its
  // stop, or after `ms` at the latest (the write is then made as any, and fails as any).
  // What waits here does not hold the loop in SQLite's wait for the lock, and is not ended by a
  // store that stopped taking writes for those seconds.
  // `orRefusing`: also when the store stops taking writes meanwhile (the caller then owes its write, and asks again).
  async clear(signal?: AbortSignal, ms = PACE_MS, orRefusing = false): Promise<void> {
    const until = Date.now() + ms;
    while (this.pacing?.() && !(orRefusing && this.refusing) && !signal?.aborted && Date.now() < until) await Bun.sleep(25);
  }
  // Something about the owed writes the owner should read (a record that was not kept): set by the daemon.
  owedSaid?: (e: Error) => void;
  private inLockedOut = false;
  private flushing = false;
  private busyFrom = 0;
  private later: { what: string; write: () => void; records: OwedRecord[]; filed: boolean }[] = [];
  // The file's writes, one after another; `journalFailed`: why one of them was not made.
  private journalled: Promise<void> = Promise.resolve();
  private journalFailed?: string;
  private journalBytes = 0;
  private notes: OwedLine[] = [];
  // The key the file's lines are marked with, and this daemon's name in them.
  private owedKey!: Uint8Array;
  private readonly life = Bun.randomUUIDv7();
  // Records that were not kept in memory (over OWED_MAX) or not filed (the file is full), since it was last said.
  private unkept = { memory: 0, file: 0, said: false };
  private madeAtStop = 0;
  orLater(what: string, write: () => void, records: OwedRecord[] = []): boolean {
    if (!this.refusing) {
      // (A write that did not get the write lock is owed too when that made the store take no writes: `lockedOut`.)
      // (And one that found the disk full, which made the store take no writes too: `full`.)
      try { write(); return true; } catch (e) { if (!refusedWrite(e) && !((busyWrite(e) || diskFull(e)) && this.refusing)) throw e; }
    }
    if (this.later.length >= OWED_MAX) { this.unkept.memory++; this.sayUnkept(); return false; }
    const filed = records.length ? this.journal(records.map((r) => ({ ...r, v: OWED_V, life: this.life, what }))) : false;
    this.later.push({ what, write, records, filed });
    if (records.length && !filed) { this.unkept.file++; this.sayUnkept(); }
    return false;
  }
  // Said once for each time the store takes no writes: the count is in the words when the daemon stops.
  private sayUnkept() {
    if (this.unkept.said) return;
    this.unkept.said = true;
    queueMicrotask(() => {
      const u = this.unkept;
      this.owedSaid?.(new Error(u.memory
        ? `More than ${OWED_MAX} writes are owed to the store while it takes none: the ones past that are not kept, and what they would have written is lost (a turn among them is closed as cut at the next start).`
        : `The file of owed writes is full (${Math.round(OWED_FILE_MAX / 1048576)} MB): what is owed from here is kept in memory only, and is lost if the daemon stops before the store takes writes again.`));
    });
  }
  // An event that is made now, or owed with the id and the time it has now. `then`: told the stored event (the bus).
  appendOrLater(session: string, kind: EventKind, data: unknown, then: (e: StoredEvent) => void = () => {}): boolean {
    const id = Bun.randomUUIDv7(), at = Date.now();
    // (Redacted before it is owed: the file never holds what the table would not.)
    data = this.redact(session, kind, data);
    return this.orLater(`${kind === "turn_end" ? "a turn's end" : kind === "tool_result" ? "a tool's result" : `an event (${kind})`}`, () => then(this.append(session, kind, data, undefined, at, id)), [{ op: "event", id, session, kind, data, at }]);
  }
  // One of the statements that may be owed (src/core/owed.ts).
  sqlOrLater(name: OwedSql, params: (string | number | null)[], what: string): boolean {
    return this.orLater(what, () => void this.db.query(owedSql(name)!).run(...params), [{ op: "sql", name, params }]);
  }
  // Something the next start must say (a restart that made no backup): kept in the same file.
  noteNext(text: string) {
    const line: OwedLine = { op: "note", text, at: Date.now(), v: OWED_V, life: this.life };
    this.notes.push(line);
    this.journalAppend(encodeOwed(this.owedKey, line));
  }
  // False: the file is full, and these are not in it.
  private journal(lines: OwedLine[]): boolean {
    const text = lines.map((l) => encodeOwed(this.owedKey, l)).join("");
    if (this.journalBytes + text.length > OWED_FILE_MAX) return false;
    this.journalAppend(text);
    return true;
  }
  // (Opened without following a link, made for its owner alone: the file is the daemon's.)
  private journalAppend(text: string, replace = false) {
    this.journalBytes = (replace ? 0 : this.journalBytes) + text.length;
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (replace ? constants.O_TRUNC : constants.O_APPEND);
    this.journalled = this.journalled.then(async () => {
      const f = await open(join(this.stateDir, OWED_FILE), flags, 0o600);
      try { await f.write(text); } finally { await f.close(); }
      this.journalSync();
    }).catch((e) => { this.journalFailed ??= (e as Error).message; });
  }
  // What was appended is synced, off the loop and beside the appends (one sync at a time; an append
  // never waits for it): on a disk that answers, an owed write is on the disk moments after it was
  // owed, so a loss of power before the store takes it does not lose it. On a disk that does not
  // answer the sync does not return, the appends go on, and a stop says the disk has not confirmed
  // the file (closeOwed).
  private journalSyncing = false;
  private journalUnsynced = false;
  private journalSync() {
    this.journalUnsynced = true;
    if (this.journalSyncing) return;
    this.journalSyncing = true;
    void (async () => {
      try {
        while (this.journalUnsynced) {
          this.journalUnsynced = false;
          const f = await open(join(this.stateDir, OWED_FILE), constants.O_RDWR | constants.O_NOFOLLOW);
          try { await f.sync(); } finally { await f.close(); }
        }
      } catch {} finally { this.journalSyncing = false; }
    })();
  }
  // Set by the checkpoint thread's owner. Off: what is owed is made, in
  // order. `failed`: a write that was owed and failed when it was made at
  // last (it is dropped). `budgetMs`: at a stop of the daemon, how long
  // this may take in all; a write the store still does not take (the lock
  // is held, the time is up) stays owed with the ones after it, in the file.
  refuse(on: boolean, failed: (e: unknown, what: string) => void = () => {}, budgetMs?: number) {
    this.refusing = on;
    if (on) return;
    const until = budgetMs === undefined ? Infinity : Date.now() + budgetMs;
    let full = false;
    this.flushing = budgetMs !== undefined;
    if (budgetMs !== undefined) try { this.db.exec(`PRAGMA busy_timeout = ${OWED_BUSY_MS}`); } catch {}
    try {
      while (this.later.length && Date.now() <= until) {
        const o = this.later[0]!;
        try { o.write(); if (budgetMs !== undefined && o.records.length) this.madeAtStop++; } catch (e) {
          // (No room on the disk for it: it stays owed with the ones after it, and the store goes on taking no writes.)
          if (diskFull(e)) { full = true; break; }
          if (budgetMs !== undefined && (busyWrite(e) || refusedWrite(e))) break;
          // (The store stopped taking writes again while these were made: the rest stays owed.)
          if (this.refusing) break;
          failed(e, o.what);
        }
        this.later.shift();
      }
    } finally {
      this.flushing = false;
      if (budgetMs !== undefined) try { this.db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`); } catch {}
    }
    if (this.later.length) {
      // The store still takes no writes (the daemon is stopping, and the write lock is still held;
      // or the disk has no room): it says so for what is left of this process, so a later write
      // fails at once, and is owed when it can be, instead of waiting for the lock on the loop.
      if (budgetMs !== undefined || full) {
        this.refusing = true;
        try { this.db.exec("PRAGMA query_only = ON"); } catch {}
        if (full && budgetMs === undefined) try { this.full?.(); } catch {}
      }
      return;
    }
    this.phases.clear();
    this.unkept = { memory: 0, file: 0, said: false };
    // Nothing is owed any more: the file goes, or holds only the words for the next start.
    // The file is done with: the next one is marked with another key (owedLineKey), so a line of
    // this one, kept and put back, is not made again.
    try { this.nextOwedFile(); } catch {}
    const path = join(this.stateDir, OWED_FILE), notes = this.notes.map((l) => encodeOwed(this.owedKey, l)).join("");
    if (notes) this.journalAppend(notes, true);
    else {
      this.journalBytes = 0;
      this.journalled = this.journalled.then(() => unlink(path)).then(() => { this.journalFailed = undefined; }, () => {});
    }
  }
  get owes(): number { return this.later.length; }
  // `f` with no wait for a lock at all: what it cannot have at once it does not get.
  noWait<T>(f: () => T): T {
    const was = this.flushing;
    this.flushing = true;
    try { this.db.exec("PRAGMA busy_timeout = 0"); return f(); } finally {
      this.flushing = was;
      try { this.db.exec(`PRAGMA busy_timeout = ${was ? OWED_BUSY_MS : BUSY_MS}`); } catch {}
    }
  }
  // At a stop of the daemon, after the last try (`refuse(false, ..., ms)`):
  // what is still owed is in its file, which is given to the disk when the
  // disk takes it in time. `made`: what the last try wrote. `lost`: what is
  // owed and in no file (the file could not be written, or was full), by
  // what it was; the daemon says exactly that.
  async closeOwed(ms = OWED_EXIT_MS): Promise<{ made: number; owed: number; synced: boolean; lost: string[] }> {
    const left = this.later.filter((o) => o.records.length);
    const made = this.madeAtStop;
    if (!left.length && !this.notes.length) {
      // (The file's last write, its removal included, is given its time.)
      await within(this.journalled, ms);
      return { made, owed: 0, synced: true, lost: [] };
    }
    const path = join(this.stateDir, OWED_FILE);
    const written = (await within(this.journalled.then(() => true), ms)) && !this.journalFailed;
    if (!written) return { made, owed: left.length, synced: false, lost: left.map((o) => o.what) };
    // (Off the loop and bounded: a sync is what this disk may never answer.)
    const synced = await within((async () => { const f = await open(path, constants.O_RDWR | constants.O_NOFOLLOW); try { await f.sync(); } finally { await f.close(); } return true; })().catch(() => false), ms);
    return { made, owed: left.length, synced: !!synced, lost: left.filter((o) => !o.filed).map((o) => o.what) };
  }
  // A session's phase as it is in memory while its write is owed: what a list of sessions says.
  private phases = new Map<string, Session["phase"]>();
  phaseOwed(id: string, phase: Session["phase"]) { this.phases.set(id, phase); }
  // What the daemon before this one owed, made at this start; what could not be made or was not taken, in words; and what it left to be said.
  owedAtStart?: { made: number; failed: string[]; notes: { text: string; at: number }[] };
  // The key the file's lines are marked with now, and the one of the file before it.
  private owedBefore?: Uint8Array;
  private readOwedKey() {
    const key = this.db.query<{ key: Uint8Array }, []>("SELECT key FROM store_keys WHERE name = 'owed'").get()!.key;
    const n = Number(this.db.query<{ key: number }, []>("SELECT key FROM store_keys WHERE name = 'owed_generation'").get()?.key ?? 0);
    this.owedKey = owedLineKey(key, n);
    this.owedBefore = n > 0 ? owedLineKey(key, n - 1) : undefined;
  }
  private nextOwedFile() {
    this.db.query("UPDATE store_keys SET key = key + 1 WHERE name = 'owed_generation'").run();
    if (!this.db.inTransaction) this.readOwedKey();
  }
  private applyOwed() {
    const path = join(this.stateDir, OWED_FILE);
    const read = readOwed(path, this.owedKey, this.owedBefore);
    if (!read) return;
    const done = { made: 0, failed: [] as string[], notes: [] as { text: string; at: number }[] };
    // A file that is not the daemon's own to read (a link, a folder, far too large) is moved aside and said: it is not applied, and it does not stay in the next file's place.
    const aside = (why: string) => {
      const to = `${path}.refused-${Date.now()}`;
      let moved = false;
      try { renameSync(path, to); moved = true; } catch {}
      done.failed.push(`the file of owed writes was not applied: ${why}${moved ? ` (it is kept as ${basename(to)})` : " (and it could not be moved aside: no new one can be written until it is removed)"}`);
      this.owedAtStart = done;
    };
    if (read.why) return aside(read.why);
    if (read.torn) done.failed.push(`${read.torn} line${read.torn === 1 ? "" : "s"} of the file of owed writes ${read.torn === 1 ? "was" : "were"} cut or not a record, and ${read.torn === 1 ? "was" : "were"} passed over`);
    if (read.unmarked + read.others) done.failed.push(`${read.unmarked + read.others} line${read.unmarked + read.others === 1 ? "" : "s"} of the file of owed writes did not carry this store's mark and ${read.unmarked + read.others === 1 ? "was" : "were"} not applied: the daemon did not write ${read.unmarked + read.others === 1 ? "it" : "them"}`);
    // (A file a start made and did not get to remove, or one of the run before put back: made already.)
    if (read.made) console.log(`[store] ${read.made} line${read.made === 1 ? "" : "s"} of the file of owed writes ${read.made === 1 ? "was" : "were"} made before (the file of the run before this one): not made again`);
    const records = read.lines.filter((r) => r.op !== "note");
    for (const r of read.lines) if (r.op === "note" && typeof r.text === "string") done.notes.push({ text: r.text.slice(0, 2000), at: Number(r.at) || 0 });
    if (records.length) console.log(`[store] applying ${records.length} write${records.length === 1 ? "" : "s"} the daemon before this one owed (${Math.round(read.bytes / 1024)} KB)`);
    const known = this.db.query<{ n: number }, [string]>("SELECT 1 AS n FROM events WHERE id = ?");
    // (A card's table is a module's: one that is not there yet has no card.)
    const facts = {
      session: (id: string) => !!this.db.query("SELECT 1 FROM sessions WHERE id = ?").get(id),
      card: (id: string) => { try { return this.db.query<{ state: string; session_id: string; data: string }, [string]>("SELECT state, session_id, data FROM approvals WHERE id = ?").get(id) ?? undefined; } catch { return undefined; } },
    };
    // (No checkpoint in this commit: a daemon that stopped with its disk not answering may have left
    // a long log, and copying it is the checkpoint thread's work once the daemon answers, not the start's.)
    const auto = this.db.query<{ wal_autocheckpoint: number }, []>("PRAGMA wal_autocheckpoint").get()?.wal_autocheckpoint ?? 1000;
    this.db.exec("PRAGMA wal_autocheckpoint = 0");
    try { this.db.transaction(() => {
      for (const r of records) {
        try {
          const why = owedRefusal(r, facts);
          if (why === "made") continue;
          if (why) throw new Error(why);
          // (A part of the whole: one that fails leaves the others made.)
          this.db.transaction(() => {
            if (r.op === "event") {
              if (known.get(r.id)) return;
              this.append(r.session, r.kind, r.data, undefined, r.at, r.id);
            } else if (r.op === "sql") {
              this.db.query(owedSql(r.name, r.v)!).run(...r.params);
            }
            done.made++;
          })();
        } catch (e) {
          done.failed.push(`${typeof r.what === "string" ? r.what.slice(0, 80) : r.op}: ${(e as Error).message}`);
        }
      }
      // With them, in the one commit: this file is done with.
      this.nextOwedFile();
    })(); } finally { this.db.exec(`PRAGMA wal_autocheckpoint = ${auto}`); this.readOwedKey(); }
    rmSync(path, { force: true });
    this.owedAtStart = done;
  }

  constructor(readonly stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    // From here this process holds locks on the store's files: nothing but SQLite opens them (store-files.ts).
    holdStore(stateDir);
    // A long log left by a daemon that did not stop cleanly is read whole by this open, before the
    // daemon listens (seconds from a cold disk): said as it begins and when it is over.
    const logMb = Math.round(logBytes(stateDir) / 1_048_576);
    const reading = logMb > LOG_SAID_MB ? performance.now() : 0;
    if (reading) console.log(`[store] reading ${logMb} MB of the store's log, left by a daemon that did not stop cleanly`);
    this.db = new Database(storePath(stateDir), { create: true, strict: true });
    this.db.exec(SCHEMA);
    if (reading) console.log(`[store] the log is read (${((performance.now() - reading) / 1000).toFixed(1)} s)`);
    immediate(this.db);
    // Each statement says which one it is while it runs: a stall in the database is named by its query (statement-label.ts).
    // (And one that ends without the write lock it waited for is told to whoever watches the lock's holder: `lockedOut`.)
    // The wait for the write lock is a fifth of a second at a time, made again (true) while its
    // holder is not known to stand still, for thirty seconds in all.
    labelled(this.db, (e, tries) => {
      // (A disk with no room: said to whoever keeps the store's state, once.)
      if (diskFull(e)) { try { this.full?.(); } catch {} return false; }
      if (!busyWrite(e) || this.inLockedOut) return false;
      const now = Date.now();
      // (This write's wait began one wait ago, when it was first tried.)
      if (tries === 0) this.busyFrom = now - BUSY_MS;
      this.inLockedOut = true;
      let out = false;
      try { out = this.lockedOut?.(now - this.busyFrom) === true; } catch {} finally { this.inLockedOut = false; }
      // The store takes no writes from here: this write is told so, as the ones after it are (not that the lock was not had).
      if (out) return refusedError();
      if (this.flushing || this.refusing) return false;
      return now - this.busyFrom < BUSY_ALL_MS;
    });
    this.readOwedKey();
    // Rows beside the conversation wait for the next commit instead of making one each (side.ts).
    this.side = new Side(this.db, (e, what) => this.sideFailed?.(e, what));
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
      // Replace the old session-only index without touching any queued prompts.
      if (this.db.query("PRAGMA index_info(queue_session)").all().length === 1) this.db.exec("DROP INDEX queue_session");
      this.db.exec("CREATE INDEX IF NOT EXISTS queue_session ON queue(session_id, steer DESC, pos)");
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
    // it has it built once: here when it is small, else after the daemon
    // listens (`indexOwed`, src/server/index-build.ts): the build reads every
    // event's body, which a large store's disk takes long over, and until it
    // is done the rows are read from the table (bare-index.ts).
    if (!hasBareIndex(this.db)) {
      const n = this.db.query<{ n: number }, []>("SELECT COALESCE(MAX(rowid), 0) AS n FROM events").get()!.n;
      if (n <= INDEX_NOW_ROWS) this.db.exec(BARE_INDEX_SQL);
      else this.indexOwed = n;
    }
    // Sessions left "working" by a crash or restart: no turn runs in them now.
    // The mark itself is the list. It stays until the engine has closed the
    // session's cut turn (Engine.closeCut, then bootSettled), so a daemon
    // killed during its own start leaves it for the next one; and whichever
    // build starts next clears it, so a mark is never older than one start.
    // What the daemon before this one owed and could not write is made first: the turns it closed are closed.
    try { this.applyOwed(); } catch (e) { this.owedAtStart = { made: 0, failed: [`the file of owed writes could not be applied: ${(e as Error).message}`], notes: [] }; }
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
    // It has no event: that is kept, so its first reader reads nothing. Not inside a transaction of
    // the caller's, which may still be undone: there the session is only known as new, and the read
    // that finds it empty is not counted as a whole-session read (held).
    if (this.db.inTransaction) {
      this.fresh.add(id);
      if (this.fresh.size > 1_000) this.fresh.delete(this.fresh.values().next().value!);
    } else this.keep(id, []);
    return this.session(id)!;
  }
  // Sessions made in this process inside a transaction that was still open: not kept as empty yet.
  private fresh = new Set<string>();

  session(id: string): Session | undefined {
    const r = this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
    return r ? this.phased(rowToSession(r)) : undefined;
  }

  sessions(opts: { archived?: boolean } = {}): Session[] {
    const all = this.db
      .query<SessionRow, [number]>("SELECT * FROM sessions WHERE archived = ? ORDER BY updated DESC")
      .all(opts.archived ? 1 : 0)
      .map(rowToSession);
    return this.phases.size ? all.map((s) => this.phased(s)) : all;
  }
  // (A phase whose write is owed is the one in memory: a turn that ended while the store took no writes is not working.)
  private phased(s: Session): Session {
    const p = this.phases.get(s.id);
    return p && p !== s.phase ? { ...s, phase: p } : s;
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
  // (`at`, `as`: the time and the id of an event that was owed: Store.orLater.)
  append(session_id: string, kind: EventKind, data: unknown, parent?: string | null, at?: number, as?: string): StoredEvent {
    data = this.redact(session_id, kind, data);
    const id = as ?? Bun.randomUUIDv7();
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

  // Under memory pressure (src/core/rest.ts): the kept events beyond `share`
  // of the budget go now, in the order trim gives them back (the bodies idle
  // sessions read first, working sessions last). Returns the bytes given back.
  giveBack(share: number): number {
    const before = this.keptBytes;
    const budget = this.budget;
    this.budget = budget * share;
    try { this.trim(); } finally { this.budget = budget; }
    return before - this.keptBytes;
  }

  // What the connection holds for speed alone (its page cache) is freed; the next reads fill it again.
  shrink() {
    this.db.exec("PRAGMA shrink_memory");
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
    // (A session made a moment ago, found empty: no read of a session.)
    if (this.fresh.delete(session_id) && !rows.length) return this.keep(session_id, rows);
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
          : `SELECT COUNT(*) AS n, MAX(ts) AS ts, MAX(LENGTH(id) + LENGTH(COALESCE(parent, '')) + LENGTH(kind)) AS w FROM events ${bareBy(this.db)} WHERE session_id = ?`, [session_id]).catch(() => {});
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

  // The branch the session shows, from its head back, an event at a time: for
  // a reader that needs how the branch ends (its last turn, its last prompt)
  // and stops there. A session in memory is walked on the branch kept. One
  // that is not is read from the index of its rows, a few hundred at a time
  // from the newest, and an event's body only when it is asked for: nothing
  // is brought into memory, and the reader pays for how far back it goes. One
  // that goes further than BACK_ROWS has the session brought in after all
  // (counted as a whole read on the loop: coldReads).
  *back(session_id: string): Generator<StoredEvent, void, undefined> {
    const walk = function* (line: readonly StoredEvent[], from: number) { for (let i = from; i >= 0; i--) yield line[i]!; };
    if (this.kept.has(session_id)) { const line = this.lineage(session_id); return yield* walk(line, line.length - 1); }
    let want = this.db.query<{ head: string | null }, [string]>("SELECT head FROM sessions WHERE id = ?").get(session_id)?.head ?? null;
    const part = this.db.query<Bare, [string, number, number]>(`SELECT id, seq, parent, kind, ts FROM events ${bareBy(this.db)} WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`);
    const body = this.db.query<{ data: string }, [string]>("SELECT data FROM events WHERE id = ?");
    let below = Number.MAX_SAFE_INTEGER;
    for (let read = 0; want; ) {
      if (read >= BACK_ROWS || this.kept.has(session_id)) {
        // Far back (or brought in by someone meanwhile): the rest is walked on the branch kept.
        const line = this.lineage(session_id);
        let at = firstAfter(line, below - 1) - 1;
        while (at >= 0 && line[at]!.id !== want) at--;
        return yield* walk(line, at);
      }
      const rows = part.all(session_id, below, BACK_PART);
      if (!rows.length) return;
      read += rows.length;
      below = rows.at(-1)!.seq;
      for (const r of rows) {
        if (r.id !== want) continue;
        want = r.parent ?? null;
        const e = { id: r.id, session_id, seq: r.seq, parent: r.parent ?? null, kind: r.kind as EventKind } as StoredEvent;
        let data: unknown;
        Object.defineProperty(e, "data", { enumerable: true, get: () => (data ??= deepFreeze(JSON.parse(body.get(r.id)?.data ?? "null"))) });
        e.ts = r.ts;
        yield Object.freeze(e);
        if (!want) return;
      }
    }
  }

  // The session's events of one kind, on any branch, newest first, an event
  // at a time: for a reader that looks back for something and stops when it
  // has it. `since`: only those stored at or after that time. From the rows
  // kept when the session is in memory, else from the index of its rows, with
  // the bodies of the events of that kind alone: nothing is brought in.
  *newest(session_id: string, kind: EventKind, since = 0): Generator<StoredEvent, void, undefined> {
    const k = this.kept.get(session_id);
    if (k) {
      this.touch(session_id, k);
      const all = k.all;
      for (let i = all.length - 1; i >= 0; i--) if (all[i]!.kind === kind && all[i]!.ts >= since) yield all[i]!;
      return;
    }
    const part = this.db.query<EventRow, [string, string, number, number, number]>(
      `SELECT e.* FROM events e WHERE e.id IN (SELECT id FROM events ${bareBy(this.db)} WHERE session_id = ?1 AND kind = ?2 AND ts >= ?3 AND seq < ?4 ORDER BY seq DESC LIMIT ?5) ORDER BY e.seq DESC`);
    for (let below = Number.MAX_SAFE_INTEGER; ; ) {
      const rows = part.all(session_id, kind, since, below, NEWEST_PART);
      for (const r of rows) yield deepFreeze(rowToEvent(r));
      if (rows.length < NEWEST_PART) return;
      below = rows.at(-1)!.seq;
    }
  }

  // The last event of the branch the session shows, read by itself: for a
  // reader that needs to know how the session stands (its last turn ended,
  // and how) and not what was said in it.
  headEvent(session_id: string): StoredEvent | undefined {
    const r = this.db.query<EventRow, [string]>("SELECT e.* FROM sessions s JOIN events e ON e.id = s.head AND e.session_id = s.id WHERE s.id = ?").get(session_id);
    return r ? rowToEvent(r) : undefined;
  }

  // Whether the session has an event of that kind, on any branch: asked of
  // the index when the session is not in memory, and nothing is brought in.
  hasKind(session_id: string, kind: EventKind): boolean {
    const k = this.kept.get(session_id);
    if (k) return k.all.some((e) => e.kind === kind);
    return !!this.db.query(`SELECT 1 FROM events ${bareBy(this.db)} WHERE session_id = ? AND kind = ? LIMIT 1`).get(session_id, kind);
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

  // Count from the index, not the rows that carry message text and images.
  // `sending` is the set of prompts Send now has taken but not yet removed.
  queueCounts(sending: Iterable<string> = []): Map<string, number> {
    const out = new Map<string, number>();
    for (const { session_id, n } of this.db.query<{ session_id: string; n: number }, []>("SELECT session_id, count(*) AS n FROM queue GROUP BY session_id").all()) out.set(session_id, n);
    for (const id of sending) {
      const of = this.db.query<{ session_id: string }, [string]>("SELECT session_id FROM queue WHERE id = ?").get(id)?.session_id;
      if (!of) continue;
      const n = (out.get(of) ?? 0) - 1;
      if (n > 0) out.set(of, n);
      else out.delete(of);
    }
    return out;
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
