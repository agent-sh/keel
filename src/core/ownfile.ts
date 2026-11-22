// The owner's own files: what the config folder holds (MCP servers, hooks,
// skills, plugins, agents, instructions). Keel edits them for the owner, so
// every edit goes through here: the file is never half written, and what it
// held before the edit stays beside it as <name>.prev.
//
// What an edit does with a file that is not a plain one of the owner's:
// - a link stays a link: what it points at is replaced (a link to nothing
//   gets its file, where it points), and the .prev is beside the link;
// - another name for the same file (a hard link) keeps what it held: only
//   the name that was edited gets the new content, so a copy stays a copy;
// - a file the owner made read-only, or one that cannot be read, is not
//   replaced: the edit fails and says why;
// - a temp file a killed process left beside the file is removed.
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pidHolds } from "./pid.ts";

// A sign-in kept in the config folder: a grant whose tokens rotate. It gets
// no .prev (a second copy of a token would outlive a sign-out), and a backup
// neither copies it nor puts it back (an older grant no longer signs in).
// A store that keeps such a file names it here.
export const GRANT_FILES: ReadonlySet<string> = new Set(["xai-auth.json"]);

export const prevOf = (path: string) => `${path}.prev`;

// Every byte or an error: a write the disk cut short (it is full, a quota,
// a size limit) must never be given the file's name.
export function writeAll(fd: number, data: Uint8Array, write: (fd: number, data: Uint8Array, offset: number, length: number) => number = writeSync) {
  for (let at = 0; at < data.length; ) {
    const n = write(fd, data, at, data.length - at);
    if (n <= 0) throw new Error(`the write stopped at ${at} of ${data.length} bytes`);
    at += n;
  }
}

// Whole on disk under a name of its own, then given the file's name: a
// reader sees the old file or the new one, never a part of either.
// `mode` is exact when given (whatever the umask); a new file with none gets
// the process's default.
function put(path: string, data: Uint8Array, mode?: number) {
  const tmp = `${path}.${process.pid}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "w", mode ?? 0o666);
    if (mode !== undefined) chmodSync(tmp, mode);
    writeAll(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
}

// Where a write to `path` lands: the path itself, or what it points at when
// it is a link. Only a link is resolved, one step at a time: asking the
// system for the real path of a plain file can answer with a name that is
// not the file's while another process renames over it.
function target(path: string): string {
  let at = path;
  for (let i = 0; i < 40; i++) {
    let link = false;
    try { link = lstatSync(at).isSymbolicLink(); } catch { return at; } // nothing there: the file is made here
    if (!link) return at;
    at = resolve(dirname(at), readlinkSync(at));
  }
  throw new Error(`${path} is a link that leads back to itself`);
}

// A writer that can still finish its write: not one that has ended and waits to be read by its parent.
const alive = pidHolds;

// The temp files of writes that never finished (the process was killed
// between the open and the rename): removed once their process is gone.
function sweep(path: string) {
  const dir = dirname(path), left = new RegExp(`^${basename(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.prev)?\\.(\\d+)\\.tmp$`);
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const pid = Number(left.exec(n)?.[2]);
    if (pid && pid !== process.pid && !alive(pid)) rmSync(join(dir, n), { force: true });
  }
}

// Replaces `path` with `data`. False when the file already holds exactly
// that: nothing is written and the .prev stays the last real change.
// `mode` is the file's mode when it is new (an existing file keeps its own
// unless `mode` is given); `prev: false` keeps no previous copy (a file in
// a folder that is not Keel's to add files to, or a sign-in).
export function writeOwnFile(path: string, data: string | Uint8Array, opt: { mode?: number; prev?: boolean } = {}): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const next = Buffer.from(data);
  const real = target(path);
  let had: Buffer | undefined, hadMode: number | undefined;
  if (existsSync(real)) {
    hadMode = statSync(real).mode & 0o777;
    try { had = readFileSync(real); } catch (e) {
      throw new Error(`${path} cannot be read, so it is not replaced: ${(e as Error).message}`, { cause: e });
    }
    if (had.equals(next) && (opt.mode === undefined || opt.mode === hadMode)) return false;
    if (!(hadMode & 0o200)) throw new Error(`${path} is read-only (mode ${hadMode.toString(8)}): it is left as it is`);
  }
  sweep(real);
  if (had && opt.prev !== false) put(prevOf(path), had, hadMode);
  put(real, next, opt.mode ?? hadMode);
  return true;
}

// Takes the file away, kept as its .prev (a removal can be taken back too).
export function removeOwnFile(path: string): boolean {
  if (!existsSync(path)) return false;
  renameSync(path, prevOf(path));
  return true;
}
