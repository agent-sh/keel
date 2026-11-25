// A port range for each session whose commands share the host's loopback (the sandbox is off), so ten agents that
// each start a dev server do not meet on one port. KEEL_PORT is the first of ten, and the session keeps it across
// restarts (a row of its own, in the store). Two sessions that exist never hold the same range; the range of a
// deleted session is free again, and when every range is taken the oldest archived session's is reused. Below the
// kernel's range for outgoing connections (32768), so a free port of a range is not taken by an outgoing connection.
import type { Database } from "bun:sqlite";

export const RANGE_FROM = 20000;
export const RANGE_SIZE = 10;
export const RANGE_END = 32760; // the last range ends below the ephemeral ports

export const SCHEMA = `CREATE TABLE IF NOT EXISTS session_ports (session_id TEXT PRIMARY KEY, base INTEGER NOT NULL UNIQUE, ts INTEGER NOT NULL)`;

// The first base no one holds, from `from` up in steps of the range size; null when all are taken.
export function firstFree(held: ReadonlySet<number>, from = RANGE_FROM, end = RANGE_END, size = RANGE_SIZE): number | null {
  for (let b = from; b + size <= end; b += size) if (!held.has(b)) return b;
  return null;
}

// The session's range, given at its first call: the first of its ten ports. null: no range is left to give.
export function rangeOf(db: Database, sessionId: string, now = Date.now()): number | null {
  const mine = db.query<{ base: number }, [string]>("SELECT base FROM session_ports WHERE session_id = ?").get(sessionId);
  if (mine) return mine.base;
  // A deleted session's range is free again.
  db.query("DELETE FROM session_ports WHERE session_id NOT IN (SELECT id FROM sessions)").run();
  const held = new Set(db.query<{ base: number }, []>("SELECT base FROM session_ports").all().map((r) => r.base));
  let base = firstFree(held);
  if (base === null) {
    // Every range is held: the oldest archived session's is taken over (it runs nothing).
    const old = db.query<{ session_id: string; base: number }, []>(
      "SELECT p.session_id, p.base FROM session_ports p JOIN sessions s ON s.id = p.session_id WHERE s.archived = 1 ORDER BY s.updated ASC LIMIT 1").get();
    if (!old) return null;
    db.query("DELETE FROM session_ports WHERE session_id = ?").run(old.session_id);
    base = old.base;
  }
  db.query("INSERT INTO session_ports (session_id, base, ts) VALUES (?, ?, ?)").run(sessionId, base, now);
  return base;
}

// The session that holds the range a port is in, if it still exists.
export function holderOf(db: Database, port: number): { session_id: string; base: number } | null {
  const base = RANGE_FROM + Math.floor((port - RANGE_FROM) / RANGE_SIZE) * RANGE_SIZE;
  if (port < RANGE_FROM || base + RANGE_SIZE > RANGE_END) return null;
  return db.query<{ session_id: string; base: number }, [number]>(
    "SELECT p.session_id, p.base FROM session_ports p JOIN sessions s ON s.id = p.session_id WHERE p.base = ?").get(base) ?? null;
}

// What a session's command gets: KEEL_PORT (the first port) and KEEL_PORT_END (the last), in one place for every tool.
export function portEnv(base: number | null): Record<string, string> {
  return base === null ? {} : { KEEL_PORT: String(base), KEEL_PORT_END: String(base + RANGE_SIZE - 1) };
}
