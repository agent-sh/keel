// These files are scratch, not the ledger. A look can rebuild its index and
// objects from the worktree. Beside logs keep their existing week of history.
import { createHash } from "node:crypto";
import { lstat, opendir, readlink, rm, rmdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const WEEK = 7 * 86400_000;
const ENTRIES_PER_SLICE = 64;
export const cacheId = (gitDir: string) => createHash("sha256").update(gitDir).digest("hex").slice(0, 20);
function missing(e: unknown) {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function* entries(path: string) {
  // The sweep owns only the actual directories, not a link out of its state.
  if (!(await lstat(path).catch(() => undefined))?.isDirectory()) return;
  try { yield* await opendir(path); } catch {} // a directory can go while we read it
}

// Even a single object cache can hold many loose blobs. Count its own
// directory entries instead of handing an entire recursive delete to fs.rm.
async function removeObjects(path: string, next: () => Promise<boolean>): Promise<boolean> {
  if (!(await lstat(path).catch(() => undefined))?.isDirectory()) {
    await rm(path, { force: true });
    return true;
  }
  for await (const entry of entries(path)) {
    if (!(await next())) return false;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      if (!(await removeObjects(child, next))) return false;
    } else await rm(child, { force: true });
  }
  await rmdir(path);
  return true;
}

async function pruneCache(dir: string, id: string, before: number, next: () => Promise<boolean>) {
  const index = join(dir, `index-${id}`);
  const objects = join(dir, `objects-${id}`);
  const mark = `${index}.gitdir`;
  const files = [index, `${index}.from`, `${index}.lock`, `${objects}.bytes`, objects];
  let gitDir: string | undefined;
  try { gitDir = await readlink(mark); } catch (e) { if (!missing(e)) return; }
  if (gitDir !== undefined) {
    if (!isAbsolute(gitDir) || cacheId(gitDir) !== id) return;
    try { await stat(gitDir); return; } catch (e) { if (!missing(e)) return; }
  } else {
    // Older caches keep only the hash of their git directory. They cannot be
    // attributed, but after a week without a look they can be rebuilt on demand.
    for (const path of files) {
      try { if ((await lstat(path)).mtimeMs >= before) return; } catch (e) { if (!missing(e)) return; }
    }
  }
  // Leave the marker until last so an interrupted sweep still knows the owner.
  for (const path of files.slice(0, -1)) await rm(path, { force: true });
  if (!(await removeObjects(objects, next))) return;
  await rm(mark, { force: true });
}

export async function pruneCheckFiles(
  dir: string,
  stop: AbortSignal,
  idle: (index: string, sweep: () => Promise<void>) => Promise<void> | undefined,
  pause: (examined: number) => Promise<void> = () => new Promise((resolve) => setImmediate(resolve)),
) {
  const before = Date.now() - WEEK;
  const logs = join(dir, "beside-logs");
  // Keep both directory cursors across slices. Fresh logs or live caches at
  // the start cannot starve entries later in the directory.
  const scan = [entries(dir), entries(logs)];
  const done = [false, false];
  let examined = 0;
  const next = async () => {
    if (stop.aborted) return false;
    if (examined === ENTRIES_PER_SLICE) {
      await pause(examined);
      examined = 0;
    }
    if (stop.aborted) return false;
    examined++;
    return true;
  };
  const cacheOf = async (name: string) => {
    const id = /^(?:objects-([a-f0-9]{20})(?:\.bytes)?|index-([a-f0-9]{20})(?:\.(?:from|lock|gitdir))?)$/.exec(name)?.slice(1).find(Boolean);
    if (id) await idle(join(dir, `index-${id}`), () => pruneCache(dir, id, before, next).catch(() => {}));
  };
  const logOf = async (name: string) => {
    if (!/^[a-f0-9]{16}-[\w.-]+-\d+\.log$/.test(name)) return;
    const path = join(logs, name);
    const st = await lstat(path).catch(() => undefined);
    if (st?.isFile() && st.mtimeMs < before) await rm(path, { force: true }).catch(() => {});
  };
  try {
    while (!done.every(Boolean) && !stop.aborted) {
      for (const [i, cursor] of scan.entries()) {
        if (done[i]) continue;
        const entry = await cursor.next();
        if (entry.done) { done[i] = true; continue; }
        if (!(await next())) return;
        if (i === 0) await cacheOf(entry.value.name);
        else if (entry.value.isFile()) await logOf(entry.value.name);
      }
    }
  } finally {
    await Promise.allSettled(scan.map((cursor) => cursor.return(undefined)));
  }
}
