// A backup is only a backup if it restores: back up a store with a session,
// events and an attachment, restore it into an empty state folder, and read
// the same thing back from a fresh Store. A changed file fails the check.
import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { attachmentPath, saveAttachment, setAttachmentsRoot } from "../engine/attachments.ts";
import { restore, Storage, undoCutRestore, verify } from "./storage.ts";

test("a backup restores into an empty state folder", () => {
  const root = mkdtempSync(join(tmpdir(), "keel-backup-"));
  try {
    const src = new Store(join(root, "src"));
    const s = src.createSession({ model: "p:m", workspace: root, title: "kept" });
    const image = { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" };
    src.append(s.id, "user", { text: "hello", images: [image] });
    src.append(s.id, "assistant", { blocks: [{ type: "text", text: "hi" }], model: "p:m", usage: {}, stop: "end_turn" });
    const storage = new Storage(src, {} as any, new Bus(), {} as any);
    const b = storage.backup("test");
    expect(b.sessions).toBe(1);
    expect(b.events).toBe(2);

    const dst = join(root, "dst");
    const r = restore(dst, b.path);
    expect(r.ok).toBe(true);
    const back = new Store(dst);
    expect(back.session(s.id)?.title).toBe("kept");
    expect(back.events(s.id).map((e) => [e.id, e.seq, e.kind])).toEqual(src.events(s.id).map((e) => [e.id, e.seq, e.kind]));
    expect(back.events(s.id)[0]!.data.images[0].data).toBe(image.data);

    appendFileSync(join(b.path, "keel.db"), "x");
    const bad = verify(b.path);
    expect(bad.ok).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a backup carries uploaded files and a restore reads as the backup did", () => {
  const root = mkdtempSync(join(tmpdir(), "keel-backup-"));
  try {
    const src = new Store(join(root, "src"));
    setAttachmentsRoot(src.stateDir);
    const bytes = new TextEncoder().encode("depot ledger 7781");
    const ref = saveAttachment(bytes, "note.txt", "text/plain");
    const s = src.createSession({ model: "p:m", workspace: root });
    src.append(s.id, "user", { text: "read it", attachments: [ref] });
    src.append(s.id, "user", { text: "again", attachments: [ref] });
    const b = new Storage(src, {} as any, new Bus(), {} as any).backup("test");
    // A settings file written after the backup does not survive its restore.
    writeFileSync(join(src.stateDir, "settings.json"), JSON.stringify({ archive: { archive_idle_days: 99 } }));
    src.db.close();

    const dst = join(root, "dst");
    const r = restore(dst, b.path);
    setAttachmentsRoot(dst);
    const path = attachmentPath(ref.id)!;
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(ref.id);
    restore(join(root, "src"), b.path);
    expect(existsSync(join(root, "src", "settings.json"))).toBe(false);
    expect(r.ok).toBe(true);

    writeFileSync(join(b.path, "attachments", ref.id, "note.txt"), "other");
    expect(verify(b.path).ok).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable manifest is listed beside the others, not instead of them", () => {
  const root = mkdtempSync(join(tmpdir(), "keel-backup-"));
  try {
    const src = new Store(join(root, "src"));
    const storage = new Storage(src, {} as any, new Bus(), {} as any);
    const names = [storage.backup("a").name, storage.backup("b").name, storage.backup("c").name];
    writeFileSync(join(src.stateDir, "backups", names[1]!, "manifest.json"), '{"created_ms": 1,');
    const list = storage.backups();
    expect(list.map((b) => b.name)).toEqual([...names].reverse());
    expect(list[1]!.unreadable).toContain("manifest.json");
    expect(list[0]!.unreadable).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup skips a family whose subagent started working after the list", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-cleanup-"));
  try {
    const store = new Store(join(root, "s"));
    store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions(id) ON DELETE CASCADE");
    const p = store.createSession({ model: "p:m", workspace: root, title: "parent" });
    const c = store.createSession({ model: "p:m", workspace: root, title: "child" });
    const old = Date.now() - 40 * 86_400_000;
    store.db.run("UPDATE sessions SET archived = 1, updated = ? WHERE id = ?", [old, p.id]);
    store.db.run("UPDATE sessions SET parent_id = ?, updated = ? WHERE id = ?", [p.id, old, c.id]);
    const removed: string[] = [];
    const storage = new Storage(store, { isRunning: () => false, interrupt: async () => {} } as any, new Bus(), {} as any);
    storage.removeSession = async (id: string) => void removed.push(id);
    const list = storage.candidates(30);
    expect(list[0]!.subagents.map((s) => s.title)).toEqual(["child"]);
    store.db.run("UPDATE sessions SET phase = 'working', updated = ? WHERE id = ?", [Date.now(), c.id]);
    const r = await storage.cleanup(30, list);
    expect(removed).toEqual([]);
    expect(r.skipped[0]!.why).toContain("child");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A disk fault for the restore tests: while `fault` is set, putting a file at
// a path it names (a copy or a rename) fails the way a bad disk does.
let fault: ((to: string, from: string) => boolean) | null = null;
const real = { ...fs };
const failing = <F extends (from: any, to: any, ...rest: any[]) => any>(f: F) => ((from: any, to: any, ...rest: any[]) => {
  if (fault?.(String(to), String(from))) throw Object.assign(new Error(`EIO: i/o error, ${String(to)}`), { code: "EIO" });
  return f(from, to, ...rest);
}) as F;
mock.module("node:fs", () => ({ ...real, copyFileSync: failing(real.copyFileSync), renameSync: failing(real.renameSync) }));

// A backup holding one session, and a state folder in use holding another,
// with a settings file the backup does not have.
function backupAndState(root: string) {
  const src = new Store(join(root, "src"));
  src.createSession({ model: "p:m", workspace: root, title: "from the backup" });
  const b = new Storage(src, {} as any, new Bus(), {} as any).backup("test");
  src.db.close();
  const dst = join(root, "dst");
  const cur = new Store(dst);
  cur.createSession({ model: "p:m", workspace: root, title: "in use" });
  cur.db.close();
  writeFileSync(join(dst, "settings.json"), JSON.stringify({ archive: { archive_idle_days: 7 } }));
  return { backup: b.path, dst };
}
const titles = (db: string) => {
  const d = new Database(db, { readonly: true });
  try { return d.query<{ title: string }, []>("SELECT title FROM sessions ORDER BY title").all().map((r) => r.title); } finally { d.close(); }
};
// What a daemon would open: the sessions and the settings file, and nothing a restore left behind.
const stateOf = (dst: string) => ({
  sessions: existsSync(join(dst, "keel.db")) ? titles(join(dst, "keel.db")) : null,
  settings: existsSync(join(dst, "settings.json")) ? readFileSync(join(dst, "settings.json"), "utf8") : null,
  left: readdirSync(dst).filter((f) => f.startsWith("restore.pending") || f.startsWith(".restore-") || f.startsWith("before-restore-")),
});
const IN_USE = { sessions: ["in use"], settings: JSON.stringify({ archive: { archive_idle_days: 7 } }), left: [] };

test("a restore that fails while the backup goes in leaves the state as it was, and the retry restores", () => {
  const root = mkdtempSync(join(tmpdir(), "keel-restore-"));
  try {
    const { backup, dst } = backupAndState(root);
    // The fault: the backup's database cannot be put in place (the one in use can be moved back).
    fault = (to, from) => to === join(dst, "keel.db") && !from.includes("before-restore-");
    let failed: Error | undefined;
    try { restore(dst, backup); } catch (e) { failed = e as Error; }
    fault = null;
    expect(stateOf(dst)).toEqual(IN_USE);
    expect(failed?.message).toContain("the restore failed and the state is as it was: EIO");

    const r = restore(dst, backup);
    expect(r.ok).toBe(true);
    const now = stateOf(dst);
    expect(now).toMatchObject({ sessions: ["from the backup"], settings: null });
    // What it replaced is kept beside it, whole.
    expect(now.left).toEqual([r.aside.slice(dst.length + 1)]);
    expect(titles(join(r.aside, "keel.db"))).toEqual(["in use"]);
    expect(readFileSync(join(r.aside, "settings.json"), "utf8")).toBe(IN_USE.settings);
  } finally {
    fault = null;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a restore cut in the middle of its swap is undone before the state is used again", () => {
  const root = mkdtempSync(join(tmpdir(), "keel-restore-"));
  try {
    const { backup, dst } = backupAndState(root);
    // The disk goes away in the middle: the database cannot be put in place,
    // and nothing can be moved back either.
    let gone = false;
    fault = (to) => gone || (gone = to === join(dst, "keel.db"));
    expect(() => restore(dst, backup)).toThrow("could not be undone now");
    fault = null;
    // In the middle: the database in use was moved aside and nothing took its place.
    expect(stateOf(dst).sessions).toBeNull();

    expect(undoCutRestore(dst)).toBe(true);
    expect(stateOf(dst)).toEqual(IN_USE);
    expect(undoCutRestore(dst)).toBe(false);

    // A restore begins by undoing one that was cut.
    gone = false;
    fault = (to) => gone || (gone = to === join(dst, "keel.db"));
    expect(() => restore(dst, backup)).toThrow("could not be undone now");
    fault = null;
    const r = restore(dst, backup);
    expect(stateOf(dst)).toMatchObject({ sessions: ["from the backup"], settings: null, left: [r.aside.slice(dst.length + 1)] });
    expect(titles(join(r.aside, "keel.db"))).toEqual(["in use"]);
  } finally {
    fault = null;
    rmSync(root, { recursive: true, force: true });
  }
});
