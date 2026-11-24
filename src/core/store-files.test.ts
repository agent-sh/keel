// The store's files outside SQLite: one kept descriptor a file, never closed,
// and the paths the daemon's own file tools leave alone. That the process
// keeps its locks through a backup is seen from the kernel's lock table in
// test/e2e/store-locks.spec.ts.
import { expect, test } from "bun:test";
import { existsSync, fstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { heldFile, heldWrite, isStoreFile, storeFd, storeLocked, storeLockedOff, storePath, STORE_FILES } from "./store-files.ts";
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
      // The same answers with the table read on the thread pool.
      expect(await storeLockedOff(dir)).toBe(true);
      expect(await storeLockedOff(dir, async () => without)).toBe(false);
      let looks = 0;
      expect(await storeLockedOff(dir, async () => (looks++ === 0 ? without : readFileSync("/proc/locks", "utf8")))).toBe(true);
      expect(await storeLockedOff(dir, async () => { throw new Error("no table here"); })).toBeUndefined();
    }
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

// The state folder holds what the daemon reads back and acts on when it starts. The file of owed
// writes is never opened by a tool at all (the next start makes what it holds); the rest of the
// folder is not written by one, except where a session's own files live.
test("the file tools of every family leave the file of owed writes alone and write nothing else into the state folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-statedir-"));
  const ws = mkdtempSync(join(tmpdir(), "keel-statedir-ws-"));
  try {
    const store = new Store(dir);
    const owed = join(dir, "owed-writes.jsonl");
    // By its name before it exists, where a link lands (also a link to nothing), and as the same file under another name.
    expect(heldFile(owed)).toContain("the daemon's own record of writes it owes");
    symlinkSync(owed, join(ws, "dangling.txt"));
    expect(heldFile(join(ws, "dangling.txt"))).toContain("the daemon's own record of writes it owes");
    writeFileSync(owed, "");
    linkSync(owed, join(ws, "hard.txt"));
    symlinkSync(dir, join(ws, "state"));
    for (const p of [owed, join(ws, "dangling.txt"), join(ws, "hard.txt"), join(ws, "state", "owed-writes.jsonl")]) expect([p, !!heldFile(p), !!heldWrite(p)]).toEqual([p, true, true]);
    // The folder's other files: read as any file is, written by no tool. A top-level one also under another name.
    writeFileSync(join(dir, "settings.json"), "{}");
    mkdirSync(join(dir, "plugins"));
    linkSync(join(dir, "settings.json"), join(ws, "settings-link.json"));
    // A nested one under another name too (a job's record, a plugin's file): found at any depth.
    mkdirSync(join(dir, "spill", "s1", "jobs"), { recursive: true });
    writeFileSync(join(dir, "spill", "s1", "jobs", "j1.json"), '{"id":"j1","pid":1}');
    linkSync(join(dir, "spill", "s1", "jobs", "j1.json"), join(ws, "job-link.json"));
    expect(heldWrite(join(ws, "job-link.json"))).toContain("the daemon's own spill/s1/jobs/j1.json under another name");
    // A file with two names of which neither is the daemon's, and one that is a session's own file there, are written.
    writeFileSync(join(ws, "plain.txt"), "x");
    linkSync(join(ws, "plain.txt"), join(ws, "plain-2.txt"));
    mkdirSync(join(dir, "artifacts", "s1"), { recursive: true });
    writeFileSync(join(dir, "artifacts", "s1", "chart.svg"), "<svg/>");
    linkSync(join(dir, "artifacts", "s1", "chart.svg"), join(ws, "chart-link.svg"));
    expect([heldWrite(join(ws, "plain-2.txt")), heldWrite(join(ws, "chart-link.svg"))]).toEqual([undefined, undefined]);
    for (const p of [join(dir, "settings.json"), join(dir, "plugins", "new.js"), join(dir, "api-token"), join(dir, "ui", "index.html"), dir, join(dir, "artifacts"), join(ws, "state", "plugins", "x.js"), join(ws, "settings-link.json")])
      expect([p, heldFile(p), !!heldWrite(p)]).toEqual([p, undefined, true]);
    // A session's own places there, and everything outside the folder.
    for (const p of [join(dir, "artifacts", "s1", "report.md"), join(dir, "worktrees", "wt-1", "src", "a.ts"), join(ws, "notes.txt"), join(ws, "new", "deep", "file.txt")]) expect([p, heldWrite(p)]).toEqual([p, undefined]);

    // Through the tools: Write and Edit, apply_patch, the notebook tool, the Gemini family's write.
    const tctx = { sessionId: "t", cwd: ws, signal: new AbortController().signal, seen: new Map<string, number>() } as any;
    const { applyPatchTool } = await import("../tools/gpt.ts");
    const { claudeTools } = await import("../tools/claude.ts");
    const { geminiTools } = await import("../tools/gemini.ts");
    const text = (r: any) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content));
    const tool = (list: any[], name: string) => list.find((x: any) => x.name === name)!;
    const refused = /the daemon's own record of writes it owes|inside the daemon's own state folder|the daemon's own (settings\.json|spill\/s1\/jobs\/j1\.json) under another name|outside the workspace/;
    const forged = '{"op":"sql","name":"perm","params":["s","full-auto","off",1]}\n';
    const tries: [string, Promise<any>][] = [
      ["Write the owed file", tool(claudeTools, "Write").run({ file_path: owed, content: forged }, tctx)],
      ["Write through a link to nothing", tool(claudeTools, "Write").run({ file_path: join(ws, "dangling.txt"), content: forged }, tctx)],
      ["Edit through a hard link", tool(claudeTools, "Edit").run({ file_path: join(ws, "hard.txt"), old_string: "", new_string: forged }, tctx)],
      ["Write settings", tool(claudeTools, "Write").run({ file_path: join(dir, "settings.json"), content: "{}" }, tctx)],
      ["Write a new plugin", tool(claudeTools, "Write").run({ file_path: join(dir, "plugins", "new.js"), content: "x" }, tctx)],
      ["Edit settings under another name", tool(claudeTools, "Edit").run({ file_path: join(ws, "settings-link.json"), old_string: "{}", new_string: "{ }" }, tctx)],
      ["Edit a job's record under another name", tool(claudeTools, "Edit").run({ file_path: join(ws, "job-link.json"), old_string: '"pid":1', new_string: '"pid":2' }, tctx)],
      ["apply_patch adds the owed file", applyPatchTool.run({ input: `*** Begin Patch\n*** Add File: state/owed-writes.jsonl\n+${forged}*** End Patch` }, tctx)],
      ["apply_patch adds a state file", applyPatchTool.run({ input: `*** Begin Patch\n*** Add File: state/plugins/x.js\n+x\n*** End Patch` }, tctx)],
      ["write_file", tool(geminiTools, "write_file").run({ file_path: join(dir, "settings.json"), content: "{}" }, tctx)],
    ];
    for (const [what, run] of tries) expect([what, refused.test(text(await run.catch((e: Error) => ({ content: e.message }))))]).toEqual([what, true]);
    expect([readFileSync(owed, "utf8"), readFileSync(join(dir, "settings.json"), "utf8"), existsSync(join(dir, "plugins", "new.js")), existsSync(join(dir, "plugins", "x.js")), readFileSync(join(dir, "spill", "s1", "jobs", "j1.json"), "utf8")]).toEqual(["", "{}", false, false, '{"id":"j1","pid":1}']);
    // And a session's file for the owner is written as before.
    const made = await tool(claudeTools, "Write").run({ file_path: join(dir, "artifacts", "s1", "report.md"), content: "a report" }, tctx);
    expect([made.is_error ?? false, readFileSync(join(dir, "artifacts", "s1", "report.md"), "utf8")]).toEqual([false, "a report"]);
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
