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
// A row is about 300 bytes; the ledger keeps the newest KEEP rows (settable:
// checks.keep_runs). That holds weeks of a busy day's runs, and the base's
// recent commits it is asked about.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { settings } from "../admin/settings.ts";
import { addAll, git, locate } from "../core/git.ts";
import type { Store } from "../core/store.ts";
import { sandboxScope } from "../safety/sandbox-scope.ts";
import { FILE, normDir, overlay, parseChecks, readChecks, type Named as NamedChecks } from "./named.ts";
import type { Result, Run } from "./words.ts";

export const KEEP = 20_000;
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
  from_run INTEGER
);
CREATE INDEX IF NOT EXISTS check_runs_key_tree ON check_runs(key, tree, ended);
CREATE INDEX IF NOT EXISTS check_runs_session ON check_runs(session_id, ended, id);
`;

let store: Store | undefined;
let keep = KEEP;
export function bindLedger(s: Store) {
  store = s;
  s.migrate(SCHEMA);
}
export const setKeep = (n: number) => { keep = n; };
export const bound = () => keep;
const db = () => store?.db;

// What a check run is known by across trees: its folder and its command.
export const keyOf = (dir: string, command: string) => `${dir}\n${command}`;

// --- the repository and its checks

export type Repo = { top: string; gitDir: string; scope: string };
export function repoOf(folder: string): Repo | undefined {
  try {
    const w = locate(folder);
    if (!w?.top) return undefined;
    return { top: w.top, gitDir: w.gitDir, scope: sandboxScope(w.top) };
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
// The tree of the work tree as it is now, and the commit it has out.
export async function treeOf(repo: Repo): Promise<{ tree: string; head: string | null } | undefined> {
  if (!store) return undefined;
  const dir = join(store.stateDir, "checks");
  const index = join(dir, `index-${createHash("sha256").update(repo.gitDir).digest("hex").slice(0, 20)}`);
  // One look at a time per index: two at once would write it under each other.
  const prev = indexes.get(index) ?? Promise.resolve();
  const run = prev.then(async () => {
    mkdirSync(dir, { recursive: true });
    const real = join(repo.gitDir, "index");
    const mark = `${index}.from`;
    let st = "";
    try { const s = statSync(real); st = `${s.size}:${s.mtimeMs}:${s.ino}`; } catch {}
    let was = "";
    try { was = readFileSync(mark, "utf8"); } catch {}
    if (st && (st !== was || !existsSync(index))) { copyFileSync(real, index); await Bun.write(mark, st); }
    const call = async (args: string[], input?: string) => {
      const r = await git(repo.top, args, { index, input, timeout: TREE_MS });
      // (`add --ignore-errors` exits 1 for a file it could not read, and adds the rest.)
      if (r.code !== 0 && !(r.code === 1 && args[0] === "add")) throw new Error(`git ${args[0]}: ${r.err.trim().split("\n").at(-1) ?? r.code}`);
      return r.out;
    };
    await addAll(repo.top, call, ["--ignore-errors"]);
    const tree = (await call(["write-tree"])).trim();
    const head = await git(repo.top, ["rev-parse", "-q", "--verify", "HEAD"], { read: true, timeout: 10_000 });
    return { tree, head: head.code === 0 ? head.out.trim() : null };
  });
  const tail = run.catch(() => {});
  indexes.set(index, tail);
  void tail.then(() => { if (indexes.get(index) === tail) indexes.delete(index); });
  try { return await run; } catch { return undefined; }
}

// The tree of a commit the repository has (a check of a commit, src/checks/named.ts tree).
export async function commitTree(repo: Repo, rev: string): Promise<{ tree: string; head: string | null } | undefined> {
  const r = await git(repo.top, ["rev-parse", "-q", "--verify", `${rev}^{commit}`, `${rev}^{tree}`], { read: true, timeout: 10_000 });
  const [head, tree] = r.out.trim().split("\n");
  return r.code === 0 && head && tree ? { tree, head } : undefined;
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

const COLS = "id, name, command, dir, tree, head, session_id, by, result, exit, pass, fail, started, ended, log, from_run";
let writes = 0;
export function record(r: Omit<Run, "id"> & { repo: string; call_id?: string | null }): Run | undefined {
  const d = db();
  if (!d) return undefined;
  const row = d.query<{ id: number }, any[]>(
    `INSERT INTO check_runs (key, name, command, dir, repo, tree, head, session_id, call_id, by, result, exit, pass, fail, started, ended, log, from_run)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).get(keyOf(r.dir, r.command), r.name, r.command, r.dir, r.repo, r.tree, r.head, r.session_id, r.call_id ?? null, r.by, r.result, r.exit, r.pass, r.fail, r.started, r.ended, r.log, r.from_run);
  // The bound, checked every hundred writes: the oldest rows past it go.
  if (++writes % 100 === 0) d.query("DELETE FROM check_runs WHERE id <= (SELECT MAX(id) FROM check_runs) - ?").run(keep);
  return row ? { id: row.id, ...r } as Run : undefined;
}

// The runs of a check on one tree, newest first (answered ones left out).
export const onTree = (key: string, tree: string): Run[] =>
  db()?.query<Run, [string, string]>(`SELECT ${COLS} FROM check_runs INDEXED BY check_runs_key_tree WHERE key = ? AND tree = ? AND result IN ('pass', 'fail') ORDER BY ended DESC LIMIT 50`).all(key, tree) ?? [];

// The passes and failures of a check on any of these trees.
export function onTrees(key: string, trees: string[]): Run[] {
  const d = db();
  if (!d || !trees.length) return [];
  return d.query<Run, string[]>(`SELECT ${COLS} FROM check_runs INDEXED BY check_runs_key_tree WHERE key = ? AND tree IN (${trees.map(() => "?").join(", ")}) AND result IN ('pass', 'fail')`).all(key, ...trees);
}

export const run = (id: number): Run | undefined => db()?.query<Run, [number]>(`SELECT ${COLS} FROM check_runs WHERE id = ?`).get(id) ?? undefined;

// A session's runs since a time, oldest first, at most `limit`.
export const ofSession = (sessionId: string, since = 0, limit = 500): Run[] =>
  db()?.query<Run, [string, number, number]>(`SELECT * FROM (SELECT ${COLS} FROM check_runs INDEXED BY check_runs_session WHERE session_id = ? AND ended >= ? ORDER BY ended DESC, id DESC LIMIT ?) ORDER BY ended, id`).all(sessionId, since, limit) ?? [];

export type ListOpts = { session?: string; repo?: string; tree?: string; before?: number; limit?: number };
// The ledger for the route: newest first, with what the answers saved.
export function list(o: ListOpts): { runs: (Run & { repo: string })[]; answered: number; saved_ms: number; kept: number; bound: number } {
  const d = db();
  if (!d) return { runs: [], answered: 0, saved_ms: 0, kept: 0, bound: keep };
  const where: string[] = [], args: (string | number)[] = [];
  if (o.session) { where.push("session_id = ?"); args.push(o.session); }
  if (o.repo) { where.push("repo = ?"); args.push(o.repo); }
  if (o.tree) { where.push("tree = ?"); args.push(o.tree); }
  if (o.before) { where.push("id < ?"); args.push(o.before); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(Math.floor(o.limit ?? 100), 1), 1000);
  const runs = d.query<Run & { repo: string }, (string | number)[]>(`SELECT ${COLS}, repo FROM check_runs ${w} ORDER BY id DESC LIMIT ?`).all(...args, limit);
  // What answering from the ledger saved: the time each answered run's original took.
  const saved = d.query<{ n: number; ms: number | null }, (string | number)[]>(
    `SELECT COUNT(*) AS n, SUM(o.ended - o.started) AS ms FROM check_runs a JOIN check_runs o ON o.id = a.from_run ${w ? w.replace(/\b(session_id|repo|tree|id)\b/g, "a.$1") : ""} ${w ? "AND" : "WHERE"} a.result = 'answered'`,
  ).get(...args) ?? { n: 0, ms: 0 };
  const kept = d.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM check_runs").get()?.n ?? 0;
  return { runs, answered: saved.n, saved_ms: saved.ms ?? 0, kept, bound: keep };
}

export type { Result };
