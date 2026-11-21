import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ErrorRecord, EventKind, ImageBlock, QueueItem, Session, StoredEvent, Usage } from "./types.ts";
import { addUsage, emptyUsage } from "./types.ts";
import { totalmem } from "node:os";
import { forgetSession } from "./session-map.ts";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
-- The write-ahead log is checkpointed at 1,000 pages (4.1 MB) and grows past
-- that only while a long read holds it (the read thread, a backup). This
-- gives the file back to that size at the first write after such a read.
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
  line?: { head: string; events: readonly StoredEvent[] };
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
// A session no turn runs in gives its events back after this long unread:
// the next read brings them back, once.
export const IDLE_KEPT_MS = 120_000;

// Dropping at least this much (as charged) is worth asking the collector for.
const GIVE_BACK_BYTES = 8e6;
// Asks the runtime's collector: for a whole collection now, or for one when it sees fit.
const collect = (whole: boolean) => (globalThis as { Bun?: { gc(whole: boolean): void } }).Bun?.gc(whole);

const pause = () => new Promise<void>((r) => setImmediate(r));

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

  constructor(readonly stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "keel.db"), { create: true, strict: true });
    this.db.exec(SCHEMA);
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

  deleteSession(id: string) {
    this.db.query("DELETE FROM sessions WHERE id = ?").run(id);
    this.forget(id);
    forgetSession(id);
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
      // A new array: a reader that holds the branch as it was keeps it.
      k.line = k.line?.head === p ? { head: id, events: [...k.line.events, held] } : undefined;
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
  // each come back here. Idle sessions go first, the longest unread first;
  // then bodies, the run read longest ago first, whoever it belongs to; and
  // only when events without bodies alone pass the budget, working sessions.
  // The session and the run in hand stay.
  private trim(keep?: Kept, keepRun = -1) {
    if (this.keptBytes <= this.budget) return;
    const target = this.budget * 0.9;
    const working = this.working();
    for (const [id, k] of [...this.kept]) {
      if (this.keptBytes <= target) return;
      if (k !== keep && !working.has(id)) this.forget(id);
    }
    const runs: { k: Kept; i: number; used: number }[] = [];
    for (const k of this.kept.values()) k.runs.forEach((r, i) => { if (r && !(k === keep && i === keepRun)) runs.push({ k, i, used: r.used }); });
    runs.sort((a, b) => a.used - b.used);
    for (const r of runs) {
      if (this.keptBytes <= target) return;
      this.drop(r.k, r.i);
    }
    for (const [id, k] of [...this.kept]) {
      if (this.keptBytes <= this.budget) return;
      if (k !== keep) this.forget(id);
    }
  }

  // Idle sessions unread for IDLE_KEPT_MS give their events back, and so does
  // a working one unread for fifteen times that (a turn inside one long tool
  // call reads them again when the call ends). The check runs only while
  // something is kept, and never holds the process open.
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
    for (const [id, k] of stale) if (!working.has(id) || now - k.at >= 15 * IDLE_KEPT_MS) this.forget(id);
    // Sessions still at work: the collector is only asked to collect when it
    // sees fit. The whole collection comes when the last one goes (rest).
    if (this.kept.size && this.owed >= GIVE_BACK_BYTES) collect(false);
  }

  // Nothing is kept any more. What was given back since the last whole
  // collection is mostly old to the collector, which looks at old objects only
  // when the heap grows, and a daemon at rest does not grow: seen after ten
  // minutes of twelve sessions, 80 to 100 MB stayed for as long as the daemon
  // was watched. So it is asked to look. No session has been read for two
  // minutes by then (or the last one kept was deleted): a whole collection
  // holds the loop some tens of milliseconds while nobody waits on it.
  private rest() {
    clearInterval(this.sweeper);
    this.sweeper = undefined;
    if (this.owed < GIVE_BACK_BYTES) return;
    this.owed = 0;
    collect(true);
  }

  // How many sessions are kept and what they are charged, in bytes of memory,
  // against the budget (the resources report shows it).
  keptEvents(): { sessions: number; bytes: number; budget: number } {
    return { sessions: this.kept.size, bytes: this.keptBytes, budget: this.budget };
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
  private held(session_id: string): Kept {
    const k = this.kept.get(session_id);
    if (k) {
      this.touch(session_id, k);
      return k;
    }
    return this.keep(session_id, this.db.query<Bare, [string]>("SELECT id, seq, parent, kind, ts FROM events WHERE session_id = ? ORDER BY seq").all(session_id));
  }

  // Brings a session into memory without holding the loop: its events a few
  // thousand at a time, then their bodies while they fit, giving the loop back
  // in between. A reader that then asks for the whole session (the page
  // opening a long one) finds it there instead of reading it in one piece.
  async warm(session_id: string): Promise<void> {
    let k = this.kept.get(session_id);
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
    if (k.line?.head === head) return k.line.events;
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
    k.line = { head, events: out };
    return out;
  }

  // Every event of the session, all branches, in seq order. With a cursor,
  // only the events after it: a reader that is catching up pays for what it
  // missed, not for the session.
  events(session_id: string, afterSeq = 0): StoredEvent[] {
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
    return this.held(session_id).all.slice();
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
  copyEvents(session_id: string, events: StoredEvent[]): string | null {
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
  recordError(raw: Omit<ErrorRecord, "id" | "ts">): ErrorRecord {
    const ts = Date.now();
    // Kept like events: a secret in a failure's text is its placeholder.
    const e = { ...raw, message: this.redact(null, "error", raw.message), stack: raw.stack && this.redact(null, "error", raw.stack), context: raw.context && this.redact(null, "error", raw.context) };
    const fp = `${e.source}\u0000${fingerprint(e.message)}`;
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
