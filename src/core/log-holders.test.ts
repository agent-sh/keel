import { expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logHolders, logStartLine } from "./log-holders.ts";

// A start that reads a long log names what holds it, and does not call it an unclean stop.
test("a long log is said with its holders by name", () => {
  const dir = join(process.env.TMPDIR ?? join(process.env.HOME!, ".cache"), `log-holders-${Date.now()}`);
  const proc = join(dir, "proc");
  const proc7 = (pid: number, comm: string, target: string) => {
    mkdirSync(join(proc, String(pid), "fd"), { recursive: true });
    writeFileSync(join(proc, String(pid), "comm"), `${comm}\n`);
    symlinkSync(target, join(proc, String(pid), "fd", "3"));
  };
  try {
    proc7(7, "sqlite3", "/state/store.db-wal");
    proc7(8, "other", "/state/other.db-wal");
    proc7(9, "mine", "/state/store.db-wal");
    mkdirSync(join(proc, "self"), { recursive: true });
    const found = logHolders(["/state/store.db-wal", "/state/store.db-shm"], proc, 9);
    expect(found).toEqual([{ pid: 7, name: "sqlite3" }]);
    expect(logStartLine(133, found)).toBe("[store] reading 133 MB of the store's log, held open by sqlite3 (pid 7): it could not be emptied while they read");
    expect(logStartLine(133, [])).not.toContain("did not stop cleanly");
    expect(logHolders(["/x"], join(dir, "none"))).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
