// The fill thread: a connection of its own to the daemon's database that
// fills a search index made again (search-index.ts) from the events, and then
// removes the old index, in steps short enough that the daemon's writes wait
// little for the lock, with a pause between them twice as long as the step:
// the daemon's own writes find the lock free two thirds of the time. Each
// step is recorded with what it did, so a daemon killed part way goes on from
// there at its next start.
import { Database } from "bun:sqlite";
import { logIndex } from "../../core/checkpoint-shared.ts";
import { SOFT } from "../../core/checkpoint.ts";
import { storeFd } from "../../core/store-files.ts";
import { dropStep, fillOne, fillStep, nextRows, passBelow } from "./search-index.ts";

declare var self: Worker;

// The time one step holds the write lock for, about: each step is sized from what the last one took.
const STEP_MS = 10;
// What the first step of the fill reads of the events' bodies, and the bounds of a step.
const FIRST_BYTES = 64 * 1024, LEAST_BYTES = 4 * 1024, MOST_BYTES = 8 * 1024 * 1024;
// And the first step of removing the old index, in rows (each is read again to remove its words),
// and the most: on a store of a gigabyte a step of 800 rows took 60 ms now and then (the merge of
// what the deletes wrote), where steps of a few hundred stayed near the target.
const FIRST_ROWS = 100, MOST_ROWS = 300;

const busy = (e: unknown) => /database is locked|SQLITE_BUSY/i.test(String((e as Error)?.message ?? e)) || (e as { code?: string })?.code?.startsWith?.("SQLITE_BUSY") === true;

// The lock was not had in time (a write of the daemon's that is long, a backup's snapshot): the
// same work again, later.
async function held<T>(f: () => T): Promise<T> {
  for (;;) {
    try { return f(); } catch (e) { if (!busy(e)) throw e; }
    await Bun.sleep(500);
  }
}

// The log is copied back and started again by the checkpoint thread (src/core/checkpoint.ts),
// which keeps it near its bound while the daemon writes as it does. The fill writes far faster:
// before a step it waits while the log is past the length from which that thread starts it again
// (SOFT), so the thread has a moment to do it. It waits a few seconds at most: where no thread
// works, the daemon's own connection checkpoints at its next commit.
const LOG_WAIT_MS = 3_000;
async function logRoom(shm: string) {
  const end = performance.now() + LOG_WAIT_MS;
  for (;;) {
    let frames = 0;
    try { frames = logIndex(storeFd(shm))?.frames ?? 0; } catch { return; }
    if (frames < SOFT || performance.now() >= end) return;
    await Bun.sleep(50);
  }
}

// The size of the next step from what the last took: toward STEP_MS, at most twice the last.
const next = (size: number, ms: number, least: number, most: number) => Math.max(least, Math.min(most, Math.round(size * Math.min(2, STEP_MS / Math.max(0.5, ms)))));

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data as { open: string };
  let db: Database | undefined;
  try {
    db = new Database(m.open);
    // As the daemon's own connection (src/core/store.ts): its commits are synced as the daemon's are.
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL");
    // The log is the checkpoint thread's to copy back: a commit of this connection that did it
    // would hold the write lock for as long as the copy and its sync take (seconds on a store
    // just written).
    db.exec("PRAGMA wal_autocheckpoint = 0");
    const shm = `${m.open}-shm`;
    let bytes = FIRST_BYTES;
    let filled = 0;
    for (;;) {
      await logRoom(shm);
      const t = performance.now();
      const r = await held(() => {
        try {
          return fillStep(db!, bytes);
        } catch (e) {
          if (busy(e)) throw e;
          // An event of the step could not be read (its body is not JSON): the step is made one event at a time, and that one is left out.
          const rows = nextRows(db!, 50);
          for (const rowid of rows) if (!fillOne(db!, rowid)) postMessage({ failed: rowid, message: e instanceof Error ? e.message : String(e) });
          if (rows.length) passBelow(db!, rows.at(-1)!);
          return { events: rows.length, left: rows.length ? 1 : 0, held_ms: 0 };
        }
      });
      filled += r.events;
      // (What the step took with the lock held sizes the next one; a wait for the lock does not.)
      const ms = r.held_ms || performance.now() - t;
      postMessage({ progress: filled, ms });
      if (process.env.KEEL_TRACE_FILL && ms > 50) console.error(`[fill] a step of ${bytes} bytes, ${r.events} events: ${ms.toFixed(0)} ms`);
      if (!r.left) break;
      bytes = next(bytes, ms, LEAST_BYTES, MOST_BYTES);
      await Bun.sleep(Math.max(10, 2 * ms));
    }
    // The old index, if there is one, is removed the same way.
    const t = performance.now();
    let rows = FIRST_ROWS;
    for (;;) {
      await logRoom(shm);
      const r = await held(() => dropStep(db!, rows));
      postMessage({ dropping: r.rows, ms: r.held_ms });
      if (process.env.KEEL_TRACE_FILL && r.held_ms > 50) console.error(`[fill] a step removing ${rows} rows of the old index: ${r.held_ms.toFixed(0)} ms`);
      if (!r.left) break;
      rows = next(rows, r.held_ms, 10, MOST_ROWS);
      await Bun.sleep(Math.max(10, 2 * r.held_ms));
    }
    postMessage({ done: filled, drop_ms: Math.round(performance.now() - t) });
  } catch (e) {
    postMessage({ error: e instanceof Error ? { message: e.message, stack: e.stack } : { message: String(e) } });
  } finally {
    try { db?.close(); } catch {}
  }
};
