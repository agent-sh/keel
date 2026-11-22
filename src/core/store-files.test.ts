// The store's files outside SQLite: one kept descriptor a file, never closed,
// and the paths the daemon's own file tools leave alone. That the process
// keeps its locks through a backup is seen from the kernel's lock table in
// test/e2e/store-locks.spec.ts.
import { expect, test } from "bun:test";
import { fstatSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { heldFile, isStoreFile, storeFd, storePath, STORE_FILES } from "./store-files.ts";
import { readFile } from "../tools/files.ts";

const locksOf = (file: string) => {
  const ino = statSync(file).ino;
  return readFileSync("/proc/locks", "utf8").split("\n").filter((l) => {
    const f = l.trim().split(/\s+/);
    return f[1] === "POSIX" && Number(f[4]) === process.pid && f[5]?.endsWith(`:${ino}`);
  }).length;
};

test("a descriptor of the store's files is opened once and kept; the file tools leave the files alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-storefd-"));
  const other = mkdtempSync(join(tmpdir(), "keel-storefd-other-"));
  try {
    // Before a store is open in the folder its files are files like any other.
    expect(isStoreFile(storePath(dir))).toBe(false);
    const store = new Store(dir);
    const id = store.createSession({ model: "p:m", workspace: "/" }).id;
    store.append(id, "note", { text: "x" });
    const db = storePath(dir);
    for (const f of STORE_FILES) expect(isStoreFile(join(dir, f))).toBe(true);
    expect(isStoreFile(join(dir, "keel.db.zst"))).toBe(false);
    // The same names in a folder with no store of this process are not held.
    writeFileSync(join(other, "keel.db"), "not a store");
    expect(isStoreFile(join(other, "keel.db"))).toBe(false);
    expect(heldFile(join(other, "keel.db"))).toBeUndefined();
    // The store's own file under another name is the same file to the kernel.
    linkSync(db, join(other, "another-name"));
    expect(isStoreFile(join(other, "another-name"))).toBe(true);

    // One descriptor a file, the same each time, of that file.
    const fd = storeFd(db);
    expect(storeFd(db)).toBe(fd);
    expect(fstatSync(fd).ino).toBe(statSync(db).ino);
    expect(storeFd(`${db}-wal`)).not.toBe(fd);
    expect(() => storeFd(join(dir, "keel.db-nothing"))).toThrow();
    // A file put in its place under the same name gets a descriptor of its own; the first stays open.
    const moved = join(other, "moved.db");
    writeFileSync(moved, "a");
    const first = storeFd(moved);
    rmSync(moved);
    writeFileSync(moved, "b");
    const second = storeFd(moved);
    expect(second).not.toBe(first);
    expect(() => fstatSync(first)).not.toThrow();

    // The daemon's own file tools do not open the store's files: they say why.
    const ctx = { seen: new Map<string, number>() } as any;
    const read = await readFile(db, ctx);
    expect(read.error).toBe(true);
    expect(String(read.content)).toContain("is the daemon's own store");
    expect(heldFile(`${db}-shm`)).toContain("is not opened from inside the daemon");
    // And with all of that the process still holds its locks on the store (Linux tells).
    if (process.platform === "linux") {
      expect(locksOf(db)).toBeGreaterThan(0);
      expect(locksOf(`${db}-shm`)).toBeGreaterThan(0);
    }
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
