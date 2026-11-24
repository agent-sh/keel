// What the daemon itself went through in a stretch of time: its starts (each
// with how the one before it ended and the turns that cut) and the stalls of
// its loop. Read for the away digest, which tells of them before the
// sessions. Starts are the restart records (life.ts); stalls are kept here,
// one row each, because the Errors list keeps one row a cause and the
// daemon's own list is only of its present process.
import type { Database } from "bun:sqlite";
import type { Restart } from "./life-rows.ts";
import { STALL_MS } from "./stall.ts";

export type StallFact = { ts_ms: number; ms: number; what: string; kind: string };
// A provider that could not be reached (src/providers/outage.ts), from its two Activity rows:
// when it began, how long it lasted (null: it still goes on), how many sessions' turns waited in
// it, and whether they went on when it answered (null while it goes on).
export type OutageFact = { provider: string; label: string; since: number; ms: number | null; sessions: number; answered: boolean | null };
export type DaemonFacts = { restarts: Restart[]; stalls: StallFact[]; outages?: OutageFact[] };

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
    // A start that knows nothing of a daemon before it and found no turn cut (a first start) went through nothing: it is not told.
    // One that found cut turns without knowing how the daemon before it ended is told by its own time.
    .filter((r) => (r.before || r.turns.length > 0) && touches(r.before?.down_ms ?? r.up_ms, r.up_ms));
  const stalls = !has(db, "daemon_stalls") ? [] : db
    .query<StallFact, [number, number, number]>("SELECT ts_ms, ms, what, kind FROM daemon_stalls WHERE ts_ms >= ? AND ts_ms <= ? AND ms >= ? ORDER BY ts_ms").all(lo, hi, STALL_MS)
    .filter((s) => touches(s.ts_ms, s.ts_ms));
  return { restarts, stalls, outages: outageFacts(db, lo, hi, touches) };
}

// The outages that touch the spans: begun in them, or begun before and still going in them.
function outageFacts(db: Database, lo: number, hi: number, touches: (a: number, b: number) => boolean): OutageFact[] {
  if (!has(db, "activity")) return [];
  type Row = { text: string; data: string };
  // An outage longer than a day is still told by the day it began in (the read is bounded by it).
  const began = db.query<Row, [number, number]>("SELECT text, data FROM activity WHERE kind = 'daemon' AND sub = 'outage' AND ts >= ? AND ts <= ? ORDER BY ts").all(lo - 86_400_000, hi);
  if (!began.length) return [];
  const over = new Map<string, { ms: number; answered: boolean }>();
  for (const r of db.query<Row, [number]>("SELECT text, data FROM activity WHERE kind = 'daemon' AND sub = 'outage_over' AND ts >= ? ORDER BY ts").all(lo - 86_400_000)) {
    const d = JSON.parse(r.data) as { provider: string; since: number; ms: number; answered: boolean };
    over.set(`${d.provider}:${d.since}`, { ms: d.ms, answered: !!d.answered });
  }
  const now = Date.now();
  return began.flatMap((r) => {
    const d = JSON.parse(r.data) as { provider: string; since: number; sessions?: number };
    const end = over.get(`${d.provider}:${d.since}`);
    if (!touches(d.since, end ? d.since + end.ms : now)) return [];
    // The row's text names the provider as the page shows it ("Bedrock cannot be reached since ...").
    const label = r.text.split(" cannot be reached")[0] || d.provider;
    return [{ provider: d.provider, label, since: d.since, ms: end?.ms ?? null, sessions: d.sessions ?? 0, answered: end ? end.answered : null }];
  });
}

// The starts before this one, the newest first, each with the stalls of its own life (from its start
// to the next one's), as the Daemon page lists them. `now`: this start's record (it is not among them).
export type EarlierStart = { start: Restart; stalls: StallFact[]; down_ms?: number };
export function earlierStarts(db: Database, now: Restart, n = 9): EarlierStart[] {
  if (!has(db, "daemon_starts")) return [];
  const rows = db.query<{ data: string }, [number, number]>("SELECT data FROM daemon_starts WHERE up_ms < ? ORDER BY up_ms DESC LIMIT ?").all(now.up_ms, n).map((r) => JSON.parse(r.data) as Restart);
  const stalls = has(db, "daemon_stalls");
  return rows.map((start, i) => {
    // Its life ended where the start after it says the daemon went down, else when that start came up.
    const next = i === 0 ? now : rows[i - 1]!;
    const end = next.before?.down_ms ?? next.up_ms;
    const own = stalls ? db.query<StallFact, [number, number, number]>("SELECT ts_ms, ms, what, kind FROM daemon_stalls WHERE ts_ms >= ? AND ts_ms <= ? AND ms >= ? ORDER BY ts_ms DESC").all(start.up_ms, Math.max(start.up_ms, end), STALL_MS) : [];
    return { start, stalls: own, ...(next.before?.down_ms ? { down_ms: next.before.down_ms } : {}) };
  });
}

// The stalls of each start's life, newest start first: how many the loop had (every stall from STALL_KEEP_MS
// up), how many of them reached the Errors bar, the longest and the time they add up to. A start's life
// runs to the next start's record of when the daemon before it went down, else to when that start came up;
// the newest one's to `now`.
export type StartStalls = { id: string; pid: number; up_ms: number; end_ms: number; stalls: number; over_bar: number; longest_ms: number; total_ms: number };
export function stallsPerStart(db: Database, now: number, n = 8): StartStalls[] {
  if (!has(db, "daemon_starts")) return [];
  const rows = db.query<{ data: string }, [number]>("SELECT data FROM daemon_starts ORDER BY up_ms DESC LIMIT ?").all(n).map((r) => JSON.parse(r.data) as Restart);
  const stalls = has(db, "daemon_stalls");
  return rows.map((start, i) => {
    const end = i === 0 ? now : rows[i - 1]!.before?.down_ms ?? rows[i - 1]!.up_ms;
    const sum = stalls
      ? db.query<{ n: number; over: number | null; longest: number | null; total: number | null }, [number, number, number]>("SELECT COUNT(*) AS n, SUM(ms >= ?) AS over, MAX(ms) AS longest, SUM(ms) AS total FROM daemon_stalls WHERE ts_ms >= ? AND ts_ms <= ?").get(STALL_MS, start.up_ms, Math.max(start.up_ms, end))
      : null;
    return { id: start.id, pid: start.pid, up_ms: start.up_ms, end_ms: end, stalls: sum?.n ?? 0, over_bar: sum?.over ?? 0, longest_ms: sum?.longest ?? 0, total_ms: sum?.total ?? 0 };
  });
}
