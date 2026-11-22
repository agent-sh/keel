// The write-ahead log is synced, checkpointed and started again off the loop.
//
// The daemon's connection runs in WAL mode with synchronous NORMAL: a commit
// appends to the log and syncs nothing. Left to itself SQLite does the rest
// in whichever commit brings the log to 1,000 pages: it syncs the log,
// copies it into the database and syncs the database (a checkpoint), and the
// next write then starts the log again and syncs its new header. On a busy
// disk each of those syncs takes hundreds of milliseconds to seconds, and
// every session's stream waits for the commit that hit them.
//
// Here a thread does all of it (checkpoint-worker.ts), and the daemon's
// connection checkpoints nothing, starts no log again and syncs nothing
// while the thread works:
// - it syncs the log file about a second after a write;
// - it copies the log into the database with passive checkpoints, which
//   take no write lock and wait for no reader (c3ref/wal_checkpoint_v2.html:
//   "Checkpoint as many frames as possible without waiting for any database
//   readers or writers to finish");
// - it keeps a read transaction open, and with it a mark in the log. A
//   writer starts the log again only "if no readers are making use of the
//   WAL" (wal.html), so with the mark held the daemon's connection never
//   does, and so never syncs a header;
// - it starts the log again itself. When every frame is copied and the
//   database is synced, it takes the write lock, looks again, gives its mark
//   up and writes one row (log_starts): that write is the first frame of the
//   new log, and the header's sync is this thread's (pragma.html,
//   synchronous NORMAL: "the WAL header is synced when a WAL file begins to
//   be reused after a checkpoint").
//
// What bounds the log. A long log (SOFT frames) starts again at the first
// pass that ends with nothing waiting: a moment in which the writer paused
// for as long as a pass over the last few frames takes. Under a writer that
// never pauses there is none, and at HARD frames the thread makes one: it
// takes the write lock, copies what is left, and starts the log again. The
// daemon's writes wait for that lock meanwhile, in their own connection (a
// write of the loop is then held for as long as two syncs of a few pages and
// one of the header take; everything that could be copied and synced before
// the lock was). No mode of checkpoint spares the writer that wait: FULL,
// RESTART and TRUNCATE all "block concurrent writers while [they are]
// running" (c3ref/wal_checkpoint_v2.html), and the log cannot start again
// while frames wait. So the log holds HARD frames, plus what the daemon
// writes from the thread's look that found them until the thread has the
// write lock: one tick, one pass with its two syncs, and the wait for the
// lock. With twelve working sessions that came to 400 to 850 frames (BOUND
// is what the ten-minute runs stayed under, not a limit SQLite enforces);
// on a disk where a sync takes seconds it is seconds of the daemon's
// writes (the thread's longest look is counted: tick_most_ms), and a step
// of DEADLINE_MS ends the thread. A reader of another
// connection that stays on old frames (a long read, a backup's snapshot)
// holds all of it up for as long as it reads, as it does in SQLite itself.
//
// What the daemon's connection gives for it:
// - its transactions begin as writers (BEGIN IMMEDIATE) and it waits for
//   the write lock (busy_timeout), both set by the store: a transaction that
//   read first and wrote after another connection's commit would fail, not
//   wait (isolation.html: "the write will fail with SQLITE_BUSY_SNAPSHOT");
// - its page cache is read again after each start of the log: the pages a
//   connection keeps are dropped when another connection commits. That is
//   once per SOFT frames at most.
//
// What a write keeps. A committed write (an accepted prompt, an approval
// answer, an event) is in the log when the call returns: it survives the
// daemon's death at once. It survives a power cut once the log is synced.
// The thread syncs the log a second after its last sync of it, as soon as
// the step it is in is over: most writes are on the disk well within a
// second, one made while a pass runs waits for the pass, and every sync is
// as long as the disk makes it (seconds, on a disk that is busy). No sync
// is left out: the thread's connections sync the log before they copy, the
// database after, and the header of a log that starts again, as the
// daemon's own did.
//
// When the thread does not work. One that fails, or does not move for
// DEADLINE_MS, is ended; its mark goes with it, and SQLite checkpoints in
// the commit again, as it does where the thread cannot run at all. One that
// cannot be ended, because it is inside a sync that does not return, keeps
// its hold on the log: see `hung` for what the daemon does then.
import { statfsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { ASKED, CELL, CELLS, logIndex, type Opts, since, stamp } from "./checkpoint-shared.ts";
import { storeFd, storePath } from "./store-files.ts";

declare const __KEEL_CHECKPOINT_JS__: string | undefined;

// SQLite's own distance between checkpoints, in pages of the log.
export const NEAR = 1_000;
// Frames waiting from which the thread makes a pass: 16 MB at the default page size.
export const AT = 4 * NEAR;
// The log's length from which it starts again at the first moment nothing waits: 48 MB.
export const SOFT = 12 * NEAR;
// The length from which the thread makes that moment: 64 MB.
export const HARD = 16 * NEAR;
// What the log stays under with twelve working sessions: HARD, and what they
// write while the thread makes its last pass and takes the lock (see above).
export const BOUND = HARD + NEAR;
const TICK_MS = 200;
const SYNC_MS = 1_000;
// The thread's own wait for the write lock: a write of the daemon in flight ends in well under it.
const LOCK_MS = 20;
// How long the write lock is held for a backup's thread to begin its read.
const HOLD_MS = 25;
// A thread that has not moved for this long is taken to be stuck: it is
// ended and SQLite's own checkpoints take over. Its longest step is a sync
// of the database; one was seen to take three seconds on a saturated disk.
const DEADLINE_MS = 60_000;
// How long a stop waits for the thread to close its connections.
const CLOSE_MS = 5_000;
// A thread that is ended has gone within this long, unless it is inside a
// call that does not return (a sync on a disk that does not answer).
const GONE_MS = 2_000;
// The log past its bound for this long is said once (a row in Errors).
const LONG_MS = 10_000;
// With the thread inside a call that does not return, the log cannot be
// started again (see `hung`). At this many times HARD the daemon's
// connection stops taking writes: half a gigabyte at the default page size.
const CEILING = 8;

let program: string | undefined;
function programUrl(): string {
  if (program) return program;
  return (program = typeof __KEEL_CHECKPOINT_JS__ === "string"
    ? URL.createObjectURL(new Blob([__KEEL_CHECKPOINT_JS__], { type: "application/javascript" }))
    : new URL("./checkpoint-worker.ts", import.meta.url).href);
}

export type CheckpointCounts = { armed: boolean; passes: number; syncs: number; starts: number; forced: number; blocked: number; held_ms: number; held_most_ms: number; frames: number; waiting: number; most_frames: number; tick_most_ms: number; failed: number };

// How long a stopping daemon tries to make the writes its store owes (Store.refuse).
const OWED_STOP_MS = 3_000;

// The store as the thread's owner uses it. `refuse`: the store takes no writes, or takes them again
// (Store.refuse). `lockedOut`: set here; the store calls it when a write of its connection waited
// its whole wait for the write lock and did not get it.
type CheckpointStore = { db: Database; stateDir: string; full?: () => void; refuse?: (on: boolean, failed?: (e: unknown, what: string) => void, budgetMs?: number) => void; lockedOut?: (waitedMs: number) => boolean; pacing?: () => boolean };
// How long a write of the loop waits for the write lock the thread holds before the store stops
// taking writes: whether the thread stands still that long (a call that does not return) or moves
// (a restart of the log on a disk whose syncs take seconds). The loop waits a fifth of a second at
// a time, so it is never without an answer for five seconds.
const LOCKED_MS = 4_600;
// SQLite's words, and the system's, for a disk with no room.
const noRoom = (e: unknown) => /SQLITE_FULL|database or disk is full|ENOSPC|no space left/i.test(`${(e as { code?: string })?.code ?? ""} ${(e as Error)?.message ?? e}`);
// With the disk full, its free space is looked at this often, and writes are taken again from this much room.
const FULL_LOOK_MS = 2_000;
const FULL_ROOM_MB = 64;
// A build the thread was asked for (Checkpointer.build) is given this long before the thread is taken for stuck.
const BUILD_MAX_MS = 15 * 60_000;
// A lock the thread has held this long is one a turn holds its writes for (pacing).
const PACE_AFTER_MS = 100;
// A turn waits for a thread that moved within this long.
const PACE_STILL_MS = 30_000;
// On a slow disk the turns hold their writes from this many times SLOW_HARD (512 MB of log) until the log has started again.
const PACE_AT = 2;
// A wait of this long under the thread's lock is said (a stall's row, the daemon's word of its store, the page).
const SAID_MS = 2_000;
// And shown for this long after the last such wait.
const SLOW_SHOWN_MS = 30_000;
// While a sync of the thread's own takes over SLOW_MS the log may grow to SLOW_HARD before a start is
// forced (256 MB at the default page size; half of what a thread that cannot be ended is let reach).
const SLOW_MS = 1_000;
const SLOW_HARD = 4 * HARD;

export type StoreDisk = { full?: { since_ms: number; free_mb?: number }; silent_since_ms?: number; refusing?: boolean; slow?: { since_ms: number; sync_ms: number; held_ms: number; refusing?: boolean; building?: string } };

export class Checkpointer {
  private worker?: Worker;
  private watch?: ReturnType<typeof setInterval>;
  private cells = new Int32Array(new SharedArrayBuffer(CELLS * 4));
  private beat = { seen: -1, at: 0 };
  private off = false;
  private failures = 0;
  // The thread was ended at its deadline and has not gone yet (`ending`), or
  // is inside a call that does not return (`silent`).
  private ending?: { worker: Worker; why: Error; timer: ReturnType<typeof setTimeout> };
  private silent?: { worker: Worker; since: number; refusing: boolean; timer: ReturnType<typeof setInterval> };
  // Since when the log has been past its bound, and whether that was said.
  private long?: { since: number; said: boolean };
  private asked = new Map<number, (m: { ok?: boolean; closed?: boolean; error?: string } | undefined) => void>();
  private ids = 0;
  private opts: Omit<Opts, "page">;

  // `onError`: a failure to record, and for one that repeats with other numbers the words its repeats share.
  constructor(private store: CheckpointStore, private onError: (e: unknown, group?: string) => void = () => {}, private workerProgram?: string, opts: Partial<Omit<Opts, "page">> & { deadlineMs?: number; goneMs?: number; longMs?: number; lockedMs?: number; saidMs?: number } = {}) {
    this.opts = { tickMs: TICK_MS, syncMs: SYNC_MS, at: AT, soft: SOFT, hard: HARD, slowHard: SLOW_HARD, slowMs: SLOW_MS, lockMs: LOCK_MS, holdMs: HOLD_MS, ...opts };
    this.saidMs = opts.saidMs ?? SAID_MS;
    this.deadlineMs = opts.deadlineMs ?? DEADLINE_MS;
    this.goneMs = opts.goneMs ?? GONE_MS;
    this.longMs = opts.longMs ?? LONG_MS;
    this.lockedMs = opts.lockedMs ?? LOCKED_MS;
  }
  private lockedMs: number;
  private saidMs: number;
  private deadlineMs: number;
  private goneMs: number;
  private longMs: number;

  // What the thread did, from the numbers it shares.
  get counts(): CheckpointCounts {
    const c = (i: number) => Atomics.load(this.cells, i);
    return { armed: this.armed, passes: c(CELL.passes), syncs: c(CELL.syncs), starts: c(CELL.starts), forced: c(CELL.forced), blocked: c(CELL.blocked), held_ms: c(CELL.held_ms), held_most_ms: c(CELL.held_most), frames: c(CELL.frames), waiting: c(CELL.waiting), most_frames: c(CELL.most), tick_most_ms: c(CELL.tick_most), failed: this.failures };
  }
  // The thread works and holds its mark: the daemon's connection leaves the log to it.
  get armed(): boolean { return !!this.worker && Atomics.load(this.cells, CELL.armed) === 1; }

  start() {
    if (this.worker || this.off) return;
    this.store.lockedOut = (waited) => this.lockedOut(waited);
    this.store.pacing = () => this.pacing();
    this.store.full = () => this.fullNow();
    // (The thread has not ticked yet: its time of standing still counts from here.)
    Atomics.store(this.cells, CELL.beat_at, stamp());
    Atomics.store(this.cells, CELL.lock_at, 0);
    let w: Worker;
    try {
      w = new Worker(this.workerProgram ?? programUrl());
    } catch (e) {
      return this.failed(undefined, e);
    }
    (w as Worker & { unref?: () => void }).unref?.();
    w.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { armed: true } | { error: string; id?: undefined } | { id: number; ok?: boolean; closed?: boolean; error?: string };
      if (this.worker !== w) return;
      if ("error" in m && m.id === undefined) return this.failed(w, new Error(`the checkpoint thread failed: ${m.error}`));
      // It holds its mark: from here the daemon's connection checkpoints nothing.
      if ("armed" in m) return this.own(true);
      const done = this.asked.get(m.id);
      this.asked.delete(m.id);
      done?.(m);
    };
    w.onerror = (ev: ErrorEvent) => this.failed(w, new Error(`the checkpoint thread failed: ${ev.message}`));
    w.addEventListener("close", () => {
      // (A thread that is gone has closed its connections: whatever lock it held is given up. One that was
      // ended inside a call is not gone before the call returns, and holds its lock until then.)
      if (!this.worker || this.worker === w) { Atomics.store(this.cells, CELL.lock_at, 0); Atomics.store(this.cells, CELL.lock_soon, 0); }
      if (this.worker === w) return this.failed(w, new Error("the checkpoint thread ended"));
      // Ended at its deadline, and gone now: its mark and its locks went with it.
      if (this.ending?.worker === w) { const { why, timer } = this.ending; clearTimeout(timer); this.ending = undefined; return this.gave(why); }
      if (this.silent?.worker === w) this.back();
    });
    this.worker = w;
    this.beat = { seen: -1, at: performance.now() };
    // From here the connection checkpoints nothing: the first write of a
    // start would otherwise copy and sync the whole log the last daemon left
    // (after a kill that is all of it), on the loop, before it listens. A
    // thread that fails or never arms gives the checkpoints back (failed).
    this.own(true);
    const page = (this.page = this.store.db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size);
    w.postMessage({ open: storePath(this.store.stateDir), cells: this.cells.buffer, opts: { ...this.opts, page } });
    // The thread counts its own ticks: a count that stands still for the deadline is a thread that hangs.
    // (The last timer of its own on the loop: it joins the daemon's one pulse, which backs off while idle, when that lands: joinPulse in ./pulse.ts.)
    this.watch = setInterval(() => this.look(w), Math.max(20, Math.min(5_000, this.deadlineMs / 4)));
    this.watch.unref?.();
  }

  private look(w: Worker) {
    if (this.worker !== w) return;
    const now = performance.now(), beat = Atomics.load(this.cells, CELL.beat);
    this.lookLong(now);
    if (beat !== this.beat.seen) { this.beat = { seen: beat, at: now }; return; }
    // (A build it was asked for is one statement, however long: it is given its time.)
    if (this.building && Date.now() - this.building.since < BUILD_MAX_MS) return;
    if (now - this.beat.at >= this.deadlineMs) this.overdue(w, new Error(`the checkpoint thread did not move in ${Math.round(this.deadlineMs / 1000)} s`));
  }

  // The log's index, read here through the process's kept descriptor (the thread's own numbers stand still while it is in a long step).
  private index() {
    try { return logIndex(storeFd(`${storePath(this.store.stateDir)}-shm`)); } catch { return undefined; }
  }
  private mb = (frames: number) => Math.round((frames * (this.page + 24)) / 1_048_576);
  private page = 4096;

  // The bound of the log is not one SQLite enforces: a reader of another
  // connection (a long read, a backup) holds the log for as long as it
  // reads, and a pass is as long as the disk's syncs. A log that stays past
  // its bound is said once, with what the thread knows of why.
  private lookLong(now: number) {
    const at = this.index();
    const slow = Atomics.load(this.cells, CELL.sync_ms) >= this.opts.slowMs;
    if (!at || at.frames <= (slow ? this.opts.slowHard : this.opts.hard) + NEAR) { this.long = undefined; return; }
    this.long ??= { since: now, said: false };
    if (this.long.said || now - this.long.since < this.longMs) return;
    this.long.said = true;
    const c = this.counts;
    const inStep = Math.round((now - this.beat.at) / 1000);
    const why = at.frames === at.copied || c.blocked ? "a reader of another connection holds it (a long read, or a backup's snapshot)"
      : inStep >= 2 ? `the disk is slow (the thread has been in one step for ${inStep} s: a sync of the store's files that has not returned yet)`
      : `the disk is slow (the thread's longest step took ${(c.tick_most_ms / 1000).toFixed(1)} s)`;
    this.onError(new Error(`The store's log is ${this.mb(at.frames)} MB, past the ${this.mb(this.opts.hard)} MB it is held to, for ${Math.round((now - this.long.since) / 1000)} s: ${why}. It starts again when that is over; nothing is lost meanwhile.`), "the store's log past its bound");
  }

  // The thread did not move for the deadline. It is ended. One that idled
  // or spun has gone at once, and the checkpoints go back to the daemon's
  // connection (`gave`). One that is inside a system call cannot be ended
  // before the call returns: that is `hung`.
  private overdue(w: Worker, why: Error) {
    this.failures++;
    this.off = true;
    clearInterval(this.watch);
    this.watch = undefined;
    this.end();
    this.ending = { worker: w, why, timer: setTimeout(() => { this.ending = undefined; this.hung(w, why); }, this.goneMs) };
  }
  private gave(why: unknown) {
    this.own(false);
    this.onError(why);
  }

  // The thread is inside a call that does not return: a sync of the store's
  // files on a disk that does not answer. Its mark in the log and whatever
  // lock it holds are its connections', and those can only be closed by the
  // thread: nothing here can take them from it. So until the call returns
  // (or the daemon is restarted) no connection can start the log again, and
  // giving the checkpoints back to the daemon's connection would only put
  // the same sync on the loop. The daemon says so once, goes on writing to
  // the log, and stops taking writes when the log reaches CEILING times its
  // bound: a write it accepted would be one more that is not on the disk,
  // in a log that has nowhere to go. When the call returns the thread ends,
  // the checkpoints go back to the daemon's connection and writes are taken
  // again (`back`).
  private hung(w: Worker, why: Error) {
    const since = Date.now();
    const at = this.index();
    this.onError(new Error(`${why.message}, and it cannot be ended: it is inside a call that has not returned, most likely a sync of the store's files on a disk that does not answer. What was written since is in the store's log (${at ? this.mb(at.frames) : "?"} MB) and may not be on the disk. The log cannot be started again until that call returns or the daemon is restarted; at ${this.mb(this.opts.hard * CEILING)} MB the daemon stops taking writes.`), "the store's disk does not answer");
    const timer = setInterval(() => this.lookSilent(), Math.min(1_000, this.goneMs));
    timer.unref?.();
    // (One that already made the store take no writes, by the write lock it holds, goes on refusing them.)
    const locked = this.locked;
    if (locked) { clearInterval(locked.timer); this.locked = undefined; }
    this.silent = { worker: w, since: locked?.since ?? since, refusing: !!locked, timer };
  }
  private lookSilent() {
    const s = this.silent;
    if (!s || s.refusing) return;
    const at = this.index();
    if (!at || at.frames < this.opts.hard * CEILING) return;
    s.refusing = true;
    // Said first: the row is a write too.
    this.onError(new Error(`The store's log reached ${this.mb(at.frames)} MB with its disk not answering for ${Math.round((Date.now() - s.since) / 1000)} s. The daemon takes no more writes: prompts, tool results and settings fail until the disk answers or the daemon is restarted. Sessions can still be read, a running turn stopped, a card answered and the daemon restarted.`), "the store takes no writes");
    try { this.store.db.exec("PRAGMA query_only = ON"); } catch (e) { this.onError(e); }
    this.store.refuse?.(true);
  }
  // A write of the daemon's connection waited for the write lock and did not
  // get it. The loop waits a fifth of a second at a time (Store, BUSY_MS)
  // and asks here between the waits, saying how long this write has waited.
  // The thread says since when it holds the lock and when it last moved.
  // - The thread does not hold the lock (another process does, or the
  //   moment between two tries): the wait goes on.
  // - It holds the lock and has stood still for `lockedMs`: it is inside a
  //   call that does not return (a sync on a disk that does not answer).
  // - It holds the lock, it moves, and this write has waited `lockedMs`
  //   all the same: the log's restart takes that long on this disk (three
  //   syncs with the lock held, each of seconds).
  // In both of the last the loop would answer nobody for as long as the
  // lock is held, one write after the other, with nothing said and nothing
  // the owner could do. So from there the store takes no writes (they fail
  // at once, and what must not be lost is owed), and it is said. True: the
  // store takes no writes.
  //
  // The thread is not ended for this. When it gives the lock up the store
  // takes writes again by itself (`lookLocked`). A thread that never moves
  // is ended at its deadline as any thread stuck in a call (overdue, hung),
  // with the writes still refused.
  //
  // A wait of over `saidMs` under the thread's lock is said as it happens:
  // to whoever names a stall (`onWait`), in what the daemon says of its
  // store (`slow`), and so on the page.
  private lockedOut(waited: number): boolean {
    if (this.silent?.refusing || this.locked) return true;
    // `slow`: the disk answers, slowly (the lock is given up in seconds): said in other words than a disk that does not answer.
    const refuse = (words: string, slow = false) => {
      // (First: the row that says it is a write too, and would wait for the same lock.)
      try { this.store.db.exec("PRAGMA query_only = ON"); } catch (e) { this.onError(e); }
      this.store.refuse?.(true);
      this.onError(new Error(slow
        ? `${words} The daemon takes no writes until the lock is given up, seconds from now: a prompt sent meanwhile waits and goes out by itself, running turns wait, and settings fail. Sessions can still be read, a running turn stopped, a card answered and the daemon restarted.`
        : `${words} The daemon takes no more writes: prompts, tool results and settings fail until ${this.silent ? "the disk answers or the daemon is restarted" : "the lock is given up or the daemon is restarted"}. Sessions can still be read, a running turn stopped, a card answered and the daemon restarted.`), slow ? "the store takes no writes for the moment" : "the store takes no writes");
    };
    // A thread already known to be stuck in a call: it is what holds the lock.
    const stuck = this.silent?.worker ?? this.ending?.worker;
    if (stuck) {
      if (this.ending) { clearTimeout(this.ending.timer); this.ending = undefined; }
      if (this.silent) clearInterval(this.silent.timer);
      const timer = setInterval(() => this.lookSilent(), Math.min(1_000, this.goneMs));
      timer.unref?.();
      this.silent = { worker: stuck, since: this.silent?.since ?? Date.now(), refusing: true, timer };
      refuse("The checkpoint thread holds the store's write lock inside a call that has not returned, most likely a sync of the store's files on a disk that does not answer.");
      return true;
    }
    const at = Atomics.load(this.cells, CELL.lock_at);
    if (!this.worker || !at) return false;
    const held = since(at), stood = since(Atomics.load(this.cells, CELL.beat_at));
    const sync = Atomics.load(this.cells, CELL.sync_ms), syncs = Atomics.load(this.cells, CELL.held_syncs);
    const secs = (ms: number) => (ms / 1000).toFixed(1);
    const disk = `${syncs ? `${syncs} sync${syncs === 1 ? "" : "s"} made under the lock so far, ` : ""}the thread's last sync of its own took ${secs(sync)} s`;
    if (waited >= this.saidMs) {
      const now = Date.now();
      const first = !this.slowed || now - this.slowed.last > SLOW_SHOWN_MS;
      this.slowed = { since: first ? now - waited : this.slowed!.since, last: now, sync_ms: sync, held_ms: held };
      this.onWait?.(`the log's restart waits for the disk (the write lock held ${secs(held)} s: ${disk})`, waited);
      if (first) this.changed();
      clearTimeout(this.slowTimer);
      this.slowTimer = setTimeout(() => this.changed(), SLOW_SHOWN_MS + 100);
      this.slowTimer.unref?.();
    }
    const still = stood >= this.lockedMs;
    if (!still && waited < this.lockedMs) return false;
    const timer = setInterval(() => this.lookLocked(), 50);
    timer.unref?.();
    // A thread that stands still on a disk it just measured as slow is inside a slow sync (the copy
    // under the lock is one call with two of them): only on a disk that was quick is that a call
    // that does not return.
    // (Nor is a build it was asked for: said as that.)
    const building = this.building?.what;
    const slow = !still || sync >= this.opts.slowMs || !!building;
    this.locked = { since: Date.now(), timer, still, slow, sync_ms: sync, building };
    refuse(building
      ? `The store is ${building}, once (the write lock held ${secs(held)} s so far, a write waiting ${secs(waited)} s).`
      : slow
      ? `The store's disk is slow: a sync of it takes ${secs(sync)} s, and its log is being started again (the write lock held ${secs(held)} s so far, a write waiting ${secs(waited)} s).`
      : `The checkpoint thread holds the store's write lock and has not moved for ${secs(stood)} s: it is inside a call that has not returned, most likely a sync of the store's files on a disk that does not answer.`, slow);
    this.changed();
    return true;
  }
  // The store takes no writes because the thread holds the write lock for too long (lockedOut); the thread itself was left alone.
  private locked?: { since: number; timer: ReturnType<typeof setInterval>; still: boolean; slow: boolean; sync_ms: number; building?: string };
  // The last waits of over `saidMs` under the thread's lock: since when, the last one, and how slow the disk was then.
  private slowed?: { since: number; last: number; sync_ms: number; held_ms: number };
  private slowTimer?: ReturnType<typeof setTimeout>;
  // Told a wait under the thread's lock (the words for a stall's row), and that what the daemon says of its store changed.
  onWait?: (label: string, ms: number) => void;
  onChange?: () => void;
  private changed() { try { this.onChange?.(); } catch {} }
  private lookLocked() {
    const l = this.locked;
    if (!l || Atomics.load(this.cells, CELL.lock_at)) return;
    // The lock is given up: writes are taken again, and what was owed meanwhile is made.
    clearInterval(l.timer);
    this.locked = undefined;
    try { this.store.db.exec("PRAGMA query_only = OFF"); } catch (e) { this.onError(e); }
    this.store.refuse?.(false, (e, what) => this.onError(new Error(`A write owed from while the store took none could not be made (${what}): ${(e as Error)?.message ?? e}`)));
    this.onError(new Error(`The store's write lock was given up ${((Date.now() - l.since) / 1000).toFixed(1)} s after the daemon stopped taking writes: it takes them again.`), "the store takes writes again");
    this.changed();
  }
  // What the daemon says of its store's disk, for its status, its health answer and the page: it
  // does not answer (since when, and whether no write is taken by now), or it is slow.
  get said(): StoreDisk | null {
    const full = this.fullFor;
    if (full) return { full, refusing: true };
    // (Writes refused for a slow start of the log: the disk is slow, not silent.)
    const l = this.locked;
    if (l?.slow && !this.silent) return { slow: { since_ms: l.building ? l.since : this.slowed?.since ?? l.since, sync_ms: l.sync_ms, held_ms: Date.now() - l.since, refusing: true, ...(l.building ? { building: l.building } : {}) } };
    const since = this.silentSince, slow = this.slow;
    if (since === undefined && !slow) return null;
    return { ...(since !== undefined ? { silent_since_ms: since, refusing: this.refusing } : {}), ...(slow ? { slow } : {}) };
  }
  // What a request that would write is answered while the store takes no writes: in the words of what holds it.
  get refusalSays(): string | undefined {
    const full = this.fullFor;
    if (full) return `the disk is full: ${full.free_mb ?? "?"} MB free: nothing new is saved until there is room. What you send waits and goes out by itself. Sessions can still be read, a running turn stopped, a card answered and the daemon restarted.`;
    const l = this.locked;
    if (l?.building && !this.silent) return `the daemon is ${l.building}, once, and its store takes no writes for some seconds. What you send waits and goes out by itself. Sessions can still be read, a running turn stopped, a card answered and the daemon restarted.`;
    return l?.slow && !this.silent ? `the daemon's disk is slow (a sync of its store takes ${(l.sync_ms / 1000).toFixed(1)} s) and its store takes no writes until its log has started again, seconds from now. What you send waits and goes out by itself. Sessions can still be read, a running turn stopped, a card answered and the daemon restarted.` : undefined;
  }
  // The disk is slow: writes waited over `saidMs` for the log's restart within the last half minute. Since when, and how slow.
  get slow(): NonNullable<StoreDisk["slow"]> | undefined {
    const s = this.slowed;
    return s && Date.now() - s.last <= SLOW_SHOWN_MS ? { since_ms: s.since, sync_ms: s.sync_ms, held_ms: s.held_ms } : undefined;
  }
  // Whether a turn should hold what it is about to write (Store.clear): the thread is about to hold
  // the write lock, or holds it for longer than a moment (a start of the log on a slow disk), or the
  // store takes no writes because that took too long. A turn that waits off the loop for the lock
  // to be given up neither holds the loop in its write nor ends for a store that refuses it. The
  // thread may stand still meanwhile: the copy under the lock is one call of SQLite's with two syncs
  // in it, and a slow disk is told from one that does not answer only by waiting. The turn's wait
  // has its own end (Store.clear): on a disk that does not answer it then writes, and ends as any
  // turn whose write the store refuses. A thread known to be stuck in a call is not waited for.
  private pacing(): boolean {
    // (A thread that has not moved for this long is inside a call that does not return: a turn stops
    // waiting for it, writes, and ends as any turn the store refuses. On a slow disk the thread moves
    // between its syncs, and a turn waits through the whole start of the log, however many seconds.
    // Nor does a build the thread was asked for count as standing still.)
    if (this.building && this.worker) return true;
    // (A disk with no room: a turn waits for room as it waits for a slow disk, within its own bound.)
    if (this.fullSince) return true;
    if (since(Atomics.load(this.cells, CELL.beat_at)) >= PACE_STILL_MS) return false;
    if (this.locked) return true;
    if (!this.worker || this.silent) return false;
    if (Atomics.load(this.cells, CELL.lock_soon)) return true;
    const at = Atomics.load(this.cells, CELL.lock_at);
    if (at && since(at) >= PACE_AFTER_MS) return true;
    // The disk is slow and the log is long: the turns hold their writes until it has started again.
    // That is what bounds the log on a slow disk, where a forced start is put off (SLOW_HARD) and
    // takes many seconds of syncs during which a writer that does not pause would add to it without
    // end. With the turns waiting nothing much is written, and the start is made at the first moment
    // all is copied. A log is read whole by the start after a loss of power, before the daemon listens.
    return Atomics.load(this.cells, CELL.sync_ms) >= this.opts.slowMs && this.framesNow() >= PACE_AT * this.opts.slowHard;
  }
  // The log's length as its index has it, read at most ten times a second.
  private looked = { at: 0, frames: 0 };
  private framesNow(): number {
    const now = performance.now();
    if (now - this.looked.at >= 100) this.looked = { at: now, frames: this.index()?.frames ?? 0 };
    return this.looked.frames;
  }
  // Whether the store refuses writes now (its disk does not answer and its log is at the ceiling).
  get refusing(): boolean { return !!this.silent?.refusing || !!this.locked || !!this.fullSince; }
  // Since when the store's disk has not answered (the thread is inside a call that does not return), if it does not.
  get silentSince(): number | undefined { return this.silent?.since ?? this.locked?.since; }
  private back() {
    const s = this.silent;
    if (!s) return;
    clearInterval(s.timer);
    this.silent = undefined;
    if (s.refusing) {
      try { this.store.db.exec("PRAGMA query_only = OFF"); } catch (e) { this.onError(e); }
      // What was owed meanwhile (a turn's end, a card's answer) is written now.
      this.store.refuse?.(false, (e, what) => this.onError(new Error(`A write owed from while the store took none could not be made (${what}): ${(e as Error)?.message ?? e}`)));
    }
    this.own(false);
    this.onError(new Error(`The store's disk answers again after ${Math.round((Date.now() - s.since) / 1000)} s${s.refusing ? ": the daemon takes writes again" : ""}. The daemon's connection checkpoints by itself until the next start.`), "the store's disk answers again");
  }

  // Whose checkpoints bound the log: the thread's (the connection makes none), or the connection's as SQLite does.
  private own(thread: boolean) {
    try { this.store.db.exec(`PRAGMA wal_autocheckpoint = ${thread ? 0 : NEAR}`); } catch (e) { this.onError(e); }
  }

  // A backup's snapshot, taken with the thread holding the daemon's writes
  // back (the loop is not held). `gate` is the number the backup's thread
  // waits on. Undefined: no thread works, and the caller empties the log itself.
  snapshot(gate: Int32Array): Promise<boolean> | undefined {
    const w = this.worker;
    if (!w || !this.armed) return undefined;
    Atomics.store(gate, 0, ASKED);
    return new Promise((resolve) => {
      const id = ++this.ids;
      this.asked.set(id, (m) => resolve(!!m?.ok));
      w.postMessage({ snapshot: gate, id });
    });
  }

  // One statement made by the thread under its write lock (a build that takes seconds: the index of
  // the events' rows). The loop is not held: its turns wait off it (pacing), and a write that waits
  // past the bound is refused and owed, in words of its own. The thread stands still for as long as
  // the statement runs: it is not taken for stuck meanwhile, within BUILD_MAX_MS.
  // Undefined: no thread works (the caller makes the statement itself). Throws what the statement threw.
  build(sql: string, what: string): Promise<boolean> | undefined {
    const w = this.worker;
    if (!w || !this.armed || this.silent || this.building) return undefined;
    this.building = { what, since: Date.now() };
    return new Promise<boolean>((resolve, reject) => {
      const id = ++this.ids;
      this.asked.set(id, (m) => {
        this.building = undefined;
        this.beat = { seen: Atomics.load(this.cells, CELL.beat), at: performance.now() };
        if (m?.error) reject(new Error(m.error)); else resolve(!!m?.ok);
      });
      w.postMessage({ exec: sql, id });
    });
  }
  private building?: { what: string; since: number };

  // At a stop: the thread copies what it can, gives its mark up and closes
  // its connections. The daemon's connection is then the last one, and
  // closing it empties the log.
  async close(): Promise<void> {
    const w = this.worker;
    // (No thread any more, one that is called stuck included: what the store owes is still made, or left in its file.)
    if (!w) { this.stop(); return; }
    clearInterval(this.watch);
    await new Promise<void>((resolve) => {
      const id = ++this.ids;
      const t = setTimeout(() => { this.asked.delete(id); resolve(); }, CLOSE_MS);
      this.asked.set(id, () => { clearTimeout(t); resolve(); });
      w.postMessage({ close: id });
    });
    this.stop();
  }

  // Ends the thread at once (its mark goes with it): the daemon's connection checkpoints by itself again.
  stop() {
    clearInterval(this.watch);
    this.watch = undefined;
    if (this.ending) { clearTimeout(this.ending.timer); this.ending = undefined; }
    // (A full disk at a stop of the daemon: what is owed is tried once more, within the stop's time, and the rest stays in its file.)
    if (this.fullSince) {
      clearInterval(this.fullTimer);
      this.fullSince = undefined;
      try { this.store.db.exec("PRAGMA query_only = OFF"); } catch {}
      this.store.refuse?.(false, (e, what) => this.onError(new Error(`A write owed from while the store took none could not be made (${what}): ${(e as Error)?.message ?? e}`)), OWED_STOP_MS);
    }
    // (A disk that does not answer is not synced from the loop on the way out either: the
    // connection's own checkpoints stay off, and the log is left for the next start's thread.)
    const silent = !!this.silent || !!this.locked;
    if (this.locked) {
      // (The same as a thread known to be stuck that made the store take no writes.)
      clearInterval(this.locked.timer);
      this.silent = { worker: this.worker!, since: this.locked.since, refusing: true, timer: this.locked.timer };
      this.locked = undefined;
    }
    if (this.silent) {
      clearInterval(this.silent.timer);
      if (this.silent.refusing) {
        try { this.store.db.exec("PRAGMA query_only = OFF"); } catch {}
        // The daemon stops, or its code is replaced: what the store owes is
        // made within a few seconds in all (the thread that does not return
        // may hold the write lock), and the rest stays owed, in its file.
        this.store.refuse?.(false, (e, what) => this.onError(new Error(`A write owed from while the store took none could not be made (${what}): ${(e as Error)?.message ?? e}`)), OWED_STOP_MS);
      }
      this.silent = undefined;
    }
    this.end();
    if (!silent) this.own(false);
  }

  private end() {
    const w = this.worker;
    this.worker = undefined;
    Atomics.store(this.cells, CELL.armed, 0);
    for (const done of this.asked.values()) done(undefined);
    this.asked.clear();
    try { w?.terminate(); } catch {}
  }

  // The thread does not work here: SQLite checkpoints in the commit from now on.
  private failed(w: Worker | undefined, e: unknown) {
    if (w && this.worker !== w) return;
    this.failures++;
    this.off = true;
    this.stop();
    this.onError(e);
    // (A sync or a copy that found the disk full: the thread is started again when there is room.)
    if (noRoom(e)) { this.fullEnded = true; this.fullNow(); }
  }

  // The disk that holds the store has no room: a write failed for it (the loop's, or the thread's).
  // From there the store takes no writes, as with a disk that does not answer: a request that would
  // write is told so at once in the daemon's words, what must not be lost is owed, and the page
  // says it. The free space is looked at every two seconds; with room again writes are taken, what
  // was owed is made, and a thread that ended for it is started again.
  private fullSince?: number;
  private fullTimer?: ReturnType<typeof setInterval>;
  private fullEnded = false;
  private freeMb(): number | undefined {
    try { const s = statfsSync(this.store.stateDir); return Math.floor((Number(s.bavail) * Number(s.bsize)) / 1_048_576); } catch { return undefined; }
  }
  private fullNow() {
    if (this.fullSince) return;
    this.fullSince = Date.now();
    try { this.store.db.exec("PRAGMA query_only = ON"); } catch (e) { this.onError(e); }
    this.store.refuse?.(true);
    this.onError(new Error(`The disk that holds the daemon's store is full (${this.freeMb() ?? "?"} MB free): nothing new is saved until there is room. A prompt sent meanwhile waits and goes out by itself; sessions can still be read, a running turn stopped, a card answered and the daemon restarted.`), "the disk is full");
    this.fullTimer = setInterval(() => this.lookFull(), FULL_LOOK_MS);
    this.fullTimer.unref?.();
    this.changed();
  }
  private lookFull() {
    const free = this.freeMb();
    if (!this.fullSince || (free !== undefined && free < FULL_ROOM_MB)) return;
    clearInterval(this.fullTimer);
    const since = this.fullSince;
    this.fullSince = undefined;
    if (!this.silent?.refusing && !this.locked) {
      try { this.store.db.exec("PRAGMA query_only = OFF"); } catch (e) { this.onError(e); }
      this.store.refuse?.(false, (e, what) => this.onError(new Error(`A write owed from while the store took none could not be made (${what}): ${(e as Error)?.message ?? e}`)));
      // (No room after all, for what was owed: full again, and looked at again.)
      if (this.fullSince) return;
    }
    if (this.fullEnded) { this.fullEnded = false; this.off = false; this.start(); }
    this.onError(new Error(`The disk that holds the daemon's store has room again (${free ?? "?"} MB free) after ${Math.round((Date.now() - since) / 1000)} s: the daemon takes writes again.`), "the disk has room again");
    this.changed();
  }
  get fullFor(): { since_ms: number; free_mb?: number } | undefined {
    return this.fullSince ? { since_ms: this.fullSince, free_mb: this.freeMb() } : undefined;
  }
}

// The checkpoint thread of the daemon's store, when one runs (a route that
// needs the log emptied asks it instead of the loop).
const running = new WeakMap<object, Checkpointer>();
export const checkpointerOf = (store: object): Checkpointer | undefined => running.get(store);
export function startCheckpointer(store: CheckpointStore, onError: (e: unknown, group?: string) => void): Checkpointer {
  running.get(store)?.stop();
  const c = new Checkpointer(store, onError);
  running.set(store, c);
  c.start();
  return c;
}
