// The pages a backup is told changed must hold every page that did: the
// database file is compared before and after, page by page, against what the
// log's reader says. And a log that started again with nobody watching must
// give "not known", never a short list.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logHead, PageLog, type LogAt } from "./log-pages.ts";
import { storeFd } from "./store-files.ts";

function store() {
  const dir = mkdtempSync(join(tmpdir(), "keel-log-pages-"));
  const path = join(dir, "keel.db");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE starts (id INTEGER PRIMARY KEY, n INTEGER); INSERT INTO starts VALUES (1, 0)");
  let n = 0;
  const write = (rows: number) => db.transaction(() => { for (let i = 0; i < rows; i++) db.query("INSERT INTO t (v) VALUES (?)").run(`row ${++n} ${"x".repeat(900)}`); })();
  const at = (): LogAt => { const h = logHead(storeFd(`${path}-shm`))!; return { s1: h.s1, s2: h.s2, frame: h.frame }; };
  // The database file whole, once every frame is in it.
  const image = () => { db.exec("PRAGMA wal_checkpoint(PASSIVE)"); return readFileSync(path); };
  return { dir, path, db, write, at, image, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

// The pages (from 1) that differ between two images of the file.
function differ(a: Buffer, b: Buffer, size = 4096): number[] {
  const out: number[] = [];
  for (let p = 0; p * size < Math.max(a.length, b.length); p++) {
    if (a.length < (p + 1) * size || b.length < (p + 1) * size || a.compare(b, p * size, (p + 1) * size, p * size, (p + 1) * size) !== 0) out.push(p + 1);
  }
  return out;
}

test("the pages between two emptied logs are every page that changed", () => {
  const s = store();
  try {
    const log = new PageLog(s.path);
    s.write(40);
    log.witnessed(() => s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
    const from = s.at(), before = readFileSync(s.path);
    expect(from.frame).toBe(0);
    s.write(300);
    s.db.query("UPDATE t SET v = 'changed' WHERE id = 7").run();
    log.witnessed(() => s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
    const to = s.at(), after = readFileSync(s.path);
    const got = log.between(from, to)!;
    const changed = differ(before, after);
    expect(changed.length).toBeGreaterThan(50);
    expect(changed.filter((p) => !got.pages.has(p))).toEqual([]);
    // Nothing that did not change in a frame is named: the set is the frames' pages.
    expect(got.pages.size).toBeLessThan(changed.length + 8);
    // From a place to itself: nothing.
    expect(log.between(to, to)!.pages.size).toBe(0);
    // Once that backup has its name the earlier rows go, and the next stretch is still whole.
    log.forget(got.walked);
    s.write(20);
    log.witnessed(() => s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
    const next = log.between(to, s.at())!;
    expect(differ(after, readFileSync(s.path)).filter((p) => !next.pages.has(p))).toEqual([]);
    expect(log.between(from, s.at())).toBeUndefined();
    log.close();
  } finally { s.done(); }
});

test("a log that started again unseen is not known", () => {
  const s = store();
  try {
    const log = new PageLog(s.path);
    s.write(10);
    log.witnessed(() => s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
    const from = s.at();
    s.write(50);
    log.scan();
    // Every frame is copied, and the next write starts the log again: these frames were read, the end was not seen.
    s.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    s.write(5);
    expect(s.at().s1).not.toBe(from.s1);
    log.scan();
    expect(log.between(from, s.at())).toBeUndefined();
    // Not even with the next end seen: the chain has a hole.
    log.witnessed(() => s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
    expect(log.between(from, s.at())).toBeUndefined();
    // From a place after the hole it is known again.
    const here = s.at(), before = readFileSync(s.path);
    s.write(30);
    log.witnessed(() => s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
    const got = log.between(here, s.at())!;
    expect(differ(before, readFileSync(s.path)).filter((p) => !got.pages.has(p))).toEqual([]);
    log.close();
  } finally { s.done(); }
});

// The checkpoint thread's way: a reader's mark keeps the writer from starting
// the log again, and the thread starts it itself with the write lock held,
// in one write. The commit of that write is what `witnessed` wraps.
test("generations ended by a write under the write lock are followed through", () => {
  const s = store();
  try {
    const K = new Database(s.path), W = new Database(s.path), R = new Database(s.path);
    for (const d of [K, W, R]) d.exec("PRAGMA wal_autocheckpoint = 0; PRAGMA busy_timeout = 1000");
    const log = new PageLog(s.path);
    const mark = () => { R.exec("BEGIN"); R.query("SELECT 1 FROM sqlite_schema LIMIT 1").get(); };
    const restart = () => {
      // The mark moves to the newest frame, a pass copies up to it, and with all copied the write lock is taken.
      R.exec("ROLLBACK");
      mark();
      K.exec("PRAGMA wal_checkpoint(PASSIVE)");
      log.scan();
      W.exec("BEGIN IMMEDIATE");
      const was = s.at();
      R.exec("ROLLBACK");
      W.query("UPDATE starts SET n = n + 1 WHERE id = 1").run();
      log.witnessed(() => W.exec("COMMIT"), "starts");
      expect(s.at().s1).not.toBe(was.s1);
      mark();
    };
    s.write(5);
    mark();
    restart();
    const from = s.at(), before = s.image();
    const salts = new Set<number>();
    for (let round = 0; round < 6; round++) {
      s.write(40 + round * 30);
      s.db.query("UPDATE t SET v = ? WHERE id = ?").run(`round ${round}`, round + 1);
      salts.add(s.at().s1);
      restart();
    }
    s.write(12); // in the newest generation, not ended
    expect(salts.size).toBe(6);
    log.scan();
    const to = s.at();
    const got = log.between(from, to)!;
    expect(got.pages.size).toBeGreaterThan(100);
    // A second reader (another thread, a daemon after a kill) reads the newest generation from its first frame and goes on.
    const other = new PageLog(s.path);
    s.write(25);
    other.scan();
    const later = other.between(from, s.at())!;
    expect(later.pages.size).toBeGreaterThan(got.pages.size);
    // A place the log has not been read up to is not known.
    s.write(3);
    expect(other.between(from, s.at())).toBeUndefined();
    other.scan();
    const all = other.between(from, s.at())!;
    R.exec("ROLLBACK");
    const changed = differ(before, s.image());
    expect(changed.length).toBeGreaterThan(100);
    expect(changed.filter((p) => !all.pages.has(p))).toEqual([]);
    expect([...got.pages].filter((p) => !all.pages.has(p))).toEqual([]);
    log.close(); other.close();
    for (const d of [K, W, R]) d.close();
  } finally { s.done(); }
});

// A commit gives the write lock up as it returns. When a reader of another
// connection kept that commit from starting the log again, and the log
// started again right after it in another writer's hands, the generation did
// not end where the witness read it to: it is not written down as ended.
test("a log that started again right after the witness's commit, in another write, is not known", () => {
  const s = store();
  try {
    const K = new Database(s.path), W = new Database(s.path), F = new Database(s.path);
    for (const d of [K, W, F]) d.exec("PRAGMA wal_autocheckpoint = 0; PRAGMA busy_timeout = 1000");
    const log = new PageLog(s.path);
    s.write(10);
    log.witnessed(() => s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
    const from = s.at();
    s.write(20);
    // Another connection's reader holds the newest frame: everything can be copied, the log cannot start again.
    F.exec("BEGIN"); F.query("SELECT COUNT(*) FROM t").get();
    K.exec("PRAGMA wal_checkpoint(PASSIVE)");
    W.exec("BEGIN IMMEDIATE");
    W.query("UPDATE starts SET n = n + 1 WHERE id = 1").run();
    const was = s.at();
    log.witnessed(() => {
      W.exec("COMMIT");
      // The row went to the end of the old generation. Then, before the witness looks: the reader ends, all is copied, the daemon writes.
      expect(s.at()).toEqual({ ...was, frame: was.frame + 1 });
      F.exec("ROLLBACK");
      K.exec("PRAGMA wal_checkpoint(PASSIVE)");
      s.write(4);
      expect(s.at().s1).not.toBe(was.s1);
    }, "starts");
    log.scan();
    expect(log.between(from, s.at())).toBeUndefined();
    log.close();
    for (const d of [K, W, F]) d.close();
  } finally { s.done(); }
});

// With the checkpoint thread at work the log is started again by the thread
// alone, each time under the write lock and around one commit, and a new
// process's first write is read the same way: no start of the log goes
// unseen. Between two snapshots a backup takes through the thread, the
// pages the log named are every page that changed, through dozens of logs.
test("with the checkpoint thread, the pages between two of its snapshots are every page that changed", async () => {
  const { Store } = await import("./store.ts");
  const { Checkpointer } = await import("./checkpoint.ts");
  const { Snapshot, snapshotTry } = await import("../admin/backup.ts");
  const dir = mkdtempSync(join(tmpdir(), "keel-log-thread-"));
  const store = new Store(dir);
  const path = join(dir, "keel.db");
  const failures: unknown[] = [];
  // A short log: it starts again every few dozen frames.
  const c = new Checkpointer(store, (e) => failures.push(e), undefined, { tickMs: 5, syncMs: 20, at: 8, soft: 24, hard: 64 });
  const until = async (f: () => boolean, ms = 10_000) => { for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 5))) if (f()) return true; return false; };
  const id = store.createSession({ model: "p:m", workspace: "/" }).id;
  const write = async (n: number) => { for (let i = 0; i < n; i++) { store.append(id, "user", { text: `row ${i} ${"x".repeat(3000)}` }); if (i % 7 === 0) await new Promise((r) => setTimeout(r, 2)); } };
  // A snapshot as a backup's thread takes it: the file as it is, and its place in the log.
  const snapshot = async () => {
    for (let tries = 0; tries < 20; tries++) {
      const snap = new Snapshot(dir);
      const gate = new Int32Array(new SharedArrayBuffer(4));
      let asked: Promise<boolean> | undefined;
      // (The thread answers on the gate from its own thread; this one waits on it.)
      const held = snapshotTry(snap, gate, () => { asked = c.snapshot(gate); }, 10_000);
      if (held && snap.at) {
        const image = readFileSync(path);
        const at = snap.at;
        snap.close();
        await asked;
        return { image, at };
      }
      snap.close();
      await asked;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("no snapshot through the thread");
  };
  try {
    c.start();
    expect(await until(() => c.armed)).toBe(true);
    await write(40);
    const one = await snapshot();
    const startsBefore = c.counts.starts;
    // Six rounds of writes, the log started again after each (a long log starts again once nothing waits).
    for (let round = 0; round < 6; round++) {
      const had = c.counts.starts;
      await write(70);
      store.db.query("UPDATE events SET data = ? WHERE session_id = ? AND seq = ?").run(JSON.stringify({ text: `changed in round ${round}` }), id, round + 2);
      expect([round, await until(() => c.counts.starts > had), failures.map(String)]).toEqual([round, true, []]);
    }
    expect(c.counts.starts - startsBefore).toBeGreaterThanOrEqual(6);
    const two = await snapshot();
    const log = new PageLog(path);
    let got = log.between(one.at, two.at);
    // (The thread writes the rows of the last frames right after the snapshot.)
    for (let i = 0; i < 100 && !got; i++) { await new Promise((r) => setTimeout(r, 10)); got = log.between(one.at, two.at); }
    expect(got).toBeDefined();
    const changed = differ(one.image, two.image);
    expect(changed.length).toBeGreaterThan(200);
    expect(changed.filter((p) => !got!.pages.has(p))).toEqual([]);
    expect(failures).toEqual([]);
    // A new process on the same store after a kill (the thread of the one before went with its loop, and the
    // log is still there): its first write is read on both sides, so a snapshot after it is still reached
    // from the one before. (A loop that went on writing after its thread was gone could start the log again
    // with nobody reading it: then the pages are not known, as the test above has it.)
    c.stop();
    const next = new Store(dir);
    const c2 = new Checkpointer(next, (e) => failures.push(e), undefined, { tickMs: 5, syncMs: 20, at: 8, soft: 24, hard: 64 });
    const snapshot2 = async () => {
      for (let tries = 0; tries < 20; tries++) {
        const snap = new Snapshot(dir);
        const gate = new Int32Array(new SharedArrayBuffer(4));
        let asked: Promise<boolean> | undefined;
        const held = snapshotTry(snap, gate, () => { asked = c2.snapshot(gate); }, 10_000);
        if (held && snap.at) { const image = readFileSync(path); const at = snap.at; snap.close(); await asked; return { image, at }; }
        snap.close();
        await asked;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("no snapshot through the thread");
    };
    try {
      c2.start();
      expect(await until(() => c2.armed)).toBe(true);
      for (let i = 0; i < 60; i++) next.append(id, "user", { text: `after ${i} ${"y".repeat(3000)}` });
      const three = await snapshot2();
      let across = log.between(one.at, three.at);
      for (let i = 0; i < 100 && !across; i++) { await new Promise((r) => setTimeout(r, 10)); across = log.between(one.at, three.at); }
      expect(across).toBeDefined();
      expect(differ(one.image, three.image).filter((p) => !across!.pages.has(p))).toEqual([]);
    } finally {
      c2.stop();
      try { next.db.close(); } catch {}
    }
    log.close();
  } finally {
    c.stop();
    try { store.db.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

// A process that ends cleanly takes its log with it (the last close copies
// every frame and removes the file). The daemon closes its log with a number
// written into the store as it exits, and the process that starts next
// follows it from there, when that number is still what the store holds.
test("a backup's place is followed across a clean end of the process, and not when anything wrote after the log was closed", async () => {
  const { Store } = await import("./store.ts");
  const { logOf } = await import("./log-pages.ts");
  const run = (after: (dir: string, path: string) => void, copied = false) => {
    const dir = mkdtempSync(join(tmpdir(), "keel-log-seal-"));
    const path = join(dir, "keel.db");
    const one = new Store(dir);
    const id = one.createSession({ model: "p:m", workspace: "/" }).id;
    const write = (st: InstanceType<typeof Store>, n: number, tag: string) => { for (let i = 0; i < n; i++) st.append(id, "user", { text: `${tag} ${i} ${"x".repeat(3000)}` }); };
    write(one, 20, "before");
    // A backup's place: the log emptied by the one writer, its end written down.
    logOf(path).witnessed(() => one.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
    const h = logHead(storeFd(`${path}-shm`))!;
    const from: LogAt = { s1: h.s1, s2: h.s2, frame: h.frame };
    const image = readFileSync(path);
    write(one, 40, "then");
    // (Every frame copied and no reader's mark: the closing write itself starts the log again.)
    if (copied) one.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    one.sealLog();
    after(dir, path);
    one.db.close();
    const two = new Store(dir);
    write(two, 30, "next");
    logOf(path).scan();
    const now = logHead(storeFd(`${path}-shm`))!;
    const got = logOf(path).between(from, { s1: now.s1, s2: now.s2, frame: now.frame });
    two.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    const changed = differ(image, readFileSync(path));
    two.db.close();
    rmSync(dir, { recursive: true, force: true });
    return { got, changed, salts: [h.s1, now.s1] };
  };
  // Closed and opened again: another log (the first one was removed), and still every changed page.
  const clean = run(() => {});
  expect(clean.salts[0]).not.toBe(clean.salts[1]);
  expect(clean.got).toBeDefined();
  expect(clean.changed.length).toBeGreaterThan(60);
  expect(clean.changed.filter((p) => !clean.got!.pages.has(p))).toEqual([]);
  const restarted = run(() => {}, true);
  expect(restarted.got).toBeDefined();
  expect(restarted.changed.filter((p) => !restarted.got!.pages.has(p))).toEqual([]);
  // The checkpoint thread wrote after the log was closed (its one row): not known.
  const late = run((dir) => {
    const w = new Database(join(dir, "keel.db"));
    w.query("UPDATE log_starts SET n = n + 1, ts = ? WHERE id = 1").run(Date.now());
    w.close();
  });
  expect(late.got).toBeUndefined();
  // Another process opened the store in between, through a Store of its own, and wrote: not known.
  const between = run((dir) => {});
  expect(between.got).toBeDefined();
  const other = (() => {
    const dir = mkdtempSync(join(tmpdir(), "keel-log-seal-"));
    const path = join(dir, "keel.db");
    const one = new Store(dir);
    const id = one.createSession({ model: "p:m", workspace: "/" }).id;
    logOf(path).witnessed(() => one.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
    const h = logHead(storeFd(`${path}-shm`))!;
    one.append(id, "user", { text: "a" });
    one.sealLog();
    one.db.close();
    const mid = new Store(dir);
    mid.append(id, "user", { text: `in between ${"y".repeat(9000)}` });
    mid.db.close();
    const two = new Store(dir);
    two.append(id, "user", { text: "b" });
    logOf(path).scan();
    const now = logHead(storeFd(`${path}-shm`))!;
    const got = logOf(path).between({ s1: h.s1, s2: h.s2, frame: h.frame }, { s1: now.s1, s2: now.s2, frame: now.frame });
    two.db.close();
    rmSync(dir, { recursive: true, force: true });
    return got;
  })();
  expect(other).toBeUndefined();
});
