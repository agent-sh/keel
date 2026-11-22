// The store's files outside SQLite: one kept descriptor a file, never closed,
// and the paths the daemon's own file tools leave alone. That the process
// keeps its locks through a backup is seen from the kernel's lock table in
// test/e2e/store-locks.spec.ts.
import { expect, test } from "bun:test";
import { fstatSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { heldFile, isStoreFile, storeFd, storeLocked, storePath, STORE_FILES } from "./store-files.ts";
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
    // Every family's tools that take a path leave the store alone, under its own name and as the same
    // file under another (a hard link in the workspace, named as an image or a notebook).
    const ws = mkdtempSync(join(tmpdir(), "keel-storefd-ws-"));
    try {
      linkSync(db, join(ws, "shot.png"));
      linkSync(db, join(ws, "book.ipynb"));
      linkSync(db, join(ws, "notes.txt"));
      const tctx = { sessionId: "t", cwd: ws, signal: new AbortController().signal, seen: new Map<string, number>([[join(ws, "book.ipynb"), 1]]) } as any;
      const { gptTools, applyPatchTool } = await import("../tools/gpt.ts");
      const { claudeTools } = await import("../tools/claude.ts");
      const text = (r: any) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content));
      const refused = /is the daemon's own store/;
      const before = statSync(db);
      expect(text(await gptTools.find((x: any) => x.name === "view_image")!.run({ path: join(ws, "shot.png") }, tctx))).toMatch(refused);
      expect(text(await claudeTools.find((x: any) => x.name === "NotebookEdit")!.run({ notebook_path: join(ws, "book.ipynb"), new_source: "x", edit_mode: "insert", cell_type: "code" }, tctx))).toMatch(refused);
      for (const patch of [
        `*** Begin Patch\n*** Update File: notes.txt\n@@\n-SQLite format\n+XQLite format\n*** End Patch`,
        `*** Begin Patch\n*** Delete File: notes.txt\n*** End Patch`,
        `*** Begin Patch\n*** Add File: ${join(dir, "keel.db-wal")}\n+x\n*** End Patch`,
      ]) expect(text(await applyPatchTool.run({ input: patch }, tctx))).toMatch(/is the daemon's own store|outside the workspace/);
      const after = statSync(db);
      expect([after.ino, after.size, after.nlink]).toEqual([before.ino, before.size, before.nlink]);
      if (process.platform === "linux") expect([locksOf(db) > 0, locksOf(`${db}-shm`) > 0]).toEqual([true, true]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
    // The lock as the kernel's table has it: there now; gone when the table has no line of this process for the file.
    if (process.platform === "linux") {
      expect(storeLocked(dir)).toBe(true);
      const ino = statSync(db).ino;
      const without = readFileSync("/proc/locks", "utf8").split("\n").filter((l) => !l.includes(`:${ino} `)).join("\n");
      expect(storeLocked(dir, () => without)).toBe(false);
      // One read that misses the line (the table changed between its parts) is not a lost lock.
      let reads = 0;
      expect(storeLocked(dir, () => (reads++ === 0 ? without : readFileSync("/proc/locks", "utf8")))).toBe(true);
      expect(storeLocked(dir, () => { throw new Error("no table here"); })).toBeUndefined();
    }
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
