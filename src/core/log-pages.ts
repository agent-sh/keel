// Which pages of the database changed, read from the write-ahead log.
//
// SQLite keeps no mark on a page that says when it changed. What changed is
// written in one place only: each frame of the log names its page (the
// first four bytes of its 24-byte header, walformat.html), and a frame is
// written over once the log starts again. So the pages are read here as the
// frames are written, and kept beside the store (log-pages.db), for a backup
// that holds only what changed since the one before it (src/admin/backup.ts).
//
// Nothing is taken on trust. A log goes through generations: each start of
// the log is one, named by the two salts in its header. What is kept is
//   scans   frames lo..hi of a generation and the pages they name. One reader
//           (a thread's own PageLog) reads a generation from its first frame
//           and in order, so a row up to `hi` means every frame before it is
//           in a row too;
//   ends    a generation ended at a frame, and the next one is this one.
//           Written only by a reader that had read every frame of the
//           generation at a moment nothing could be added to it, and saw the
//           next one begin from there (`witnessed`).
// A backup asks for the pages between two places in the log (`between`). It
// gets them only when every generation from the first place to the second is
// there and ended in a row; anything else (a log that started again unseen,
// a reader that could not write its row, a store that was restored) is
// "not known", and the backup compares every page as it did before.
//
// Who may call `witnessed`: whoever is, for the length of the call, the only
// one that can write to the store: the holder of the write lock, or the
// daemon's loop where no other connection writes. What it wraps is the write
// that may start the log again (the first frame of a new log, a TRUNCATE
// checkpoint).
//
// A process that ends takes its log with it: the last connection to close
// copies every frame into the database and removes the log, and the next
// process begins a log of its own. Two rows carry a backup's place across
// that:
//   closed  written as the last thing the daemon does with its store (at the
//           process's exit): the generation, how far it was read, and a
//           number written into the store itself in that same moment
//           (log_starts.ts), whose frame is read too;
//   ends    written by the next process at its first write, when the closed
//           row's number is still the one in the store and no log holds a
//           frame: the closed generation ended there, and this one follows.
// Whatever writes through a Store after the close changes that number (a
// Store's first write sets it), and so does the checkpoint thread's own
// write, so a frame nobody read leaves no chain. A process that was killed
// leaves its log, which the next one reads from its first frame.
//
// The rows are written with no sync (they are an index, not the data): a
// machine that went down may have lost some, or kept some of a log that did
// not reach the disk. So the rows of an earlier boot are dropped, and a
// reader never takes up where an earlier one stopped: it reads its
// generation from the first frame.
import { Database } from "bun:sqlite";
import { readFileSync, readSync } from "node:fs";
import { endianness, uptime } from "node:os";
import { dirname, join } from "node:path";
import { storeFd } from "./store-files.ts";

export const PAGE_LOG = "log-pages.db";

// A place in the log: a generation and a frame of it (0: its beginning).
export type LogAt = { s1: number; s2: number; frame: number };
export type LogHead = LogAt & { copied: number };

const LE = endianness() === "LE";
// A closing token is two numbers of 26 bits and more: above any time in milliseconds, exact as a double.
const HALF = 2 ** 26;

// The log's index (the -shm file): the generation, its newest committed
// frame and how many frames are in the database. Both copies of the header
// must agree (a writer between them is read again); undefined when there is
// no index to read.
export function logHead(shmFd: number, buf = Buffer.alloc(136)): LogHead | undefined {
  for (let i = 0; i < 8; i++) {
    let n = 0;
    try { n = readSync(shmFd, buf, 0, 136, 0); } catch { return undefined; }
    if (n < 136 || !buf[12]) return undefined;
    if (buf.compare(buf, 48, 96, 0, 48) !== 0) continue;
    const u32 = (at: number) => (LE ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
    return { s1: buf.readUInt32BE(32), s2: buf.readUInt32BE(36), frame: u32(16), copied: u32(96) };
  }
  return undefined;
}

// The pages frames lo..hi (from 1) of the generation name, into `out`, in
// order; how many frames in a row were that generation's. A frame of another
// one (the log started again meanwhile) ends the count.
const HEADER = 32, FRAME = 24;
const SOME = 256; // frames read at a time
export function framePages(walFd: number, at: { s1: number; s2: number }, lo: number, hi: number, out: number[]): number {
  const head = Buffer.alloc(HEADER);
  if (readSync(walFd, head, 0, HEADER, 0) < HEADER) return 0;
  if ((head.readUInt32BE(0) & ~1) >>> 0 !== 0x377f0682 || head.readUInt32BE(16) !== at.s1 || head.readUInt32BE(20) !== at.s2) return 0;
  const size = FRAME + head.readUInt32BE(8);
  let done = 0;
  const one = (b: Buffer, o: number) => {
    if (b.readUInt32BE(o + 8) !== at.s1 || b.readUInt32BE(o + 12) !== at.s2) return false;
    out.push(b.readUInt32BE(o));
    return true;
  };
  // A few frames: their headers alone. Many: the log in pieces of a megabyte, which is quicker than a read per frame.
  const few = hi - lo + 1 <= 16;
  const buf = Buffer.allocUnsafe(few ? 16 : SOME * size);
  for (let f = lo; f <= hi; ) {
    const count = few ? 1 : Math.min(SOME, hi - f + 1);
    const want = few ? 16 : (count - 1) * size + 16;
    let got = 0;
    while (got < want) {
      const n = readSync(walFd, buf, got, want - got, HEADER + (f - 1) * size + got);
      if (n <= 0) return done;
      got += n;
    }
    for (let k = 0; k < count; k++, f++, done++) if (!one(buf, k * size)) return done;
  }
  return done;
}

// This boot of the machine: rows of another one are not read.
function bootKey(): string {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch {}
  return `t:${Math.round((Date.now() - uptime() * 1000) / 60_000)}`;
}
const sameBoot = (a: string, b: string) => a === b || (a.startsWith("t:") && b.startsWith("t:") && Math.abs(Number(a.slice(2)) - Number(b.slice(2))) <= 2);

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = OFF;
PRAGMA busy_timeout = 50;
CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY, end INTEGER NOT NULL, s1 INTEGER NOT NULL, s2 INTEGER NOT NULL, lo INTEGER NOT NULL, hi INTEGER NOT NULL, n1 INTEGER, n2 INTEGER, pages BLOB);
CREATE INDEX IF NOT EXISTS rows_gen ON rows (s1, s2, end);
CREATE INDEX IF NOT EXISTS rows_next ON rows (n1, n2) WHERE end = 1;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

function open(dbPath: string): Database {
  const db = new Database(join(dirname(dbPath), PAGE_LOG));
  try {
    db.exec(SCHEMA);
    const boot = bootKey();
    db.transaction(() => {
      const was = db.query<{ v: string }, []>("SELECT v FROM meta WHERE k = 'boot'").get()?.v;
      if (was !== undefined && sameBoot(was, boot)) return;
      db.exec("DELETE FROM rows");
      db.query("INSERT INTO meta (k, v) VALUES ('boot', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(boot);
    }).immediate();
    return db;
  } catch (e) {
    try { db.close(); } catch {}
    throw e;
  }
}

// One reader of the log, for one thread. It never throws: what it could not
// read or write is not in the rows, and a backup then finds the pages "not known".
export class PageLog {
  private db?: Database;
  private at?: { s1: number; s2: number };
  private read = 0; // frames of `at` that are in rows of this reader
  // `fds`: the process's kept descriptors of the log and its index, where the caller has them (a thread made per job opens none).
  constructor(private dbPath: string, private fds: { wal?: number; shm?: number } = {}) {}

  private head(): LogHead | undefined {
    try { return logHead(this.fds.shm ?? storeFd(`${this.dbPath}-shm`)); } catch { return undefined; }
  }
  private side(): Database { return (this.db ??= open(this.dbPath)); }

  // Reads the frames written since the last call into a row.
  scan(): void {
    try {
      const h = this.head();
      if (!h) return;
      if (!this.at || this.at.s1 !== h.s1 || this.at.s2 !== h.s2 || h.frame < this.read) { this.at = { s1: h.s1, s2: h.s2 }; this.read = 0; }
      if (h.frame <= this.read) return;
      const pages: number[] = [];
      const n = framePages(this.fds.wal ?? storeFd(`${this.dbPath}-wal`), this.at, this.read + 1, h.frame, pages);
      if (!n) return;
      const set = Uint32Array.from(new Set(pages));
      this.side().query("INSERT INTO rows (end, s1, s2, lo, hi, pages) VALUES (0, ?, ?, ?, ?, ?)").run(h.s1, h.s2, this.read + 1, this.read + n, new Uint8Array(set.buffer, 0, set.byteLength));
      this.read += n;
    } catch {
      this.drop();
    }
  }

  // Runs `write` and reads the log on both sides of it. The caller is the
  // only one that can write to the store until `write` returns. When the log
  // started again in `write`, the generation it ended is written down as
  // ended, with the one that followed.
  // `table`: for a caller whose write gives the write lock up as it returns
  // (a COMMIT): another writer may have followed before the log is looked
  // at here. `write` then changes one row of `table`, a table nothing else
  // writes, and the log is taken to have started again in `write` only when
  // the first frame of the new generation is that table's page.
  witnessed<T>(write: () => T, table?: string): T {
    this.scan();
    const was = this.at, h = this.head();
    // (An index with no log behind it yet names no generation: nothing ends there.)
    const whole = !!was && !!h && h.s1 === was.s1 && h.s2 === was.s2 && h.frame === this.read && !(h.frame === 0 && h.s1 === 0 && h.s2 === 0);
    try {
      return write();
    } finally {
      try {
        const now = this.head();
        if (whole && now && (now.s1 !== was!.s1 || now.s2 !== was!.s2) && (!table || this.first(now) === this.root(table))) {
          this.side().query("INSERT INTO rows (end, s1, s2, lo, hi, n1, n2) VALUES (1, ?, ?, ?, ?, ?, ?)").run(was!.s1, was!.s2, this.read, this.read, now.s1, now.s2);
        }
      } catch {
        this.drop();
      }
      this.scan();
    }
  }
  // The last thing a process does with its store. `write` puts `token` into
  // the store (one row of a table nothing else writes): its frame is read
  // with the rest, and the generation is written down as closed there.
  // (The write is read as any write that may start the log again: with every frame copied and the
  // checkpoint thread's mark gone, it does.)
  seal(write: (token: number) => void, table: string): void {
    try {
      const token = (HALF + Math.floor(Math.random() * HALF)) * HALF + Math.floor(Math.random() * HALF);
      this.witnessed(() => write(token), table);
      const h = this.head();
      if (!h || !this.at || h.s1 !== this.at.s1 || h.s2 !== this.at.s2 || h.frame !== this.read || !h.frame) return;
      const db = this.side();
      db.transaction(() => {
        db.exec("DELETE FROM rows WHERE end = 2");
        db.query("INSERT INTO rows (end, s1, s2, lo, hi, n1, n2) VALUES (2, ?, ?, ?, ?, ?, ?)").run(h.s1, h.s2, this.read, this.read, Math.floor(token / HALF), token % HALF);
      })();
    } catch {
      this.drop();
    }
  }

  // A process's first write to its store, read on both sides as any write
  // that may start the log again (`witnessed`). `token`: the number the store
  // holds before it. When the process before closed its log with that number
  // and no log holds a frame now, the closed generation is written down as
  // ended, with this process's as the one that follows.
  opened<T>(token: number | undefined, write: () => T, table: string): T {
    let closed: { s1: number; s2: number; hi: number; n1: number; n2: number } | null | undefined;
    let empty = false;
    try {
      closed = this.side().query<{ s1: number; s2: number; hi: number; n1: number; n2: number }, []>("SELECT s1, s2, hi, n1, n2 FROM rows WHERE end = 2 ORDER BY id DESC LIMIT 1").get();
      const before = this.head();
      empty = !before || before.frame === 0;
    } catch { this.drop(); }
    try {
      return this.witnessed(write, table);
    } finally {
      try {
        const db = this.side();
        db.exec("DELETE FROM rows WHERE end = 2");
        const now = this.head();
        if (closed && empty && token === closed.n1 * HALF + closed.n2 && now && now.frame >= 1 && !(now.s1 === closed.s1 && now.s2 === closed.s2) && this.first(now) === this.root(table)) {
          db.query("INSERT INTO rows (end, s1, s2, lo, hi, n1, n2) VALUES (1, ?, ?, ?, ?, ?, ?)").run(closed.s1, closed.s2, closed.hi, closed.hi, now.s1, now.s2);
        }
      } catch { this.drop(); }
    }
  }

  // The page the first frame of generation `at` names.
  private first(at: { s1: number; s2: number }): number | undefined {
    const out: number[] = [];
    return framePages(this.fds.wal ?? storeFd(`${this.dbPath}-wal`), at, 1, 1, out) === 1 ? out[0] : undefined;
  }
  // The one page of a table that holds a row or two (its root), asked once.
  private roots = new Map<string, number>();
  private root(table: string): number {
    let page = this.roots.get(table);
    if (page === undefined) {
      const db = new Database(this.dbPath, { readonly: true });
      try { page = db.query<{ rootpage: number }, [string]>("SELECT rootpage FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)?.rootpage ?? -1; } finally { db.close(); }
      this.roots.set(table, page);
    }
    return page;
  }

  // The pages of every frame after `from` up to `to` (page numbers from 1),
  // or undefined when they are not all known: `to` must be in a generation
  // read that far, and every generation back to `from`'s must have ended in a row.
  // `walked`: what `forget` is given once the backup that asked has its name.
  between(from: LogAt, to: LogAt): { pages: Set<number>; walked: { id: number; s1: number; s2: number } } | undefined {
    try {
      const db = this.side();
      const far = db.query<{ hi: number | null }, [number, number]>("SELECT MAX(hi) AS hi FROM rows WHERE end = 0 AND s1 = ? AND s2 = ?");
      if (to.frame > 0 && (far.get(to.s1, to.s2)?.hi ?? 0) < to.frame) return undefined;
      const gens: { s1: number; s2: number }[] = [{ s1: to.s1, s2: to.s2 }];
      const ended = db.query<{ s1: number; s2: number; hi: number }, [number, number]>("SELECT s1, s2, hi FROM rows WHERE end = 1 AND n1 = ? AND n2 = ? ORDER BY id DESC LIMIT 1");
      const seen = new Set<string>([`${to.s1}:${to.s2}`]);
      let cur = gens[0]!;
      while (cur.s1 !== from.s1 || cur.s2 !== from.s2) {
        const e = ended.get(cur.s1, cur.s2);
        if (!e || seen.has(`${e.s1}:${e.s2}`)) return undefined;
        // The generation was read to its end by whoever wrote that it ended.
        if (e.hi > 0 && (far.get(e.s1, e.s2)?.hi ?? 0) < e.hi) return undefined;
        seen.add(`${e.s1}:${e.s2}`);
        gens.push((cur = { s1: e.s1, s2: e.s2 }));
      }
      const pages = new Set<number>();
      const rows = db.query<{ pages: Uint8Array }, [number, number]>("SELECT pages FROM rows WHERE end = 0 AND s1 = ? AND s2 = ?");
      for (const g of gens) for (const r of rows.all(g.s1, g.s2)) {
        const b = r.pages;
        const u = new DataView(b.buffer, b.byteOffset, b.byteLength);
        for (let o = 0; o + 4 <= b.byteLength; o += 4) pages.add(u.getUint32(o, LE));
      }
      // Rows a later backup has no use for: those of the generations before `to`'s.
      let id = 0;
      const last = db.query<{ id: number | null }, [number, number]>("SELECT MAX(id) AS id FROM rows WHERE s1 = ? AND s2 = ?");
      for (const g of gens.slice(1)) id = Math.max(id, last.get(g.s1, g.s2)?.id ?? 0);
      return { pages, walked: { id, s1: to.s1, s2: to.s2 } };
    } catch {
      this.drop();
      return undefined;
    }
  }

  // Removes the rows of the generations a backup read through, once that
  // backup has its name: the next one begins from its place.
  forget(walked: { id: number; s1: number; s2: number }): void {
    if (!walked.id) return;
    try { this.side().query("DELETE FROM rows WHERE id <= ? AND NOT (s1 = ? AND s2 = ?)").run(walked.id, walked.s1, walked.s2); } catch { this.drop(); }
  }

  // The newest row there is now: what was read of the log before a moment (a backup's snapshot) has an id up to it.
  newest(): number | undefined {
    try { return this.side().query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM rows").get()?.id ?? 0; } catch { this.drop(); return undefined; }
  }

  // The side store is opened again at the next call (and this reader's generation read again from its first frame).
  private drop() {
    try { this.db?.close(); } catch {}
    this.db = undefined;
    this.at = undefined;
    this.read = 0;
  }

  close() {
    try { this.db?.close(); } catch {}
    this.db = undefined;
  }
}

// One reader per thread and store, for the two calls a thread that owns the
// log makes (the checkpoint thread, and the loop where it is the only writer).
const mine = new Map<string, PageLog>();
const of = (dbPath: string) => mine.get(dbPath) ?? (mine.set(dbPath, new PageLog(dbPath)), mine.get(dbPath)!);
export const logOf = of;
export const sealLog = (dbPath: string, write: (token: number) => void, table: string) => of(dbPath).seal(write, table);
export const openedLog = <T>(dbPath: string, token: number | undefined, write: () => T, table: string): T => of(dbPath).opened(token, write, table);
// The thread's reader gives its file back (it opens it again when it next reads).
export const restLog = (dbPath: string) => void mine.get(dbPath)?.close();
export const scanLog = (dbPath: string) => of(dbPath).scan();
export const witnessed = <T>(dbPath: string, write: () => T, table?: string): T => of(dbPath).witnessed(write, table);
