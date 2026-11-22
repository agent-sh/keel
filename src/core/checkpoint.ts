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
//
// What bounds the log. A passive pass copies what was in the log when it
// began; the log starts again only when a write finds all of it copied, so
// only when the writer paused for as long as a pass takes. With a few
// sessions that happens every AT pages or so and the file stays near 16 MB.
// With a writer that never pauses (twelve working sessions) it does not: the
// log grows to FAR pages (64 MB), where the daemon's connection runs its own
// checkpoint, in the commit, on the loop, as SQLite always did, about once
// per FAR pages instead of once per 1,000. The thread has copied nearly all
// of it by then, so that checkpoint is short unless the disk is too busy for
// the thread to keep up. After it the file is cut back to AT pages.
//
// Besides that checkpoint one sync stays on the loop: when the log starts
// again, SQLite syncs the log's new header in the write that starts it
// (without it a power cut could leave old frames under a new header).
//
// What a write keeps. A committed write (an accepted prompt, an approval
// answer, an event) is in the log when the call returns: it survives the
// daemon's death at once, as before. It survives a power cut once the log is
// synced: by the thread within about a second of the write (a second and a
// checkpoint pass when one is running), where before it was at the next
// checkpoint, up to 1,000 pages of writes later. No sync is left out: the
// thread's connection syncs the log before it copies and the database after,
// as the daemon's own did. Where the thread cannot run, or stops answering,
// SQLite checkpoints and syncs in the commit, as before.
import { readSync } from "node:fs";
import { endianness } from "node:os";
import type { Database } from "bun:sqlite";
import { storeFd, storePath } from "./store-files.ts";

declare const __KEEL_CHECKPOINT_JS__: string | undefined;

// SQLite's own distance between checkpoints, in pages of the log.
export const NEAR = 1_000;
// The thread's distance: 16 MB of log at the default page size. The log
// starts again at most once in that many pages, and each start is the one
// sync the loop still makes, so further is better for the loop; the log's
// sync no longer waits for the checkpoint, so nothing is given up for it.
export const AT = 4 * NEAR;
// The daemon's own checkpoint while the thread works, and so the most the
// log holds: 64 MB. Twelve working sessions write that in ten seconds to a
// minute; further out the loop's checkpoint would be rarer, and a start
// after a crash would have more to read back.
export const FAR = 16 * NEAR;
const TICK_MS = 1_000;
// How long the thread stays after its last checkpoint.
const IDLE_MS = 60_000;
// Passes in a row while frames written during a pass still wait.
const PASSES = 4;
// A request with no answer after this long is over: the thread is taken to be
// stuck and SQLite's own checkpoints take over. A pass is two syncs and the
// copy; a sync was seen to take up to three seconds on a saturated disk, so a
// minute is past anything a working thread needs.
const DEADLINE_MS = 60_000;

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
  private due?: ReturnType<typeof setTimeout>;
  // The thread has checkpointed once: the daemon's connection leaves the near checkpoints to it.
  private proved = false;
  private off = false;
  private changes = -1;
  private buf = Buffer.alloc(100);
  // What was asked of the thread and how it ended (tests read it).
  readonly counts = { asked: 0, done: 0, synced: 0, checkpoints: 0, failed: 0 };
  last?: { passes: number; log: number; checkpointed: number };
  // The log file's size limit the store set and the one set here: the first
  // is put back when the thread stops, unless something else set another since.
  private limit?: number;
  private raised?: number;

  constructor(private store: { db: Database; stateDir: string }, private onError: (e: unknown) => void = () => {}, private workerProgram?: string, private tickMs = TICK_MS, private deadlineMs = DEADLINE_MS) {}

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
    this.own(false);
    this.proved = false;
  }

  // Whose checkpoints bound the log: the thread's (the connection's own far
  // out, the log file kept at the thread's distance so it is written over,
  // not cut and grown again each time), or the connection's as SQLite does.
  private own(thread: boolean) {
    const db = this.store.db;
    try {
      const limit = () => db.query<{ journal_size_limit: number }, []>("PRAGMA journal_size_limit").get()!.journal_size_limit;
      if (thread) {
        this.limit = limit();
        const page = db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
        this.raised = Math.max(this.limit, AT * (page + 24));
        db.exec(`PRAGMA wal_autocheckpoint = ${FAR}; PRAGMA journal_size_limit = ${this.raised}`);
      } else {
        db.exec(`PRAGMA wal_autocheckpoint = ${NEAR}`);
        if (this.limit !== undefined && limit() === this.raised) db.exec(`PRAGMA journal_size_limit = ${this.limit}`);
        this.limit = this.raised = undefined;
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
    // The index's descriptor is the process's kept one: never closed, and never one of this object's own (store-files.ts).
    let shm: number;
    try { shm = storeFd(`${storePath(this.store.stateDir)}-shm`); } catch { return undefined; }
    return framesWaiting(shm, this.buf);
  }

  // `checkpoint` false: the log is synced only.
  private ask(checkpoint: boolean) {
    const w = this.thread();
    if (!w) return;
    this.busy = true;
    this.counts.asked++;
    clearTimeout(this.idle);
    clearTimeout(this.due);
    this.due = setTimeout(() => this.failed(w, new Error(`the checkpoint thread did not answer in ${Math.round(this.deadlineMs / 1000)} s`)), this.deadlineMs);
    this.due.unref?.();
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
      clearTimeout(this.due);
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
    w.postMessage({ open: storePath(this.store.stateDir) });
    return (this.worker = w);
  }

  // The thread is ended while it has nothing to do (the next checkpoint starts another).
  private end() {
    const w = this.worker;
    this.worker = undefined;
    this.busy = false;
    clearTimeout(this.due);
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
