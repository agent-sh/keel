// The outward ledger's table and its reports (src/safety/egress.ts writes the
// rows). The day's report reads every row of the day: it runs on the read
// thread (src/server/read-tasks.ts), so this file imports nothing of the daemon.
import type { Database } from "bun:sqlite";

export const EGRESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS egress (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT,
  turn_event TEXT,
  call_id TEXT,
  tool TEXT NOT NULL,
  via TEXT,
  host TEXT NOT NULL,
  port INTEGER,
  bytes_out INTEGER,
  outcome TEXT NOT NULL,
  status INTEGER,
  why TEXT,
  -- The link before this row in its session's chain (src/core/seal.ts).
  prev BLOB
);
-- A day's rows; a turn's rows within its time (the receipt).
CREATE INDEX IF NOT EXISTS egress_ts ON egress(ts);
-- When a host was first seen.
CREATE INDEX IF NOT EXISTS egress_host ON egress(host, ts);
`;

export type EgressAsk = { since: number; until?: number; session?: string; recent?: number };
export type HostRow = { host: string; ports: string; rows: number; bytes: number; unknown_bytes: number; refused: number; failed: number; sessions: number; tools: string; first: number; last: number; new: boolean };
export type SessionRow = { session_id: string | null; title: string | null; parent_id: string | null; rows: number; bytes: number; refused: number; hosts: string };
export type PairRow = { host: string; session_id: string | null; rows: number; bytes: number; refused: number; tools: string };
export type RecentRow = { ts: number; session_id: string | null; call_id: string | null; tool: string; via: string | null; host: string; port: number | null; bytes_out: number | null; outcome: string; status: number | null; why: string | null };

const LIMIT = 500;

// What left between `since` and `until` (now), by host and by session, and the latest rows.
// A host is new when it has no row before `since`.
export function egressReport(db: Database, a: EgressAsk) {
  const until = a.until ?? Date.now() + 60_000;
  const where = `ts >= ? AND ts < ?${a.session ? " AND session_id = ?" : ""}`;
  const args: (string | number)[] = a.session ? [a.since, until, a.session] : [a.since, until];
  const hosts = db.query<Omit<HostRow, "new"> & { before: number | null }, (string | number)[]>(
    `SELECT host, GROUP_CONCAT(DISTINCT port) AS ports, COUNT(*) AS rows, COALESCE(SUM(bytes_out), 0) AS bytes,
            SUM(bytes_out IS NULL AND outcome = 'sent') AS unknown_bytes, SUM(outcome = 'refused') AS refused, SUM(outcome = 'failed') AS failed,
            COUNT(DISTINCT session_id) AS sessions, GROUP_CONCAT(DISTINCT tool) AS tools, MIN(ts) AS first, MAX(ts) AS last,
            (SELECT MIN(b.ts) FROM egress b WHERE b.host = egress.host AND b.ts < ?) AS before
       FROM egress WHERE ${where} GROUP BY host ORDER BY bytes DESC, rows DESC LIMIT ${LIMIT}`).all(a.since, ...args)
    .map(({ before, ...h }) => ({ ...h, ports: h.ports ?? "", tools: h.tools ?? "", new: before === null }));
  const agents = hasTable(db, "agents");
  const sessions = db.query<SessionRow, (string | number)[]>(
    `SELECT e.session_id, s.title, ${agents ? "(SELECT a.parent_id FROM agents a WHERE a.session_id = e.session_id LIMIT 1)" : "NULL"} AS parent_id,
            COUNT(*) AS rows, COALESCE(SUM(e.bytes_out), 0) AS bytes, SUM(e.outcome = 'refused') AS refused, GROUP_CONCAT(DISTINCT e.host) AS hosts
       FROM egress e LEFT JOIN sessions s ON s.id = e.session_id WHERE ${where.replace(/\b(ts|session_id)\b/g, "e.$1")} GROUP BY e.session_id ORDER BY bytes DESC, rows DESC LIMIT ${LIMIT}`).all(...args)
    .map((s) => ({ ...s, hosts: s.hosts ?? "" }));
  const pairs = db.query<PairRow, (string | number)[]>(
    `SELECT host, session_id, COUNT(*) AS rows, COALESCE(SUM(bytes_out), 0) AS bytes, SUM(outcome = 'refused') AS refused, GROUP_CONCAT(DISTINCT tool) AS tools
       FROM egress WHERE ${where} GROUP BY host, session_id ORDER BY bytes DESC LIMIT ${LIMIT * 4}`).all(...args)
    .map((p) => ({ ...p, tools: p.tools ?? "" }));
  const recent = db.query<RecentRow, (string | number)[]>(
    `SELECT ts, session_id, call_id, tool, via, host, port, bytes_out, outcome, status, why FROM egress WHERE ${where} ORDER BY ts DESC, id DESC LIMIT ${Math.min(a.recent ?? 100, LIMIT)}`).all(...args);
  const totals = db.query<{ rows: number; bytes: number; refused: number; hosts: number; sessions: number }, (string | number)[]>(
    `SELECT COUNT(*) AS rows, COALESCE(SUM(bytes_out), 0) AS bytes, COALESCE(SUM(outcome = 'refused'), 0) AS refused, COUNT(DISTINCT host) AS hosts, COUNT(DISTINCT session_id) AS sessions FROM egress WHERE ${where}`).get(...args)!;
  return { since: a.since, until: a.until ?? null, totals: { ...totals, new_hosts: hosts.filter((h) => h.new).length }, hosts, sessions, pairs, recent };
}
export type EgressReport = ReturnType<typeof egressReport>;

// The hosts one turn's transfers went to (its receipt), read by the turn's time on the day index.
export function turnHosts(db: Database, a: { session: string; turn: string; from: number; to: number }) {
  if (!hasTable(db, "egress")) return [];
  return db.query<{ host: string; ports: string | null; rows: number; bytes: number; refused: number; tools: string | null }, [number, number, string, string]>(
    `SELECT host, GROUP_CONCAT(DISTINCT port) AS ports, COUNT(*) AS rows, COALESCE(SUM(bytes_out), 0) AS bytes, SUM(outcome = 'refused') AS refused, GROUP_CONCAT(DISTINCT tool) AS tools
       FROM egress WHERE ts >= ? AND ts <= ? AND session_id = ? AND turn_event = ? GROUP BY host ORDER BY bytes DESC LIMIT 50`).all(a.from, a.to, a.session, a.turn)
    .map((h) => ({ ...h, ports: h.ports ?? "", tools: h.tools ?? "" }));
}

const tables = new WeakMap<Database, Set<string>>();
function hasTable(db: Database, name: string): boolean {
  const seen = tables.get(db) ?? new Set<string>();
  tables.set(db, seen);
  if (seen.has(name)) return true;
  const there = !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  if (there) seen.add(name);
  return there;
}
