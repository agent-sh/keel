// The checkpoint thread: it copies the log into the database, holds the mark
// that keeps the daemon's connection from starting the log again, starts it
// again itself, and bounds it under a writer that never pauses. A thread
// that cannot run, or stops moving, leaves the checkpoints to SQLite.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, openSync, readSync, closeSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpointer, NEAR } from "./checkpoint.ts";
import { EXPIRED, HELD, TRIED } from "./checkpoint-shared.ts";
import { Snapshot, snapshotTry } from "../admin/backup.ts";
import { Store } from "./store.ts";

const pragma = (store: Store, name: string) => Object.values(store.db.query<Record<string, number>, []>(`PRAGMA ${name}`).get()!)[0]!;
const until = async (f: () => boolean, ms = 30_000) => { for (const t0 = Date.now(); !f() && Date.now() - t0 < ms;) await Bun.sleep(5); return f(); };
// About `pages` pages of log.
const write = (store: Store, id: string, pages: number) => {
  for (let n = 0; n < pages / 5; n++) store.append(id, "note", { text: "x".repeat(16_000) + n });
};
// The log's salt, which changes each time the log starts again, and its frames.
const index = (dir: string) => {
  const fd = openSync(join(dir, "keel.db-shm"), "r");
  const b = Buffer.alloc(100);
  readSync(fd, b, 0, 100, 0);
  closeSync(fd);
  return { frames: b.readUInt32LE(16), copied: b.readUInt32LE(96), salt: b.readUInt32LE(32) };
};
const starts = (store: Store) => store.db.query<{ n: number }, []>("SELECT n FROM log_starts").get()!.n;
const rig = (opts: ConstructorParameters<typeof Checkpointer>[3] = {}, program?: string) => {
  const dir = mkdtempSync(join(tmpdir(), "keel-ckpt-"));
  const store = new Store(dir);
  const failures: unknown[] = [];
  const c = new Checkpointer(store, (e) => failures.push(e), program, { tickMs: 10, syncMs: 30, at: 200, soft: 800, hard: 1_000_000, ...opts });
  const end = () => { c.stop(); try { store.db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); };
  return { dir, store, c, failures, end };
};

test("the thread holds a mark, so the daemon's connection never starts the log again; the thread does", async () => {
  const r = rig();
  try {
    expect(pragma(r.store, "wal_autocheckpoint")).toBe(NEAR);
    const id = r.store.createSession({ model: "p:m", workspace: "/" }).id;
    r.c.start();
    // Armed: the thread holds its mark, and the connection makes no checkpoint of its own.
    expect(await until(() => r.c.armed && pragma(r.store, "wal_autocheckpoint") === 0)).toBe(true);
    // A short log: everything is copied once the writes stop, and the log is synced.
    write(r.store, id, 300);
    expect(await until(() => r.c.counts.waiting === 0 && r.c.counts.frames > 250 && r.c.counts.syncs > 0)).toBe(true);
    const before = index(r.dir);
    expect(before.copied).toBe(before.frames);
    // All copied, and the daemon's next write does not start the log again: its frames go to the end.
    write(r.store, id, 5);
    const after = index(r.dir);
    expect(after.salt).toBe(before.salt);
    expect(after.frames).toBeGreaterThan(before.frames);
    expect(r.c.counts.starts).toBe(0);
    // A long log starts again when nothing waits, by the thread's own write, with no write lock held for a copy.
    write(r.store, id, 800);
    expect(await until(() => r.c.counts.starts === 1)).toBe(true);
    expect(index(r.dir).salt).not.toBe(after.salt);
    expect(index(r.dir).frames).toBeLessThan(20);
    expect(r.c.counts.forced).toBe(0);
    expect(starts(r.store)).toBeGreaterThanOrEqual(1);
    // The daemon writes on in the new log; nothing was lost on the way.
    write(r.store, id, 50);
    expect(index(r.dir).frames).toBeGreaterThan(40);
    expect(r.store.events(id).length).toBe(60 + 1 + 160 + 10);
    expect(r.store.db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    expect(r.failures).toEqual([]);
    // Stopped: the mark goes with the thread, and the connection checkpoints by itself again.
    r.c.stop();
    expect(pragma(r.store, "wal_autocheckpoint")).toBe(NEAR);
  } finally { r.end(); }
}, 60_000);

test("the daemon's connection checkpoints nothing from the moment the thread is started", async () => {
  const r = rig();
  try {
    expect(pragma(r.store, "wal_autocheckpoint")).toBe(1_000);
    r.c.start();
    // Before the thread has said a word: a start's first write must not copy the log the last daemon left.
    expect(r.c.armed).toBe(false);
    expect(pragma(r.store, "wal_autocheckpoint")).toBe(0);
    expect(await until(() => r.c.armed)).toBe(true);
    expect(pragma(r.store, "wal_autocheckpoint")).toBe(0);
  } finally { r.end(); }
});

// After a kill the log the daemon left may be past its bound, all of it to be copied again. The thread
// does not take the write lock for it as it begins (the start's turns write then): it starts the log
// again at the first moment nothing waits, and takes the lock only after as many frames more as any long log gets.
test("a log left past its bound starts again without the write lock taken first", async () => {
  const r = rig({ at: 100, soft: 300, hard: 400 });
  try {
    const id = r.store.createSession({ model: "p:m", workspace: "/" }).id;
    r.store.db.exec("PRAGMA wal_autocheckpoint = 0");
    write(r.store, id, 600);
    expect(index(r.dir).frames).toBeGreaterThan(400);
    const before = starts(r.store);
    r.c.start();
    expect(await until(() => starts(r.store) > before)).toBe(true);
    expect(r.c.counts.forced).toBe(0);
    expect(r.failures).toEqual([]);
  } finally { r.end(); }
}, 60_000);

test("under a writer that never pauses the log stays within its bound", async () => {
  // (No room between the two lengths: the log never starts again at a pause here, however fast the disk
  // is, so every start is one with the write lock taken first.)
  const hard = 1_500;
  const r = rig({ at: 300, soft: hard, hard });
  try {
    const id = r.store.createSession({ model: "p:m", workspace: "/" }).id;
    r.c.start();
    expect(await until(() => r.c.armed)).toBe(true);
    // Five pages every millisecond or so (four times what twelve working sessions write), with no longer
    // pause, until the log has started again six times (on a quiet disk: about fifteen thousand pages).
    let most = 0, n = 0, written = 0, last = index(r.dir);
    const t0 = performance.now();
    for (let k = 0; k < 40_000 && r.c.counts.starts < 6; k++) {
      r.store.append(id, "note", { text: "x".repeat(16_000) + n++ });
      const at = index(r.dir);
      // The pages written in all: what the log grew by, and all of it when it started again in between.
      written += at.salt === last.salt ? at.frames - last.frames : at.frames;
      last = at;
      most = Math.max(most, at.frames);
      await Bun.sleep(1);
    }
    const c = r.c.counts;
    expect(c.starts).toBeGreaterThan(5);
    expect(c.forced).toBeGreaterThan(0);
    // The bound: `hard`, and what the writer adds from the thread's look that found it until the thread
    // has the write lock, which is at most one wait between looks and one look (its pass, its syncs, the
    // lock). How long a look is, is the disk's; twice the writer's mean rate allows for its bursts.
    const rate = written / (performance.now() - t0);
    expect(Math.max(most, c.most_frames)).toBeLessThan(hard + 2 * rate * (10 + c.tick_most_ms) + 300);
    expect(r.store.events(id).length).toBe(n);
    expect(r.store.db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    expect(r.failures).toEqual([]);
    expect(pragma(r.store, "wal_autocheckpoint")).toBe(0);
  } finally { r.end(); }
}, 120_000);

test("a transaction that reads first waits for the thread's write and does not fail", async () => {
  const r = rig({ soft: 60, at: 30, hard: 120 });
  try {
    const id = r.store.createSession({ model: "p:m", workspace: "/" }).id;
    r.c.start();
    expect(await until(() => r.c.armed)).toBe(true);
    // The thread starts the log again over and over while transactions that read and then write run.
    const count = r.store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE session_id = ?");
    // (Three hundred of them, and more on a disk so slow that the log has not started again three times by then.)
    let wrote = 0;
    for (let k = 0; k < 300 || (r.c.counts.starts < 3 && k < 20_000); k++) {
      r.store.db.transaction(() => {
        const n = count.get(id)!.n;
        r.store.append(id, "note", { text: "y".repeat(4_000) + n });
        wrote++;
      })();
      if (k % 3 === 0) await Bun.sleep(1);
    }
    expect(wrote).toBeGreaterThanOrEqual(300);
    expect(r.c.counts.starts).toBeGreaterThan(2);
    expect(r.store.events(id).length).toBe(wrote);
    expect(r.failures).toEqual([]);
  } finally { r.end(); }
}, 60_000);

test("a backup's read begins with the log all copied and the writes held, and sees the database file alone", async () => {
  // (No log is long here: the one start of the log is the snapshot's. The hold is long: this side is never late.)
  const r = rig({ soft: 1_000_000, holdMs: 20_000 });
  try {
    const id = r.store.createSession({ model: "p:m", workspace: "/" }).id;
    r.c.start();
    expect(await until(() => r.c.armed)).toBe(true);
    write(r.store, id, 400);
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const held = r.c.snapshot(gate)!;
    expect(await until(() => Atomics.load(gate, 0) === HELD)).toBe(true);
    const at = index(r.dir);
    expect(at.copied).toBe(at.frames);
    // The backup's side: its read transaction, then its word.
    const snap = new Database(join(r.dir, "keel.db"), { readonly: true });
    snap.run("BEGIN");
    const events = snap.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events");
    expect(events.get()!.n).toBe(80);
    expect(Atomics.compareExchange(gate, 0, HELD, TRIED)).toBe(HELD);
    Atomics.notify(gate, 0);
    expect(await held).toBe(true);
    // The log started again under the snapshot, by the thread.
    expect(r.c.counts.starts).toBe(1);
    // What the daemon writes meanwhile waits in the log: nothing is copied into the file the snapshot reads.
    const size = statSync(join(r.dir, "keel.db")).size;
    write(r.store, id, 300);
    expect(await until(() => r.c.counts.waiting > 250)).toBe(true);
    await Bun.sleep(150);
    expect(r.c.counts.waiting).toBeGreaterThan(250);
    expect(statSync(join(r.dir, "keel.db")).size).toBe(size);
    expect(events.get()!.n).toBe(80);
    // The snapshot ends: the thread copies again.
    snap.run("ROLLBACK");
    snap.close();
    expect(await until(() => r.c.counts.waiting === 0)).toBe(true);
    expect(r.store.events(id).length).toBe(140);
    expect(r.failures).toEqual([]);
  } finally { r.end(); }
}, 60_000);

// The write lock is held for a moment only, and a backup's thread can be held up for longer than that
// on a busy machine. A read it begins after the hold ended reads through the new log: the counts it
// takes are then of a later moment than the file's bytes it copies, and a restore refuses the backup.
// One swap of the gate decides whose the moment was (checkpoint-shared.ts).
test("a backup's thread that is late for the hold does not take its read for the snapshot", async () => {
  const r = rig({ soft: 1_000_000, holdMs: 20 });
  try {
    const id = r.store.createSession({ model: "p:m", workspace: "/" }).id;
    r.c.start();
    expect(await until(() => r.c.armed)).toBe(true);
    write(r.store, id, 200);
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const snap = new Snapshot(r.dir);
    let answer: Promise<boolean> | undefined;
    const ask = () => { answer = r.c.snapshot(gate)!; };
    // Late, and the daemon wrote meanwhile: the read would go through the log.
    expect(snapshotTry(snap, gate, ask, 10_000, () => { Bun.sleepSync(120); r.store.append(id, "note", { text: "written after the hold" }); })).toBe(false);
    expect(Atomics.load(gate, 0)).toBe(EXPIRED);
    expect(await answer).toBe(false);
    // Late with nothing written since: the file is as the read sees it, but that the lock was held is not known. Not taken either.
    expect(await until(() => r.c.counts.waiting === 0)).toBe(true);
    expect(snapshotTry(snap, gate, ask, 10_000, () => Bun.sleepSync(120))).toBe(false);
    expect(await answer).toBe(false);
    // In time: taken, and what it counts is what the file holds.
    r.c.stop();
    const timely = rig({ soft: 1_000_000, holdMs: 20_000 });
    try {
      const sid = timely.store.createSession({ model: "p:m", workspace: "/" }).id;
      timely.c.start();
      expect(await until(() => timely.c.armed)).toBe(true);
      write(timely.store, sid, 200);
      const g = new Int32Array(new SharedArrayBuffer(4));
      const s2 = new Snapshot(timely.dir);
      let a2: Promise<boolean> | undefined;
      expect(snapshotTry(s2, g, () => { a2 = timely.c.snapshot(g)!; }, 10_000)).toBe(true);
      expect(await a2).toBe(true);
      expect(s2.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n).toBe(40);
      s2.close();
    } finally { timely.end(); }
    snap.close();
    expect(r.failures).toEqual([]);
  } finally { r.end(); }
}, 60_000);

test("a stop closes the thread's connections, and the daemon's close then empties the log", async () => {
  const r = rig();
  const id = r.store.createSession({ model: "p:m", workspace: "/" }).id;
  r.c.start();
  expect(await until(() => r.c.armed)).toBe(true);
  write(r.store, id, 300);
  await r.c.close();
  expect(r.c.armed).toBe(false);
  expect(pragma(r.store, "wal_autocheckpoint")).toBe(NEAR);
  r.store.db.close();
  const wal = join(r.dir, "keel.db-wal");
  expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);
  const again = new Store(r.dir);
  expect(again.events(id).length).toBe(60);
  again.db.close();
  rmSync(r.dir, { recursive: true, force: true });
}, 60_000);

test("a thread that cannot run leaves the checkpoints to SQLite", async () => {
  const broken = URL.createObjectURL(new Blob(["self.onmessage = () => { throw new Error('no sqlite here'); };"], { type: "application/javascript" }));
  const r = rig({}, broken);
  try {
    r.c.start();
    expect(await until(() => r.c.counts.failed >= 1)).toBe(true);
    expect(r.c.armed).toBe(false);
    expect(pragma(r.store, "wal_autocheckpoint")).toBe(NEAR);
    expect(r.failures).toHaveLength(1);
    // The connection bounds the log by itself.
    const id = r.store.createSession({ model: "p:m", workspace: "/" }).id;
    write(r.store, id, 2_000);
    const at = index(r.dir);
    expect(at.frames - at.copied).toBeLessThan(NEAR);
  } finally { r.end(); }
}, 60_000);

// A thread that armed itself and then stops moving: after the deadline it is
// ended, its mark goes with it, one error is recorded, and SQLite
// checkpoints in the commit again.
test("a thread that stops moving is noticed at its deadline", async () => {
  // The real thread's first steps (the mark, the word that it is armed), then nothing: no tick is ever counted.
  const hangs = URL.createObjectURL(new Blob([`
    import { Database } from "bun:sqlite";
    let R;
    self.onmessage = (ev) => {
      const m = ev.data;
      if (!m.open) return;
      const cells = new Int32Array(m.cells);
      const W = new Database(m.open);
      W.exec("UPDATE log_starts SET n = n + 1");
      W.close();
      R = new Database(m.open);
      R.exec("BEGIN");
      R.query("SELECT 1 FROM sqlite_schema LIMIT 1").get();
      Atomics.store(cells, 1, 1);
      postMessage({ armed: true });
    };`], { type: "application/javascript" }));
  const r = rig({ deadlineMs: 300 }, hangs);
  try {
    const id = r.store.createSession({ model: "p:m", workspace: "/" }).id;
    r.c.start();
    expect(await until(() => r.c.armed)).toBe(true);
    expect(pragma(r.store, "wal_autocheckpoint")).toBe(0);
    expect(await until(() => r.failures.length >= 1)).toBe(true);
    expect(r.c.counts.failed).toBe(1);
    expect(String((r.failures[0] as Error).message)).toContain("did not move");
    expect(r.failures).toHaveLength(1);
    expect(pragma(r.store, "wal_autocheckpoint")).toBe(NEAR);
    // Its mark is gone with it: the connection copies the log and starts it again by itself.
    write(r.store, id, 3_000);
    const at = index(r.dir);
    expect(at.frames).toBeLessThan(2 * NEAR);
  } finally { r.end(); }
}, 60_000);

// A thread inside a call that does not return (a sync on a disk that does not answer) cannot be ended, and
// its mark and locks cannot be taken from it. The daemon says so, keeps the checkpoints off its own
// connection (they would be the same sync, on the loop), stops taking writes when the log reaches its
// ceiling, and goes back to SQLite's own checkpoints when the call returns.
test("a thread stuck in a call is said, writes stop at the log's ceiling, and both end when the call returns", async () => {
  // The real thread's first steps, then a call of two and a half seconds that nothing can interrupt.
  const stuck = URL.createObjectURL(new Blob([`
    import { Database } from "bun:sqlite";
    let R;
    self.onmessage = (ev) => {
      const m = ev.data;
      if (!m.open) return;
      const cells = new Int32Array(m.cells);
      const W = new Database(m.open);
      W.exec("UPDATE log_starts SET n = n + 1");
      W.close();
      R = new Database(m.open);
      R.exec("BEGIN");
      R.query("SELECT 1 FROM sqlite_schema LIMIT 1").get();
      Atomics.store(cells, 1, 1);
      postMessage({ armed: true });
      setTimeout(() => Bun.sleepSync(2500), 20);
    };`], { type: "application/javascript" }));
  // The ceiling is eight times `hard`: 400 pages here.
  const r = rig({ deadlineMs: 200, goneMs: 100, hard: 50 }, stuck);
  try {
    const id = r.store.createSession({ model: "p:m", workspace: "/" }).id;
    r.c.start();
    expect(await until(() => r.c.armed)).toBe(true);
    const said = () => r.failures.map((e) => String((e as Error).message));
    expect(await until(() => r.failures.length >= 1)).toBe(true);
    expect(said()[0]).toContain("did not move");
    expect(said()[0]).toContain("cannot be ended");
    expect(said()[0]).toContain("a disk that does not answer");
    // Not given back: the daemon's connection would make the sync that does not return.
    expect(pragma(r.store, "wal_autocheckpoint")).toBe(0);
    expect(r.c.refusing).toBe(false);
    // The log grows to its ceiling: from there no write is taken, and what is there is read.
    write(r.store, id, 500);
    expect(await until(() => r.c.refusing)).toBe(true);
    expect(said()[1]).toContain("takes no more writes");
    const had = r.store.events(id).length;
    expect(() => r.store.append(id, "note", { text: "refused" })).toThrow(/readonly/);
    expect(r.store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE session_id = ?").get(id)!.n).toBe(had);
    // The call returns: the thread ends, writes are taken, and SQLite checkpoints in the commit again.
    expect(await until(() => !r.c.refusing)).toBe(true);
    expect(said()[2]).toContain("answers again");
    expect(said()).toHaveLength(3);
    expect(pragma(r.store, "wal_autocheckpoint")).toBe(NEAR);
    r.store.append(id, "note", { text: "taken again" });
    write(r.store, id, 3_000);
    expect(index(r.dir).frames).toBeLessThan(2 * NEAR);
    expect(r.store.events(id).length).toBe(had + 1 + 600);
  } finally { r.end(); }
}, 60_000);

// The thread holds the write lock while it starts the log again, and a write of the daemon's
// connection waits for it: a fifth of a second at a time, asking between the waits how the thread
// stands. A stand-in for the thread takes the lock for `hold` ms and says so as the thread does
// (since when it holds the lock, cell 14; its last sync's time, cell 15); it ticks every 100 ms
// while `ticks` (a slow disk: one sync after another), or stands still (a call that does not return).
const holder = (hold: number, ticks: boolean) => URL.createObjectURL(new Blob([`
  import { Database } from "bun:sqlite";
  self.onmessage = (ev) => {
    const m = ev.data;
    if (!m.open) return;
    const cells = new Int32Array(m.cells);
    const stamp = () => (Date.now() % 0x7fffffff) + 1;
    const tick = () => Atomics.store(cells, 13, stamp());
    const W = new Database(m.open);
    W.exec("UPDATE log_starts SET n = n + 1");
    Atomics.store(cells, 1, 1);
    tick();
    postMessage({ armed: true });
    setInterval(tick, 50);
    setTimeout(() => {
      W.exec("BEGIN IMMEDIATE");
      tick();
      Atomics.store(cells, 14, stamp());
      Atomics.store(cells, 15, 700);
      if (${ticks}) for (let t = 0; t < ${hold}; t += 100) { Bun.sleepSync(100); tick(); Atomics.store(cells, 16, 1 + Math.floor(t / 700)); }
      else Bun.sleepSync(${hold});
      W.exec("ROLLBACK");
      Atomics.store(cells, 14, 0);
      tick();
    }, 20);
  };`], { type: "application/javascript" }));

test("a write waits for the write lock through a slow disk, and the wait is said: nothing is refused under the bound", async () => {
  const r = rig({ deadlineMs: 60_000, goneMs: 100, lockedMs: 4_000, saidMs: 600 }, holder(1_500, true));
  try {
    const id = r.store.createSession({ model: "p:m", workspace: "/" }).id;
    const waits: { label: string; ms: number }[] = [];
    let changes = 0;
    r.c.onWait = (label, ms) => void waits.push({ label, ms });
    r.c.onChange = () => void changes++;
    r.c.start();
    expect(await until(() => r.c.armed)).toBe(true);
    await Bun.sleep(200);
    expect(r.c.said).toBeNull();
    // The lock is held for a second and a half: the write waits it out.
    const t = performance.now();
    r.store.append(id, "note", { text: "waited" });
    expect(performance.now() - t).toBeGreaterThan(800);
    expect([r.c.refusing, r.store.refusing, r.failures.length]).toEqual([false, false, 0]);
    expect(r.store.events(id).map((e) => e.data.text)).toEqual(["waited"]);
    // A wait of over the said time is told as it happens: for a stall's row, and in what the daemon says of its store.
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.at(-1)!.label).toMatch(/^the log's restart waits for the disk \(the write lock held \d\.\d s: \d syncs? made under the lock so far, the thread's last sync of its own took 0\.7 s\)$/);
    expect(waits.at(-1)!.ms).toBeGreaterThanOrEqual(600);
    expect(r.c.said).toMatchObject({ slow: { sync_ms: 700 } });
    expect(r.c.said!.silent_since_ms).toBeUndefined();
    expect(changes).toBe(1);
  } finally { r.end(); }
}, 60_000);

test("the write lock held past the bound by a thread that moves (a restart of the log on a slow disk): writes stop at the bound and are taken again when the lock is given up", async () => {
  const r = rig({ deadlineMs: 60_000, goneMs: 100, lockedMs: 800 }, holder(2_500, true));
  try {
    const id = r.store.createSession({ model: "p:m", workspace: "/" }).id;
    r.c.start();
    expect(await until(() => r.c.armed)).toBe(true);
    await Bun.sleep(200);
    const had = r.store.events(id).length;
    // The first write waits the bound, and no longer; it is told the store takes no writes (not that the lock was not had).
    let t = performance.now();
    expect(() => r.store.append(id, "note", { text: "waited" })).toThrow(/readonly database: the store takes no writes/);
    const waited = performance.now() - t;
    expect([waited > 500, waited < 1_500]).toEqual([true, true]);
    expect([r.c.refusing, r.store.refusing]).toEqual([true, true]);
    const said = () => r.failures.map((e) => String((e as Error).message));
    // Said as a slow disk, not as one that does not answer: in Errors, to a request that would write, and in what the page shows.
    expect(said().at(-1)).toMatch(/^The store's disk is slow: a sync of it takes 0\.7 s, and its log is being started again \(the write lock held \d\.\d s so far, a write waiting \d\.\d s\)\. The daemon takes no writes until the lock is given up, seconds from now: a prompt sent meanwhile waits and goes out by itself/);
    expect(said().at(-1)).toContain("a running turn stopped, a card answered and the daemon restarted");
    expect(r.c.said).toMatchObject({ slow: { sync_ms: 700, refusing: true } });
    expect(r.c.said!.silent_since_ms).toBeUndefined();
    expect(r.c.refusalSays).toStartWith("the daemon's disk is slow (a sync of its store takes 0.7 s) and its store takes no writes until its log has started again");
    // The next ones fail at once, and what must not be lost is owed.
    t = performance.now();
    expect(() => r.store.append(id, "note", { text: "refused" })).toThrow(/readonly/);
    expect(r.store.appendOrLater(id, "turn_end", { reason: "interrupted" })).toBe(false);
    expect(performance.now() - t).toBeLessThan(100);
    expect(r.store.owes).toBe(1);
    expect(r.store.events(id).length).toBe(had);
    // The lock is given up: writes are taken, and what was owed is made. The thread was not ended for it.
    expect(await until(() => !r.c.refusing, 10_000)).toBe(true);
    expect(said().at(-1)).toContain("write lock was given up");
    expect([r.store.owes, r.c.armed]).toEqual([0, true]);
    r.store.append(id, "note", { text: "taken again" });
    expect(r.store.events(id).slice(had).map((e) => e.kind)).toEqual(["turn_end", "note"]);
  } finally { r.end(); }
}, 60_000);

test("a thread that stands still with the write lock: writes stop within the bound, and are taken again by themselves when it gives the lock up", async () => {
  const r = rig({ deadlineMs: 60_000, goneMs: 100, lockedMs: 400 }, holder(2_500, false));
  try {
    const id = r.store.createSession({ model: "p:m", workspace: "/" }).id;
    r.c.start();
    expect(await until(() => r.c.armed)).toBe(true);
    await Bun.sleep(200);
    const had = r.store.events(id).length;
    let t = performance.now();
    expect(() => r.store.append(id, "note", { text: "waited" })).toThrow(/readonly database: the store takes no writes/);
    const waited = performance.now() - t;
    expect([waited > 150, waited < 1_200]).toEqual([true, true]);
    expect([r.c.refusing, r.store.refusing]).toEqual([true, true]);
    const said = () => r.failures.map((e) => String((e as Error).message));
    expect(said().at(-1)).toContain("holds the store's write lock and has not moved for");
    expect(said().at(-1)).toContain("a running turn stopped, a card answered and the daemon restarted");
    // (A disk that was quick and now holds a call: one that does not answer. The request's answer keeps its own words.)
    expect(r.c.said).toMatchObject({ refusing: true });
    expect([r.c.said!.slow, r.c.refusalSays]).toEqual([undefined, undefined]);
    t = performance.now();
    expect(() => r.store.append(id, "note", { text: "refused" })).toThrow(/readonly/);
    expect(r.store.appendOrLater(id, "turn_end", { reason: "interrupted" })).toBe(false);
    expect(performance.now() - t).toBeLessThan(100);
    expect(r.store.owes).toBe(1);
    expect(r.store.events(id).length).toBe(had);
    expect(await until(() => !r.c.refusing, 10_000)).toBe(true);
    expect(said().at(-1)).toContain("write lock was given up");
    expect([r.store.owes, r.c.armed]).toEqual([0, true]);
    r.store.append(id, "note", { text: "taken again" });
    expect(r.store.events(id).slice(had).map((e) => e.kind)).toEqual(["turn_end", "note"]);
  } finally { r.end(); }
}, 60_000);

// A turn asks before it writes, where it can wait (Store.clear): while the thread holds the write lock
// for long and moves, the turn waits off the loop, and its write is made when the lock is given up. It
// neither holds the loop in SQLite's wait nor is ended by a store that stopped taking writes meanwhile.
test("a turn that asks first holds its write off the loop while the thread holds the write lock, whether the thread moves or stands still", async () => {
  let r = rig({ deadlineMs: 60_000, goneMs: 100, lockedMs: 800 }, holder(1_500, true));
  try {
    const id = r.store.createSession({ model: "p:m", workspace: "/" }).id;
    expect(r.store.pacing?.()).toBeFalsy();
    r.c.start();
    expect(await until(() => r.c.armed)).toBe(true);
    await Bun.sleep(250);
    expect(r.store.pacing!()).toBe(true);
    // The loop goes on while the turn waits: its timers fire.
    let turns = 0;
    const beat = setInterval(() => void turns++, 20);
    const t = performance.now();
    await r.store.clear();
    clearInterval(beat);
    expect(performance.now() - t).toBeGreaterThan(800);
    expect(turns).toBeGreaterThan(20);
    expect(r.store.pacing!()).toBe(false);
    // The write is made at once, and nothing was refused or said.
    const t1 = performance.now();
    r.store.append(id, "note", { text: "after the hold" });
    expect(performance.now() - t1).toBeLessThan(150);
    expect([r.c.refusing, r.store.refusing, r.failures.length]).toEqual([false, false, 0]);
    // A stop of the turn ends the wait.
    const stop = new AbortController();
    stop.abort();
    await r.store.clear(stop.signal);
  } finally { r.end(); }
  // A thread that stands still with the lock (the copy under it is one call with two syncs): the turn waits all
  // the same, also after the store stopped taking writes for it, until the lock is given up or its own wait is over.
  r = rig({ deadlineMs: 60_000, goneMs: 100, lockedMs: 400 }, holder(2_000, false));
  try {
    const id = r.store.createSession({ model: "p:m", workspace: "/" }).id;
    r.c.start();
    expect(await until(() => r.c.armed)).toBe(true);
    await Bun.sleep(200);
    expect(r.store.pacing!()).toBe(true);
    // Another writer (a request) waits the bound and is refused; the turn still waits, and is not ended by it.
    expect(() => r.store.append(id, "note", { text: "a request's write" })).toThrow(/readonly/);
    expect([r.c.refusing, r.store.pacing!()]).toEqual([true, true]);
    // Its own wait ends by its bound when the hold does not.
    const t0 = performance.now();
    await r.store.clear(undefined, 300);
    expect(performance.now() - t0).toBeLessThan(600);
    expect(r.store.pacing!()).toBe(true);
    // A thread that has not moved for half a minute is inside a call that does not return: a turn stops waiting for it.
    const cells = (r.c as any).cells as Int32Array, was = Atomics.load(cells, 13);
    Atomics.store(cells, 13, ((Date.now() - 31_000) % 0x7fffffff) + 1);
    expect(r.store.pacing!()).toBe(false);
    Atomics.store(cells, 13, was);
    expect(r.store.pacing!()).toBe(true);
    await r.store.clear();
    expect(await until(() => !r.c.refusing, 5_000)).toBe(true);
    expect(r.store.pacing!()).toBe(false);
    r.store.append(id, "note", { text: "the turn's write" });
    expect(r.store.events(id).map((e) => e.data.text)).toEqual(["the turn's write"]);
  } finally { r.end(); }
}, 60_000);

// A disk with no room: a write of the loop fails for it, or the thread's sync does. The store then takes
// no writes, as with a disk that does not answer, and says so in its own words; with room again it
// takes them, makes what it owed, and the thread that ended for it runs again.
test("a full disk: the store takes no writes and says so, and with room again writes are taken, what was owed is made and the thread runs", async () => {
  const r = rig({ deadlineMs: 60_000, goneMs: 100 });
  try {
    const id = r.store.createSession({ model: "p:m", workspace: "/" }).id;
    r.c.start();
    expect(await until(() => r.c.armed)).toBe(true);
    let free = 5;
    (r.c as any).freeMb = () => free;
    // The thread's sync finds no room: the thread ends, and the daemon says the disk is full.
    (r.c as any).failed((r.c as any).worker, Object.assign(new Error("ENOSPC: no space left on device, fsync"), { code: "ENOSPC" }));
    expect([r.c.armed, r.c.refusing, r.store.refusing]).toEqual([false, true, true]);
    expect(r.c.said).toEqual({ full: { since_ms: expect.any(Number), free_mb: 5 }, refusing: true });
    expect(r.c.refusalSays).toStartWith("the disk is full: 5 MB free: nothing new is saved until there is room. What you send waits and goes out by itself.");
    const said = () => r.failures.map((e) => String((e as Error).message));
    expect(said().at(-1)).toStartWith("The disk that holds the daemon's store is full (5 MB free): nothing new is saved until there is room.");
    // A write fails at once, and what must not be lost is owed.
    expect(() => r.store.append(id, "note", { text: "refused" })).toThrow(/readonly/);
    expect(r.store.appendOrLater(id, "turn_end", { reason: "interrupted" })).toBe(false);
    // Still no room: nothing changes. Then there is: writes are taken, the owed one is made, the thread is started again.
    (r.c as any).lookFull();
    expect(r.c.refusing).toBe(true);
    free = 900;
    (r.c as any).lookFull();
    expect([r.c.refusing, r.store.refusing, r.store.owes, r.c.said]).toEqual([false, false, 0, null]);
    expect(said().at(-1)).toMatch(/^The disk that holds the daemon's store has room again \(900 MB free\) after \d+ s: the daemon takes writes again\.$/);
    expect(await until(() => r.c.armed)).toBe(true);
    r.store.append(id, "note", { text: "taken again" });
    expect(r.store.events(id).map((e) => e.kind)).toEqual(["turn_end", "note"]);
    // And a write of the loop that finds the disk full says the same (SQLite's own words for it).
    free = 3;
    r.store.full!();
    expect(r.c.said).toMatchObject({ full: { free_mb: 3 } });
    free = 900;
    (r.c as any).lookFull();
    expect(r.c.refusing).toBe(false);
  } finally { r.end(); }
}, 60_000);

// The log's bound is not one SQLite enforces: a reader of another connection holds the log for as long
// as it reads. A log that stays past its bound for some seconds is said once, with why, and starts again
// when the reader is done.
test("a log held past its bound is said once, and starts again when its reader is done", async () => {
  const r = rig({ at: 100, soft: 200, hard: 300, longMs: 150, deadlineMs: 60_000 });
  try {
    const id = r.store.createSession({ model: "p:m", workspace: "/" }).id;
    r.c.start();
    expect(await until(() => r.c.armed)).toBe(true);
    write(r.store, id, 50);
    // A long read of another connection, begun while frames wait: it reads through the log.
    const reader = new Database(join(r.dir, "keel.db"), { readonly: true });
    reader.run("BEGIN");
    reader.query("SELECT COUNT(*) FROM events").get();
    for (let k = 0; k < 400; k++) { r.store.append(id, "note", { text: "x".repeat(16_000) + k }); if (k % 20 === 0) await Bun.sleep(1); }
    expect(index(r.dir).frames).toBeGreaterThan(300 + NEAR);
    expect(await until(() => r.failures.length >= 1)).toBe(true);
    const words = String((r.failures[0] as Error).message);
    expect(words).toContain("past the");
    expect(words).toContain("a reader of another connection holds it");
    await Bun.sleep(400);
    expect(r.failures).toHaveLength(1);
    // The reader is done: the log starts again and nothing more is said.
    const before = starts(r.store);
    reader.run("ROLLBACK");
    reader.close();
    expect(await until(() => starts(r.store) > before)).toBe(true);
    expect(await until(() => index(r.dir).frames < 300)).toBe(true);
    expect(r.failures).toHaveLength(1);
    expect(r.store.events(id).length).toBe(410);
  } finally { r.end(); }
}, 60_000);
