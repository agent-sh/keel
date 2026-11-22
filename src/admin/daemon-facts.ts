// What the daemon itself went through in a stretch of time: its starts (each
// with how the one before it ended and the turns that cut) and the stalls of
// its loop. Read for the away digest, which tells of them before the
// sessions. Starts are the restart records (life.ts); stalls are kept here,
// one row each, because the Errors list keeps one row a cause and the
// daemon's own list is only of its present process.
import type { Database } from "bun:sqlite";
import type { Restart } from "./life-rows.ts";

export type StallFact = { ts_ms: number; ms: number; what: string; kind: string };
export type DaemonFacts = { restarts: Restart[]; stalls: StallFact[] };

const SCHEMA = "CREATE TABLE IF NOT EXISTS daemon_stalls (ts_ms INTEGER NOT NULL, ms INTEGER NOT NULL, what TEXT NOT NULL, kind TEXT NOT NULL); CREATE INDEX IF NOT EXISTS daemon_stalls_ts ON daemon_stalls(ts_ms);";
// Stalls kept: the digest reads at most a week back.
const KEPT = 2000;
const has = (db: Database, table: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

// One stall, as it was told (its end, how long, what took the time).
export function keepStall(db: Database, s: StallFact) {
  db.exec(SCHEMA);
  db.query("INSERT INTO daemon_stalls (ts_ms, ms, what, kind) VALUES (?, ?, ?, ?)").run(s.ts_ms, Math.round(s.ms), s.what.slice(0, 400), s.kind);
  db.query(`DELETE FROM daemon_stalls WHERE rowid NOT IN (SELECT rowid FROM daemon_stalls ORDER BY ts_ms DESC LIMIT ${KEPT})`).run();
}

// The starts whose time down touches one of the spans, and the stalls that ended in one. Oldest first.
export function daemonFacts(db: Database, spans: { from: number; to: number }[]): DaemonFacts {
  if (!spans.length) return { restarts: [], stalls: [] };
  const lo = Math.min(...spans.map((s) => s.from)), hi = Math.max(...spans.map((s) => s.to));
  const touches = (a: number, b: number) => spans.some((s) => a <= s.to && b >= s.from);
  const restarts = !has(db, "daemon_starts") ? [] : db
    .query<{ data: string }, [number, number]>("SELECT data FROM daemon_starts WHERE up_ms >= ? AND up_ms <= ? ORDER BY up_ms").all(lo, hi + 7 * 86_400_000)
    .map((r) => JSON.parse(r.data) as Restart)
    // A first start, or one that knows nothing of the daemon before it, is told by its own time.
    .filter((r) => touches(r.before?.down_ms ?? r.up_ms, r.up_ms));
  const stalls = !has(db, "daemon_stalls") ? [] : db
    .query<StallFact, [number, number]>("SELECT ts_ms, ms, what, kind FROM daemon_stalls WHERE ts_ms >= ? AND ts_ms <= ? ORDER BY ts_ms").all(lo, hi)
    .filter((s) => touches(s.ts_ms, s.ts_ms));
  return { restarts, stalls };
}
