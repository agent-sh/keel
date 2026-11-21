// A backup is only a backup if it restores: back up a store with a session,
// events and an attachment, restore it into an empty state folder, and read
// the same thing back from a fresh Store. A changed file fails the check.
import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { attachmentPath, saveAttachment, setAttachmentsRoot } from "../engine/attachments.ts";
import { adminCommands } from "../cli/admin.ts";
import { mobileCommands } from "../cli/mobile.ts";
import { HASH_CHUNK, hashFile, restore, Storage, undoCutRestore, verify } from "./storage.ts";

test("a backup restores into an empty state folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-backup-"));
  try {
    const src = new Store(join(root, "src"));
    const s = src.createSession({ model: "p:m", workspace: root, title: "kept" });
    const image = { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" };
    src.append(s.id, "user", { text: "hello", images: [image] });
    src.append(s.id, "assistant", { blocks: [{ type: "text", text: "hi" }], model: "p:m", usage: {}, stop: "end_turn" });
    const storage = new Storage(src, {} as any, new Bus(), {} as any);
    const b = await storage.backup("test");
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

// A backup is made in a worker: the daemon's loop goes on turning while the
// database is copied, hashed and checked, and a second backup asked for
// meanwhile waits its turn.
test("the loop turns while a backup is made", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-backup-"));
  try {
    const src = new Store(join(root, "src"));
    const s = src.createSession({ model: "p:m", workspace: root, title: "kept" });
    for (let i = 0; i < 200; i++) src.append(s.id, "user", { text: "x".repeat(4000) });
    const storage = new Storage(src, {} as any, new Bus(), {} as any);
    let turns = 0;
    const tick = setInterval(() => turns++, 1);
    const [a, b] = await Promise.all([storage.backup("one"), storage.backup("two")]);
    clearInterval(tick);
    expect(turns).toBeGreaterThan(0);
    expect(a.name).not.toBe(b.name);
    expect(storage.backups().map((x) => x.reason)).toEqual(["two", "one"]);
    expect(readdirSync(join(src.stateDir, "backups")).filter((d) => d.endsWith(".partial"))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The owner's config folder goes with the state. A restore puts its files
// back only into a folder the caller names, each at the mode the live file
// has, with what it replaced kept as .prev. A sign-in is neither copied nor
// put back, and nothing in the folder can fail a backup.
test("a backup carries the config folder, and a restore puts it back where it is told to", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-backup-"));
  const config = join(root, "config");
  try {
    fs.mkdirSync(join(config, "agents"), { recursive: true });
    writeFileSync(join(config, "mcp.json"), '{"servers":{"a":{"command":"a"}}}');
    writeFileSync(join(config, "agents", "scout.md"), "scout");
    writeFileSync(join(config, "fcm-service-account.json"), "key");
    fs.chmodSync(join(config, "fcm-service-account.json"), 0o600);
    writeFileSync(join(config, "xai-auth.json"), "grant-then");
    writeFileSync(join(config, "mcp.json.prev"), "older");
    fs.symlinkSync("/etc/hostname", join(config, "linked"));
    // A tool's own store is not configuration, and a file that cannot be read fails nothing.
    for (const d of [".venv", "skills/x/node_modules", "skills/x"]) fs.mkdirSync(join(config, d), { recursive: true });
    writeFileSync(join(config, ".venv", "big.bin"), "x".repeat(4096));
    writeFileSync(join(config, "skills", "x", "node_modules", "p.js"), "p");
    writeFileSync(join(config, "skills", "x", "SKILL.md"), "skill");
    writeFileSync(join(config, "skills", "x", "locked.txt"), "no");
    fs.chmodSync(join(config, "skills", "x", "locked.txt"), 0);
    const src = new Store(join(root, "src"));
    src.createSession({ model: "p:m", workspace: root, title: "kept" });
    const caught: unknown[][] = [];
    const storage = new Storage(src, {} as any, new Bus(), { capture: (...a: unknown[]) => caught.push(a) } as any, config);
    const b = await storage.backup("test");
    const mode = (p: string) => fs.statSync(p).mode & 0o777;
    const held = (dir: string, under = ""): string[] => readdirSync(join(dir, under)).flatMap((n) => (fs.statSync(join(dir, under, n)).isDirectory() ? held(dir, join(under, n)) : [join(under, n)])).sort();
    expect(held(join(b.path, "config"))).toEqual(["agents/scout.md", "fcm-service-account.json", "mcp.json", "skills/x/SKILL.md"]);
    const manifest = JSON.parse(readFileSync(join(b.path, "manifest.json"), "utf8"));
    expect(manifest.config.dir).toBe(config);
    expect(manifest.config.skipped.map((x: { name: string }) => x.name)).toEqual(["skills/x/locked.txt"]);
    expect(caught.length).toBe(1);
    // No copy is easier to read than its original.
    expect(mode(join(b.path, "config", "fcm-service-account.json"))).toBe(0o600);
    expect(mode(join(b.path, "config"))).toBe(0o700);
    expect(verify(b.path).ok).toBe(true);
    // A keel from before config was carried checks the files the manifest lists and names the first one missing: this sentence.
    expect(manifest.files[0].name).toStartWith("a keel that knows backups with a config folder");
    expect(existsSync(join(b.path, manifest.files[0].name))).toBe(false);

    // The next backup: an unchanged file is a second name for the first backup's copy, a changed one is copied.
    writeFileSync(join(config, "agents", "scout.md"), "scout, changed");
    const b2 = await storage.backup("test");
    const ino = (p: string) => fs.statSync(p).ino;
    expect(ino(join(b2.path, "config", "mcp.json"))).toBe(ino(join(b.path, "config", "mcp.json")));
    expect(ino(join(b2.path, "config", "agents", "scout.md"))).not.toBe(ino(join(b.path, "config", "agents", "scout.md")));
    expect(ino(join(b2.path, "config", "mcp.json"))).not.toBe(ino(join(config, "mcp.json"))); // never the live file
    expect(readFileSync(join(b2.path, "config", "agents", "scout.md"), "utf8")).toBe("scout, changed");
    expect(verify(b2.path).ok).toBe(true);
    src.db.close();

    // Since the first backup: a server list changed and narrowed to the owner, a file lost, a newer sign-in, a file the backup never held.
    writeFileSync(join(config, "mcp.json"), '{"servers":{}}');
    fs.chmodSync(join(config, "mcp.json"), 0o600);
    rmSync(join(config, "agents", "scout.md"));
    writeFileSync(join(config, "xai-auth.json"), "grant-now");
    writeFileSync(join(config, "hooks.json"), "{}");
    // Not told a config folder: the state alone.
    expect(restore(join(root, "src"), b.path).config_files).toBe(0);
    expect(readFileSync(join(config, "mcp.json"), "utf8")).toBe('{"servers":{}}');
    const r = restore(join(root, "src"), b.path, config);
    expect(r.config_files).toBe(2);
    expect(readFileSync(join(config, "mcp.json"), "utf8")).toBe('{"servers":{"a":{"command":"a"}}}');
    expect(mode(join(config, "mcp.json"))).toBe(0o600); // the mode the owner gave it since
    expect(readFileSync(join(config, "mcp.json.prev"), "utf8")).toBe('{"servers":{}}');
    expect(readFileSync(join(config, "agents", "scout.md"), "utf8")).toBe("scout");
    expect(mode(join(config, "fcm-service-account.json"))).toBe(0o600);
    expect(readFileSync(join(config, "xai-auth.json"), "utf8")).toBe("grant-now");
    expect(readFileSync(join(config, "hooks.json"), "utf8")).toBe("{}");
    // A changed config file in a backup fails its check, as any other file of it does.
    fs.chmodSync(join(b.path, "config", "agents", "scout.md"), 0o600);
    writeFileSync(join(b.path, "config", "agents", "scout.md"), "other");
    expect(() => restore(join(root, "dst"), b.path, config)).toThrow("changed since the backup was made");
  } finally {
    fs.chmodSync(join(config, "skills", "x", "locked.txt"), 0o600);
    rmSync(root, { recursive: true, force: true });
  }
});

// keel restore, from a shell whose config folder is neither the one the
// backup was made from nor anything to do with the state folder named: the
// case that would rewrite the owner's servers with a scratch daemon's.
// A file that did not change shares the previous backup's copy. A copy that
// was changed inside a backup since is not shared again: the next backup
// holds the live file and checks out, where it used to carry the damage on.
test("a config copy damaged inside one backup is not linked into the next", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-backup-"));
  const config = join(root, "config");
  try {
    fs.mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "mcp.json"), '{"servers":{"a":{"command":"a"}}}');
    const store = new Store(join(root, "src"));
    store.createSession({ model: "p:m", workspace: root, title: "kept" });
    const storage = new Storage(store, {} as any, new Bus(), { capture: () => {} } as any, config);
    const one = await storage.backup("test");
    const two = await storage.backup("test");
    expect(fs.statSync(join(two.path, "config", "mcp.json")).ino).toBe(fs.statSync(join(one.path, "config", "mcp.json")).ino);
    // Written in place, so every backup linked to it changes with it.
    writeFileSync(join(two.path, "config", "mcp.json"), '{"servers":{"b":{"command":"b"}}}');
    const three = await storage.backup("test");
    expect(verify(three.path).ok).toBe(true);
    expect(fs.readFileSync(join(three.path, "config", "mcp.json"), "utf8")).toBe('{"servers":{"a":{"command":"a"}}}');
    store.db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keel restore leaves the config folder alone unless asked, and asks for the folder when it is another", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-backup-"));
  const made = join(root, "made-config"), shell = join(root, "shell-config"), other = join(root, "other-config");
  const kept = process.env.KEEL_CONFIG_DIR;
  const said: string[] = [];
  const log = console.log, error = console.error;
  console.log = console.error = (...a: unknown[]) => { said.push(a.join(" ")); };
  try {
    for (const [d, text] of [[made, '{"servers":{"stand-in":{"command":"x"}}}'], [shell, '{"servers":{"owners":{"command":"y"}}}']] as const) {
      fs.mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "mcp.json"), text);
    }
    const src = new Store(join(root, "one"));
    src.createSession({ model: "p:m", workspace: root, title: "kept" });
    const b = await new Storage(src, {} as any, new Bus(), {} as any, made).backup("test");
    src.db.close();
    const state = join(root, "two");
    const run = async (...args: string[]) => { said.length = 0; return adminCommands.restore([b.path, "--state-dir", state, ...args]); };
    const servers = (d: string) => readFileSync(join(d, "mcp.json"), "utf8");
    process.env.KEEL_CONFIG_DIR = shell;

    expect(await run()).toBe(0);
    expect(servers(shell)).toContain("owners");
    expect(said.join("\n")).toContain(`left alone: the 1 config file this backup carries, from ${made}`);
    expect(said.join("\n")).toContain(`--config=${made}`);
    expect(new Store(state).sessions().length).toBe(1);

    // Asked, but this shell's folder is not the backup's: nothing moves, the state included.
    const before = readdirSync(state).sort();
    expect(await run("--config")).toBe(1);
    expect(said.join("\n")).toContain(`came from ${made}, and this shell's config folder is ${shell}`);
    expect(servers(shell)).toContain("owners");
    expect(readdirSync(state).sort()).toEqual(before);

    // The folder spelled out, and the shell the backup was made from.
    expect(await run(`--config=${other}`)).toBe(0);
    expect(servers(other)).toContain("stand-in");
    expect(said.join("\n")).toContain(`into ${other}, which is not the folder they came from (${made})`);
    expect(servers(shell)).toContain("owners");
    process.env.KEEL_CONFIG_DIR = made;
    writeFileSync(join(made, "mcp.json"), '{"servers":{}}');
    expect(await run("--config")).toBe(0);
    expect(servers(made)).toContain("stand-in");
    expect(said.join("\n")).toContain(`put back 1 of 1 config file into ${made}`);
    expect(servers(shell)).toContain("owners");

    // "--config DIR" with a space, from the shell the backup was made in: the
    // folder would be read as a second backup and the files put into the
    // shell's own folder. Refused, with nothing moved.
    writeFileSync(join(made, "mcp.json"), '{"servers":{"edited-since":{"command":"z"}}}');
    const stateBefore = readdirSync(state).sort();
    expect(await run("--config", other)).toBe(1);
    expect(said.join("\n")).toContain("--config=DIR");
    expect(servers(made)).toContain("edited-since");
    expect(readdirSync(state).sort()).toEqual(stateBefore);
    // The hint after a plain restore names the state folder it was run with.
    process.env.KEEL_CONFIG_DIR = shell;
    expect(await run()).toBe(0);
    expect(said.join("\n")).toContain(`--state-dir ${state} --config=${made}`);
  } finally {
    console.log = log;
    console.error = error;
    process.env.KEEL_CONFIG_DIR = kept;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a backup carries uploaded files and a restore reads as the backup did", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-backup-"));
  try {
    const src = new Store(join(root, "src"));
    setAttachmentsRoot(src.stateDir);
    const bytes = new TextEncoder().encode("depot ledger 7781");
    const ref = saveAttachment(bytes, "note.txt", "text/plain");
    const s = src.createSession({ model: "p:m", workspace: root });
    src.append(s.id, "user", { text: "read it", attachments: [ref] });
    src.append(s.id, "user", { text: "again", attachments: [ref] });
    const b = await new Storage(src, {} as any, new Bus(), {} as any).backup("test");
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

// A file of several chunks: the same hash as reading it whole gives, no read
// larger than a chunk; a backup carries it, and a byte changed at its very end
// (in the last chunk) fails the check.
test("a large file is hashed a chunk at a time, and a change at its end is caught", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-backup-"));
  try {
    const bytes = Buffer.alloc(3 * HASH_CHUNK + 4321);
    for (let i = 0; i + 4 <= bytes.length; i += 4) bytes.writeUInt32LE((i * 2654435761) >>> 0, i);
    const whole = createHash("sha256").update(bytes).digest("hex");
    const file = join(root, "big.bin");
    writeFileSync(file, bytes);
    const reads: number[] = [];
    const counted = ((fd: number, buf: Uint8Array, off: number, len: number, pos: null) => { const n = readSync(fd, buf, off, len, pos); reads.push(len); return n; }) as typeof readSync;
    expect(hashFile(file, counted)).toBe(whole);
    expect(Math.max(...reads)).toBe(HASH_CHUNK);
    expect(reads.length).toBe(5); // four chunks and the read that finds the end
    writeFileSync(join(root, "empty"), "");
    expect(hashFile(join(root, "empty"))).toBe(createHash("sha256").update("").digest("hex"));

    const src = new Store(join(root, "src"));
    setAttachmentsRoot(src.stateDir);
    const ref = saveAttachment(bytes, "big.bin", "application/octet-stream");
    expect(ref.id).toBe(whole);
    const s = src.createSession({ model: "p:m", workspace: root });
    src.append(s.id, "user", { text: "read it", attachments: [ref] });
    const b = await new Storage(src, {} as any, new Bus(), {} as any).backup("test");
    const m = JSON.parse(readFileSync(join(b.path, "manifest.json"), "utf8")) as { files: { name: string; sha256: string; bytes: number }[] };
    expect(m.files.find((f) => f.name === `attachments/${whole}/big.bin`)).toEqual({ name: `attachments/${whole}/big.bin`, bytes: bytes.length, sha256: whole });
    expect(m.files.find((f) => f.name === "keel.db")!.sha256).toBe(createHash("sha256").update(readFileSync(join(b.path, "keel.db"))).digest("hex"));
    expect(verify(b.path).ok).toBe(true);
    src.db.close();
    const dst = join(root, "dst");
    expect(restore(dst, b.path).ok).toBe(true);
    setAttachmentsRoot(dst);
    expect(hashFile(attachmentPath(ref.id)!)).toBe(whole);

    // The last byte of the copy changes (its own file: the backup's is a hard link of the store's).
    const kept = join(b.path, "attachments", whole, "big.bin");
    const changed = Buffer.from(bytes);
    changed[changed.length - 1]! ^= 1;
    rmSync(kept);
    writeFileSync(kept, changed);
    const bad = verify(b.path);
    expect(bad).toEqual({ ok: false, why: `attachments/${whole}/big.bin changed since the backup was made` });
    expect(() => restore(join(root, "dst2"), b.path)).toThrow("changed since the backup was made");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable manifest is listed beside the others, not instead of them", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-backup-"));
  try {
    const src = new Store(join(root, "src"));
    const storage = new Storage(src, {} as any, new Bus(), {} as any);
    const names = [(await storage.backup("a")).name, (await storage.backup("b")).name, (await storage.backup("c")).name];
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
// The process dying: while `dying` is set, removing a path it names stops
// there (nothing after it runs). With "partly", a folder loses its database first.
let dying: ((path: string) => boolean | "partly") | null = null;
const KILLED = "the process was killed";
const rmOrDie: typeof real.rmSync = (path, opts) => {
  const how = dying?.(String(path));
  if (how === "partly") real.rmSync(join(String(path), "keel.db"), { force: true });
  if (how) throw new Error(KILLED);
  return real.rmSync(path, opts);
};
mock.module("node:fs", () => ({ ...real, copyFileSync: failing(real.copyFileSync), renameSync: failing(real.renameSync), rmSync: rmOrDie }));

// A backup holding one session, and a state folder in use holding another,
// with a settings file the backup does not have.
async function backupAndState(root: string) {
  const src = new Store(join(root, "src"));
  src.createSession({ model: "p:m", workspace: root, title: "from the backup" });
  const b = await new Storage(src, {} as any, new Bus(), {} as any).backup("test");
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

test("a restore that fails while the backup goes in leaves the state as it was, and the retry restores", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-restore-"));
  try {
    const { backup, dst } = await backupAndState(root);
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

test("a restore cut in the middle of its swap is undone before the state is used again", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-restore-"));
  try {
    const { backup, dst } = await backupAndState(root);
    // The disk goes away in the middle: the database cannot be put in place,
    // and nothing can be moved back either.
    let gone = false;
    fault = (to) => gone || (gone = to === join(dst, "keel.db"));
    expect(() => restore(dst, backup)).toThrow("could not be undone now");
    fault = null;
    // In the middle: the database in use was moved aside and nothing took its place.
    expect(stateOf(dst).sessions).toBeNull();

    expect(undoCutRestore(dst)).toBe("undone");
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

// The two whole states a restore may leave: the one in use, or the backup.
const FROM_BACKUP = { sessions: ["from the backup"], settings: null };
const whole = (dst: string) => {
  const now = stateOf(dst);
  return now.sessions?.[0] === "in use" ? expect(now).toMatchObject({ sessions: IN_USE.sessions, settings: IN_USE.settings }) : expect(now).toMatchObject(FROM_BACKUP);
};

test("a restore killed while it tidies up leaves a state that opens, the old one or the backup", async () => {
  // Its swap is done; the process dies at one of the two things it removes after it.
  for (const victim of ["restore.pending", ".restore-"]) {
    const root = mkdtempSync(join(tmpdir(), "keel-restore-"));
    try {
      const { backup, dst } = await backupAndState(root);
      dying = (path) => path.startsWith(join(dst, victim));
      expect(() => restore(dst, backup)).toThrow(KILLED);
      dying = null;
      // What the next start of the daemon does before it opens the database.
      undoCutRestore(dst);
      whole(dst);
      new Store(dst).db.close();
      // And the next restore: the backup is in, nothing of the cut one is left.
      const r = restore(dst, backup);
      expect(stateOf(dst)).toMatchObject(FROM_BACKUP);
      expect(readdirSync(dst).filter((f) => f.startsWith("restore.pending") || f.startsWith(".restore-"))).toEqual([]);
      expect(existsSync(join(r.aside, "keel.db"))).toBe(true);
    } finally {
      dying = null;
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("an undo killed while it removes the staged copy does not cost the database in use", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-restore-"));
  try {
    const { backup, dst } = await backupAndState(root);
    // The restore is cut in its swap and cannot undo it.
    let gone = false;
    fault = (to) => gone || (gone = to === join(dst, "keel.db"));
    expect(() => restore(dst, backup)).toThrow("could not be undone now");
    fault = null;
    // The undo puts everything back and dies removing the staged copy, its database already gone.
    dying = (path) => (path.startsWith(join(dst, ".restore-")) ? "partly" : false);
    expect(() => undoCutRestore(dst)).toThrow(KILLED);
    dying = null;
    // The next start: nothing to undo, and the state is the one in use.
    expect(undoCutRestore(dst)).toBe(false);
    expect(stateOf(dst)).toEqual(IN_USE);
    new Store(dst).db.close();
  } finally {
    fault = null;
    dying = null;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a restore.pending that cannot be read moves nothing and is said plainly", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-restore-"));
  try {
    const { backup, dst } = await backupAndState(root);
    for (const bad of ["", "{", JSON.stringify({ aside: "before-restore-x", stage: ".restore-x.partial", moves: [["keel.db", "../elsewhere/keel.db"]] })]) {
      writeFileSync(join(dst, "restore.pending"), bad);
      expect(undoCutRestore(dst)).toBe("unreadable");
      expect(stateOf(dst)).toEqual({ ...IN_USE, left: ["restore.pending.unreadable"] });
    }
    // A restore that meets one says so and changes nothing; the next one restores.
    writeFileSync(join(dst, "restore.pending"), "");
    expect(() => restore(dst, backup)).toThrow("could not be read, so nothing was changed");
    expect(stateOf(dst)).toMatchObject({ sessions: IN_USE.sessions, settings: IN_USE.settings });
    restore(dst, backup);
    expect(stateOf(dst)).toMatchObject(FROM_BACKUP);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a command that opens the state by itself does not make an empty database in a cut restore", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-restore-"));
  const log = console.log;
  try {
    const { backup, dst } = await backupAndState(root);
    let gone = false;
    fault = (to) => gone || (gone = to === join(dst, "keel.db"));
    expect(() => restore(dst, backup)).toThrow("could not be undone now");
    fault = null;
    expect(stateOf(dst).sessions).toBeNull();
    // keel devices: the cut restore is undone first, and the database is the one in use.
    console.log = () => {};
    expect(await mobileCommands.devices(["--state-dir", dst])).toBe(0);
    expect(stateOf(dst)).toEqual(IN_USE);
  } finally {
    console.log = log;
    fault = null;
    rmSync(root, { recursive: true, force: true });
  }
});
