// A backup is only a backup if it restores: back up a store with a session,
// events and an attachment, restore it into an empty state folder, and read
// the same thing back from a fresh Store. A changed file fails the check.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { attachmentPath, saveAttachment, setAttachmentsRoot } from "../engine/attachments.ts";
import { restore, Storage, verify } from "./storage.ts";

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
