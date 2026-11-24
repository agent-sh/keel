// The check ledger: every run of a check a repository names (src/checks/named.ts),
// by an agent or by the owner, kept by the tree it ran on.
//
// The tree is the git tree of the work tree as it is, uncommitted and new
// files included (ignored ones not): git's own `add -A` into an index of
// Keel's own, then `write-tree`. The index is a copy of the repository's,
// kept per git directory and copied again only when the repository's index
// changed, so git hashes only the files whose size or time changed since the
// last look (git's stat cache), and the same files give the same tree in any
// worktree or clone. A repository inside the work tree counts by the commit
// it has out (src/core/git.ts addAll).
//
// The look writes the blobs of new and changed files into an object folder
// of Keel's own (the repository's store is read through an alternate, never
// written), and hashes at most NEW_MAX bytes of them: a look over more
// records the run with no tree (never answered, never compared), so a large
// file that is not ignored costs nothing before the check starts.
//
// A row is about 300 bytes; the ledger keeps the newest KEEP rows (settable:
// checks.keep_runs). That holds weeks of a busy day's runs, and the base's
// recent commits it is asked about.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { settings } from "../admin/settings.ts";
import { addAll, git, locate } from "../core/git.ts";
import type { Store } from "../core/store.ts";
import { sandboxScope } from "../safety/sandbox-scope.ts";
import { FILE, normDir, overlay, parseChecks, readChecks, type Named as NamedChecks } from "./named.ts";
import type { Result, Run } from "./words.ts";

export const KEEP = 20_000;
// Bytes of new and changed files one look hashes at most: git hashed and wrote a 300 MB file in 6.9 s
// (about 43 MB/s), so this is under a second before the check starts. More new files than NEW_FILES:
// the same (the look stats each of them).
export const NEW_MAX = 32 * 1024 * 1024;
const NEW_FILES = 20_000;
// Keel's object folder for a repository is emptied when the bytes written to it pass this.
const OWN_OBJECTS_MAX = 512 * 1024 * 1024;
const TREE_MS = 30_000;
const HISTORY = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS check_runs (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  dir TEXT NOT NULL,
  repo TEXT NOT NULL,
  tree TEXT NOT NULL,
  head TEXT,
  session_id TEXT,
  call_id TEXT,
  by TEXT NOT NULL,
  result TEXT NOT NULL,
  exit INTEGER,
  pass INTEGER,
  fail INTEGER,
  started INTEGER NOT NULL,
  ended INTEGER NOT NULL,
  log TEXT,
  from_run INTEGER,
  inputs TEXT,
  top TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS check_pending (call_id TEXT PRIMARY KEY, data TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS check_anyway (session_id TEXT NOT NULL, key TEXT NOT NULL, tree TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (session_id, key, tree)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS check_runs_key_tree ON check_runs(key, tree, ended);
CREATE INDEX IF NOT EXISTS check_runs_session ON check_runs(session_id, ended, id);
CREATE INDEX IF NOT EXISTS check_runs_tree ON check_runs(tree, ended);
CREATE INDEX IF NOT EXISTS check_runs_head ON check_runs(head, session_id, ended);
`;

let store: Store | undefined;
let keep = KEEP;
export function bindLedger(s: Store) {
  store = s;
  s.migrate(SCHEMA);
  // (A table of an earlier build of this module.)
  for (const c of ["inputs", "top", "note"]) if (!s.columnExists("check_runs", c)) s.migrate(`ALTER TABLE check_runs ADD COLUMN ${c} TEXT`);
  // What a restart left owed is kept a week; a mark to run anyway, a day.
  s.db.query("DELETE FROM check_pending WHERE created < ?").run(Date.now() - 7 * 86400_000);
  s.db.query("DELETE FROM check_anyway WHERE created < ?").run(Date.now() - 86400_000);
}
// (A test that bound a store of its own lets go of it: the ledger is process-wide.)
export const unbindLedger = () => { store = undefined; };
// The passes and failures of every check on one tree, newest first (an agent's work note, src/automation/leftovers.ts).
export const decidedOn = (tree: string, limit = 200): Run[] =>
  !tree ? [] : db()?.query<Run, [string, number]>(`SELECT ${COLS} FROM check_runs INDEXED BY check_runs_tree WHERE tree = ? AND result IN ('pass', 'fail') ORDER BY ended DESC LIMIT ?`).all(tree, limit) ?? [];
export const setKeep = (n: number) => { keep = n; };
export const bound = () => keep;
const db = () => store?.db;

// What a check run is known by across trees: its folder and its command.
export const keyOf = (dir: string, command: string) => `${dir}\n${command}`;

// --- the repository and its checks

export type Repo = { top: string; gitDir: string; common: string; scope: string };
export function repoOf(folder: string): Repo | undefined {
  try {
    const w = locate(folder);
    if (!w?.top) return undefined;
    return { top: w.top, gitDir: w.gitDir, common: w.common, scope: sandboxScope(w.top) };
  } catch { return undefined; }
}

// The checks for a repository: the file in its work tree with the owner's
// setting for it laid over (src/checks/named.ts overlay). `source` says
// where they come from; undefined: nothing names checks there. The file is
// read again only when it changed on disk.
const fileCache = new Map<string, { mark: string; named: NamedChecks }>();
export type Named = NamedChecks & { source: "file" | "setting" | "file and setting" };
// The owner's setting for a repository (checks.repos, by its main checkout).
export const settingFor = (scope: string): unknown => (settings().checks?.repos as Record<string, unknown> | undefined)?.[scope];
function fileOf(top: string): NamedChecks | undefined {
  const path = join(top, FILE);
  let mark: string;
  try { const st = statSync(path); if (!st.isFile()) return undefined; mark = `${st.size}:${st.mtimeMs}:${st.ino}`; } catch { return undefined; }
  const had = fileCache.get(path);
  if (had?.mark === mark) return had.named;
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch {}
  const named = text.length > 64_000 ? { checks: [], wait: [], env: [], problems: ["it is over 64 KB"] } : parseChecks(text);
  fileCache.set(path, { mark, named });
  if (fileCache.size > 256) fileCache.delete(fileCache.keys().next().value!);
  return named;
}
export function namedFor(repo: Repo, setting: (scope: string) => unknown = settingFor): Named | undefined {
  const file = fileOf(repo.top);
  const raw = setting(repo.scope);
  const own = raw === undefined ? undefined : readChecks(raw);
  const got = overlay(file, own);
  if (!got) return undefined;
  return { ...got, source: file && own ? "file and setting" : own ? "setting" : "file" };
}

// A folder from the repository's top, or undefined when it is outside.
export function fromTop(repo: Repo, folder: string): string | undefined {
  const rel = relative(repo.top, folder);
  if (rel.startsWith("..") || rel.startsWith("/")) return undefined;
  return normDir(rel);
}

// --- the tree

const indexes = new Map<string, Promise<unknown>>();
// Keel's own object folder for a repository's looks: the blobs of new and changed files and the trees a look
// writes (a copy of the files is checked out from it and the repository's own objects: src/checks/beside-run.ts).
export const objectsOf = (repo: Repo): string | undefined => store && join(store.stateDir, "checks", `objects-${createHash("sha256").update(repo.gitDir).digest("hex").slice(0, 20)}`);
export type Look = { tree: string; head: string | null } | { tree: null; head: string | null; why: string };
// The tree of the work tree as it is now, and the commit it has out; `tree` null with why when it was not read.
export async function treeOf(repo: Repo): Promise<Look | undefined> {
  if (!store) return undefined;
  const dir = join(store.stateDir, "checks");
  const id = createHash("sha256").update(repo.gitDir).digest("hex").slice(0, 20);
  const index = join(dir, `index-${id}`);
  const objects = objectsOf(repo)!;
  const written = `${objects}.bytes`;
  // One look at a time per index: two at once would write it under each other.
  const prev = indexes.get(index) ?? Promise.resolve();
  const run = prev.then(async (): Promise<Look> => {
    mkdirSync(join(objects, "info"), { recursive: true });
    const real = join(repo.gitDir, "index");
    const mark = `${index}.from`;
    let st = "";
    let real0: ReturnType<typeof statSync> | undefined;
    try { real0 = statSync(real); st = `${real0.size}:${real0.mtimeMs}:${real0.ino}`; } catch {}
    let was = "";
    try { was = readFileSync(mark, "utf8"); } catch {}
    if (st && (st !== was || !existsSync(index))) {
      copyFileSync(real, index);
      // The copy keeps the index's times: git trusts an entry's stat only when the file is older than
      // the index that holds it (its racy-entry rule), and a copy made later would hide a same-size
      // change made in the second the index was written.
      utimesSync(index, real0!.atime, real0!.mtime);
      await Bun.write(mark, st);
    }
    // Blobs go to Keel's own folder; the repository's objects are read through an alternate.
    const env = { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(repo.common, "objects") };
    const call = async (args: string[], input?: string) => {
      const r = await git(repo.top, args, { index, input, timeout: TREE_MS, env });
      // (`add --ignore-errors` exits 1 for a file it could not read, and adds the rest.)
      if (r.code !== 0 && !(r.code === 1 && args[0] === "add")) throw new Error(`git ${args[0]}: ${r.err.trim().split("\n").at(-1) ?? r.code}`);
      return r.out;
    };
    const headOf = async () => { const h = await git(repo.top, ["rev-parse", "-q", "--verify", "HEAD"], { read: true, timeout: 10_000 }); return h.code === 0 ? h.out.trim() : null; };
    // What the add would hash: files new to the copy and files changed since it, by their size.
    const names = [...(await call(["ls-files", "-z", "-m"])).split("\0"), ...(await call(["ls-files", "-z", "-o", "--exclude-standard"])).split("\0")].filter(Boolean);
    if (names.length > NEW_FILES) return { tree: null, head: await headOf(), why: `more than ${NEW_FILES} new or changed files` };
    let bytes = 0;
    for (const n of names) { try { const f = statSync(join(repo.top, n)); if (f.isFile()) bytes += f.size; } catch {} } // gone meanwhile
    if (bytes > NEW_MAX) return { tree: null, head: await headOf(), why: `${Math.round(bytes / 1048576)} MB of new or changed files, over the ${NEW_MAX / 1048576} MB a look hashes` };
    let total = 0;
    try { total = Number(readFileSync(written, "utf8")) || 0; } catch {}
    if (total + bytes > OWN_OBJECTS_MAX) {
      // Emptied, with the copy that points into it: the next copy points only at the repository's objects.
      rmSync(objects, { recursive: true, force: true });
      mkdirSync(join(objects, "info"), { recursive: true });
      copyFileSync(real, index);
      if (real0) utimesSync(index, real0.atime, real0.mtime);
      total = 0;
    }
    await Bun.write(written, String(total + bytes));
    await addAll(repo.top, call, ["--ignore-errors"]);
    const tree = (await call(["write-tree"])).trim();
    return { tree, head: await headOf() };
  });
  const tail = run.catch(() => {});
  indexes.set(index, tail);
  void tail.then(() => { if (indexes.get(index) === tail) indexes.delete(index); });
  try { return await run; } catch { return undefined; }
}

// What a check's `inputs` are now (src/checks/named.ts): each path from the work tree's top, through
// links (`node_modules/../bun.lock` is the lock file of the install node_modules is), by the stat of
// the file, or of a folder and each entry in it. Undefined: the check names none.
// A path from `top` as the kernel reads it: each part through its link before the next, so `..` after
// a link is the parent of where the link points (path.join and realpath here read `..` first).
function walk(top: string, p: string): string {
  let cur = realpathSync(top);
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    cur = part === ".." ? dirname(cur) : realpathSync(join(cur, part));
  }
  return cur;
}
export function inputsOf(top: string, inputs: readonly string[]): string | undefined {
  if (!inputs.length) return undefined;
  const h = createHash("sha256");
  const of = (p: string) => { const f = statSync(p); return `${f.size}:${f.mtimeMs}:${f.ino}`; };
  for (const p of inputs) {
    let real: string;
    try { real = walk(top, p); } catch { h.update(`${p}\0missing\n`); continue; }
    h.update(`${p}\0${real}\0`);
    try {
      const f = statSync(real);
      if (!f.isDirectory()) { h.update(`${of(real)}\n`); continue; }
      h.update(`${f.mtimeMs}:${f.ino}\n`);
      const entries = readdirSync(real).sort().slice(0, 5000);
      for (const e of entries) { try { h.update(`${e}\0${of(join(real, e))}\n`); } catch { h.update(`${e}\0?\n`); } }
    } catch { h.update("unreadable\n"); }
  }
  return h.digest("hex").slice(0, 24);
}

// The tree of a commit the repository has (a check of a commit, src/checks/named.ts tree).
// (`--verify` takes one revision a call.)
export async function commitTree(repo: Repo, rev: string): Promise<{ tree: string; head: string | null } | undefined> {
  if (rev.startsWith("-")) return undefined;
  const one = async (r: string) => { const o = await git(repo.top, ["rev-parse", "-q", "--verify", "--end-of-options", r], { read: true, timeout: 10_000 }); return o.code === 0 ? o.out.trim() || undefined : undefined; };
  const head = await one(`${rev}^{commit}`);
  const tree = head && (await one(`${head}^{tree}`));
  return head && tree ? { tree, head } : undefined;
}

// --- the base: the branch a red check is compared with

// The base of a work tree: its Keel worktree's base, else what origin/HEAD
// names, else main or master. Its first-parent commits, newest first, with their trees.
export async function baseOf(repo: Repo): Promise<{ name: string; history: { commit: string; tree: string }[] } | undefined> {
  const wt = db()?.query<{ base: string }, [string]>("SELECT base FROM worktrees WHERE path = ? AND state = 'active' LIMIT 1").get(repo.top);
  const tries: string[] = [];
  if (wt?.base) tries.push(wt.base);
  const origin = await git(repo.top, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], { read: true, timeout: 10_000 });
  if (origin.code === 0 && origin.out.trim()) tries.push(origin.out.trim());
  tries.push("origin/main", "main", "origin/master", "master");
  for (const name of tries) {
    const r = await git(repo.top, ["log", "--first-parent", "--format=%H %T", `-n${HISTORY}`, `${name}^{commit}`, "--"], { read: true, timeout: 10_000 });
    if (r.code !== 0 || !r.out.trim()) continue;
    return { name, history: r.out.trim().split("\n").map((l) => { const [commit, tree] = l.split(" "); return { commit: commit!, tree: tree! }; }) };
  }
  return undefined;
}

// --- rows

const COLS = "id, name, command, dir, tree, head, session_id, by, result, exit, pass, fail, started, ended, log, from_run, inputs, top";
let writes = 0;
// `note`: why a run is not a result (the first line of what the copy lacked): it is "stopped", said on the timeline.
export function record(r: Omit<Run, "id" | "inputs" | "top"> & { repo: string; call_id?: string | null; inputs?: string | null; top?: string | null; note?: string | null }): Run | undefined {
  const d = db();
  if (!d) return undefined;
  const row = d.query<{ id: number }, any[]>(
    `INSERT INTO check_runs (key, name, command, dir, repo, tree, head, session_id, call_id, by, result, exit, pass, fail, started, ended, log, from_run, inputs, top, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).get(keyOf(r.dir, r.command), r.name, r.command, r.dir, r.repo, r.tree, r.head, r.session_id, r.call_id ?? null, r.by, r.result, r.exit, r.pass, r.fail, r.started, r.ended, r.log, r.from_run, r.inputs ?? null, r.top ?? null, r.note ?? null);
  // The bound, checked every hundred writes: the oldest rows past it go.
  if (++writes % 100 === 0) d.query("DELETE FROM check_runs WHERE id <= (SELECT MAX(id) FROM check_runs) - ?").run(keep);
  return row ? ({ id: row.id, ...r, inputs: r.inputs ?? null, top: r.top ?? null } as Run) : undefined;
}

// The runs of a check on one tree (and the same inputs, when it names them), newest first (answered ones left out).
// A run with no tree (its files were not read) is never on one.
export const onTree = (key: string, tree: string, inputs: string | null = null): Run[] =>
  !tree ? [] : db()?.query<Run, [string, string, string | null]>(`SELECT ${COLS} FROM check_runs INDEXED BY check_runs_key_tree WHERE key = ? AND tree = ? AND inputs IS ? AND result IN ('pass', 'fail') ORDER BY ended DESC LIMIT 50`).all(key, tree, inputs) ?? [];

// The passes and failures of a check on any of these trees (the base's history), by the owner or a session:
// a run Keel made by itself beside an agent ran on its copy, in its sandbox, and is no evidence of the base.
export function onTrees(key: string, trees: string[]): Run[] {
  const d = db();
  if (!d || !trees.length) return [];
  return d.query<Run, string[]>(`SELECT ${COLS} FROM check_runs INDEXED BY check_runs_key_tree WHERE key = ? AND tree IN (SELECT value FROM json_each(?)) AND result IN ('pass', 'fail') AND by != 'beside'`).all(key, JSON.stringify(trees));
}

export const run = (id: number): Run | undefined => db()?.query<Run, [number]>(`SELECT ${COLS} FROM check_runs WHERE id = ?`).get(id) ?? undefined;

// The runs of every check on one tree, whoever ran them, the newest first (an agent's lane: src/automation/lane.ts).
export const ofTree = (tree: string, limit = 100): Run[] =>
  db()?.query<Run, [string, number]>(`SELECT ${COLS} FROM check_runs INDEXED BY check_runs_tree WHERE tree = ? ORDER BY ended DESC LIMIT ?`).all(tree, limit) ?? [];

// A session's runs since a time, oldest first, at most `limit`.
export const ofSession = (sessionId: string, since = 0, limit = 500): Run[] =>
  db()?.query<Run, [string, number, number]>(`SELECT * FROM (SELECT ${COLS} FROM check_runs INDEXED BY check_runs_session WHERE session_id = ? AND ended >= ? ORDER BY ended DESC, id DESC LIMIT ?) ORDER BY ended, id`).all(sessionId, since, limit) ?? [];

// --- what outlives a restart: a call's check run owed a record (its job may be taken back by the next
// daemon), and a session's mark that the next send of an answered check runs it.
export const owe = (callId: string, data: unknown) => void db()?.query("INSERT OR REPLACE INTO check_pending (call_id, data, created) VALUES (?, ?, ?)").run(callId, JSON.stringify(data), Date.now());
export function owed<T>(callId: string): T | undefined {
  const r = db()?.query<{ data: string }, [string]>("DELETE FROM check_pending WHERE call_id = ? RETURNING data").get(callId);
  return r ? (JSON.parse(r.data) as T) : undefined;
}
export const markAnyway = (sessionId: string, key: string, tree: string) => void db()?.query("INSERT OR REPLACE INTO check_anyway (session_id, key, tree, created) VALUES (?, ?, ?, ?)").run(sessionId, key, tree, Date.now());
// Whether the mark was there (it is used up).
export const takeAnyway = (sessionId: string, key: string, tree: string): boolean =>
  !!db()?.query<{ k: string }, [string, string, string]>("DELETE FROM check_anyway WHERE session_id = ? AND key = ? AND tree = ? RETURNING key AS k").get(sessionId, key, tree);

export type ListOpts = { session?: string; repo?: string; tree?: string; before?: number; limit?: number };
export type Read = <T>(sql: string, params: (string | number | null)[]) => Promise<T[]>;
// The ledger for the route: newest first, with what the answers saved. Read on the read thread
// (`read`, src/server/reads.ts): the sums go over the whole table.
export async function list(o: ListOpts, read: Read): Promise<{ runs: (Run & { repo: string })[]; answered: number; saved_ms: number; kept: number; bound: number }> {
  const where: string[] = [], args: (string | number)[] = [];
  if (o.session) { where.push("session_id = ?"); args.push(o.session); }
  if (o.repo) { where.push("repo = ?"); args.push(o.repo); }
  if (o.tree) { where.push("tree = ?"); args.push(o.tree); }
  if (o.before) { where.push("id < ?"); args.push(o.before); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(Math.floor(o.limit ?? 100), 1), 1000);
  const [runs, saved, kept] = await Promise.all([
    read<Run & { repo: string }>(`SELECT ${COLS}, repo FROM check_runs ${w} ORDER BY id DESC LIMIT ?`, [...args, limit]),
    // What answering from the ledger saved: the time each answered run's original took.
    read<{ n: number; ms: number | null }>(
      `SELECT COUNT(*) AS n, SUM(o.ended - o.started) AS ms FROM check_runs a JOIN check_runs o ON o.id = a.from_run ${w ? w.replace(/\b(session_id|repo|tree|id)\b/g, "a.$1") : ""} ${w ? "AND" : "WHERE"} a.result = 'answered'`, args),
    read<{ n: number }>("SELECT COUNT(*) AS n FROM check_runs", []),
  ]);
  return { runs, answered: saved[0]?.n ?? 0, saved_ms: saved[0]?.ms ?? 0, kept: kept[0]?.n ?? 0, bound: keep };
}

export type { Result };
