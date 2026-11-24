// The store's files, for anything that touches them outside SQLite.
//
// SQLite's locks on the database file and on the log's index are POSIX
// record locks. Those belong to the process, not to a descriptor: when the
// process closes any descriptor of a file, every lock it holds on that file
// is gone, whoever took it (sqlite.org/howtocorrupt.html, "Posix advisory
// locks canceled by a separate thread doing close()"; SQLite keeps its own
// closed descriptors aside for this reason). A daemon that opens keel.db
// with node:fs and closes it holds no lock on its store from then on, and
// says nothing. The next process that opens the store read-write and closes
// it takes the exclusive lock, checkpoints, and removes the log and its
// index under the running daemon, which goes on writing into files that have
// no name.
//
// So, in a process that has the store open:
// - a descriptor of keel.db, keel.db-wal or keel.db-shm outside SQLite comes
//   from `storeFd` and is never closed. It is opened once and kept for the
//   life of the process. (Why not a child process: a backup reads the file
//   under a read transaction of this process, which is what keeps the pages
//   still. Why not SQLite's own copy, VACUUM INTO: it writes another page
//   layout, so no backup could hold only the pages that changed.)
// - a thread started per job gets the descriptor's number from the thread
//   that keeps it; a number is the process's.
// - nothing else opens them: the file tools and the routes that read a path
//   ask `heldFile` first and leave these files alone. A stat is fine.
// src/conventions.test.ts holds the list of files that may name them.
import { type Dirent, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { CLAIM_FILE, claimedDirs, claimNote, isClaimFile } from "./claim.ts";
import { OWED_FILE } from "./owed.ts";

export const STORE_DB = "keel.db";
export const STORE_FILES = [STORE_DB, `${STORE_DB}-wal`, `${STORE_DB}-shm`] as const;
export const storePath = (stateDir: string) => join(stateDir, STORE_DB);

const g = globalThis as { __keelStoreFds?: Map<string, number>; __keelStores?: Set<string> };
// Kept per process (a hot reload has them), by path.
const fds: Map<string, number> = (g.__keelStoreFds ??= new Map());
// The state folders this process has a store open in.
const stores: Set<string> = (g.__keelStores ??= new Set());

// This process has the store of `stateDir` open: its files are held.
export function holdStore(stateDir: string) {
  stores.add(resolve(stateDir));
}

// A read-only descriptor of one of the store's files, opened once and kept
// for the life of the process: never close it. Throws when the file is not
// there. A file that was replaced since (another file under the same name:
// a log made again after the last connection closed) gets a descriptor of
// its own; the old one stays open.
export function storeFd(path: string): number {
  const had = fds.get(path);
  if (had !== undefined) {
    try {
      const a = fstatSync(had), b = statSync(path);
      if (a.ino === b.ino && a.dev === b.dev) return had;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw e;
    }
  }
  const fd = openSync(path, "r");
  fds.set(path, fd);
  return fd;
}

// The length of the store's log as the folder has it (0: none). No descriptor is opened for it.
export function logBytes(stateDir: string): number {
  try { return statSync(`${storePath(stateDir)}-wal`).size; } catch { return 0; }
}

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
// Where a path lands, also when nothing is there yet: its links followed as far as they go (a link
// whose target does not exist lands where that target would be), then the folders above it.
function landing(path: string): string {
  let p = resolve(path);
  for (let hop = 0; hop < 16; hop++) {
    try { return realpathSync(p); } catch {}
    let target: string | undefined;
    try { if (lstatSync(p).isSymbolicLink()) target = readlinkSync(p); } catch {}
    if (target === undefined) break;
    p = resolve(dirname(p), target);
  }
  // Nothing there: the nearest folder that exists, as it really is, and the rest of the name under it.
  const rest: string[] = [];
  let dir = p;
  for (;;) {
    const up = dirname(dir);
    if (up === dir) return p;
    rest.unshift(basename(dir));
    dir = up;
    try { return join(realpathSync(dir), ...rest); } catch {}
  }
}

// One of the store's three files, in a folder whose store this process has
// open: by its name there, or by being the same file under another name (a
// hard link, another way to the folder), which the kernel's locks do not tell apart.
export function isStoreFile(path: string): boolean {
  if (!stores.size) return false;
  const p = real(path);
  const named = (STORE_FILES as readonly string[]).includes(basename(p));
  let st: { ino: number; dev: number } | undefined;
  try { st = statSync(p); } catch {}
  for (const s of stores) {
    const dir = real(s);
    if (named && dirname(p) === dir) return true;
    if (!st) continue;
    for (const f of STORE_FILES) {
      try {
        const own = statSync(join(dir, f));
        if (own.ino === st.ino && own.dev === st.dev) return true;
      } catch {} // not there (no log yet)
    }
  }
  return false;
}

// The file of owed writes of a store this process has open (src/core/owed.ts): by its name in the
// state folder, also when it is not there yet and as where a link lands, or as the same file under
// another name. The next start makes what it holds, so nothing but the daemon reads or writes it.
export function isOwedFile(path: string): boolean {
  if (!stores.size) return false;
  const p = landing(path);
  let st: { ino: number; dev: number } | undefined;
  try { st = statSync(p); } catch {}
  for (const s of stores) {
    const dir = real(s);
    if (dirname(p) === dir && basename(p) === OWED_FILE) return true;
    if (!st) continue;
    try {
      const own = statSync(join(dir, OWED_FILE));
      if (own.ino === st.ino && own.dev === st.dev) return true;
    } catch {} // none is owed
  }
  return false;
}

// What a session may write inside the daemon's state folder: its files for the owner (artifacts)
// and its own checkout (worktrees). Everything else there is the daemon's: what it reads back when
// it starts and acts on (its settings, its keys and tokens, its plugins, the page it serves, its
// records of a restart, its backups), and what it keeps as evidence.
const SESSION_WRITES = ["artifacts", "worktrees"];
const stateFolderNote = (path: string, dir: string) => `${path} is inside the daemon's own state folder (${dir}), which holds what the daemon reads back and acts on when it starts. A session writes there only under ${SESSION_WRITES.map((n) => `${n}/`).join(" and ")}.`;
// Why `path` is not written from a tool or a route that takes a path; undefined: it may be.
// Besides what is never opened at all (heldFile): any file of a state folder this process has a
// store open in, where it lands or, for a top-level file of the folder, as the same file under
// another name (a hard link in a workspace).
export function heldWrite(path: string): string | undefined {
  const held = heldFile(path);
  if (held) return held;
  if (!stores.size) return undefined;
  const p = landing(path);
  let st: { ino: number; dev: number; nlink: number } | undefined;
  try { st = statSync(p); } catch {}
  for (const s of stores) {
    const dir = real(s);
    const said = stateFolderNote(path, dir);
    if (p === dir) return said;
    if (p.startsWith(dir + sep)) {
      const top = p.slice(dir.length + 1).split(sep)[0]!;
      if (!SESSION_WRITES.includes(top) || p === join(dir, top)) return said;
      continue;
    }
    // Elsewhere, and a file with more than one name: one of the state folder's own files under
    // another, at any depth (a job's record, a plugin's file). A name on another disk is no such file.
    if (!st || st.nlink < 2) continue;
    try { if (statSync(dir).dev !== st.dev) continue; } catch { continue; }
    const own = sameFileBelow(dir, st, true);
    if (own) return `${path} is the daemon's own ${own.slice(dir.length + 1)} under another name. It is not written from a session.`;
  }
  return undefined;
}

// The file below `dir` that is the file `st` (the same inode), if one is: every folder is looked
// through, the ones a session writes left out (`top`: at the state folder's own level), and links
// to folders not followed. Asked only for a file that has more than one name, which few have.
function sameFileBelow(dir: string, st: { ino: number; dev: number }, top = false): string | undefined {
  let names: Dirent[];
  try { names = readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
  for (const n of names) {
    const at = join(dir, n.name);
    if (n.isDirectory()) {
      if (top && SESSION_WRITES.includes(n.name)) continue;
      const found = sameFileBelow(at, st);
      if (found) return found;
    } else if (n.isFile()) {
      try {
        const own = lstatSync(at);
        if (own.ino === st.ino && own.dev === st.dev) return at;
      } catch {}
    }
  }
  return undefined;
}

const owedNote = (path: string) => `${path} is the daemon's own record of writes it owes its store. It is read and written by the daemon alone: what it holds is made when the daemon starts.`;
const storeNote = (path: string) => `${path} is the daemon's own store. It is not opened from inside the daemon: closing it there would drop the daemon's locks on it. Read it with a command (sqlite3 in read-only mode: sqlite3 -readonly), or ask the daemon's API.`;
// What to say instead of opening `path` from inside the daemon; undefined: it may be opened.
export function heldFile(path: string): string | undefined {
  if (isClaimFile(path)) return claimNote(path);
  if (isOwedFile(path)) return owedNote(path);
  if (isStoreFile(path)) return storeNote(path);
  return undefined;
}

// ---- the same answers, the kernel asked on the thread pool -----------------------------------------------
// For a call that holds a path which may be on a mount that stopped answering: that stalls the call (a Stop
// ends it), not the loop. They answer exactly what heldFile and heldWrite answer.
const realOf = (p: string) => realpath(p).catch(() => resolve(p));
async function landingOf(path: string): Promise<string> {
  let p = resolve(path);
  for (let hop = 0; hop < 16; hop++) {
    try { return await realpath(p); } catch {}
    let target: string | undefined;
    try { if ((await lstat(p)).isSymbolicLink()) target = readlinkSync(p); } catch {}
    if (target === undefined) break;
    p = resolve(dirname(p), target);
  }
  const rest: string[] = [];
  let dir = p;
  for (;;) {
    const up = dirname(dir);
    if (up === dir) return p;
    rest.unshift(basename(dir));
    dir = up;
    try { return join(await realpath(dir), ...rest); } catch {}
  }
}
// What `heldFile` answers, with every question to the kernel asked at once (one wait for the thread pool, however
// many state folders and files): the path's own real path, its landing, its device and inode, and for each folder
// its real path and the files in it. The comparing is then of what came back.
const statOf = (p: string) => stat(p).then((s) => s, () => undefined);
export async function heldFileOf(path: string): Promise<string | undefined> {
  const claimed = claimedDirs();
  if (!claimed.length && !stores.size) return undefined;
  const given = resolve(path);
  const [p, land, st, claims, folders] = await Promise.all([
    realOf(given), landingOf(given), statOf(given),
    Promise.all(claimed.map(async (dir) => { const [at, own] = await Promise.all([realOf(dir), statOf(join(dir, CLAIM_FILE))]); return { at, own }; })),
    Promise.all([...stores].map(async (s) => {
      const [dir, files, owed] = await Promise.all([realOf(s), Promise.all(STORE_FILES.map((f) => statOf(join(s, f)))), statOf(join(s, OWED_FILE))]);
      return { dir, files, owed };
    })),
  ]);
  const same = (own: { ino: number; dev: number } | undefined) => !!own && !!st && own.ino === st.ino && own.dev === st.dev;
  if (claims.some((c) => (basename(p) === CLAIM_FILE && c.at === dirname(p)) || same(c.own))) return claimNote(path);
  if (folders.some((f) => (dirname(land) === f.dir && basename(land) === OWED_FILE) || same(f.owed))) return owedNote(path);
  const named = (STORE_FILES as readonly string[]).includes(basename(p));
  if (folders.some((f) => (named && dirname(p) === f.dir) || f.files.some(same))) return storeNote(path);
  return undefined;
}
export async function heldWriteOf(path: string): Promise<string | undefined> {
  if (!stores.size) return heldFileOf(path);
  const given = resolve(path);
  const [held, p, st] = await Promise.all([heldFileOf(path), landingOf(given), stat(given).then((s) => s, () => undefined)]);
  if (held) return held;
  for (const s of stores) {
    const dir = await realOf(s);
    const said = stateFolderNote(path, dir);
    if (p === dir) return said;
    if (p.startsWith(dir + sep)) {
      const top = p.slice(dir.length + 1).split(sep)[0]!;
      if (!SESSION_WRITES.includes(top) || p === join(dir, top)) return said;
      continue;
    }
    if (!st || st.nlink < 2) continue;
    try { if ((await stat(dir)).dev !== st.dev) continue; } catch { continue; }
    const own = sameFileBelow(dir, st, true);
    if (own) return `${path} is the daemon's own ${own.slice(dir.length + 1)} under another name. It is not written from a session.`;
  }
  return undefined;
}

// Whether this process still holds a lock on the store's database file, as
// the kernel's own table has it (Linux: /proc/locks). Every site that reads
// a path is asked to leave the store's files alone, and this is what says
// so when one did not: a daemon without its lock looks well and is one
// foreign close away from losing its log. Undefined where the table cannot
// be read. The table is read in parts while it changes, so a lock is taken
// to be gone only when several reads in a row do not show it.
export function storeLocked(stateDir: string, table: () => string = () => readFileSync("/proc/locks", "utf8"), pid = process.pid): boolean | undefined {
  let ino: number;
  try { ino = statSync(storePath(stateDir)).ino; } catch { return undefined; }
  for (let n = 0; n < LOCK_LOOKS; n++) {
    let text: string;
    try { text = table(); } catch { return undefined; }
    if (lockListed(text, ino, pid)) return true;
  }
  return false;
}

// The same look with the table read on the thread pool. Inside the daemon the read holds the loop for
// ten milliseconds and more (the kernel builds the table under the locks the store's own threads take),
// so what looks every half minute reads it here.
export async function storeLockedOff(stateDir: string, table: () => Promise<string> = () => readFile("/proc/locks", "utf8"), pid = process.pid): Promise<boolean | undefined> {
  let ino: number;
  try { ino = (await stat(storePath(stateDir))).ino; } catch { return undefined; }
  for (let n = 0; n < LOCK_LOOKS; n++) {
    let text: string;
    try { text = await table(); } catch { return undefined; }
    if (lockListed(text, ino, pid)) return true;
  }
  return false;
}

const LOCK_LOOKS = 5;
// Whether the kernel's table has a POSIX lock of this process on the file with this inode number.
export function lockListed(text: string, ino: number, pid: number): boolean {
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f[1] === "POSIX" && Number(f[4]) === pid && f[5]?.endsWith(`:${ino}`)) return true;
  }
  return false;
}
