// The fill thread: a connection of its own to the daemon's database that
// fills a search index made again (search-index.ts) from the events, in
// steps short enough that the daemon's writes wait little for the lock, with
// a pause between them twice as long as the step: the daemon's own writes
// find the lock free two thirds of the time. When the index is whole it drops
// the old one. Each step is recorded with what it filled, so a daemon killed
// part way goes on from there at its next start.
import { Database } from "bun:sqlite";
import { dropOld, fillOne, fillStep, nextRows, passBelow } from "./search-index.ts";

declare var self: Worker;

// The time one step holds the write lock for, about (its size follows what the last one took).
const STEP_MS = 10;

const busy = (e: unknown) => /database is locked|SQLITE_BUSY/i.test(String((e as Error)?.message ?? e)) || (e as { code?: string })?.code?.startsWith?.("SQLITE_BUSY") === true;

// The lock was not had in time (the daemon holds it for long at its start, a backup's snapshot):
// the same work again, later.
async function held<T>(f: () => T): Promise<T> {
  for (;;) {
    try { return f(); } catch (e) { if (!busy(e)) throw e; }
    await Bun.sleep(500);
  }
}

// Two seconds with no commit of another connection (PRAGMA data_version), or ten minutes at most.
const QUIET_MS = 2_000;
const QUIET_MOST_MS = 10 * 60_000;
async function quiet(db: Database) {
  const version = () => db.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version;
  const end = performance.now() + QUIET_MOST_MS;
  for (let v = version(); performance.now() < end; ) {
    await Bun.sleep(QUIET_MS);
    const now = version();
    if (now === v) return;
    v = now;
  }
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data as { open: string; stepMs?: number };
  const target = m.stepMs ?? STEP_MS;
  let db: Database | undefined;
  try {
    db = new Database(m.open);
    db.exec("PRAGMA busy_timeout = 5000");
    // The log is the checkpoint thread's to copy back (src/core/checkpoint.ts): a commit of this
    // connection that did it would hold the write lock for as long as the copy and its sync take
    // (seconds on a store just written).
    db.exec("PRAGMA wal_autocheckpoint = 0");
    let batch = 100;
    let filled = 0;
    for (;;) {
      const t = performance.now();
      const r = await held(() => {
        try {
          return fillStep(db!, batch);
        } catch (e) {
          if (busy(e)) throw e;
          // An event of the step could not be read (its body is not JSON): the step is made one event at a time, and that one is left out.
          const rows = nextRows(db!, batch);
          for (const rowid of rows) if (!fillOne(db!, rowid)) postMessage({ failed: rowid, message: e instanceof Error ? e.message : String(e) });
          if (rows.length) passBelow(db!, rows.at(-1)!);
          return { events: rows.length, left: rows.length ? 1 : 0, held_ms: 0 };
        }
      });
      filled += r.events;
      const left = r.left;
      // (What the step took with the lock held sizes the next one; a wait for the lock does not.)
      const ms = r.held_ms || performance.now() - t;
      postMessage({ progress: filled, ms });
      if (!left) break;
      batch = Math.max(10, Math.min(5000, Math.round(batch * Math.min(2, target / Math.max(1, ms)))));
      await Bun.sleep(Math.max(10, 2 * ms));
    }
    // Dropping the old index holds the lock for as long as SQLite takes to free its pages (half a
    // second for 700 MB): it waits for a moment when nothing else has written for a while.
    if (db.query("SELECT 1 FROM sqlite_master WHERE name = 'search_idx'").get()) await quiet(db);
    const t = performance.now();
    await held(() => dropOld(db!));
    postMessage({ done: filled, drop_ms: Math.round(performance.now() - t) });
  } catch (e) {
    postMessage({ error: e instanceof Error ? { message: e.message, stack: e.stack } : { message: String(e) } });
  } finally {
    try { db?.close(); } catch {}
  }
};
