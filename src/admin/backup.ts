// What a backup is on disk, and making one: a folder with the database as it
// was at one moment, the state's JSON files, the uploaded files and the config
// folder's files, each named in manifest.json with its size and SHA-256.
// Nothing here knows the store or the engine: makeBackup runs in a worker
// (backup-worker.ts), off the daemon's event loop, on a connection of its own.
//
// The database is kept in one of three ways (manifest.database.kind):
//   full    keel.db.zst: the database file's pages, compressed (zstd frames of
//           4 MiB of pages each; `zstd -d` reads the file too), and
//           keel.db.pages, a hash per page that the next backups compare with.
//   delta   keel.db.delta.zst: only the pages that differ from the newest
//           full backup, which the manifest names. Restoring reads that full
//           backup and puts these pages over it.
//   (none)  keel.db, a plain copy: what a keel before this one wrote.
// Whatever the kind, the manifest holds the SHA-256 of the whole database
// file a restore must end up with, and a restore checks it.
//
// What a backup was checked for before it got its name (database.checked):
//   whole   a full backup: SQLite's integrity check passed on the snapshot
//           that was read, and the file was read back whole to that SHA-256.
//   pages   a delta: every page that differs from its full backup is in it,
//           read from one snapshot; the delta was read back and each page in
//           it is the snapshot's; its full backup is the one it names (by
//           the database's SHA-256) and its file has the SHA-256 it was
//           written with.
//           It was not read back whole over its full backup and SQLite's
//           check was not run: both take time in proportion to the store,
//           and a restart waits on its backup. They are done after it, by
//           the daemon (Storage.checkBackups), and written beside the
//           manifest (checked.json): until then the list says "pages".
//           A delta that fails that check, or whose database fails SQLite's
//           check at that time, is marked and never called whole; nothing
//           more is built on its full backup, and a full backup is made at
//           once, so the newest backup known whole (`newest_whole` in the
//           list) is never older than the last check.
// Every file a backup writes is synced to disk, then its folder, before the
// folder gets its name.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { GRANT_FILES, writeAll } from "../core/ownfile.ts";
import { ASKED, HELD, logIndex, TRIED } from "../core/checkpoint-shared.ts";
import { storeFd, storePath } from "../core/store-files.ts";

// `config`: the config folder the backup carries files of, when it carries any.
// `kind`: how it holds the database; `base`: the full backup a delta is read
// over, and `base_missing` when that one is gone (it cannot be restored).
// `checked`: what it was checked for (see the top of this file), "whole" also
// once the later check read it back; `failed`: that check found it does not
// read back, and why. `newest_whole`: the newest backup of the list that is
// known whole (itself, and for a delta the full backup it is read over).
export type Backup = { name: string; path: string; created_ms: number | null; reason: string; sessions: number | null; events: number | null; bytes: number | null; unreadable?: string; config?: string; kind?: "full" | "delta"; base?: string; base_missing?: true; checked?: "whole" | "pages"; failed?: string; newest_whole?: true };

// The later check of a backup, written beside its manifest.
export const CHECKED = "checked.json";
// `deep_ms`: when it was checked as a restore would take it (written out, SQLite's check, its counts).
// `again_ms`: when it was read back to its hash again, long after it was made (the day's rotation).
export type Checked = { checked_ms: number; ok: boolean; why?: string; deep_ms?: number; again_ms?: number };
export function checkedOf(dir: string): Checked | undefined {
  try { return JSON.parse(readFileSync(join(dir, CHECKED), "utf8")) as Checked; } catch { return undefined; }
}

// A file's bytes, or a folder's entries, on disk: a backup that has its name is whole after a power cut too.
export function syncPath(path: string) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export type ManifestFile = { name: string; bytes: number; sha256: string; mtime_ms?: number; mode?: number; older_keel?: true };
// The database a backup holds: the size of the file a restore writes
// (`pages` of `page_size` bytes) and its SHA-256, the compressed length of
// each frame of the file that holds it, and for a delta the full backup it
// is read over (by name and by that database's SHA-256) and how many pages
// it carries. `source`: read from the database file under a read snapshot,
// or from a VACUUM INTO copy when no such snapshot could be had.
export type DbInfo = { kind: "full" | "delta"; page_size: number; pages: number; sha256: string; frames: number[]; base?: string; base_sha256?: string; changed?: number; source: "file" | "vacuum"; checked?: "whole" | "pages" };
export type Manifest = { created_ms: number; reason: string; sessions: number; events: number; files: ManifestFile[]; database?: DbInfo; config?: { dir: string; skipped: { name: string; why: string }[] } };

const FULL = "keel.db.zst", PAGES = "keel.db.pages", DELTA = "keel.db.delta.zst";
// What holds the database in a backup folder: never copied into a state folder as it is.
export const DB_FILES: ReadonlySet<string> = new Set([FULL, PAGES, DELTA]);
const FRAME_BYTES = 4 << 20; // of pages per zstd frame: what a reader holds at a time
const PAGE_HASH = 16; // bytes of a page's SHA-256 kept to tell a changed page

// A backup that carries config files cannot be restored by a keel from
// before it did (it would take config/ for a state file and stop on it).
// That keel checks every file the manifest lists and says which one is
// missing, so the first entry of such a manifest is this sentence: its
// restore then ends with "the backup cannot be restored: a keel that knows
// ... is missing", the state untouched. This keel skips the entry.
const OLDER_KEEL = "a keel that knows backups with a config folder (this one carries it: restore with the keel that made it, or a newer one)";

// keel-2026-11-19T10-00-00-000Z[-N] -> its time, or null; and its N.
const order = (name: string) => Number(/Z-(\d+)$/.exec(name)?.[1] ?? 0);
const stampMs = (name: string) => {
  const m = /^keel-(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z(?:-\d+)?$/.exec(name);
  const t = m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
  return Number.isNaN(t) ? null : t;
};

// Every backup folder under `root`, newest first. One whose manifest cannot
// be read is listed as such (its time from the folder name) rather than
// hiding the others, and is never pruned: nothing says what it holds.
export function listBackups(root: string): Backup[] {
  if (!existsSync(root)) return [];
  const list = readdirSync(root)
    .filter((d) => d.startsWith("keel-") && existsSync(join(root, d, "manifest.json")))
    .map((name): Backup => {
      const path = join(root, name);
      try {
        const m = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
        if (typeof m.created_ms !== "number" || !Array.isArray(m.files)) throw new Error("it lacks created_ms or files");
        const d = m.database as DbInfo | undefined;
        const later = d ? checkedOf(path) : undefined;
        return {
          name, path, created_ms: m.created_ms, reason: m.reason, sessions: m.sessions, events: m.events, bytes: (m.files as { bytes: number }[]).reduce((n, f) => n + f.bytes, 0),
          ...(typeof m.config?.dir === "string" ? { config: m.config.dir } : {}),
          ...(d ? { kind: d.kind, checked: later?.ok ? "whole" as const : d.checked ?? "whole" as const } : {}),
          ...(later && !later.ok ? { failed: later.why ?? "it does not read back" } : {}),
          ...(d?.kind === "delta" && d.base ? { base: d.base, ...(existsSync(join(root, d.base, "manifest.json")) ? {} : { base_missing: true as const }) } : {}),
        };
      } catch (e) {
        return { name, path, created_ms: stampMs(name), reason: "", sessions: null, events: null, bytes: null, unreadable: `manifest.json cannot be read: ${(e as Error).message}` };
      }
    })
    // By the folder's own stamp (when the backup began, the same clock for a
    // readable manifest and a damaged one), then its -N suffix.
    .sort((a, b) => (stampMs(b.name) ?? b.created_ms ?? 0) - (stampMs(a.name) ?? a.created_ms ?? 0) || order(b.name) - order(a.name));
  // A plain copy (a keel before this one) was checked whole when it was made.
  const whole = (b: Backup) => !b.unreadable && !b.failed && !b.base_missing && (b.checked ?? "whole") === "whole";
  const newest = list.find((b) => whole(b) && (!b.base || list.some((f) => f.name === b.base && whole(f))));
  if (newest) newest.newest_whole = true;
  return list;
}

// The files of a config folder a backup carries, as paths inside it: every
// regular file. Left out: links (what they point at is not the folder's), the
// .prev and .tmp files an edit leaves beside a config file, folders that
// are a tool's own store and not configuration (a name that starts with a
// dot: a clone's history, a virtual environment, a cache; and
// node_modules), and a sign-in (GRANT_FILES): its tokens rotate, so an
// older copy no longer signs in and would replace one that does, and a copy
// in every backup would outlive a sign-out.
// `skipped`: what could not be listed (a folder that cannot be opened).
// Something that went away meanwhile is just not there.
export function configFiles(dir: string, under = "", skipped: { name: string; why: string }[] = []): { files: string[]; skipped: { name: string; why: string }[] } {
  const files: string[] = [];
  const gone = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
  let names: string[] = [];
  try { names = readdirSync(join(dir, under)).sort(); } catch (e) {
    if (under && !gone(e)) skipped.push({ name: `${under}/`, why: (e as Error).message });
  }
  for (const name of names) {
    const rel = under ? join(under, name) : name;
    try {
      const st = lstatSync(join(dir, rel));
      if (st.isDirectory()) { if (!name.startsWith(".") && name !== "node_modules") files.push(...configFiles(dir, rel, skipped).files); }
      else if (st.isFile() && !name.endsWith(".prev") && !name.endsWith(".tmp") && !(under === "" && GRANT_FILES.has(name))) files.push(rel);
    } catch (e) {
      if (!gone(e)) skipped.push({ name: rel, why: (e as Error).message });
    }
  }
  return { files, skipped };
}

// What a backup says of the config files it carries: how many, and the
// folder they were read from (null: none, or a backup from before that was
// written down).
export function backupConfig(backupDir: string): { dir: string | null; files: number } {
  let dir: string | null = null;
  try { dir = (JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8")) as Manifest).config?.dir ?? null; } catch {}
  return { dir, files: configFiles(join(backupDir, "config")).files.length };
}

// A file's SHA-256, read a megabyte at a time into one buffer: the database
// of a backup can be gigabytes, and so can an upload.
export const HASH_CHUNK = 1024 * 1024;
export function hashFile(path: string, read: typeof readSync = readSync): string {
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(HASH_CHUNK);
  const fd = openSync(path, "r");
  try {
    for (let n = read(fd, buf, 0, buf.length, null); n > 0; n = read(fd, buf, 0, buf.length, null)) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

// Checks a backup: every file against the manifest, and the database. One
// that holds the database compressed is read back whole (a delta over its
// full backup) and must give the SHA-256 the manifest names: the bytes the
// snapshot held when the backup was made. Its counts and SQLite's check
// were taken through that snapshot then, and the snapshot is known to have
// read the file alone (Snapshot.begin, snapshotTry), so this is the routine
// check and it writes nothing.
// `deep`: as a restore would take it. The database is written out whole
// beside the backups, must pass SQLite's integrity check, and must hold the
// sessions and events the manifest counts: the three things a restore
// refuses a backup for. It costs the store's size in writes, so the daemon
// asks it of the newest backup once a day (Storage.checkNow), which is what
// would find a count taken at another moment than the bytes. Where the copy
// cannot be written (no room), the routine check stands.
// A plain copy (and a folder with no manifest) is opened and checked itself.
export function verify(dir: string, deep = false): { ok: true; sessions: number; events: number } | { ok: false; why: string } {
  const files = verifyFiles(dir);
  if (!files.ok) return files;
  const m = files.manifest;
  if (m?.database) {
    const routine = (): { ok: true; sessions: number; events: number } | { ok: false; why: string } => {
      const hash = createHash("sha256");
      streamImage(dir, m.database!, (b) => void hash.update(b));
      if (hash.digest("hex") !== m.database!.sha256) return { ok: false, why: "the database it holds does not read back as the one that was backed up" };
      return { ok: true, sessions: m.sessions, events: m.events };
    };
    if (!deep) {
      try { return routine(); } catch (e) { return { ok: false, why: (e as Error).message }; }
    }
    const out = join(dirname(dir), `.check-${basename(dir)}-${process.pid}.partial`);
    try {
      try {
        materialize(dir, m.database, out, false);
      } catch (e) {
        if (!/^(ENOSPC|EDQUOT|EROFS|EACCES|EPERM)$/.test((e as NodeJS.ErrnoException).code ?? "")) return { ok: false, why: (e as Error).message };
        return routine();
      }
      const check = checkDatabase(out);
      if (check.ok && (check.sessions !== m.sessions || check.events !== m.events)) return { ok: false, why: `it holds ${check.sessions} sessions and ${check.events} events, its manifest says ${m.sessions} and ${m.events}` };
      return check;
    } catch (e) {
      return { ok: false, why: (e as Error).message };
    } finally {
      rmSync(out, { force: true });
    }
  }
  return checkDatabase(join(dir, "keel.db"));
}

// The files of a backup against its manifest (none: a bare folder with a keel.db).
export function verifyFiles(dir: string): { ok: true; manifest?: Manifest } | { ok: false; why: string } {
  const mf = join(dir, "manifest.json");
  if (!existsSync(mf)) return existsSync(join(dir, "keel.db")) ? { ok: true } : { ok: false, why: "no keel.db in it" };
  const m = JSON.parse(readFileSync(mf, "utf8")) as Manifest;
  if (!m.database && !existsSync(join(dir, "keel.db"))) return { ok: false, why: "no keel.db in it" };
  for (const f of m.files) {
    if (f.older_keel) continue; // a sentence for a keel that cannot restore this backup, not a file
    if (f.name === PAGES) continue; // what the next backup compares with: a restore never reads it, and a damaged one makes that backup a full one
    if (!existsSync(join(dir, f.name))) return { ok: false, why: `${f.name} is missing` };
    const sha = hashFile(join(dir, f.name));
    if (sha !== f.sha256) return { ok: false, why: `${f.name} changed since the backup was made` };
    // An attachment's folder is named by its content's hash.
    const a = /^attachments\/([0-9a-f]{64})\//.exec(f.name);
    if (a && a[1] !== sha) return { ok: false, why: `${f.name} does not match its hash` };
  }
  return { ok: true, manifest: m };
}

// Opens a database file read-only: SQLite's integrity check, and what it holds.
export function checkDatabase(path: string): { ok: true; sessions: number; events: number } | { ok: false; why: string } {
  if (!existsSync(path)) return { ok: false, why: "no keel.db in it" };
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const why = integrity(db);
    if (why) return { ok: false, why };
    return { ok: true, ...counts(db) };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  } finally {
    db?.close();
  }
}

const integrity = (db: Database) => {
  const r = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
  return r?.integrity_check === "ok" ? undefined : `integrity check: ${r?.integrity_check}`;
};

const counts = (db: Database) => ({
  sessions: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()!.n,
  events: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n,
});

// What a worker is asked for: a backup of `stateDir` written into `tmp` (a
// folder under the backups folder `root`, renamed by the daemon once it is
// whole). `config`: the owner's config folder, carried with the state.
// `keep`: how many backups the owner keeps, which sets how large a delta may be.
// `full`: a full backup whatever changed (the one made after a failed check).
// `dbFd`: the daemon's kept descriptor of the database file (src/core/store-files.ts), for a backup made on a thread of its own.
// `shmFd`: its kept descriptor of the log's index, the same way.
export type BackupJob = { stateDir: string; root: string; tmp: string; reason: string; config?: string; keep?: number; full?: true; dbFd?: number; shmFd?: number };
export type BackupDone = { sessions: number; events: number; skipped: { name: string; why: string }[]; config?: string };

// The database as it is at one moment, for the length of a backup.
//
// A read transaction that begins while every frame of the write-ahead log
// is in the database file reads that file and nothing else, and for as long
// as it is open SQLite writes nothing into the file (a checkpoint may not
// overwrite a page a reader can still see; what the daemon commits
// meanwhile waits in the log). The file is then the snapshot, with every
// page where the last backup saw it, which is what lets the next backup
// hold only the pages that changed.
//
// The daemon's checkpoint thread makes that moment (src/core/checkpoint.ts):
// it copies the log, holds the write lock so nothing is added, and tells the
// worker to begin, for at most 25 ms. The daemon's loop is not held; a
// write of its own waits that long at most. Where no such thread works the
// daemon empties the log itself (a TRUNCATE checkpoint on its own
// connection) and holds still for the worker, and the worker looks at the
// log's file: still empty means its transaction reads the database file
// alone. A try that did not get there (the daemon wrote in between) is made
// again; `begin` says which.
export class Snapshot {
  readonly path: string;
  readonly db: Database;
  // `shmFd`: the process's kept descriptor of the log's index, from the thread that keeps it.
  constructor(stateDir: string, private shmFd?: number) {
    this.path = storePath(stateDir);
    this.db = new Database(this.path, { readonly: true });
    this.db.run("PRAGMA cache_size = -32768"); // 32 MiB: the check walks every table and index
  }
  // The slow part of emptying the log, done here where it holds nobody up:
  // the log's pages are written into the database file and the file is
  // synced (a PASSIVE checkpoint: it never makes the daemon's writes or
  // reads wait). What the daemon then empties is the little it wrote since,
  // most often nothing, and then it syncs nothing.
  flush() {
    try {
      const w = new Database(this.path, { readwrite: true });
      try { w.run("PRAGMA wal_checkpoint(PASSIVE)"); } finally { w.close(); }
    } catch {} // the daemon's own checkpoint does it all
  }
  // `held`: the checkpoint thread has copied every frame of the log into the
  // file and holds the write lock (src/core/checkpoint.ts): a read that
  // begins now reads the file alone, whatever the log's file still holds.
  // It is looked at all the same: a read that began with frames of the log
  // not yet in the file reads through the log, and is not this snapshot.
  // (That the lock was still held when the read began is the gate's to say:
  // `snapshotTry` below.)
  begin(held = false): boolean {
    this.db.run("BEGIN");
    this.db.query("SELECT COUNT(*) FROM sqlite_schema").get(); // the read snapshot starts with the first read
    if (held) {
      const at = this.index();
      if (at && at.frames === at.copied) return true;
    } else {
      let wal = 0;
      try { wal = statSync(`${this.path}-wal`).size; } catch {} // no log at all
      if (wal === 0) return true;
    }
    this.end();
    return false;
  }
  // The read is given up: the next try begins another.
  end() {
    try { this.db.run("ROLLBACK"); } catch {}
  }
  private index() {
    try { return logIndex(this.shmFd ?? storeFd(`${this.path}-shm`)); } catch { return undefined; }
  }
  close() {
    try { this.db.close(); } catch {}
  }
}

// One try of a backup's thread at its snapshot. `ask` asks the daemon to
// empty the log and hold its writes (the checkpoint thread does, or the loop
// where no thread works) and the answer comes on `gate`. True: `snap` holds
// a read that reads the database file alone. Undefined: the daemon gave no
// answer within `waitMs`.
//
// With the checkpoint thread the write lock is held for a moment only, and
// this thread may be held up for longer than that (a busy machine): the
// read begins first, and then one swap of the gate from HELD to TRIED says
// whether the lock was still held (src/core/checkpoint-shared.ts). A swap
// that is not this thread's means the hold ended first: the read is given
// up, whatever it saw. `late`: a test's delay between the answer and the read.
export function snapshotTry(snap: Snapshot, gate: Int32Array, ask: () => void, waitMs: number, late?: () => void): boolean | undefined {
  Atomics.store(gate, 0, ASKED);
  ask();
  if (Atomics.wait(gate, 0, ASKED, waitMs) === "timed-out") return undefined;
  const under = Atomics.load(gate, 0) === HELD;
  late?.();
  let held = snap.begin(under);
  if (under) {
    if (Atomics.compareExchange(gate, 0, HELD, TRIED) !== HELD && held) {
      snap.end();
      held = false;
    }
  } else Atomics.store(gate, 0, TRIED);
  Atomics.notify(gate, 0);
  return held;
}

const stamp = (path: string) => { const st = statSync(path); return `${st.size}:${st.mtimeMs}`; };

// The backup of `job.stateDir` in `job.tmp`. `snap` holds the read snapshot
// (begun: the database file is read as it is); without one, or when the file
// turns out to have moved under it, the database is copied out first
// (VACUUM INTO: one read snapshot too, in another page layout, so always a
// full backup).
export function makeBackup(job: BackupJob, snap?: Snapshot): BackupDone {
  const { stateDir, tmp } = job;
  mkdirSync(tmp, { recursive: true });
  let made: { info: DbInfo; files: string[]; sessions: number; events: number } | undefined;
  if (snap) {
    const before = stamp(snap.path);
    const held = counts(snap.db);
    const pages = snap.db.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
    const size = snap.db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
    try {
      // The file is read through in order first; SQLite's check, which walks
      // it table by table, then finds it in the system's file cache.
      const out = writeDatabase(snap.path, size, pages, "file", job);
      // The file's size and time as they were: nothing wrote into it meanwhile.
      if (stamp(snap.path) === before) made = { ...out, ...held };
    } catch (e) {
      if (!(e instanceof ShortFile)) throw e;
    }
    if (made) {
      // A full backup: SQLite's check, on the same snapshot the pages were
      // read under, so it is of the bytes that were backed up. A delta's
      // check comes after it has its name (see the top of this file).
      if (made.info.kind === "full") {
        const why = integrity(snap.db);
        if (why) throw new Error(`the database did not check out: ${why}`);
      }
    } else for (const f of DB_FILES) rmSync(join(tmp, f), { force: true });
  }
  if (!made) {
    const raw = join(tmp, "keel.db.raw");
    const src = snap?.db ?? new Database(storePath(stateDir), { readonly: true });
    try {
      if (snap) try { src.run("ROLLBACK"); } catch {} // VACUUM runs outside a transaction
      src.run(`VACUUM INTO '${raw.replace(/'/g, "''")}'`);
      const copy = new Database(raw, { readonly: true });
      try {
        const why = integrity(copy);
        if (why) throw new Error(`the backup did not check out: ${why}`);
        const pages = copy.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
        const size = copy.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
        made = { ...writeDatabase(raw, size, pages, "vacuum", job), ...counts(copy) };
      } finally {
        copy.close();
      }
    } finally {
      if (!snap) src.close();
      for (const f of [raw, `${raw}-wal`, `${raw}-shm`]) rmSync(f, { force: true });
    }
  }
  snap?.close(); // the database is in: the daemon's log can be emptied again
  const files: string[] = [...made.files];
  // The state's JSON files. One that is as the newest backup has it (a
  // catalog, a listing: megabytes that rarely change) is a second name for
  // that backup's copy, as an unchanged config file is: a backup's files are
  // never written again, and the copy is read to see it is still whole.
  const prev = listBackups(job.root).find((b) => !b.unreadable);
  const was = new Map<string, ManifestFile>();
  if (prev) try {
    for (const f of (JSON.parse(readFileSync(join(prev.path, "manifest.json"), "utf8")) as Manifest).files) was.set(f.name, f);
  } catch {} // nothing to share with
  for (const f of readdirSync(stateDir)) {
    if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
    const from = join(stateDir, f), to = join(tmp, f);
    try {
      const old = was.get(f);
      if (old && old.bytes === statSync(from).size && hashFile(from) === old.sha256) {
        try {
          linkSync(join(prev!.path, f), to);
          if (hashFile(to) === old.sha256) { files.push(f); continue; }
          rmSync(to, { force: true });
        } catch {} // another filesystem, or that copy is gone: a real copy
      }
      copyFileSync(from, to);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // replaced meanwhile: the daemon writes these by rename
      throw e;
    }
    files.push(f);
  }
  // Uploaded files the prompts refer to (<state>/attachments/<sha256>/<name>).
  // They never change once written, so a hard link is a full copy at no
  // extra space; another filesystem gets a real copy.
  const att = join(stateDir, "attachments");
  if (existsSync(att)) for (const id of readdirSync(att)) {
    if (!/^[0-9a-f]{64}$/.test(id)) continue;
    for (const name of readdirSync(join(att, id))) {
      mkdirSync(join(tmp, "attachments", id), { recursive: true });
      const from = join(att, id, name), to = join(tmp, "attachments", id, name);
      try { linkSync(from, to); } catch { copyFileSync(from, to); }
      files.push(`attachments/${id}/${name}`);
    }
  }
  const carried = job.config ? carryConfig(job.config, tmp, job.root) : null;
  const manifest: Manifest = {
    created_ms: Date.now(), reason: job.reason, sessions: made.sessions, events: made.events,
    files: [
      // First, so a keel from before config was carried stops at once (see OLDER_KEEL).
      ...(carried?.files.length ? [{ name: OLDER_KEEL, bytes: 0, sha256: "", older_keel: true as const }] : []),
      ...files.map((f) => ({ name: f, bytes: statSync(join(tmp, f)).size, sha256: hashFile(join(tmp, f)) })),
      ...(carried?.files ?? []),
    ],
    database: made.info,
    ...(carried ? { config: { dir: carried.dir, skipped: carried.skipped } } : {}),
  };
  writeFileSync(join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  // On disk before the folder gets its name: every file this backup wrote
  // (one shared with an earlier backup or the store is already there), then
  // every folder in it.
  const folders = new Set<string>([tmp]);
  for (const f of manifest.files) {
    if (f.older_keel) continue;
    const path = join(tmp, f.name);
    for (let d = dirname(path); d.length > tmp.length; d = dirname(d)) folders.add(d);
    if (statSync(path).nlink === 1) syncPath(path);
  }
  syncPath(join(tmp, "manifest.json"));
  for (const d of [...folders].sort((a, b) => b.length - a.length)) syncPath(d);
  return { sessions: made.sessions, events: made.events, skipped: carried?.skipped ?? [], ...(carried ? { config: carried.dir } : {}) };
}

// The check that follows a backup, run in a process of its own
// (backup-check.ts). First SQLite's
// integrity check of the store as it is now (with `stateDir`). Then each of
// `check`, a delta, read back whole over its full backup against the SHA-256
// its manifest names; `each` is told as one is done, so a check that is cut
// keeps what it found. A store that fails its check fails every delta of
// this run with that reason, unread: its pages were taken as they were, and
// nothing says they are from before the damage. For a delta that does not
// read back, its full backup is read back too (once), which says whether
// that one is what is damaged: `bases`.
// `deep`: the one backup of `check` that is checked as a restore would take it (see verify).
// `known`: those of `check` that were known whole already and are read again (the day's
// rotation, the day's deep check): what the store's own check says now is not held against them.
export type CheckJob = { check: string[]; stateDir?: string; deep?: string; known?: string[] };
export type CheckResult = { dir: string; ok: boolean; why?: string; deep?: true };
export type CheckDone = { backups: CheckResult[]; bases: CheckResult[]; store?: { ok: boolean; why?: string } };
export function checkBackups(job: CheckJob, each?: (r: CheckResult) => void): CheckDone {
  let store: CheckDone["store"];
  if (job.stateDir) {
    let db: Database | undefined;
    try {
      db = new Database(storePath(job.stateDir), { readonly: true });
      db.run("PRAGMA cache_size = -32768");
      const why = integrity(db);
      store = why ? { ok: false, why } : { ok: true };
    } catch (e) {
      store = { ok: false, why: (e as Error).message };
    } finally {
      db?.close();
    }
  }
  const read = (dir: string): CheckResult => {
    let r: ReturnType<typeof verify>;
    const deep = dir === job.deep;
    try { r = verify(dir, deep); } catch (e) { r = { ok: false, why: (e as Error).message }; }
    return { dir, ...(r.ok ? { ok: true } : { ok: false, why: r.why }), ...(deep ? { deep: true as const } : {}) };
  };
  const bases = new Map<string, CheckResult>();
  const backups = job.check.map((dir) => {
    let r: CheckResult;
    if (store && !store.ok && !job.known?.includes(dir)) r = { dir, ok: false, why: `the database did not pass SQLite's check when this backup was checked (${store.why}); it holds the pages as they were, so it may hold the damage` };
    else {
      r = read(dir);
      if (!r.ok) try {
        const base = (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest).database?.base;
        const at = base ? join(dirname(dir), base) : undefined;
        if (at && !bases.has(at) && existsSync(join(at, "manifest.json"))) bases.set(at, read(at));
      } catch {} // its manifest is what is damaged: `r` says so
    }
    each?.(r);
    return r;
  });
  return { backups, bases: [...bases.values()], ...(store ? { store } : {}) };
}

// ---- the database of a backup ----

class ShortFile extends Error {}

// Reads `count` pages from page `first` (0-based) of a database file into
// `buf`, whole. The first page says the file is in rollback-journal mode
// (bytes 18 and 19, the only place the journal mode is written): the file a
// restore writes has no write-ahead log beside it, and one that says WAL
// would make every reader create one.
function readPages(fd: number, size: number, first: number, count: number, buf: Buffer) {
  const want = count * size;
  for (let got = 0; got < want; ) {
    const n = readSync(fd, buf, got, want - got, first * size + got);
    if (n <= 0) throw new ShortFile(`the database file ends before page ${first + count}`);
    got += n;
  }
  if (first === 0) buf[18] = buf[19] = 1;
  return buf.subarray(0, want);
}

// Writes one zstd frame and notes its length.
function frame(fd: number, data: Uint8Array, frames: number[]) {
  const z = Bun.zstdCompressSync(data, { level: 3 });
  writeAll(fd, z);
  frames.push(z.length);
}

// The newest full backup a delta can be read over: its page hashes are there
// and are the ones its manifest names, and its pages are this size. Not one
// that failed a later check, nor one with a delta that did (the full backup's
// file or its page hashes may be what is wrong: nothing more is built on it).
function findBase(root: string, size: number): { name: string; info: DbInfo; hashes: Buffer } | undefined {
  const list = listBackups(root);
  const b = list.find((b) => !b.unreadable && b.kind === "full");
  if (!b || b.failed || list.some((d) => d.base === b.name && d.failed)) return;
  try {
    const m = JSON.parse(readFileSync(join(b.path, "manifest.json"), "utf8")) as Manifest;
    const info = m.database!, idx = m.files.find((f) => f.name === PAGES), db = m.files.find((f) => f.name === FULL);
    // The chain's checksum: the full backup's file is the bytes its manifest names (a pass over the compressed file).
    if (info.page_size !== size || !idx || !db || statSync(join(b.path, FULL)).size !== db.bytes || hashFile(join(b.path, FULL)) !== db.sha256) return;
    const hashes = readFileSync(join(b.path, PAGES));
    if (hashes.length !== info.pages * PAGE_HASH || createHash("sha256").update(hashes).digest("hex") !== idx.sha256) return;
    return { name: b.name, info, hashes };
  } catch {} // not one to build on
}

// Puts the database file at `path` (`pages` pages of `size` bytes, not
// changing while this runs) into the backup folder `job.tmp`: as the pages
// that differ from the newest full backup when those are few, else whole.
// Few is no more than one page in `keep`: the deltas kept beside a full
// backup then never outweigh a second full one. What was written is read
// back and must give the file's own SHA-256; a delta that does not (its
// full backup was damaged since) is dropped for a full backup.
function writeDatabase(path: string, size: number, pages: number, source: DbInfo["source"], job: BackupJob): { info: DbInfo; files: string[] } {
  const per = Math.max(1, Math.floor(FRAME_BYTES / size));
  const buf = Buffer.allocUnsafe(per * size);
  const hashes = Buffer.allocUnsafe(pages * PAGE_HASH);
  const whole = createHash("sha256");
  // The store's own file is read through the descriptor the process keeps and
  // is never closed: closing one would drop every lock this process holds on
  // the store (src/core/store-files.ts). A copy made for this backup is a
  // file of its own, opened and closed here.
  const live = source === "file";
  const fd = live ? job.dbFd ?? storeFd(path) : openSync(path, "r");
  try {
    for (let p = 0; p < pages; p += per) {
      const block = readPages(fd, size, p, Math.min(per, pages - p), buf);
      whole.update(block);
      for (let i = 0; i * size < block.length; i++) createHash("sha256").update(block.subarray(i * size, (i + 1) * size)).digest().copy(hashes, (p + i) * PAGE_HASH, 0, PAGE_HASH);
    }
    const sha256 = whole.digest("hex");
    const reads = (info: DbInfo) => {
      const h = createHash("sha256");
      try { streamImage(job.tmp, info, (b) => void h.update(b)); } catch { return false; }
      return h.digest("hex") === sha256;
    };

    const keep = job.keep ?? 1;
    const base = source === "file" && keep > 1 && !job.full ? findBase(job.root, size) : undefined;
    if (base) {
      const changed: number[] = [];
      for (let p = 0; p < pages; p++) {
        if (p >= base.info.pages || hashes.compare(base.hashes, p * PAGE_HASH, (p + 1) * PAGE_HASH, p * PAGE_HASH, (p + 1) * PAGE_HASH) !== 0) changed.push(p);
      }
      if (changed.length * keep <= pages) {
        const frames: number[] = [];
        const out = openSync(join(job.tmp, DELTA), "w", 0o600);
        try {
          // Records of a page number (4 bytes, big-endian, from 0) and the page, in page order.
          const rec = Buffer.allocUnsafe(per * (4 + size));
          const one = Buffer.allocUnsafe(size);
          for (let i = 0; i < changed.length; i += per) {
            const part = changed.slice(i, i + per);
            part.forEach((p, k) => {
              rec.writeUInt32BE(p, k * (4 + size));
              readPages(fd, size, p, 1, one).copy(rec, k * (4 + size) + 4);
            });
            frame(out, rec.subarray(0, part.length * (4 + size)), frames);
          }
        } finally {
          closeSync(out);
        }
        const info: DbInfo = { kind: "delta", page_size: size, pages, sha256, frames, base: base.name, base_sha256: base.info.sha256, changed: changed.length, source, checked: "pages" };
        // Read back from what was written: every page it holds is the
        // snapshot's page, and it holds every changed one. The whole
        // database over the full backup is read back later (checked.json).
        let held = 0, same = true;
        try {
          for (const b of framesOf(join(job.tmp, DELTA), frames)) {
            for (let o = 0; o + 4 + size <= b.length && same; o += 4 + size, held++) {
              const p = b.readUInt32BE(o);
              same = p === changed[held] && createHash("sha256").update(b.subarray(o + 4, o + 4 + size)).digest().compare(hashes, p * PAGE_HASH, (p + 1) * PAGE_HASH, 0, PAGE_HASH) === 0;
            }
          }
        } catch { same = false; }
        if (same && held === changed.length) return { info, files: [DELTA] };
        rmSync(join(job.tmp, DELTA), { force: true });
      }
    }

    const frames: number[] = [];
    const out = openSync(join(job.tmp, FULL), "w", 0o600);
    try {
      for (let p = 0; p < pages; p += per) frame(out, readPages(fd, size, p, Math.min(per, pages - p), buf), frames);
    } finally {
      closeSync(out);
    }
    writeFileSync(join(job.tmp, PAGES), hashes, { mode: 0o600 });
    const info: DbInfo = { kind: "full", page_size: size, pages, sha256, frames, source, checked: "whole" };
    if (!reads(info)) throw new Error("the backup did not check out: the database does not read back as it was written");
    return { info, files: [FULL, PAGES] };
  } finally {
    if (!live) closeSync(fd);
  }
}

// The frames of a compressed file, each decompressed in turn.
function* framesOf(path: string, lengths: number[]): Generator<Buffer> {
  const fd = openSync(path, "r");
  try {
    let at = 0;
    for (const len of lengths) {
      const z = Buffer.allocUnsafe(len);
      for (let got = 0; got < len; ) {
        const n = readSync(fd, z, got, len - got, at + got);
        if (n <= 0) throw new Error(`${path} ends before its frames do`);
        got += n;
      }
      at += len;
      let out: Uint8Array;
      try { out = Bun.zstdDecompressSync(z); } catch { throw new Error(`${basename(dirname(path))}/${basename(path)} is damaged: the frame at byte ${at - len} does not decompress`); }
      yield Buffer.from(out);
    }
  } finally {
    closeSync(fd);
  }
}

// Gives `sink` the database file a backup holds, in order, a few megabytes
// at a time: a full backup's own pages, or for a delta the pages of the full
// backup it names (found beside it) with the delta's pages over them, cut or
// grown to the delta's page count. The caller hashes what it is given: the
// manifest's SHA-256 is the proof, not this function.
export function streamImage(dir: string, info: DbInfo, sink: (b: Buffer) => void) {
  const size = info.page_size;
  if (info.kind === "full") {
    let total = 0;
    for (const b of framesOf(join(dir, FULL), info.frames)) { total += b.length; sink(b); }
    if (total !== info.pages * size) throw new Error(`${FULL} holds ${total} bytes, not ${info.pages} pages of ${size}`);
    return;
  }
  const baseDir = join(dirname(dir), info.base ?? "");
  let base: DbInfo | undefined;
  try { base = (JSON.parse(readFileSync(join(baseDir, "manifest.json"), "utf8")) as Manifest).database; } catch {}
  if (!info.base || !base) throw new Error(`it holds the pages that changed since the backup ${info.base}, and that one is gone or cannot be read`);
  if (base.kind !== "full" || base.sha256 !== info.base_sha256 || base.page_size !== size) throw new Error(`it holds the pages that changed since the backup ${info.base}, and that one is not the backup it was made from`);

  // The delta's records, one at a time, in page order.
  const records = (function* () {
    for (const b of framesOf(join(dir, DELTA), info.frames)) {
      if (b.length % (4 + size)) throw new Error(`${DELTA} holds a frame that is not whole pages`);
      for (let o = 0; o < b.length; o += 4 + size) yield { page: b.readUInt32BE(o), data: b.subarray(o + 4, o + 4 + size) };
    }
  })();
  let next = records.next(), used = 0, at = 0; // `at`: the page the next bytes given are
  const over = (block: Buffer) => {
    for (; !next.done && next.value.page < at + block.length / size; next = records.next(), used++) {
      if (next.value.page < at) throw new Error(`${DELTA} holds its pages out of order`);
      next.value.data.copy(block, (next.value.page - at) * size);
    }
  };
  for (const b of framesOf(join(baseDir, FULL), base.frames)) {
    if (at >= info.pages) break;
    const block = b.subarray(0, Math.min(b.length, (info.pages - at) * size));
    over(block);
    sink(block);
    at += block.length / size;
  }
  // Pages past the end of the full backup: all of them are in the delta.
  for (; at < info.pages; at++, next = records.next(), used++) {
    if (next.done || next.value.page !== at) throw new Error(`${DELTA} lacks page ${at}`);
    sink(Buffer.from(next.value.data));
  }
  if (!next.done) throw new Error(`${DELTA} holds pages past the end of the database`);
  if (used !== info.changed) throw new Error(`${DELTA} holds ${used} pages, the manifest says ${info.changed}`);
}

// Writes the database a backup holds to `dest` and checks it is the one that
// was backed up; a file that is not is removed. `sync` false: a copy made to
// be looked at and removed.
export function materialize(dir: string, info: DbInfo, dest: string, sync = true) {
  const hash = createHash("sha256");
  const fd = openSync(dest, "w", 0o644);
  try {
    try {
      streamImage(dir, info, (b) => { hash.update(b); writeAll(fd, b); });
      if (sync) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (hash.digest("hex") !== info.sha256) throw new Error("the database it holds does not read back as the one that was backed up");
  } catch (e) {
    rmSync(dest, { force: true });
    throw e;
  }
}

// The owner's config folder (MCP servers, hooks, skills, plugins, agents,
// instructions) goes with the state, under config/: each file at its own
// mode, in folders only the owner can open, so a copy is never easier to
// read than its original.
// A file that is as the newest backup of this folder has it (the same
// size, time and mode) is a second name for that backup's copy, not a new
// one: a backup's files are never written again, so sharing them is safe,
// and an unchanged folder costs a listing. (Never a link to the live file:
// an editor that writes in place would change the backup with it.)
// A file that cannot be read, or goes away meanwhile, is left out and
// named in the manifest: nothing in this folder fails a backup, so nothing
// in it calls off the restart that waits on one.
function carryConfig(dir: string, tmp: string, root: string) {
  const prev = listBackups(root).find((b) => !b.unreadable && b.config === dir);
  const was = new Map<string, ManifestFile>();
  if (prev) try {
    for (const f of (JSON.parse(readFileSync(join(prev.path, "manifest.json"), "utf8")) as Manifest).files) if (f.name.startsWith("config/")) was.set(f.name, f);
  } catch {} // nothing to share with
  const { files: listed, skipped } = configFiles(dir);
  const files: ManifestFile[] = [];
  for (const rel of listed) {
    const name = `config/${rel}`, from = join(dir, rel), to = join(tmp, name);
    try {
      const st = lstatSync(from);
      if (!st.isFile()) continue; // became a folder or a link since the listing
      const mode = st.mode & 0o777, old = was.get(name);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      // An unchanged file shares the previous backup's copy. Unchanged is by
      // content, and that copy is read too: a copy that was damaged since is
      // not carried into every backup after it.
      if (old && old.bytes === st.size && old.mode === mode && hashFile(from) === old.sha256) {
        try {
          linkSync(join(prev!.path, name), to);
          if (hashFile(to) === old.sha256) {
            files.push({ ...old, mtime_ms: st.mtimeMs });
            continue;
          }
          rmSync(to, { force: true });
        } catch {} // another filesystem, or that copy is gone: a real copy
      }
      copyFileSync(from, to);
      chmodSync(to, mode);
      files.push({ name, bytes: statSync(to).size, sha256: hashFile(to), mtime_ms: st.mtimeMs, mode });
    } catch (e) {
      rmSync(to, { force: true });
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") skipped.push({ name: rel, why: (e as Error).message });
    }
  }
  return { dir, files, skipped };
}
