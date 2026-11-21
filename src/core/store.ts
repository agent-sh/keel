import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ErrorRecord, EventKind, ImageBlock, QueueItem, Session, StoredEvent, Usage } from "./types.ts";
import { addUsage, emptyUsage } from "./types.ts";
import { forgetSession, SessionMap } from "./session-map.ts";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
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
const EVENT_REFS = ["covered", "undo_head", "from_event", "replaced_head"] as const;
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
function sessionOf(ctx: any): string | undefined {
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
  // Sessions whose turn was open when the last daemon stopped.
  bootWorking: string[] = [];
  // The parsed events of the sessions read last. A turn reads its whole session
  // before each model call and the page and routes read it too; events never
  // change once written, so each is parsed once. A 2,000-event session is about
  // 2 MB parsed, so only a few sessions are kept.
  private parsed = new SessionMap<StoredEvent[]>(4);

  constructor(readonly stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "keel.db"), { create: true, strict: true });
    this.db.exec(SCHEMA);
    // The event tree (edit, fork, branches) and per-session settings.
    if (!this.columnExists("events", "parent")) this.db.exec("ALTER TABLE events ADD COLUMN parent TEXT");
    if (!this.columnExists("sessions", "head")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN head TEXT");
      // A session from before the tree is one line: each event follows the one before.
      this.db.exec(`UPDATE events SET parent = (SELECT e2.id FROM events e2 WHERE e2.session_id = events.session_id AND e2.seq < events.seq ORDER BY e2.seq DESC LIMIT 1)`);
      this.db.exec(`UPDATE sessions SET head = (SELECT id FROM events WHERE session_id = sessions.id ORDER BY seq DESC LIMIT 1)`);
    }
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
    // Sessions left "working" by a crash or restart are idle now: no turn runs.
    // The engine closes and resumes their cut turns (Engine.recover).
    this.bootWorking = this.db.query<{ id: string }, []>("SELECT id FROM sessions WHERE phase = 'working'").all().map((r) => r.id);
    this.db.run("UPDATE sessions SET phase = 'idle' WHERE phase = 'working'");
  }

  // A feature module's tables: run once per start, statements must be idempotent
  // (CREATE ... IF NOT EXISTS; ALTER guarded by columnExists).
  // What is written may be rewritten first (secrets are kept out of history).
  // `kind` is the event kind, or "title", "queue", "error". Identity by default.
  redact: (sessionId: string | null, kind: string, value: any) => any = (_s, _k, v) => v;

  migrate(sql: string) {
    this.db.exec(sql);
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
    forgetSession(id);
  }

  // A new event at the head of the session's branch (or after `parent`, which
  // starts a new branch there: an edited prompt). It becomes the head.
  append(session_id: string, kind: EventKind, data: unknown, parent?: string | null): StoredEvent {
    data = this.redact(session_id, kind, data);
    const id = Bun.randomUUIDv7();
    const text = JSON.stringify(data);
    const ts = Date.now();
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
      this.db.query("UPDATE sessions SET updated = ?, head = ? WHERE id = ?").run(ts, id, session_id);
      return { n, p };
    });
    const { n, p } = tx();
    const ev: StoredEvent = { id, session_id, seq: n, parent: p, kind, data, ts };
    // The cached copy is what a read from the table would give (a JSON round trip).
    this.parsed.get(session_id)?.push(deepFreeze({ ...ev, data: JSON.parse(text) }));
    return ev;
  }

  // Every event of the session, all branches, in seq order. With a cursor,
  // only the events after it: a reader that is catching up pays for what it
  // missed, not for the session.
  events(session_id: string, afterSeq = 0): StoredEvent[] {
    let all = this.parsed.get(session_id);
    if (afterSeq > 0) {
      if (all) return all.slice(firstAfter(all, afterSeq));
      // Not in memory: the (session_id, seq) index finds the rows after the
      // cursor and only they are parsed. A part is not kept as the session.
      return this.db
        .query<EventRow, [string, number]>("SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq")
        .all(session_id, afterSeq)
        .map((r) => deepFreeze(rowToEvent(r)));
    }
    if (!all) {
      all = this.db
        .query<EventRow, [string]>("SELECT * FROM events WHERE session_id = ? ORDER BY seq")
        .all(session_id)
        .map((r) => deepFreeze(rowToEvent(r)));
      this.parsed.set(session_id, all);
    }
    return all.slice();
  }

  event(id: string): StoredEvent | undefined {
    const r = this.db.query<EventRow, [string]>("SELECT * FROM events WHERE id = ?").get(id);
    return r ? rowToEvent(r) : undefined;
  }

  // A new session with its events, all or nothing (an import): each event keeps
  // the id and time it is given, chained in order; the last is the head.
  createWithEvents(s: { title?: string; model: string; workspace: string }, events: { id: string; kind: EventKind; data: unknown; ts: number }[]): Session {
    const tx = this.db.transaction(() => {
      const ses = this.createSession(s);
      let prev: string | null = null;
      let seq = 0;
      for (const e of events) {
        this.db
          .query("INSERT INTO events (id, session_id, seq, parent, kind, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(e.id, ses.id, ++seq, prev, e.kind, JSON.stringify(this.redact(ses.id, e.kind, e.data)), e.ts);
        prev = e.id;
      }
      this.db.query("UPDATE sessions SET head = ? WHERE id = ?").run(prev, ses.id);
      return ses.id;
    });
    const id = tx();
    this.parsed.delete(id);
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
    this.parsed.delete(session_id);
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
  // or read row that happens again opens again, unread.
  recordError(raw: Omit<ErrorRecord, "id" | "ts">): ErrorRecord {
    const ts = Date.now();
    // Kept like events: a secret in a failure's text is its placeholder.
    const e = { ...raw, message: this.redact(null, "error", raw.message), stack: raw.stack && this.redact(null, "error", raw.stack), context: raw.context && this.redact(null, "error", raw.context) };
    const fp = `${e.source}\u0000${fingerprint(e.message)}`;
    const session_id = e.session_id ?? sessionOf(e.context);
    const live = session_id ? this.session(session_id) : undefined;
    const turn = live
      ? this.db.query<{ id: string }, [string]>("SELECT id FROM events WHERE session_id = ? AND kind = 'turn_start' ORDER BY seq DESC LIMIT 1").get(live.id)
      : null;
    const sid = live ? live.id : null;
    const ctx = e.context ? JSON.stringify(e.context) : null;
    const row = this.db.query<{ id: string }, [string]>("SELECT id FROM errors WHERE fingerprint = ?").get(fp);
    if (row) {
      this.db
        .query("UPDATE errors SET ts = ?, count = count + 1, message = ?, stack = ?, context = ?, session_id = COALESCE(?, session_id), turn_event = CASE WHEN ? IS NULL THEN turn_event ELSE ? END, span_id = ?, resolved_ts = NULL, read_ts = NULL WHERE id = ?")
        .run(ts, e.message, e.stack ?? null, ctx, sid, sid, turn?.id ?? null, e.span_id ?? null, row.id);
      return this.error(row.id)!;
    }
    const id = Bun.randomUUIDv7();
    this.db
      .query("INSERT INTO errors (id, ts, first_ts, source, message, stack, context, fingerprint, session_id, turn_event, span_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, ts, ts, e.source, e.message, e.stack ?? null, ctx, fp, sid, turn?.id ?? null, e.span_id ?? null);
    return this.error(id)!;
  }

  error(id: string): ErrorRecord | undefined {
    const r = this.db.query<any, [string]>("SELECT * FROM errors WHERE id = ?").get(id);
    return r ? errorRow(r) : undefined;
  }

  errors(limit = 200, opts: { resolved?: boolean; read?: boolean } = {}): ErrorRecord[] {
    const conds = [
      opts.resolved === undefined ? "" : opts.resolved ? "resolved_ts IS NOT NULL" : "resolved_ts IS NULL",
      opts.read === undefined ? "" : opts.read ? "read_ts IS NOT NULL" : "read_ts IS NULL",
    ].filter(Boolean);
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    return this.db.query<any, [number]>(`SELECT * FROM errors ${where} ORDER BY ts DESC LIMIT ?`).all(limit).map(errorRow);
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
