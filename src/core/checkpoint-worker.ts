// The checkpoint thread (checkpoint.ts): it syncs the write-ahead log, and
// with a connection of its own to the daemon's database copies the log into
// it. A passive checkpoint takes no write lock and waits for no one, so the
// daemon's connection never waits for this one; the syncs (the log, and
// after a copy the database) are this thread's to wait for.
import { Database } from "bun:sqlite";
import { fsyncSync } from "node:fs";
import { storeFd } from "./store-files.ts";

declare var self: Worker;

let db: Database | undefined;
let path = "";

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data as { open: string } | { id: number; passes: number };
  try {
    if ("open" in m) {
      path = m.open;
      db = new Database(m.open);
      // Synced as the daemon's own checkpoints were; this connection never
      // checkpoints by itself and never waits for a lock.
      db.exec("PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 0; PRAGMA busy_timeout = 0");
      return;
    }
    if (!db) throw new Error("the checkpoint thread has no database");
    if (!m.passes) {
      // No log file: nothing was written since the database was last closed.
      // The log's descriptor is kept for the life of the process and never closed (store-files.ts).
      try { fsyncSync(storeFd(`${path}-wal`)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      postMessage({ id: m.id, passes: 0 });
      return;
    }
    // A checkpoint syncs the log itself before it copies. Frames written
    // while a pass ran wait for the next: a few passes in a row end with none
    // waiting when the writer pauses that long.
    let r = { busy: 0, log: 0, checkpointed: 0 };
    let n = 0;
    do {
      r = db.query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(PASSIVE)").get()!;
      n++;
    } while (n < m.passes && r.log > r.checkpointed);
    postMessage({ id: m.id, passes: n, log: r.log, checkpointed: r.checkpointed, busy: r.busy });
  } catch (e) {
    postMessage({ id: "id" in m ? m.id : 0, error: e instanceof Error ? e.message : String(e) });
  }
};
