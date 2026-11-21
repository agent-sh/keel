// What a backup is on disk, and making one: a folder with a consistent copy
// of the database, the state's JSON files, the uploaded files and the config
// folder's files, each named in manifest.json with its size and SHA-256.
// Nothing here knows the store or the engine: makeBackup runs in a worker
// (backup-worker.ts), off the daemon's event loop, on a connection of its own.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GRANT_FILES } from "../core/ownfile.ts";

// `config`: the config folder the backup carries files of, when it carries any.
export type Backup = { name: string; path: string; created_ms: number | null; reason: string; sessions: number | null; events: number | null; bytes: number | null; unreadable?: string; config?: string };

export type ManifestFile = { name: string; bytes: number; sha256: string; mtime_ms?: number; mode?: number; older_keel?: true };
export type Manifest = { created_ms: number; reason: string; sessions: number; events: number; files: ManifestFile[]; config?: { dir: string; skipped: { name: string; why: string }[] } };

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
  return readdirSync(root)
    .filter((d) => d.startsWith("keel-") && existsSync(join(root, d, "manifest.json")))
    .map((name): Backup => {
      const path = join(root, name);
      try {
        const m = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
        if (typeof m.created_ms !== "number" || !Array.isArray(m.files)) throw new Error("it lacks created_ms or files");
        return { name, path, created_ms: m.created_ms, reason: m.reason, sessions: m.sessions, events: m.events, bytes: (m.files as { bytes: number }[]).reduce((n, f) => n + f.bytes, 0), ...(typeof m.config?.dir === "string" ? { config: m.config.dir } : {}) };
      } catch (e) {
        return { name, path, created_ms: stampMs(name), reason: "", sessions: null, events: null, bytes: null, unreadable: `manifest.json cannot be read: ${(e as Error).message}` };
      }
    })
    // By the folder's own stamp (when the backup began, the same clock for a
    // readable manifest and a damaged one), then its -N suffix.
    .sort((a, b) => (stampMs(b.name) ?? b.created_ms ?? 0) - (stampMs(a.name) ?? a.created_ms ?? 0) || order(b.name) - order(a.name));
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

// Opens a backup's database read-only and checks it: SQLite's integrity check,
// the files against the manifest, and what it holds.
export function verify(dir: string): { ok: true; sessions: number; events: number } | { ok: false; why: string } {
  const path = join(dir, "keel.db");
  if (!existsSync(path)) return { ok: false, why: "no keel.db in it" };
  const mf = join(dir, "manifest.json");
  if (existsSync(mf)) {
    const m = JSON.parse(readFileSync(mf, "utf8"));
    for (const f of m.files as ManifestFile[]) {
      if (f.older_keel) continue; // a sentence for a keel that cannot restore this backup, not a file
      if (!existsSync(join(dir, f.name))) return { ok: false, why: `${f.name} is missing` };
      const sha = hashFile(join(dir, f.name));
      if (sha !== f.sha256) return { ok: false, why: `${f.name} changed since the backup was made` };
      // An attachment's folder is named by its content's hash.
      const a = /^attachments\/([0-9a-f]{64})\//.exec(f.name);
      if (a && a[1] !== sha) return { ok: false, why: `${f.name} does not match its hash` };
    }
  }
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const r = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
    if (r?.integrity_check !== "ok") return { ok: false, why: `integrity check: ${r?.integrity_check}` };
    return { ok: true, ...counts(db) };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  } finally {
    db?.close();
  }
}

const counts = (db: Database) => ({
  sessions: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()!.n,
  events: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n,
});

// What a worker is asked for: a backup of `stateDir` written into `tmp` (a
// folder under the backups folder `root`, renamed by the daemon once it is
// whole). `config`: the owner's config folder, carried with the state.
export type BackupJob = { stateDir: string; root: string; tmp: string; reason: string; config?: string };
export type BackupDone = { sessions: number; events: number; skipped: { name: string; why: string }[]; config?: string };

// A consistent copy of the database (VACUUM INTO on a connection of its own:
// one read snapshot, safe while the daemon writes) and the JSON settings
// files, checked by opening the copy before it counts: integrity, and what
// the store held around the copy.
export function makeBackup(job: BackupJob): BackupDone {
  const { stateDir, tmp } = job;
  mkdirSync(tmp, { recursive: true });
  const src = new Database(join(stateDir, "keel.db"), { readonly: true });
  let before, after;
  try {
    before = counts(src);
    src.run(`VACUUM INTO '${join(tmp, "keel.db").replace(/'/g, "''")}'`);
    after = counts(src);
  } finally {
    src.close();
  }
  const files: string[] = ["keel.db"];
  for (const f of readdirSync(stateDir)) {
    if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
    try { copyFileSync(join(stateDir, f), join(tmp, f)); } catch (e) {
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
  const check = verify(tmp);
  if (!check.ok) throw new Error(`the backup did not check out: ${check.why}`);
  // The daemon goes on writing while the copy is made: the copy holds what
  // the store held at some moment between the two counts.
  const within = (n: number, a: number, b: number) => n >= Math.min(a, b) && n <= Math.max(a, b);
  if (!within(check.sessions, before.sessions, after.sessions) || !within(check.events, before.events, after.events)) {
    throw new Error(`the backup holds ${check.sessions} sessions and ${check.events} events, the store ${before.sessions} and ${before.events} before the copy, ${after.sessions} and ${after.events} after`);
  }
  const manifest: Manifest = {
    created_ms: Date.now(), reason: job.reason, sessions: check.sessions, events: check.events,
    files: [
      // First, so a keel from before config was carried stops at once (see OLDER_KEEL).
      ...(carried?.files.length ? [{ name: OLDER_KEEL, bytes: 0, sha256: "", older_keel: true as const }] : []),
      ...files.map((f) => ({ name: f, bytes: statSync(join(tmp, f)).size, sha256: hashFile(join(tmp, f)) })),
      ...(carried?.files ?? []),
    ],
    ...(carried ? { config: { dir: carried.dir, skipped: carried.skipped } } : {}),
  };
  writeFileSync(join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { sessions: check.sessions, events: check.events, skipped: carried?.skipped ?? [], ...(carried ? { config: carried.dir } : {}) };
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
