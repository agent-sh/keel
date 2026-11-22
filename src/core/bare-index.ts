// The index of the events' rows without their bodies (events_bare): what a
// session's events are read from when their bodies are not wanted. A store
// from before it gets it built once, after the daemon listens (a build
// reads every event's body off the disk, minutes on a large store with a
// cold cache: src/server/index-build.ts). Until then a statement must not
// name the index: it is read without it, from the table, more slowly.
import type { Database } from "bun:sqlite";

export const BARE_INDEX = "events_bare";
export const BARE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${BARE_INDEX} ON events(session_id, seq, id, parent, kind, ts)`;
// A store with at most this many events has the index built as it is opened: a moment's work.
export const INDEX_NOW_ROWS = 20_000;

const there = new WeakSet<Database>();
export function hasBareIndex(db: Database): boolean {
  if (there.has(db)) return true;
  if (!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = '${BARE_INDEX}'`).get()) return false;
  there.add(db);
  return true;
}
// What a statement over `events` puts after the table's name to be answered from the index: nothing while the index is not there.
export const bareBy = (db: Database): string => (hasBareIndex(db) ? `INDEXED BY ${BARE_INDEX}` : "");
