// The checkpoint thread (checkpoint.ts): it syncs the write-ahead log,
// copies it into the database, and is the one that starts the log again.
// It works by its own clock and asks nothing of the daemon's loop: what it
// did is read from shared numbers.
import { constants, Database } from "bun:sqlite";
import { fsyncSync } from "node:fs";
import { CELL, EXPIRED, HELD, logIndex, type LogIndex, NOT_EMPTIED, type Opts, stamp, TRIED } from "./checkpoint-shared.ts";
import { storeFd } from "./store-files.ts";

declare var self: Worker;

// Three connections, each for one thing SQLite lets a connection do at a time:
// K copies the log into the database (a checkpoint cannot run inside a transaction);
// W takes the write lock and writes the first frame of a log that starts again;
// R holds a read transaction, and with it a mark in the log: while a reader
// uses the log, no writer starts it again.
let K: Database | undefined, W: Database | undefined, R: Database | undefined;
let path = "";
let cells: Int32Array;
let opts: Opts;
let marked = false;
let said = false;
let timer: ReturnType<typeof setInterval> | undefined;
// The log as it was at the last sync of it, and when that was.
let synced = { frames: -1, salt: -1, at: 0 };
// The frames at the last tick: a tick that finds the same number saw no write in between.
let before = -1;
// A try to start the log again that another connection's reader stopped is
// not made again before this time, each time later (up to RETRY_MOST_MS).
let retryAt = 0, retryMs = 0;
const RETRY_MS = 1_000, RETRY_MOST_MS = 30_000;
// A log an earlier daemon left may be at its bound already when this thread
// begins (after a kill all of it waits to be copied again). The write lock is
// not taken for it at once, while the start's turns continue: the log gets
// as many frames more as lie between SOFT and HARD to start again at a
// moment nothing waits, as any long log does.
let grace = 0;
// A tail this short after a pass is worth one more pass at once.
const SHORT = 32;

type Index = LogIndex;
// The log's index, through the process's kept descriptor of the -shm file (never closed: store-files.ts).
function index(): Index | undefined {
  try { return logIndex(storeFd(`${path}-shm`), buf); } catch { return undefined; }
}
const buf = Buffer.alloc(136);

const busy = (e: unknown) => /database is locked|SQLITE_BUSY/i.test(String((e as Error)?.message ?? e));
const add = (cell: number, by = 1) => Atomics.add(cells, cell, by);
const set = (cell: number, v: number) => Atomics.store(cells, cell, v);
const see = (h: Index) => {
  set(CELL.frames, h.frames);
  set(CELL.waiting, h.frames - h.copied);
  if (h.frames > Atomics.load(cells, CELL.most)) set(CELL.most, h.frames);
};

// The mark: R's read transaction. Begun while frames wait to be copied, it
// reads through the log and holds a mark there (a reader that begins when
// all is copied reads the database file and holds none).
function mark() {
  R!.exec("BEGIN");
  R!.query("SELECT 1 FROM sqlite_schema LIMIT 1").get();
  marked = true;
  set(CELL.armed, 1);
  if (!said) { said = true; self.postMessage({ armed: true }); }
}
function unmark() {
  if (!marked) return;
  try { R!.exec("ROLLBACK"); } catch {}
  marked = false;
}
// The mark moves to the newest frame, so a pass can copy up to it. Never
// while all is copied: the mark would be given up for a moment in which a
// writer could start the log again.
function advance(h: Index) {
  if (h.frames === h.copied) return;
  unmark();
  mark();
}

// W's one write: the first frame of a log that starts again. The log's new
// header is written and synced in it, by this thread (pragma.html,
// synchronous NORMAL: "the WAL header is synced when a WAL file begins to
// be reused after a checkpoint").
const first = () => { moved(); W!.query("UPDATE log_starts SET n = n + 1, ts = ? WHERE id = 1").run(Date.now()); moved(); };
// The write lock, and since when it is held: the loop, when a write of its own waits for it, reads
// that (checkpoint.ts, lockedOut). `commit` and `unlock` give it up.
const lock = (): boolean => {
  try { W!.exec("BEGIN IMMEDIATE"); } catch (e) { if (busy(e)) return false; throw e; }
  moved();
  set(CELL.held_syncs, 0);
  set(CELL.lock_at, stamp());
  return true;
};
const unlock = () => { try { W!.exec("ROLLBACK"); } catch {} set(CELL.lock_at, 0); };
// (The first frame of a log that starts again is written with its header synced: one more sync under the lock.)
const commit = (restarts: boolean) => { try { W!.exec("COMMIT"); } finally { set(CELL.lock_at, 0); } if (restarts) add(CELL.held_syncs); };

// Holds the mark from here on. With frames waiting the mark is taken as it
// is. With all copied (a fresh log too) this thread writes one frame first.
function arm(): boolean {
  if (marked) return true;
  const h = index();
  if (h && h.frames !== h.copied) { mark(); return true; }
  if (!lock()) return false;
  try { first(); commit(false); } catch (e) { unlock(); throw e; }
  mark();
  return true;
}

// The thread moved: said after each sync and around what it does with the write lock held. The loop,
// when a write of its own waits for that lock, tells a slow disk from a call that does not return
// by how long ago this was (checkpoint.ts, lockedOut).
const moved = () => set(CELL.beat_at, stamp());
// A sync of the thread's own, timed: how long the last one took is how slow the disk is now.
const timedSync = (fd: number) => {
  const t0 = performance.now();
  fsyncSync(fd);
  set(CELL.sync_ms, Math.round(performance.now() - t0));
  moved();
};
const syncLog = () => {
  let log: number;
  // (No log yet: nothing to sync. Any other failure to reach it is a failure: a copy must not go on without the log's sync.)
  try { log = storeFd(`${path}-wal`); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  timedSync(log);
  add(CELL.syncs);
};
const syncFile = () => timedSync(storeFd(path));
const copy = () => { K!.query("PRAGMA wal_checkpoint(PASSIVE)").get(); add(CELL.passes); };
// A copy made with the write lock held: SQLite's own checkpoint, whole. It syncs the log, copies,
// syncs the database, and only then marks the frames as copied (wal.c, walCheckpoint): that order is
// SQLite's and is not taken apart here. A frame marked as copied before the database's sync would
// let the log start again over pages that are not on the disk, should that sync fail or the thread
// end inside the copy. So the thread stands still for one sync of the log and one of the database;
// what could be done before the lock was (restart), so both have little to write.
const copyHeld = () => {
  moved();
  copy();
  add(CELL.held_syncs, 2);
  moved();
};

// One pass: the log is synced, then copied into the database up to the mark
// (a passive checkpoint: wal.html, "it does as much work as it can without
// interfering with other database connections"); the database is synced
// when the pass reached the log's end. How many frames wait after it.
function pass(): number {
  const h = index();
  if (!h) return 0;
  advance(h);
  copy();
  const now = index();
  if (!now) return 0;
  see(now);
  return now.frames - now.copied;
}

// The log starts again. It can when every frame is in the database and the
// database is synced, and it does at the next write, if no reader uses the
// log (wal.html: "the writer will rewind the WAL back to the beginning").
// That write is made here: the write lock is taken, the state is looked at
// again under it, the mark is given up and one row is written.
//
// `force`: the log is at its bound and no pass ended with all copied (the
// writer never paused that long). The rest is then copied with the write
// lock held: the daemon's writes wait meanwhile, in its own connection's
// wait for the lock. Before the lock is taken everything that can be is
// copied and synced, so what is done under it is small.
//
// "started"; "later": the daemon wrote in between, tried again at the next
// tick; "blocked": a reader of another connection uses the log.
function restart(force: boolean): "started" | "later" | "blocked" {
  // Before the lock, everything that can be done without it: one pass (not more: a pass is as long
  // as its syncs, and the log grows for as long as it runs), the database's sync, then the log's, so
  // the two syncs SQLite makes under the lock find only what was written in the moment between.
  // Then the turns are told that the lock is about to be held (checkpoint.ts, pacing), and given a
  // moment to stop writing: what they would write waits off the loop instead of on it.
  if (force) { pass(); syncFile(); syncLog(); set(CELL.lock_soon, 1); Bun.sleepSync(LEAD_MS); }
  // (On a slow disk the start made at a moment nothing waits holds the lock for the new header's sync, seconds of it: said the same way.)
  else if (Atomics.load(cells, CELL.sync_ms) >= opts.slowMs) { set(CELL.lock_soon, 1); Bun.sleepSync(LEAD_MS); }
  try { return restartHeld(force); } finally { set(CELL.lock_soon, 0); }
}
// How long before a forced start's lock the turns are told of it.
const LEAD_MS = 150;
function restartHeld(force: boolean): "started" | "later" | "blocked" {
  for (let round = 0; round < 3; round++) {
    if (!lock()) continue;
    const t0 = performance.now();
    let done = false;
    try {
      let h = index()!;
      if (h.frames !== h.copied) {
        if (!force) return "later";
        advance(h);
        copyHeld();
        h = index()!;
        // A reader of another connection still uses older frames.
        if (h.frames !== h.copied) return "blocked";
        // W's own read began before that pass. It begins again, to read the database file alone.
        unlock();
        if (!lock()) continue;
        h = index()!;
        if (h.frames !== h.copied) continue;
      }
      const salt = h.salt;
      unmark();
      first();
      commit(true);
      done = true;
      const now = index();
      if (now && now.salt !== salt) {
        add(CELL.starts);
        if (force) add(CELL.forced);
        return "started";
      }
      // A reader of another connection held the log: the row went to its end.
      return "blocked";
    } finally {
      if (!done) unlock();
      const ms = Math.round(performance.now() - t0);
      add(CELL.held_ms, ms);
      if (ms > Atomics.load(cells, CELL.held_most)) set(CELL.held_most, ms);
      arm();
    }
  }
  return "later";
}

function tick() {
  const t0 = performance.now();
  try { look(); } finally {
    const ms = Math.round(performance.now() - t0);
    if (ms > Atomics.load(cells, CELL.tick_most)) set(CELL.tick_most, ms);
  }
}

function look() {
  add(CELL.beat);
  set(CELL.beat_at, stamp());
  const h = index();
  // No index: nothing was written since the database was last closed by all.
  if (!h) { if (!marked) arm(); return; }
  see(h);
  if (!marked && !arm()) return;
  const now = performance.now();
  const quiet = h.frames === before;
  before = h.frames;
  const grew = h.frames !== synced.frames || h.salt !== synced.salt;
  // What was committed since the last sync is on the disk within about a second.
  if (grew && now - synced.at >= opts.syncMs) {
    syncLog();
    synced = { frames: h.frames, salt: h.salt, at: now };
  }
  let waiting = h.frames - h.copied;
  const long = h.frames >= opts.soft;
  if (waiting >= opts.at || (waiting > 0 && (quiet || long))) {
    waiting = pass();
    // A long log with next to nothing left: one more pass may find nothing written meanwhile.
    if (long && waiting > 0 && waiting <= SHORT) waiting = pass();
  }
  const at = index();
  if (!at || at.frames < opts.soft || now < retryAt) return;
  // The log must start again from `hard`. A forced start holds the write lock for three syncs (the
  // log's, the database's, the new log's header), and the daemon's writes wait for all of them: on
  // a disk whose syncs are slow that is seconds each time. So while the thread's own last sync took
  // over `slowMs`, the log is let grow to `slowHard` before a start is forced: it starts again at a
  // moment nothing waits, as below `hard`, and is forced a few times less often when no such moment comes.
  const slow = Atomics.load(cells, CELL.sync_ms) >= opts.slowMs;
  const force = at.frames >= Math.max(slow ? opts.slowHard : opts.hard, grace);
  if (waiting && !force) return;
  const how = restart(force);
  if (how === "blocked") {
    add(CELL.blocked);
    retryMs = Math.min(RETRY_MOST_MS, retryMs ? retryMs * 2 : RETRY_MS);
    retryAt = performance.now() + retryMs;
  } else if (how === "started") { retryMs = 0; grace = 0; }
}

// A backup's snapshot (src/admin/backup.ts): a read transaction that reads
// the database file alone. One that begins while all is copied does, and
// for as long as it is open nothing is copied into the file (a checkpoint
// does not overwrite a page a reader can still see). Here everything is
// copied, the write lock is held so that it stays so, and the backup's
// thread is told to begin (`gate`: HELD); it answers TRIED, or the wait ends.
function snapshot(gate: Int32Array): boolean {
  pass();
  syncFile();
  syncLog();
  // (The turns are told before the lock is taken, as before a forced start: restart.)
  set(CELL.lock_soon, 1);
  Bun.sleepSync(LEAD_MS);
  try { return snapshotHeld(gate); } finally { set(CELL.lock_soon, 0); }
}
function snapshotHeld(gate: Int32Array): boolean {
  for (let round = 0; round < 4; round++) {
    if (!lock()) continue;
    let done = false;
    try {
      let h = index();
      if (!h) continue;
      if (h.frames !== h.copied) {
        advance(h);
        copyHeld();
        h = index()!;
        if (h.frames !== h.copied) continue;
        unlock();
        if (!lock()) continue;
        h = index()!;
        if (h.frames !== h.copied) continue;
      }
      Atomics.store(gate, 0, HELD);
      Atomics.notify(gate, 0);
      Atomics.wait(gate, 0, HELD, opts.holdMs);
      moved();
      // One swap decides (checkpoint-shared.ts): the backup's read began under the lock, or the
      // hold is over. The lock is given up only after it.
      const began = Atomics.compareExchange(gate, 0, HELD, EXPIRED) === TRIED;
      Atomics.notify(gate, 0);
      // The log starts again under the snapshot (a reader of the file alone does not hold it): the first frame is this thread's.
      const salt = h.salt;
      unmark();
      first();
      commit(true);
      done = true;
      if (index()?.salt !== salt) add(CELL.starts);
      return began;
    } finally {
      if (!done) unlock();
      arm();
    }
  }
  Atomics.store(gate, 0, NOT_EMPTIED);
  Atomics.notify(gate, 0);
  return false;
}

// Everything copied that can be, the mark given up, the connections closed:
// the daemon's connection is then the last, and closing it empties the log.
function close() {
  clearInterval(timer);
  timer = undefined;
  // After a failure (a sync that did not happen, a disk with no room) the thread copies nothing
  // more and its connections close without a checkpoint of their own and without cutting the log:
  // what is copied from here is the daemon's connection's doing, SQLite's own checkpoint with its
  // syncs in their order. (A connection that closes as the last one of a file checkpoints it and
  // removes or cuts its log, wal.c sqlite3WalClose; kept from that with SQLITE_FCNTL_PERSIST_WAL
  // and no size limit on the log, whichever of the process's connections is last.)
  if (failed) { for (const d of [R, W, K]) { try { d?.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 1); } catch {} } }
  else { try { syncLog(); pass(); } catch {} }
  unmark();
  set(CELL.armed, 0);
  for (const d of [R, W, K]) { try { d?.close(); } catch {} }
  R = W = K = undefined;
  // The descriptors of the store's files stay open: closing one would drop
  // the daemon's own locks on the store while its connection is still open
  // (store-files.ts). The process ends right after.
}

let failed = false;
const guard = <T>(f: () => T): T | undefined => {
  if (failed) return undefined;
  try { return f(); } catch (e) {
    failed = true;
    clearInterval(timer);
    // Nothing is left held: the daemon's connection takes the checkpoints back.
    try { unlock(); unmark(); set(CELL.armed, 0); } catch {}
    self.postMessage({ error: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
};

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data as { open: string; cells: SharedArrayBuffer; opts: Opts } | { snapshot: Int32Array; id: number } | { exec: string; id: number } | { close: number };
  if ("open" in m) {
    guard(() => {
      path = m.open;
      cells = new Int32Array(m.cells);
      opts = m.opts;
      const open = (wait: number) => {
        const d = new Database(path);
        // Synced as the daemon's own checkpoints were; none checkpoints by itself, and each keeps next to no pages.
        d.exec(`PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 0; PRAGMA cache_size = -256; PRAGMA busy_timeout = ${wait}`);
        return d;
      };
      K = open(0);
      // The wait for the write lock is this thread's, and short: a write of the daemon in flight ends well within it.
      W = open(opts.lockMs);
      // The log's file keeps its length when it starts again (the connection
      // that starts it is the one whose limit counts): its frames are then
      // written over, not cut off and grown again.
      W.exec(`PRAGMA journal_size_limit = ${opts.hard * (opts.page + 24) + 32}`);
      R = open(0);
      arm();
      const left = index();
      if (left && left.frames >= opts.soft) grace = left.frames + (opts.hard - opts.soft);
      pass();
      timer = setInterval(() => guard(tick), opts.tickMs);
    });
    return;
  }
  if ("snapshot" in m) {
    const ok = guard(() => snapshot(m.snapshot));
    if (ok === undefined) { Atomics.store(m.snapshot, 0, NOT_EMPTIED); Atomics.notify(m.snapshot, 0); }
    self.postMessage({ id: m.id, ok: !!ok });
    return;
  }
  if ("exec" in m) {
    // (A statement that fails is its own failure, said to who asked: the thread goes on.)
    let ok = false, error: string | undefined;
    if (!failed) try { ok = execHeld(m.exec); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    self.postMessage({ id: m.id, ok, error });
    return;
  }
  try { close(); } catch {}
  self.postMessage({ id: m.close, closed: true });
};

// One statement made with the write lock held by this thread, not by the loop: a piece of work on
// the store that takes seconds (the index of the events' rows, built once: src/server/index-build.ts).
// The turns are told before the lock is taken, as before a forced start of the log, and wait off the
// loop meanwhile; the lock is tried for some seconds.
function execHeld(sql: string): boolean {
  set(CELL.lock_soon, 1);
  Bun.sleepSync(LEAD_MS);
  try {
    for (let round = 0; round < 150; round++) {
      if (!lock()) { Bun.sleepSync(20); continue; }
      let done = false;
      try {
        W!.exec(sql);
        commit(false);
        done = true;
        moved();
        return true;
      } finally { if (!done) unlock(); }
    }
    return false;
  } finally { set(CELL.lock_soon, 0); }
}
