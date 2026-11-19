import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
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

type SessionRow = Omit<Session, "archived" | "usage" | "settings"> & { archived: number; usage: string; settings: string };

function rowToSession(r: SessionRow): Session {
  return {
    ...r,
    head: r.head ?? null,
    archived: !!r.archived,
    usage: { ...emptyUsage(), ...JSON.parse(r.usage || "{}") },
    settings: JSON.parse(r.settings || "{}"),
  };
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
    session_id: r.session_id ?? undefined, turn_event: r.turn_event ?? undefined, resolved_ts: r.resolved_ts ?? undefined,
  };
}

const queueRow = (r: any): QueueItem => {
  const { images, ...rest } = r;
  return { ...rest, steer: !!r.steer, ...(images ? { images: JSON.parse(images) } : {}) };
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
    if (!this.columnExists("sessions", "settings")) this.db.exec("ALTER TABLE sessions ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
    for (const [col, type] of [["fingerprint", "TEXT"], ["count", "INTEGER NOT NULL DEFAULT 1"], ["first_ts", "INTEGER"], ["session_id", "TEXT"], ["turn_event", "TEXT"], ["resolved_ts", "INTEGER"]] as const) {
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

  updateSession(id: string, patch: Partial<Pick<Session, "title" | "model" | "phase" | "archived" | "usage" | "workspace" | "head" | "settings">>): Session {
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      if (k === "title") { vals.push(this.redact(id, "title", v)); continue; }
      vals.push(k === "usage" || k === "settings" ? JSON.stringify(v) : k === "archived" ? (v ? 1 : 0) : (v as string));
    }
    sets.push("updated = ?");
    vals.push(Date.now());
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
    this.db.query("UPDATE sessions SET settings = ? WHERE id = ?").run(JSON.stringify(next), id);
    return this.session(id);
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

  // Every event of the session, all branches, in seq order.
  events(session_id: string, afterSeq = 0): StoredEvent[] {
    let all = this.parsed.get(session_id);
    if (!all) {
      all = this.db
        .query<EventRow, [string]>("SELECT * FROM events WHERE session_id = ? ORDER BY seq")
        .all(session_id)
        .map((r) => deepFreeze(rowToEvent(r)));
      this.parsed.set(session_id, all);
    }
    return afterSeq ? all.filter((e) => e.seq > afterSeq) : all.slice();
  }

  event(id: string): StoredEvent | undefined {
    const r = this.db.query<EventRow, [string]>("SELECT * FROM events WHERE id = ?").get(id);
    return r ? rowToEvent(r) : undefined;
  }

  // Copy a lineage into another session under new ids (fork). Returns the new head.
  copyEvents(session_id: string, events: StoredEvent[]): string | null {
    let prev: string | null = null;
    const tx = this.db.transaction(() => {
      let seq = 0;
      for (const e of events) {
        const id = Bun.randomUUIDv7();
        this.db
          .query("INSERT INTO events (id, session_id, seq, parent, kind, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, session_id, ++seq, prev, e.kind, JSON.stringify(this.redact(session_id, e.kind, e.data)), e.ts);
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

  enqueue(session_id: string, text: string, steer: boolean, images?: ImageBlock[]): QueueItem {
    text = this.redact(session_id, "queue", text);
    const id = Bun.randomUUIDv7();
    const { p } = this.db.query<{ p: number }, [string]>("SELECT COALESCE(MAX(pos), 0) + 1 AS p FROM queue WHERE session_id = ?").get(session_id)!;
    this.db.query("INSERT INTO queue (id, session_id, text, steer, pos, created, images) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, session_id, text, steer ? 1 : 0, p, Date.now(), images?.length ? JSON.stringify(images) : null);
    return this.queue(session_id).find((q) => q.id === id)!;
  }

  queueItem(id: string): QueueItem | undefined {
    const r = this.db.query<any, [string]>("SELECT * FROM queue WHERE id = ?").get(id);
    return r ? queueRow(r) : undefined;
  }

  updateQueueItem(id: string, patch: { text?: string; steer?: boolean; pos?: number }) {
    if (patch.text !== undefined) this.db.query("UPDATE queue SET text = ? WHERE id = ?").run(this.redact(this.queueItem(id)?.session_id ?? null, "queue", patch.text), id);
    if (patch.steer !== undefined) this.db.query("UPDATE queue SET steer = ? WHERE id = ?").run(patch.steer ? 1 : 0, id);
    if (patch.pos !== undefined) this.db.query("UPDATE queue SET pos = ? WHERE id = ?").run(patch.pos, id);
  }

  dequeue(id: string) {
    this.db.query("DELETE FROM queue WHERE id = ?").run(id);
  }

  // One row per kind of failure: the same source and message (numbers and ids
  // folded) bumps the row's count and time instead of adding one. A resolved
  // row that happens again opens again.
  recordError(e: Omit<ErrorRecord, "id" | "ts">): ErrorRecord {
    const ts = Date.now();
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
        .query("UPDATE errors SET ts = ?, count = count + 1, message = ?, stack = ?, context = ?, session_id = COALESCE(?, session_id), turn_event = CASE WHEN ? IS NULL THEN turn_event ELSE ? END, resolved_ts = NULL WHERE id = ?")
        .run(ts, e.message, e.stack ?? null, ctx, sid, sid, turn?.id ?? null, row.id);
      return this.error(row.id)!;
    }
    const id = Bun.randomUUIDv7();
    this.db
      .query("INSERT INTO errors (id, ts, first_ts, source, message, stack, context, fingerprint, session_id, turn_event) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, ts, ts, e.source, e.message, e.stack ?? null, ctx, fp, sid, turn?.id ?? null);
    return this.error(id)!;
  }

  error(id: string): ErrorRecord | undefined {
    const r = this.db.query<any, [string]>("SELECT * FROM errors WHERE id = ?").get(id);
    return r ? errorRow(r) : undefined;
  }

  errors(limit = 200, opts: { resolved?: boolean } = {}): ErrorRecord[] {
    const where = opts.resolved === undefined ? "" : opts.resolved ? "WHERE resolved_ts IS NOT NULL" : "WHERE resolved_ts IS NULL";
    return this.db.query<any, [number]>(`SELECT * FROM errors ${where} ORDER BY ts DESC LIMIT ?`).all(limit).map(errorRow);
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
