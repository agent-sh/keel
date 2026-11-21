// The events a turn is made of (its start, its end, its compactions, its error
// event), in an index by kind: the turn before or after a point, or a
// session's newest turn, is one seek, however many other events (notes, the
// model's replies, tool results) lie between. Read by the timeline and by the
// tracer; each makes the index when it starts.
import type { Store } from "../core/store.ts";

export const TURN = "kind IN ('turn_start', 'turn_end', 'compaction', 'error')";
export const TURN_IX = "events_turn_marks";
export const TURN_SCHEMA = `CREATE INDEX IF NOT EXISTS ${TURN_IX} ON events(session_id, kind, ts, id) WHERE ${TURN};`;

const made = new WeakSet<Store>();
export function turnMarks(store: Store) {
  if (made.has(store)) return;
  store.migrate(TURN_SCHEMA);
  made.add(store);
}

// A session's newest turn: its turn_start event.
export function newestTurn(store: Store, sessionId: string): { id: string; ts: number; seq: number } | null {
  turnMarks(store);
  return store.db.query<{ id: string; ts: number; seq: number }, [string]>(
    `SELECT id, ts, seq FROM events INDEXED BY ${TURN_IX} WHERE session_id = ? AND ${TURN} AND kind = 'turn_start' ORDER BY ts DESC, id DESC LIMIT 1`).get(sessionId);
}
