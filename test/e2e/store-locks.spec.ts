import { expect, test } from "./isolate.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { daemon, exited, ROOT } from "./own-daemon.ts";

// Feature: the daemon holds its locks on the store for its whole life.
//
// SQLite's locks are the process's: a daemon that opens one of the store's
// files outside SQLite and closes it has none left, and the next process
// that opens the store read-write and closes it removes the log under the
// daemon (src/core/store-files.ts). Here a daemon of the spec's own makes a
// backup, a storage report and a problem report, and the kernel's lock table
// is read after each: the daemon's locks on keel.db and on the log's index
// are there. Another process then opens the store read-write and closes it,
// and the log is the same file. A clean stop gives the locks up only as
// SQLite closes the store.
test.skip(process.platform !== "linux" || !existsSync("/proc/locks"), "the kernel's lock table is read from /proc/locks");
test.skip(spawnSync("python3", ["-c", "import sqlite3"]).status !== 0, "the other process is the system's SQLite, through python3");

// The POSIX locks process `pid` holds on `file`, from /proc/locks ("N: POSIX ADVISORY READ pid major:minor:inode start end").
function locks(pid: number, file: string): number {
  let ino: number;
  try { ino = statSync(file).ino; } catch { return 0; }
  return readFileSync("/proc/locks", "utf8").split("\n").filter((l) => {
    const f = l.trim().split(/\s+/);
    return f[1] === "POSIX" && Number(f[4]) === pid && f[5]?.endsWith(`:${ino}`);
  }).length;
}
// An open descriptor of this database, not just a process still finishing shutdown.
const dbFd = (pid: number, db: string) => {
  const dir = `/proc/${pid}/fd`;
  try {
    return readdirSync(dir).find((fd) => {
      try { return readlinkSync(join(dir, fd)) === db; } catch { return false; }
    });
  } catch { return undefined; }
};

test("the daemon keeps its locks on the store through a backup, its reports and a second process, until it closes the store", async ({ request }) => {
  test.setTimeout(180_000);
  const state = join(ROOT, `store-locks-${Date.now()}`);
  const db = join(state, "keel.db"), shm = `${db}-shm`, wal = `${db}-wal`;
  const d = await daemon(state);
  try {
    const pid = (await (await request.get(`${d.url}/api/daemon`)).json()).pid as number;
    const held = () => ({ db: locks(pid, db) > 0, shm: locks(pid, shm) > 0 });
    // Something to back up, and a log with frames in it.
    const s = (await (await request.post(`${d.url}/api/sessions`, { data: { title: "Held" } })).json()).session;
    await request.post(`${d.url}/api/sessions/${s.id}/messages`, { data: { text: "script:render please" } });
    await expect.poll(async () => (await (await request.get(`${d.url}/api/sessions/${s.id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 60_000 }).toBe(true);
    expect(held()).toEqual({ db: true, shm: true });

    // A backup (twice: a full one, then one that holds the changed pages), a storage report, a problem report.
    for (let i = 0; i < 2; i++) {
      const made = await request.post(`${d.url}/api/backups`);
      expect(made.status(), await made.text()).toBe(201);
      expect(held(), `after backup ${i + 1}`).toEqual({ db: true, shm: true });
      await request.post(`${d.url}/api/sessions/${s.id}/messages`, { data: { text: "script:render again" } });
      await expect.poll(async () => (await (await request.get(`${d.url}/api/sessions/${s.id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 60_000 }).toBe(i + 2);
    }
    expect((await request.get(`${d.url}/api/storage?refresh=1`)).ok()).toBe(true);
    expect(held(), "after the storage report").toEqual({ db: true, shm: true });
    expect((await request.post(`${d.url}/api/report`, { data: { session_id: s.id, note: "locks" } })).ok()).toBe(true);
    expect(held(), "after the problem report").toEqual({ db: true, shm: true });
    // The backups are checked after their answer, on the daemon's own time: once that is over too.
    await expect.poll(async () => (await (await request.get(`${d.url}/api/backups`)).json()).backups.every((b: any) => (b.checked ?? "whole") === "whole" || b.failed), { timeout: 60_000 }).toBe(true);
    expect(held(), "after the backups were read back").toEqual({ db: true, shm: true });

    // Another process opens the store read-write and closes it. With the daemon's lock in place its
    // close cannot take the store for itself (SQLite's last connection to close checkpoints and removes
    // the log): the log and its index are the files they were.
    const before = { wal: statSync(wal).ino, shm: statSync(shm).ino };
    const logBytes = statSync(wal).size;
    expect(logBytes).toBeGreaterThan(0);
    // (The system's SQLite, through python: its last connection to close removes the log. Bun's own keeps
    // the file and cuts it to nothing, which loses the same frames.)
    const other = execFileSync("python3", ["-c", `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1], isolation_level=None, timeout=5)
n = c.execute("SELECT COUNT(*) FROM events").fetchone()[0]
c.execute("CREATE TABLE IF NOT EXISTS other_process (n INTEGER)")
c.execute("DROP TABLE other_process")
c.close()
sys.stdout.write(str(n))
`, db], { encoding: "utf8" });
    expect(Number(other)).toBeGreaterThan(0);
    expect({ wal: existsSync(wal) && statSync(wal).ino, shm: existsSync(shm) && statSync(shm).ino }).toEqual(before);
    expect(statSync(wal).size).toBeGreaterThanOrEqual(logBytes);
    expect(held(), "after the other process").toEqual({ db: true, shm: true });
    // What the daemon writes after it is in the store another process reads.
    await request.post(`${d.url}/api/sessions/${s.id}/messages`, { data: { text: "script:render once more" } });
    await expect.poll(async () => (await (await request.get(`${d.url}/api/sessions/${s.id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 60_000 }).toBe(4);
    const seen = execFileSync("bun", ["-e", `
      import { Database } from "bun:sqlite";
      const db = new Database(process.env.STORE_DB, { readonly: true });
      process.stdout.write(String(db.query("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND kind = 'turn_end'").get(process.env.STORE_SESSION).n));
      db.close();
    `], { encoding: "utf8", env: { ...process.env, STORE_DB: db, STORE_SESSION: s.id } });
    expect(Number(seen.trim())).toBe(4);

    // A clean stop: count a missing lock only while the store is still open. The process can
    // outlive database close, and the lock table and files are not one atomic snapshot.
    let bare = 0, samples = 0;
    const gone = exited(d.proc);
    let ended = false;
    void gone.then(() => (ended = true));
    d.proc.kill("SIGTERM");
    while (!ended) {
      const fd = dbFd(pid, db);
      const had = !fd || locks(pid, db) > 0;
      let log = 0;
      try { log = statSync(wal).size; } catch {}
      if (!had && log > 0 && dbFd(pid, db) === fd && locks(pid, db) === 0 && dbFd(pid, db) === fd) bare++;
      samples++;
      await new Promise((r) => setTimeout(r, 2));
    }
    await gone;
    expect(samples).toBeGreaterThan(0);
    expect(bare).toBe(0);
    // Closed by SQLite itself: the log was emptied and removed.
    expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);
  } finally {
    if (d.proc.exitCode === null) { d.proc.kill("SIGKILL"); await exited(d.proc); }
    rmSync(state, { recursive: true, force: true });
  }
});
