// Where each kind of failure happened: one row per kind and session, with
// that session's own count, its latest time, turn and span, and how many of
// its occurrences a retry healed. The errors table keeps one row per kind and
// names only the last occurrence; a kind seen in three sessions is read from
// here, and so is "open this session's own failure".
import type { Database } from "bun:sqlite";
import type { ErrorRecord, ErrorSite } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS error_sites (
  error_id TEXT NOT NULL REFERENCES errors(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  count INTEGER NOT NULL DEFAULT 1,
  healed INTEGER NOT NULL DEFAULT 0,
  first_ts INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  healed_ts INTEGER,
  turn_event TEXT,
  span_id TEXT,
  PRIMARY KEY (error_id, session_id)
);
CREATE INDEX IF NOT EXISTS error_sites_session ON error_sites(session_id);
`;
// What is open of a kind, kept with the kind and not worked out from its sessions: a session
// that is deleted takes its row above with it, and what the owner resolved is dealt with whether
// or not a retry healed it. `open`: the occurrences that neither a retry healed nor the owner
// resolved. `pending`: those of them captured as about to be tried again (not the owner's yet).
// `healed_ts`: the last time a retry healed one.
const TALLY = `
CREATE TABLE IF NOT EXISTS error_tally (
  error_id TEXT PRIMARY KEY REFERENCES errors(id) ON DELETE CASCADE,
  open INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  healed_ts INTEGER
);
`;

type Row = Omit<ErrorSite, "title"> & { error_id: string; title: string | null };
const siteOf = (r: Row): ErrorSite => ({
  session_id: r.session_id, count: r.count, healed: r.healed, first_ts: r.first_ts, ts: r.ts,
  ...(r.title ? { title: r.title } : {}),
  ...(r.healed_ts ? { healed_ts: r.healed_ts } : {}), ...(r.turn_event ? { turn_event: r.turn_event } : {}), ...(r.span_id ? { span_id: r.span_id } : {}),
});

// A kind is recovered when nothing of it is open and a retry healed its last
// open occurrence: every occurrence since the owner last resolved it was
// healed by a retry of its request. One that was not (the retries ran out, or
// it happened outside a session) keeps the kind open; a session deleted
// afterwards changes nothing. An occurrence whose retry is still to come
// (`pending`) does not open a recovered kind: it is healed or it fails for
// good, and only then does the kind change.
export const recoveredAt = (t: { open: number; pending?: number; healed_ts: number | null } | undefined): number | undefined => (t && t.open - (t.pending ?? 0) <= 0 && t.healed_ts ? t.healed_ts : undefined);

// The record with its last occurrence put aside for the one in `sessionId`,
// when the kind happened there: what a bundle or a trace opened from that
// session is about. A kind that never happened there is returned as it is.
export function atSession(e: ErrorRecord, sessionId: string | undefined): ErrorRecord {
  const site = sessionId ? e.sites?.find((s) => s.session_id === sessionId) : undefined;
  if (!site || (e.session_id === sessionId && e.ts === site.ts)) return e;
  // The context was captured with the last occurrence: it is another session's.
  // `kind_ts`: when the kind last happened anywhere (`ts` is this session's last).
  const { turn_event: _t, span_id: _s, context: _c, ...rest } = e;
  return { ...rest, session_id: site.session_id, ts: site.ts, kind_ts: e.ts, ...(site.turn_event ? { turn_event: site.turn_event } : {}), ...(site.span_id ? { span_id: site.span_id } : {}) };
}

export class ErrorSites {
  constructor(private db: Database) {
    const fresh = !db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'error_sites'").get();
    db.exec(SCHEMA);
    // Kinds recorded before this table: the last occurrence of each is known (its
    // session, turn and span); the earlier ones are counted with no session.
    if (fresh) {
      db.exec(`INSERT OR IGNORE INTO error_sites (error_id, session_id, count, first_ts, ts, turn_event, span_id)
        SELECT id, session_id, 1, ts, ts, turn_event, span_id FROM errors WHERE session_id IN (SELECT id FROM sessions)`);
    }
    const tally = !db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'error_tally'").get();
    db.exec(TALLY);
    // Kinds from before the tally: open is what no retry healed, as their sessions' rows say.
    if (tally) {
      db.exec(`INSERT OR IGNORE INTO error_tally (error_id, open, healed_ts)
        SELECT e.id, CASE WHEN e.resolved_ts IS NOT NULL THEN 0 ELSE MAX(0, COALESCE(e.count, 1) - COALESCE((SELECT SUM(healed) FROM error_sites WHERE error_id = e.id), 0)) END,
          (SELECT MAX(healed_ts) FROM error_sites WHERE error_id = e.id) FROM errors e`);
    }
  }

  // How many occurrences of a kind failed for good: open, and not waiting for a retry of their request.
  failed(errorId: string): number {
    const t = this.db.query<{ open: number; pending: number }, [string]>("SELECT open, pending FROM error_tally WHERE error_id = ?").get(errorId);
    return t ? Math.max(0, t.open - t.pending) : 0;
  }

  // The owner resolved the kind: what was open of it is dealt with. A later occurrence opens it again.
  settle(errorId: string) {
    this.db.query("INSERT INTO error_tally (error_id, open) VALUES (?1, 0) ON CONFLICT(error_id) DO UPDATE SET open = 0, pending = 0").run(errorId);
  }

  // This occurrence, as the store kept it (its session, turn and span are the
  // ones the store accepted). An occurrence in no session has no site.
  // `pending`: it is about to be tried again.
  note(rec: ErrorRecord, pending = false, recovered = false) {
    if (recovered && !rec.session_id) {
      // An already-healed daemon occurrence has no session site and was never open.
      this.db.query(`INSERT INTO error_tally (error_id, healed_ts) VALUES (?1, ?2)
        ON CONFLICT(error_id) DO UPDATE SET healed_ts = ?2`).run(rec.id, rec.ts);
      return;
    }
    this.db.query("INSERT INTO error_tally (error_id, open, pending) VALUES (?1, 1, ?2) ON CONFLICT(error_id) DO UPDATE SET open = open + 1, pending = pending + ?2").run(rec.id, pending ? 1 : 0);
    if (!rec.session_id) return;
    this.db
      .query(`INSERT INTO error_sites (error_id, session_id, first_ts, ts, turn_event, span_id) VALUES (?1, ?2, ?3, ?3, ?4, ?5)
        ON CONFLICT(error_id, session_id) DO UPDATE SET count = count + 1, ts = ?3, turn_event = ?4, span_id = ?5`)
      .run(rec.id, rec.session_id, rec.ts, rec.turn_event ?? null, rec.span_id ?? null);
  }

  healGroup(id: string) {
    this.db.query("UPDATE error_tally SET open = 0, pending = 0, healed_ts = ? WHERE error_id = ?").run(Date.now(), id);
  }

  // A retry of the request passed: `n` occurrences of this kind in the session were healed.
  heal(errorId: string, sessionId: string, n = 1, now = Date.now()): boolean {
    const site = this.db.query<{ count: number; healed: number }, [string, string]>("SELECT count, healed FROM error_sites WHERE error_id = ?1 AND session_id = ?2").get(errorId, sessionId);
    if (!site) return false;
    const healed = Math.max(0, Math.min(n, site.count - site.healed));
    this.db.query("UPDATE error_sites SET healed = healed + ?3, healed_ts = ?4 WHERE error_id = ?1 AND session_id = ?2").run(errorId, sessionId, healed, now);
    this.db.query("INSERT INTO error_tally (error_id, open, healed_ts) VALUES (?1, 0, ?3) ON CONFLICT(error_id) DO UPDATE SET open = MAX(0, open - ?2), pending = MAX(0, pending - ?2), healed_ts = ?3").run(errorId, healed, now);
    return true;
  }

  of(ids: string[]): Map<string, ErrorSite[]> {
    const out = new Map<string, ErrorSite[]>();
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400);
      const rows = this.db
        .query<Row, string[]>(`SELECT p.*, s.title AS title FROM error_sites p JOIN sessions s ON s.id = p.session_id WHERE p.error_id IN (SELECT value FROM json_each(?)) ORDER BY p.ts DESC`)
        .all(JSON.stringify(part));
      for (const r of rows) (out.get(r.error_id) ?? out.set(r.error_id, []).get(r.error_id)!).push(siteOf(r));
    }
    return out;
  }

  // The records with where each happened and whether it is recovered.
  with<T extends ErrorRecord>(recs: T[]): T[] {
    if (!recs.length) return recs;
    const ids = recs.map((r) => r.id);
    const all = this.of(ids);
    const tally = new Map<string, { open: number; pending: number; healed_ts: number | null }>();
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400);
      for (const t of this.db.query<{ error_id: string; open: number; pending: number; healed_ts: number | null }, string[]>(`SELECT error_id, open, pending, healed_ts FROM error_tally WHERE error_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(part))) tally.set(t.error_id, t);
    }
    return recs.map((r) => {
      const sites = all.get(r.id);
      const recovered_ts = recoveredAt(tally.get(r.id));
      return sites || recovered_ts ? { ...r, ...(sites ? { sites } : {}), ...(recovered_ts ? { recovered_ts } : {}) } : r;
    });
  }

  // The ids of the kinds that happened in a session or in an agent of it (not only last there, and
  // a kind from before sites were kept by where it last happened), the newest first. Selected by the
  // session's own rows: however many kinds the store holds, the session's are all found.
  kindsOf(sessionId: string, opts: { resolved?: boolean; read?: boolean } = {}, limit = 200): string[] {
    const agents = this.db.query("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'parent_id'").get() ? " UNION SELECT id FROM sessions WHERE parent_id = ?1" : "";
    const conds = [
      opts.resolved === undefined ? "" : opts.resolved ? "e.resolved_ts IS NOT NULL" : "e.resolved_ts IS NULL",
      opts.read === undefined ? "" : opts.read ? "e.read_ts IS NOT NULL" : "e.read_ts IS NULL",
    ].filter(Boolean).map((c) => ` AND ${c}`).join("");
    return this.db
      .query<{ id: string }, [string, number]>(`WITH scope(id) AS (SELECT ?1${agents})
        SELECT e.id FROM errors e WHERE (e.id IN (SELECT error_id FROM error_sites WHERE session_id IN (SELECT id FROM scope)) OR e.session_id IN (SELECT id FROM scope))${conds} ORDER BY e.ts DESC LIMIT ?2`)
      .all(sessionId, limit).map((r) => r.id);
  }}
