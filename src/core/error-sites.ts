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

type Row = Omit<ErrorSite, "title"> & { error_id: string; title: string | null };
const siteOf = (r: Row): ErrorSite => ({
  session_id: r.session_id, count: r.count, healed: r.healed, first_ts: r.first_ts, ts: r.ts,
  ...(r.title ? { title: r.title } : {}),
  ...(r.healed_ts ? { healed_ts: r.healed_ts } : {}), ...(r.turn_event ? { turn_event: r.turn_event } : {}), ...(r.span_id ? { span_id: r.span_id } : {}),
});

// A kind is recovered when every occurrence it counts happened in a session
// and each was healed by a retry of its request. One occurrence that was not
// (the retries ran out, or it happened outside a session) keeps the kind open.
export function recoveredAt(count: number, sites: ErrorSite[]): number | undefined {
  if (!sites.length) return undefined;
  let seen = 0;
  let at = 0;
  for (const s of sites) {
    if (s.healed < s.count || !s.healed_ts) return undefined;
    seen += s.count;
    at = Math.max(at, s.healed_ts);
  }
  return seen >= count ? at : undefined;
}

// The record with its last occurrence put aside for the one in `sessionId`,
// when the kind happened there: what a bundle or a trace opened from that
// session is about. A kind that never happened there is returned as it is.
export function atSession(e: ErrorRecord, sessionId: string | undefined): ErrorRecord {
  const site = sessionId ? e.sites?.find((s) => s.session_id === sessionId) : undefined;
  if (!site || (e.session_id === sessionId && e.ts === site.ts)) return e;
  // The context was captured with the last occurrence: it is another session's.
  const { turn_event: _t, span_id: _s, context: _c, ...rest } = e;
  return { ...rest, session_id: site.session_id, ts: site.ts, ...(site.turn_event ? { turn_event: site.turn_event } : {}), ...(site.span_id ? { span_id: site.span_id } : {}) };
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
  }

  // This occurrence, as the store kept it (its session, turn and span are the
  // ones the store accepted). An occurrence in no session has no site.
  note(rec: ErrorRecord) {
    if (!rec.session_id) return;
    this.db
      .query(`INSERT INTO error_sites (error_id, session_id, first_ts, ts, turn_event, span_id) VALUES (?1, ?2, ?3, ?3, ?4, ?5)
        ON CONFLICT(error_id, session_id) DO UPDATE SET count = count + 1, ts = ?3, turn_event = ?4, span_id = ?5`)
      .run(rec.id, rec.session_id, rec.ts, rec.turn_event ?? null, rec.span_id ?? null);
  }

  // A retry of the request passed: `n` occurrences of this kind in the session were healed.
  heal(errorId: string, sessionId: string, n = 1, now = Date.now()): boolean {
    return this.db.query("UPDATE error_sites SET healed = MIN(count, healed + ?3), healed_ts = ?4 WHERE error_id = ?1 AND session_id = ?2").run(errorId, sessionId, n, now).changes > 0;
  }

  of(ids: string[]): Map<string, ErrorSite[]> {
    const out = new Map<string, ErrorSite[]>();
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400);
      const rows = this.db
        .query<Row, string[]>(`SELECT p.*, s.title AS title FROM error_sites p JOIN sessions s ON s.id = p.session_id WHERE p.error_id IN (${part.map(() => "?").join(",")}) ORDER BY p.ts DESC`)
        .all(...part);
      for (const r of rows) (out.get(r.error_id) ?? out.set(r.error_id, []).get(r.error_id)!).push(siteOf(r));
    }
    return out;
  }

  // The records with where each happened and whether it is recovered.
  with<T extends ErrorRecord>(recs: T[]): T[] {
    if (!recs.length) return recs;
    const all = this.of(recs.map((r) => r.id));
    return recs.map((r) => {
      const sites = all.get(r.id);
      if (!sites) return r;
      const recovered_ts = recoveredAt(r.count ?? 1, sites);
      return { ...r, sites, ...(recovered_ts ? { recovered_ts } : {}) };
    });
  }

  // The kinds that happened in a session or in an agent of it (not only last there).
  inScope(sessionId: string): Set<string> {
    // Agents are sessions with a parent (the column is the automation module's).
    const agents = this.db.query("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'parent_id'").get() ? " OR session_id IN (SELECT id FROM sessions WHERE parent_id = ?1)" : "";
    const rows = this.db.query<{ error_id: string }, [string]>(`SELECT DISTINCT error_id FROM error_sites WHERE session_id = ?1${agents}`).all(sessionId);
    return new Set(rows.map((r) => r.error_id));
  }
}
