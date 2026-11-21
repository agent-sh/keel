// The write-ahead log is synced and checkpointed off the loop.
//
// The daemon's connection runs in WAL mode with synchronous NORMAL: a commit
// appends to the log and syncs nothing. The log is synced, copied into the
// database and the database synced at a checkpoint, and SQLite runs that
// inside the commit that brings the log to 1,000 pages. On a busy disk each
// sync takes hundreds of milliseconds, and every session's stream waits for
// the commit that hit them.
//
// Here a thread with a connection of its own does both, and the loop only
// looks, once a second and only after a write, at how many frames wait:
// - it syncs the log file, so what was committed in the last second is on
//   the disk;
// - once AT frames wait it runs the checkpoint. It is a passive one: it
//   takes no write lock and waits for no reader, so the daemon's connection
//   never waits for it.
// The daemon's connection keeps a checkpoint of its own much further out
// (FAR pages): the bound on the log when the thread cannot keep up with a
// writer that never pauses, or is gone.
//
// One sync stays on the loop: when the log starts again after a checkpoint
// that copied all of it, SQLite syncs the log's new header in the write that
// starts it (without it a power cut could leave old frames under a new
// header). That is one small sync for each AT pages written at most, where
// there were three for each 1,000, two of them over the whole log and every
// page copied.
//
// What a write keeps. A committed write (an accepted prompt, an approval
// answer, an event) is in the log when the call returns: it survives the
// daemon's death at once, as before. It survives a power cut once the log is
// synced: by the thread within about a second of the write, where before it
// was at the next checkpoint, up to 1,000 pages of writes later. No sync is
// left out: the thread's connection syncs the log before it copies and the
// database after, as the daemon's own did. Where the thread cannot run,
// SQLite checkpoints and syncs in the commit, as before.
import { closeSync, openSync, readSync } from "node:fs";
import { endianness } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

declare const __KEEL_CHECKPOINT_JS__: string | undefined;

// SQLite's own distance between checkpoints, in pages of the log.
export const NEAR = 1_000;
// The thread's distance: 16 MB of log at the default page size. The log
// starts again at most once in that many pages, and each start is the one
// sync the loop still makes, so further is better for the loop; the log's
// sync no longer waits for the checkpoint, so nothing is given up for it.
export const AT = 4 * NEAR;
// The daemon's own checkpoint while the thread works: 64 MB of log. Twelve
// working sessions write that in about a minute; below it a slow disk has
// room, above it a start after a crash would replay too much.
export const FAR = 16 * NEAR;
const TICK_MS = 1_000;
// How long the thread stays after its last checkpoint.
const IDLE_MS = 60_000;
// Passes in a row while frames written during a pass still wait.
const PASSES = 4;

let program: string | undefined;
function programUrl(): string {
  if (program) return program;
  return (program = typeof __KEEL_CHECKPOINT_JS__ === "string"
    ? URL.createObjectURL(new Blob([__KEEL_CHECKPOINT_JS__], { type: "application/javascript" }))
    : new URL("./checkpoint-worker.ts", import.meta.url).href);
}

// Frames in the log that no checkpoint has copied yet, from the two numbers
// SQLite keeps in the log's index (the -shm file, format in walformat.html:
// the newest frame at byte 16, the frames copied at byte 96, in the
// machine's byte order). Read from the page cache: no disk is touched.
export function framesWaiting(fd: number, buf = Buffer.alloc(100)): number | undefined {
  try {
    if (readSync(fd, buf, 0, 100, 0) < 100) return undefined;
    const u32 = (at: number) => (endianness() === "LE" ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
    const waiting = u32(16) - u32(96);
    return waiting >= 0 ? waiting : undefined;
  } catch {
    return undefined;
  }
}

export class Checkpointer {
  private worker?: Worker;
  private timer?: ReturnType<typeof setInterval>;
  private idle?: ReturnType<typeof setTimeout>;
  private asked = 0;
  private busy = false;
  // The thread has checkpointed once: the daemon's connection leaves the near checkpoints to it.
  private proved = false;
  private off = false;
  private shm = -1;
  private changes = -1;
  private buf = Buffer.alloc(100);
  // What was asked of the thread and how it ended (tests read it).
  readonly counts = { asked: 0, done: 0, synced: 0, checkpoints: 0, failed: 0 };
  last?: { passes: number; log: number; checkpointed: number };
  // The log file's size limit the store set, put back when the thread stops.
  private limit?: number;

  constructor(private store: { db: Database; stateDir: string }, private onError: (e: unknown) => void = () => {}, private workerProgram?: string, private tickMs = TICK_MS) {}

  // Starts the thread and asks it one checkpoint: once it answers, the
  // daemon's connection moves its own checkpoint out to FAR.
  start() {
    if (this.timer || this.off) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
    this.ask(true);
  }

  // The daemon's connection checkpoints by itself again, as SQLite does.
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    clearTimeout(this.idle);
    this.end();
    if (this.shm >= 0) { try { closeSync(this.shm); } catch {} this.shm = -1; }
    this.own(false);
    this.proved = false;
  }

  // Whose checkpoints bound the log: the thread's (the connection's own far
  // out, the log file kept at the thread's distance so it is written over,
  // not cut and grown again each time), or the connection's as SQLite does.
  private own(thread: boolean) {
    const db = this.store.db;
    try {
      if (thread) {
        this.limit ??= db.query<{ journal_size_limit: number }, []>("PRAGMA journal_size_limit").get()!.journal_size_limit;
        const page = db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
        db.exec(`PRAGMA wal_autocheckpoint = ${FAR}; PRAGMA journal_size_limit = ${Math.max(this.limit, AT * (page + 24))}`);
      } else {
        db.exec(`PRAGMA wal_autocheckpoint = ${NEAR}`);
        if (this.limit !== undefined) db.exec(`PRAGMA journal_size_limit = ${this.limit}`);
      }
    } catch (e) { this.onError(e); }
  }

  // Once a tick: nothing is read while nothing was written since the last
  // one. After a write the log is synced, and checkpointed once enough waits.
  private tick() {
    if (this.busy || this.off) return;
    const changes = this.store.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
    if (changes === this.changes) return;
    this.changes = changes;
    const waiting = this.waiting();
    this.ask(waiting === undefined || waiting >= AT);
  }

  waiting(): number | undefined {
    if (this.shm < 0) {
      try { this.shm = openSync(join(this.store.stateDir, "keel.db-shm"), "r"); } catch { return undefined; }
    }
    return framesWaiting(this.shm, this.buf);
  }

  // `checkpoint` false: the log is synced only.
  private ask(checkpoint: boolean) {
    const w = this.thread();
    if (!w) return;
    this.busy = true;
    this.counts.asked++;
    clearTimeout(this.idle);
    w.postMessage({ id: ++this.asked, passes: checkpoint ? PASSES : 0 });
  }

  private thread(): Worker | undefined {
    if (this.worker) return this.worker;
    let w: Worker;
    try {
      w = new Worker(this.workerProgram ?? programUrl());
    } catch (e) {
      this.failed(undefined, e);
      return undefined;
    }
    (w as Worker & { unref?: () => void }).unref?.();
    w.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { id: number; passes?: number; log?: number; checkpointed?: number; error?: string };
      if (this.worker !== w) return;
      if (m.error) return this.failed(w, new Error(`the checkpoint thread failed: ${m.error}`));
      this.busy = false;
      this.counts.done++;
      if (m.passes) {
        this.counts.checkpoints++;
        this.last = { passes: m.passes, log: m.log ?? 0, checkpointed: m.checkpointed ?? 0 };
        if (!this.proved) {
          this.proved = true;
          this.own(true);
        }
      } else this.counts.synced++;
      this.idle = setTimeout(() => this.end(), IDLE_MS);
      this.idle.unref?.();
    };
    w.onerror = (ev: ErrorEvent) => this.failed(w, new Error(`the checkpoint thread failed: ${ev.message}`));
    w.addEventListener("close", () => { if (this.worker === w) this.failed(w, new Error("the checkpoint thread ended")); });
    w.postMessage({ open: join(this.store.stateDir, "keel.db") });
    return (this.worker = w);
  }

  // The thread is ended while it has nothing to do (the next checkpoint starts another).
  private end() {
    const w = this.worker;
    this.worker = undefined;
    this.busy = false;
    w?.terminate();
  }

  // The thread does not work here: SQLite checkpoints in the commit from now on.
  private failed(w: Worker | undefined, e: unknown) {
    if (w && this.worker !== w) return;
    this.counts.failed++;
    this.off = true;
    clearInterval(this.timer);
    this.timer = undefined;
    clearTimeout(this.idle);
    this.end();
    this.own(false);
    this.onError(e);
  }
}
