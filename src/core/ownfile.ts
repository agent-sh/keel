// The owner's own files: what the config folder holds (MCP servers, hooks,
// skills, plugins, agents, instructions). Keel edits them for the owner, so
// every edit goes through here: the file is never half written, and what it
// held before the edit stays beside it as <name>.prev.
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

// A sign-in kept in the config folder: a grant whose tokens rotate. It gets
// no .prev (a second copy of a token would outlive a sign-out), and a backup
// neither copies it nor puts it back (an older grant no longer signs in).
// A store that keeps such a file names it here.
export const GRANT_FILES: ReadonlySet<string> = new Set(["xai-auth.json"]);

export const prevOf = (path: string) => `${path}.prev`;

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
    writeSync(fd, data);
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

// Replaces `path` with `data`. False when the file already holds exactly
// that: nothing is written and the .prev stays the last real change.
// `mode` is the file's mode when it is new (an existing file keeps its own
// unless `mode` is given); `prev: false` keeps no previous copy (a file in
// a folder that is not Keel's to add files to, or a sign-in). A name that
// is a link stays one: what it points at is replaced, and the .prev is
// beside the name the owner knows.
export function writeOwnFile(path: string, data: string | Uint8Array, opt: { mode?: number; prev?: boolean } = {}): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const next = Buffer.from(data);
  let real = path;
  try { real = realpathSync(path); } catch {} // no file yet, or a link to nothing
  let had: Buffer | undefined, hadMode: number | undefined;
  try {
    had = readFileSync(real);
    hadMode = statSync(real).mode & 0o777;
  } catch {} // no file yet
  if (had && had.equals(next) && (opt.mode === undefined || opt.mode === hadMode)) return false;
  if (had && hadMode !== undefined && opt.prev !== false) put(prevOf(path), had, hadMode);
  put(real, next, opt.mode ?? hadMode);
  return true;
}

// Takes the file away, kept as its .prev (a removal can be taken back too).
export function removeOwnFile(path: string): boolean {
  if (!existsSync(path)) return false;
  renameSync(path, prevOf(path));
  return true;
}
