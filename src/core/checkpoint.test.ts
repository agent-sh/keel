// The checkpoint thread: the log is copied into the database off the loop,
// the daemon's connection keeps a far checkpoint of its own as the bound,
// and a thread that cannot run leaves SQLite checkpointing as it does.
import { expect, test } from "bun:test";
import { mkdtempSync, openSync, closeSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AT, Checkpointer, FAR, framesWaiting, NEAR } from "./checkpoint.ts";
import { Store } from "./store.ts";

const pragma = (store: Store, name: string) => Object.values(store.db.query<Record<string, number>, []>(`PRAGMA ${name}`).get()!)[0]!;
const until = async (f: () => boolean, ms = 30_000) => { for (const t0 = Date.now(); !f() && Date.now() - t0 < ms;) await Bun.sleep(10); return f(); };
// About `pages` pages of log.
const write = (store: Store, id: string, pages: number) => {
  for (let n = 0; n < pages / 5; n++) store.append(id, "note", { text: "x".repeat(16_000) + n });
};

test("the frames that wait are read from the log's index", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-ckpt-"));
  const store = new Store(dir);
  try {
    store.db.exec("PRAGMA wal_autocheckpoint = 0");
    const id = store.createSession({ model: "p:m", workspace: "/" }).id;
    store.db.query("PRAGMA wal_checkpoint(PASSIVE)").get();
    const shm = openSync(join(dir, "keel.db-shm"), "r");
    expect(framesWaiting(shm)).toBe(0);
    write(store, id, 400);
    const waiting = framesWaiting(shm)!;
    expect(waiting).toBeGreaterThan(300);
    // What SQLite itself says: every frame of the log, none copied yet beyond them.
    const r = store.db.query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(PASSIVE)").get()!;
    expect(r.log).toBeGreaterThanOrEqual(waiting);
    expect(r.checkpointed).toBe(r.log);
    expect(framesWaiting(shm)).toBe(0);
    closeSync(shm);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a thread syncs the log after a write and checkpoints it once enough waits; the connection keeps the far bound", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-ckpt-"));
  const store = new Store(dir);
  const failures: unknown[] = [];
  const c = new Checkpointer(store, (e) => failures.push(e), undefined, 20);
  try {
    expect(pragma(store, "wal_autocheckpoint")).toBe(NEAR);
    const limit = pragma(store, "journal_size_limit");
    const id = store.createSession({ model: "p:m", workspace: "/" }).id;
    c.start();
    // The thread answered once: the connection's own checkpoint moves out, and the log file is kept at the thread's distance.
    expect(await until(() => c.counts.checkpoints >= 1)).toBe(true);
    expect(pragma(store, "wal_autocheckpoint")).toBe(FAR);
    expect(pragma(store, "journal_size_limit")).toBeGreaterThanOrEqual(AT * 4096);
    const version = pragma(store, "data_version");
    // Under the distance the log is synced, not copied. Nothing is asked while nothing is written.
    write(store, id, 200);
    expect(await until(() => c.counts.synced >= 1)).toBe(true);
    await Bun.sleep(100);
    const asked = c.counts.asked;
    await Bun.sleep(100);
    expect(c.counts).toMatchObject({ asked, checkpoints: 1 });
    expect(c.waiting()).toBeGreaterThan(100);
    // Past it the thread copies the log: nothing is left waiting, and the connection never did it itself.
    write(store, id, AT + 500);
    expect(c.waiting()).toBeGreaterThan(AT);
    expect(await until(() => c.counts.checkpoints >= 2 && c.waiting() === 0)).toBe(true);
    expect(c.last!.checkpointed).toBe(c.last!.log);
    // A checkpoint is no write: only another connection's commit moves this (the spend total reads it).
    expect(pragma(store, "data_version")).toBe(version);
    // The next write starts the log again, and the file is cut to its limit.
    write(store, id, 10);
    expect(statSync(join(dir, "keel.db-wal")).size).toBeLessThanOrEqual(pragma(store, "journal_size_limit") + 4_096);
    expect(store.events(id).length).toBe(40 + (AT + 500) / 5 + 2);
    expect(store.db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    c.stop();
    expect(pragma(store, "wal_autocheckpoint")).toBe(NEAR);
    expect(pragma(store, "journal_size_limit")).toBe(limit);
    expect(failures).toEqual([]);
  } finally {
    c.stop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("a thread that cannot run leaves the checkpoints to SQLite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-ckpt-"));
  const store = new Store(dir);
  const failures: unknown[] = [];
  const broken = URL.createObjectURL(new Blob(["self.onmessage = () => { throw new Error('no sqlite here'); };"], { type: "application/javascript" }));
  const c = new Checkpointer(store, (e) => failures.push(e), broken, 20);
  try {
    c.start();
    expect(await until(() => c.counts.failed >= 1)).toBe(true);
    expect(pragma(store, "wal_autocheckpoint")).toBe(NEAR);
    expect(failures).toHaveLength(1);
    // Nothing is asked again; the connection checkpoints in its commits.
    const id = store.createSession({ model: "p:m", workspace: "/" }).id;
    write(store, id, 2_000);
    await Bun.sleep(100);
    expect(c.counts.asked).toBe(1);
    expect(c.waiting()).toBeLessThan(NEAR);
    expect(store.db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
  } finally {
    c.stop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

// A thread that took a request and never answers it: after the deadline it is
// ended, one error is recorded, and SQLite checkpoints in the commit again.
test("a thread that stops answering is noticed at its deadline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-ckpt-"));
  const store = new Store(dir);
  const failures: unknown[] = [];
  // Answers the first checkpoint, then takes requests and says nothing.
  const hangs = URL.createObjectURL(new Blob([`let n = 0; self.onmessage = (ev) => { const m = ev.data; if ("open" in m) return; if (n++ === 0) postMessage({ id: m.id, passes: 1, log: 0, checkpointed: 0, busy: 0 }); };`], { type: "application/javascript" }));
  const c = new Checkpointer(store, (e) => failures.push(e), hangs, 20, 300);
  try {
    c.start();
    expect(await until(() => c.counts.checkpoints >= 1)).toBe(true);
    expect(pragma(store, "wal_autocheckpoint")).toBe(FAR);
    const id = store.createSession({ model: "p:m", workspace: "/" }).id;
    write(store, id, 50);
    expect(await until(() => c.counts.failed >= 1)).toBe(true);
    expect(c.counts).toMatchObject({ asked: 2, done: 1, failed: 1 });
    expect(String((failures[0] as Error).message)).toContain("did not answer");
    expect(failures).toHaveLength(1);
    expect(pragma(store, "wal_autocheckpoint")).toBe(NEAR);
    expect(pragma(store, "journal_size_limit")).toBe(4_194_304);
    // From here the connection bounds the log by itself.
    write(store, id, 2_000);
    await Bun.sleep(100);
    expect(c.counts.asked).toBe(2);
    expect(c.waiting()).toBeLessThan(NEAR);
  } finally {
    c.stop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
