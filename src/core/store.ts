import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ErrorRecord, EventKind, Session, StoredEvent, Usage } from "./types.ts";
import { addUsage, emptyUsage } from "./types.ts";

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
`;

type SessionRow = Omit<Session, "archived" | "usage"> & { archived: number; usage: string };

function rowToSession(r: SessionRow): Session {
  return { ...r, archived: !!r.archived, usage: { ...emptyUsage(), ...JSON.parse(r.usage || "{}") } };
}

export class Store {
  readonly db: Database;

  constructor(readonly stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "keel.db"), { create: true, strict: true });
    this.db.exec(SCHEMA);
    // Sessions left "working" by a crash or restart are idle now: no turn runs.
    this.db.run("UPDATE sessions SET phase = 'idle' WHERE phase = 'working'");
  }

  // A feature module's tables: run once per start, statements must be idempotent
  // (CREATE ... IF NOT EXISTS; ALTER guarded by columnExists).
  migrate(sql: string) {
    this.db.exec(sql);
  }

  columnExists(table: string, column: string): boolean {
    return this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  }

  createSession(s: { title?: string; model: string; workspace: string }): Session {
    const now = Date.now();
    const id = Bun.randomUUIDv7();
    this.db
      .query("INSERT INTO sessions (id, title, model, workspace, created, updated) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, s.title ?? "", s.model, s.workspace, now, now);
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

  updateSession(id: string, patch: Partial<Pick<Session, "title" | "model" | "phase" | "archived" | "usage" | "workspace">>): Session {
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(k === "usage" ? JSON.stringify(v) : k === "archived" ? (v ? 1 : 0) : (v as string));
    }
    sets.push("updated = ?");
    vals.push(Date.now());
    this.db.query(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.session(id)!;
  }

  deleteSession(id: string) {
    this.db.query("DELETE FROM sessions WHERE id = ?").run(id);
  }

  append(session_id: string, kind: EventKind, data: unknown): StoredEvent {
    const id = Bun.randomUUIDv7();
    const ts = Date.now();
    const tx = this.db.transaction(() => {
      const { n } = this.db
        .query<{ n: number }, [string]>("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE session_id = ?")
        .get(session_id)!;
      this.db
        .query("INSERT INTO events (id, session_id, seq, kind, data, ts) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, session_id, n, kind, JSON.stringify(data), ts);
      this.db.query("UPDATE sessions SET updated = ? WHERE id = ?").run(ts, session_id);
      return n;
    });
    return { id, session_id, seq: tx(), kind, data, ts };
  }

  events(session_id: string, afterSeq = 0): StoredEvent[] {
    return this.db
      .query<Omit<StoredEvent, "data"> & { data: string }, [string, number]>(
        "SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq",
      )
      .all(session_id, afterSeq)
      .map((r) => ({ ...r, kind: r.kind as EventKind, data: JSON.parse(r.data) }));
  }

  recordError(e: Omit<ErrorRecord, "id" | "ts">): ErrorRecord {
    const rec: ErrorRecord = { id: Bun.randomUUIDv7(), ts: Date.now(), ...e };
    this.db
      .query("INSERT INTO errors (id, ts, source, message, stack, context) VALUES (?, ?, ?, ?, ?, ?)")
      .run(rec.id, rec.ts, rec.source, rec.message, rec.stack ?? null, rec.context ? JSON.stringify(rec.context) : null);
    return rec;
  }

  errors(limit = 200): ErrorRecord[] {
    return this.db
      .query<any, [number]>("SELECT * FROM errors ORDER BY ts DESC LIMIT ?")
      .all(limit)
      .map((r) => ({ ...r, stack: r.stack ?? undefined, context: r.context ? JSON.parse(r.context) : undefined }));
  }

  addUsage(id: string, u: Usage) {
    const s = this.session(id);
    if (!s) return;
    this.updateSession(id, { usage: addUsage(s.usage, u) });
  }
}
