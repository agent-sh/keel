// The installed packages of a fails-before run's base (src/checks/before-run.ts), kept once per repository and
// lockfile: the frozen install runs once for a lockfile, in the scratch checkout of the run that first needs it,
// and its packages folders are moved here and linked into every later scratch checkout of the same lockfile. An
// install that failed is remembered for FAILED_MS, so the reports in that while say so at once. Old entries go by
// age and by a size budget (evictOf).
//
// An entry is `<state>/checks/packages/<key>/`: `tree/` holds the packages folders where the install made them
// (relative to the lockfile's folder: `node_modules`, `packages/a/node_modules`), and `root` is a link to the
// lockfile's folder of the scratch checkout that uses the entry now. A link the install made out of the packages
// folders (a workspace package, `node_modules/a -> ../packages/a`) points through `root`, so it reaches the
// checkout of the run that uses the entry. One run at a time per repository (the run's lane) and a key per
// repository keep `root` one run's.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, symlinkSync, unlinkSync, type Dirent } from "node:fs";
import { readdir, readlink, rename, rm, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { contains } from "../core/paths.ts";
import { outputOf } from "../core/proc.ts";
import type { Store } from "../core/store.ts";

export const CACHE_DIR = ["checks", "packages"] as const;
// An entry no run used for three days goes: a lockfile not seen in that long belongs to a base the repository
// moved past (a dependency bump makes a new one), and building it again costs one install.
export const MAX_AGE_MS = 3 * 24 * 3600_000;
// What the entries may hold together: a large JavaScript project's packages are 0.3 to 1.5 GB, and a
// repository's live bases use one or two lockfiles at a time, so 4 GiB keeps the recent lockfiles of a few
// repositories without filling a disk. The entry used last is kept whatever its size (else a project larger than
// the budget would install on every report).
export const BUDGET_BYTES = 4 * 1024 ** 3;
// How long a failed install of a lockfile is the answer for it: a frozen install of the same bytes fails the same
// way until something outside it changes (the registry or the network comes back, a program is installed), which
// is minutes to hours. Half an hour spares a wave of agents' reports the same failing install, one after another
// in the repository's lane, and still tries again within the hour; the owner's Run again tries at once.
export const FAILED_MS = 30 * 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS package_cache (
  key TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  lock TEXT NOT NULL,
  state TEXT NOT NULL,
  why TEXT,
  dirs TEXT,
  bytes INTEGER,
  made INTEGER NOT NULL,
  used INTEGER NOT NULL
);
`;
type Row = { key: string; repo: string; lock: string; state: "ok" | "failed"; why: string | null; dirs: string | null; bytes: number | null; made: number; used: number };

// What an entry is known by: the repository (its common git directory), the lockfile's folder in it, the
// lockfile's name and its bytes.
export function cacheKey(common: string, lockDir: string, lockFile: string, bytes: Uint8Array): string {
  const h = createHash("sha256").update(`${common}\0${lockDir}\0${lockFile}\0`).update(bytes);
  return h.digest("hex").slice(0, 32);
}

// Which entries go: every one not used for `maxAgeMs`, and, from the one used last down, each that no longer fits
// in `budget` bytes with the ones kept before it. One in use, and the one used last, never go (and count first).
export type CacheEntry = { key: string; bytes: number; used: number };
export function evictOf(entries: readonly CacheEntry[], now: number, inUse: ReadonlySet<string>, o: { maxAgeMs?: number; budget?: number } = {}): string[] {
  const maxAge = o.maxAgeMs ?? MAX_AGE_MS, budget = o.budget ?? BUDGET_BYTES;
  const newest = [...entries].sort((a, b) => b.used - a.used);
  const kept = (e: CacheEntry, i: number) => inUse.has(e.key) || i === 0;
  let total = newest.filter(kept).reduce((n, e) => n + e.bytes, 0);
  const out: string[] = [];
  for (const [i, e] of newest.entries()) {
    if (kept(e, i)) continue;
    if (now - e.used > maxAge || total + e.bytes > budget) out.push(e.key);
    else total += e.bytes;
  }
  return out;
}

// A link of a packages folder, as the entry keeps it. `at`: where the link was in the scratch checkout; `target`
// what it says; `folders`: the packages folders there (absolute, in the scratch checkout); `lockDir`: the
// lockfile's folder there; `scratch`: the checkout's top; `entry`: the entry's folder. The new target, or
// undefined when it stays as it is: a relative link within the packages folders works the same in the entry, an
// absolute one outside the checkout is someone else's (a global store).
export function relinkOf(at: string, target: string, p: { folders: readonly string[]; lockDir: string; scratch: string; entry: string }): string | undefined {
  const abs = isAbsolute(target) ? resolve(target) : resolve(dirname(at), target);
  const folder = p.folders.find((f) => contains(f, abs));
  if (folder) return isAbsolute(target) ? join(p.entry, "tree", relative(p.lockDir, abs)) : undefined;
  if (isAbsolute(target) && !contains(p.scratch, abs)) return undefined;
  return join(p.entry, "root", relative(p.lockDir, abs));
}

// The packages folders in what `git ls-files -o --directory -z` lists (untracked, ignored ones too): every
// `node_modules/` that is in no other one.
export function foldersOf(listed: string): string[] {
  return listed.split("\0").filter((l) => l.endsWith("node_modules/")).map((l) => l.slice(0, -1)).filter((l) => !l.split("/").slice(0, -1).includes("node_modules")).sort();
}

// What an install made out of the packages folders: the paths `after` lists that `before` does not (both what
// `git ls-files -o -z` lists, out of node_modules).
export function madeOutside(before: string, after: string): string[] {
  const had = new Set(before.split("\0"));
  return after.split("\0").filter((p) => p && !had.has(p)).sort();
}

let store: Store | undefined;
const dir = () => join(store!.stateDir, ...CACHE_DIR);
// The entries a run uses now (kept by the process: a module loaded again sees the runs of the one before it).
const inUse = ((globalThis as any).__keelPackageCache ??= new Set<string>()) as Set<string>;

// The table, and what an earlier daemon left: an entry it was still making, one without a row, a row without its
// folder. Then the entries over the age and the budget go.
export async function bindCache(s: Store): Promise<void> {
  store = s;
  s.migrate(SCHEMA);
  const rows = new Map(s.db.query<Row, []>("SELECT * FROM package_cache WHERE state = 'ok'").all().map((r) => [r.key, r]));
  let names: string[] = [];
  try { names = readdirSync(dir()); } catch {} // none made yet
  for (const n of names) if (!rows.has(n) && !inUse.has(n) && ![...inUse].some((k) => n.startsWith(`${k}.`))) await rm(join(dir(), n), { recursive: true, force: true }); // made in part, or evicted
  for (const k of rows.keys()) if (!names.includes(k)) s.db.query("DELETE FROM package_cache WHERE key = ?").run(k);
  await evict();
}

// What the cache holds for a key: its entry, or the failure of its install while it is remembered. A failure is
// known by the key and how the install ran (failedKey): one in a sandbox without the network says nothing of an
// install with it.
export type Hit = { state: "ok"; dir: string; dirs: string[] } | { state: "failed"; why: string; at: number };
export const failedKey = (key: string, how: string) => `${key}@${how}`;
export function lookup(key: string, now = Date.now()): Hit | undefined {
  if (!store) return undefined;
  const r = store.db.query<Row, [string]>("SELECT * FROM package_cache WHERE key = ?").get(key);
  if (!r) return undefined;
  if (r.state === "failed") return now - r.made < FAILED_MS ? { state: "failed", why: r.why ?? "", at: r.made } : undefined;
  const at = join(dir(), key);
  if (!existsSync(join(at, "tree"))) { store.db.query("DELETE FROM package_cache WHERE key = ?").run(key); return undefined; }
  return { state: "ok", dir: at, dirs: JSON.parse(r.dirs ?? "[]") };
}

export function failed(key: string, repo: string, lock: string, why: string) {
  store?.db.query("INSERT OR REPLACE INTO package_cache (key, repo, lock, state, why, made, used) VALUES (?, ?, ?, 'failed', ?, ?, ?)").run(key, repo, lock, why, Date.now(), Date.now());
}

// The entry is the run's until `release`: it is not evicted, and its `root` is the run's checkout.
export const hold = (key: string) => { inUse.add(key); };
export const release = (key: string) => { inUse.delete(key); };

// Links an entry's packages folders into the lockfile's folder of a scratch checkout (`lockDir`), and its `root`
// to that folder. A folder whose place is not in the checkout is left out (the base has no such package any more).
export function linkInto(key: string, hit: Extract<Hit, { state: "ok" }>, lockDir: string) {
  const root = join(hit.dir, "root"), next = `${root}.${process.pid}`;
  try { unlinkSyncQuiet(next); symlinkSync(lockDir, next); renameSync(next, root); } catch (e) { throw new Error(`the cached packages could not be pointed at the checkout: ${(e as Error).message}`); }
  for (const rel of hit.dirs) {
    const to = join(lockDir, rel);
    if (!existsSync(dirname(to)) || existsSync(to)) continue;
    symlinkSync(join(hit.dir, "tree", rel), to);
  }
  store?.db.query("UPDATE package_cache SET used = ? WHERE key = ?").run(Date.now(), key);
}
const unlinkSyncQuiet = (p: string) => { try { unlinkSync(p); } catch {} }; // none there

// The packages folders an install made in the lockfile's folder of a scratch checkout (`rels`, relative to it)
// become the entry of `key`, linked back into the checkout. Off the loop: the moves are renames, the links are
// read and rewritten through the thread pool, and the size is du's. Undefined when they could not be moved (the
// state folder is on another file system): they stay in the checkout, for this run only. Throws when they were
// moved and could not be made an entry.
export async function adopt(key: string, meta: { repo: string; lock: string }, scratch: string, lockDir: string, rels: readonly string[]): Promise<Extract<Hit, { state: "ok" }> | undefined> {
  if (!store || !rels.length) return undefined;
  const entry = join(dir(), key), part = `${entry}.part-${process.pid}`;
  await rm(part, { recursive: true, force: true });
  mkdirSync(join(part, "tree"), { recursive: true });
  const moved: string[] = [];
  try {
    for (const rel of rels) {
      mkdirSync(dirname(join(part, "tree", rel)), { recursive: true });
      await rename(join(lockDir, rel), join(part, "tree", rel));
      moved.push(rel);
    }
  } catch {
    for (const rel of moved) await rename(join(part, "tree", rel), join(lockDir, rel)).catch(() => {});
    await rm(part, { recursive: true, force: true });
    return undefined;
  }
  try {
    const folders = rels.map((r) => join(lockDir, r));
    for (const rel of rels) await relinkAll(join(part, "tree", rel), join(lockDir, rel), { folders, lockDir, scratch, entry });
    await rm(entry, { recursive: true, force: true });
    await rename(part, entry);
  } catch (e) {
    // (Its links may be half rewritten: what the install made is not kept, and the run says why it has none.)
    await rm(part, { recursive: true, force: true });
    throw e;
  }
  const bytes = await sizeOf(entry);
  const now = Date.now();
  store.db.query("INSERT OR REPLACE INTO package_cache (key, repo, lock, state, why, dirs, bytes, made, used) VALUES (?, ?, ?, 'ok', NULL, ?, ?, ?, ?)").run(key, meta.repo, meta.lock, JSON.stringify(rels), bytes, now, now);
  const hit = { state: "ok" as const, dir: entry, dirs: [...rels] };
  linkInto(key, hit, lockDir);
  await evict();
  return hit;
}

// Every link under `real` (a packages folder moved into an entry; `was`: where it was), rewritten by relinkOf.
async function relinkAll(real: string, was: string, p: Parameters<typeof relinkOf>[2]) {
  let list: Dirent[];
  try { list = await readdir(real, { withFileTypes: true }); } catch { return; }
  for (const d of list) {
    const at = join(real, d.name);
    if (d.isDirectory()) await relinkAll(at, join(was, d.name), p);
    else if (d.isSymbolicLink()) {
      const target = await readlink(at).catch(() => undefined);
      const next = target === undefined ? undefined : relinkOf(join(was, d.name), target, p);
      if (next) { await unlink(at); await symlink(next, at); }
    }
  }
}

async function sizeOf(p: string): Promise<number> {
  try {
    const du = Bun.spawn(["du", "-sk", p], { stdout: "pipe", stderr: "ignore" });
    const { out } = await outputOf(du, { where: "du" });
    const kb = Number(out.split(/\s/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch { return 0; } // no du here: the entry counts as nothing against the budget
}

// The entries over the age and the budget go (evictOf), off the loop.
export async function evict(now = Date.now()) {
  if (!store) return;
  store.db.query("DELETE FROM package_cache WHERE state = 'failed' AND made < ?").run(now - FAILED_MS);
  const rows = store.db.query<Row, []>("SELECT * FROM package_cache WHERE state = 'ok'").all();
  for (const key of evictOf(rows.map((r) => ({ key: r.key, bytes: r.bytes ?? 0, used: r.used })), now, inUse)) {
    store.db.query("DELETE FROM package_cache WHERE key = ?").run(key);
    await rm(join(dir(), key), { recursive: true, force: true });
  }
}
