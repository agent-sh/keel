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
