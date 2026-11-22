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
import { fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { claimNote, isClaimFile } from "./claim.ts";

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

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

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

// What to say instead of opening `path` from inside the daemon; undefined: it may be opened.
export function heldFile(path: string): string | undefined {
  if (isClaimFile(path)) return claimNote(path);
  if (isStoreFile(path)) return `${path} is the daemon's own store. It is not opened from inside the daemon: closing it there would drop the daemon's locks on it. Read it with a command (sqlite3 in read-only mode: sqlite3 -readonly), or ask the daemon's API.`;
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
  for (let n = 0; n < 5; n++) {
    let text: string;
    try { text = table(); } catch { return undefined; }
    for (const line of text.split("\n")) {
      const f = line.trim().split(/\s+/);
      if (f[1] === "POSIX" && Number(f[4]) === pid && f[5]?.endsWith(`:${ino}`)) return true;
    }
  }
  return false;
}
