// What an agent leaves behind when it ends, and what is left across sessions.
//
// At an agent's end (reported, failed, stopped) its commands that still have processes alive are stopped, unless
// another process is connected to a port they listen on. The worktree Keel made for it (the managed worktree of
// its session, recorded when Keel made it) goes with its branch when nothing of it would be lost, and is kept and
// named otherwise. Nothing else is removed by Keel: what is new in its repositories since it started (worktrees,
// branches) is only listed with what is in it, in its report and on Settings > Leftovers, where the owner removes
// it. Nothing the agent can write (a command line, a file, a trace, a reflog) decides a removal.
//
// What is seen of its processes: a command's processes by what the daemon holds the command by
// (src/tools/jobs.ts): its cgroup scope where the user manager gives one, which no descendant leaves (setsid,
// double forks, a cleared environment); without one its process group, its session and the mark its processes
// carry. Not seen: a process that leaves both the session and the mark where there is no cgroup, one a command
// hands to another manager (`systemd-run --user`, a container engine, ssh to another machine), and commands older
// than the jobs the daemon keeps.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BEFORE_DIR } from "../checks/before.ts";
import { BESIDE_DIR } from "../checks/beside.ts";
import type { Store } from "../core/store.ts";
import { git, locate } from "../core/git.ts";
import { contains, realOf } from "../core/paths.ts";
import { clientsOf, portsOf } from "../fleet/portal.ts";
import { allJobs, findJob, jobsIn, jobsOf, processesOf, scopeHoldsSelf, stopJob, type Job } from "../tools/jobs.ts";
import type { Worktree, Worktrees } from "../worktree/manager.ts";
import { readsOf } from "../server/reads.ts";
import { readText } from "../core/proc.ts";
import * as rules from "./leftover-rules.ts";
import * as scopes from "./scopes.ts";
import { HOLDS_SELF } from "./foreign-scopes.ts";
import { checksOnTree, FILES_KEPT, landingLines, type AgentLanding, type Landing, type BaseConflict, type ChecksOn } from "./landing.ts";
import { forecastOf } from "../worktree/overlap-scan.ts";
import { decidedOn, inputsOf, namedFor, repoOf, treeOf } from "../checks/ledger.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_git_before (agent_id TEXT NOT NULL, repo TEXT NOT NULL, snap TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (agent_id, repo));
CREATE TABLE IF NOT EXISTS leftovers (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, parent_id TEXT NOT NULL, kind TEXT NOT NULL, repo TEXT, path TEXT, name TEXT, fate TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS leftovers_repo ON leftovers(repo, kind);
CREATE TABLE IF NOT EXISTS scope_keeps (job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS scope_idle (key TEXT PRIMARY KEY, cpu REAL NOT NULL, at INTEGER NOT NULL, since INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS scope_told (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
`;
export function migrate(store: Store) {
  store.migrate(SCHEMA);
  if (!store.columnExists("leftovers", "report")) store.migrate("ALTER TABLE leftovers ADD COLUMN report TEXT");
  store.migrate("CREATE INDEX IF NOT EXISTS leftovers_agent ON leftovers(agent_id, report)");
  // Readings of agents that ended without their end settled (a path that closes an agent without its finish).
  if (store.columnExists("agents", "status")) store.db.query("DELETE FROM agent_git_before WHERE agent_id NOT IN (SELECT id FROM agents WHERE status IN ('running', 'waiting'))").run();
}
// An agent closed without its end settled: the reading from its start is no longer needed.
export const forget = (store: Store, agentId: string) => void store.db.query("DELETE FROM agent_git_before WHERE agent_id = ?").run(agentId);

// What earlier passes of one end recorded (a daemon that went down before the report was stored): what it
// stopped is gone now, and the reading from its start is used up, so both are told from the record.
function earlier(store: Store, agentId: string, report: string): rules.Settled {
  const s: rules.Settled = { stopped: [], kept: [], found: [] };
  const rows = store.db.query<{ kind: string; repo: string | null; path: string | null; name: string | null; fate: string }, [string, string]>(
    "SELECT kind, repo, path, name, fate FROM leftovers WHERE agent_id = ? AND report = ? ORDER BY id").all(agentId, report);
  for (const r of rows) {
    if (r.kind === "process" && r.fate === "stopped") s.stopped.push({ job: "", command: r.name ?? "", pids: [], ports: [], clients: 0 });
    else if ((r.kind === "worktree" || r.kind === "branch") && r.fate.startsWith("found: ") && r.repo)
      s.found.push({ kind: r.kind, repo: topOf(r.repo), path: r.path ?? undefined, name: r.name ?? undefined, holds: r.fate.slice(7) });
    else if (r.kind === "unit" && r.name !== null && !s.units?.includes(r.name)) (s.units ??= []).push(r.name);
  }
  return s;
}
const topOf = (common: string) => (common.endsWith("/.git") ? dirname(common) : common);

// A repository by its common git directory, with a checkout to run git in.
type Repo = { common: string; top: string };
function repoAt(dir: string): Repo | undefined {
  let d = dir;
  try { if (!statSync(d).isDirectory()) d = dirname(d); } catch { return undefined; }
  const w = locate(d);
  if (!w?.top) return undefined;
  return { common: w.common, top: w.top };
}
const reposOf = (dirs: Iterable<string>, cap = 40): Repo[] => {
  const by = new Map<string, Repo>();
  for (const d of dirs) {
    if (by.size >= cap) break;
    const r = repoAt(d);
    if (r && !by.has(r.common)) by.set(r.common, r);
  }
  return [...by.values()];
};
const run = async (dir: string, args: string[]) => { const r = await git(dir, args, { read: true, timeout: 30_000 }); return r.code === 0 ? r.out : undefined; };

async function trees(top: string): Promise<rules.GitTree[] | undefined> {
  const out = await run(top, ["worktree", "list", "--porcelain"]);
  return out === undefined ? undefined : rules.parseWorktrees(out);
}
async function branches(top: string): Promise<Record<string, string> | undefined> {
  const out = await run(top, ["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"]);
  if (out === undefined) return undefined;
  return Object.fromEntries(out.split("\n").filter(Boolean).map((l) => l.split("\0") as [string, string]));
}
async function snap(r: Repo): Promise<rules.GitSnap | undefined> {
  const [t, b] = await Promise.all([trees(r.top), branches(r.top)]);
  return t && b ? { worktrees: t.map((x) => x.path), branches: b } : undefined;
}

// When a worktree was made, for the page's order: its git directory's commondir file is written by `git worktree add`.
function treeMade(path: string): number | undefined {
  try {
    const named = /^gitdir: (.+)$/m.exec(readFileSync(join(path, ".git"), "utf8"))?.[1]?.trim();
    return named ? statSync(join(resolve(path, named), "commondir")).mtimeMs : undefined;
  } catch { return undefined; }
}

// The repositories an agent may change, read before its first step: what is new there at its end is listed.
export async function before(store: Store, agentId: string, dirs: string[]) {
  for (const r of reposOf(dirs)) {
    const s = await snap(r);
    if (s) store.db.query("INSERT OR REPLACE INTO agent_git_before (agent_id, repo, snap, at) VALUES (?, ?, ?, ?)").run(agentId, r.common, JSON.stringify(s), Date.now());
  }
}

// The systemd units its commands name (`systemd-run`): a process there is the user manager's, held by no job.
// Only said, never stopped or removed, so their names are read from the commands ("" for one with no name).
function unitsOf(jobs: Job[]): string[] {
  const out: string[] = [];
  for (const j of jobs) {
    if (j.by === "owner") continue;
    for (const m of j.command.matchAll(/\bsystemd-run\b([^;&|\n]*)/g)) {
      const unit = /(?:--unit[= ]|-u\s+)['"]?([\w.@:-]+)/.exec(m[1]!)?.[1] ?? "";
      if (!out.includes(unit)) out.push(unit);
    }
  }
  return out;
}

// What git status lists of a folder: changed and untracked files, and apart the ignored ones (a whole ignored
// folder is one name), which `git worktree remove` deletes without a word. Untracked files are listed whatever
// status.showUntrackedFiles says: with it off, `git worktree remove` deletes them too.
type Status = { dirty: number; ignored: string[] };
const statusOf = async (path: string): Promise<Status | undefined> => {
  const out = await run(path, ["status", "--porcelain", "-z", "--ignored", "--untracked-files=normal"]);
  if (out === undefined) return undefined;
  const recs = out.split("\0").filter(Boolean);
  const st: Status = { dirty: 0, ignored: [] };
  for (let i = 0; i < recs.length; i++) {
    if (recs[i]!.startsWith("!! ")) { st.ignored.push(recs[i]!.slice(3)); continue; }
    st.dirty++;
    if (recs[i]![0] === "R" || recs[i]![0] === "C") i++;
  }
  return st;
};
// Commits of `ref` that no other branch, remote branch or tag holds (`self`: the branches to leave out). `over`: a
// branch whose commits are its own, held or not by `self` (the branch the worktree was made from).
const uniqueOf = async (dir: string, ref: string, self?: string | string[], over?: string): Promise<number | undefined> => {
  const out = await run(dir, ["rev-list", "--count", ref, "--not", ...(over ? [`refs/heads/${over}`] : []), ...[self ?? []].flat().map((b) => `--exclude=${b}`), "--branches", "--remotes", "--tags", "--"]);
  return out === undefined ? undefined : Number(out.trim()) || 0;
};

// The base a branch lands on: the local branch origin/HEAD names (its remote ref when there is none), else a
// local main or master, as the landing queue and the board take it. Nothing is fetched.
async function landingBase(top: string): Promise<string | undefined> {
  const origin = (await run(top, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]))?.trim();
  if (origin) {
    const local = origin.slice(origin.indexOf("/") + 1);
    return local && (await run(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${local}`]))?.trim() ? local : origin;
  }
  for (const b of ["main", "master"]) if ((await run(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]))?.trim()) return b;
  return undefined;
}

// Whether the base holds a branch's work though its commits are its own (leftover-rules.ts, Landed). Read from git
// and the landing record; the merges' objects go to a folder of Keel's own, dropped after, and no merge driver or
// attribute of the repository runs (an empty attribute source). An answer is kept by the tip and the base's tip:
// a base that moves (on, or back) is read again. Its git calls are background work (niced). `undefined`: nothing
// says it landed, or git could not tell (the safe side).
const landedKept = new Map<string, rules.Landed | null>();
const BASE_LOG = 3000;
const low = async (dir: string, args: string[], o: { env?: Record<string, string>; input?: string; timeout?: number } = {}) => git(dir, args, { read: true, low: true, timeout: 30_000, ...o });
const lowOut = async (dir: string, args: string[]) => { const r = await low(dir, args); return r.code === 0 ? r.out : undefined; };
export async function landedOn(store: Store, top: string, tip: string, base?: string): Promise<rules.Landed | undefined> {
  base ??= await landingBase(top);
  if (!base) return undefined;
  const baseTip = (await run(top, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]))?.trim();
  if (!baseTip || !/^[0-9a-f]{40,64}$/.test(tip)) return undefined;
  const w = locate(top);
  if (!w) return undefined;
  const key = `${w.common} ${tip} ${baseTip}`;
  const known = landedKept.get(key);
  if (known !== undefined) return known ?? undefined;
  const found = await landedRead(store, top, w.common, tip, baseTip).catch(() => undefined);
  if (landedKept.size > 4096) landedKept.clear();
  landedKept.set(key, found ?? null);
  return found;
}
async function landedRead(store: Store, top: string, common: string, tip: string, baseTip: string): Promise<rules.Landed | undefined> {
  const ahead = (await lowOut(top, ["rev-list", "--count", `${baseTip}..${tip}`, "--"]))?.trim();
  if (ahead === undefined || !/^\d+$/.test(ahead) || ahead === "0") return undefined;
  const empty = (await low(top, ["hash-object", "-t", "tree", "--stdin"], { input: "" })).out.trim();
  if (!/^[0-9a-f]{40,64}$/.test(empty)) return undefined;
  const fork = (await lowOut(top, ["merge-base", baseTip, tip]))?.trim();
  if (!fork) return undefined;
  // A branch that changes no file over its fork (empty commits, a change and its undo) merges to any tree: the
  // tree says nothing of its commits, so only the landing record speaks for it.
  const [forkTree, tipTree] = await Promise.all([lowOut(top, ["rev-parse", `${fork}^{tree}`]), lowOut(top, ["rev-parse", `${tip}^{tree}`])]);
  if (!forkTree || !tipTree) return undefined;
  const changes = forkTree.trim() !== tipTree.trim();
  const dir = join(store.stateDir, "overlap-objects");
  mkdirSync(dir, { recursive: true });
  const objects = mkdtempSync(join(dir, "landed-"));
  try {
    mkdirSync(join(objects, "info"), { recursive: true });
    const env = { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(common, "objects") };
    // The branch merged on `at` gives `at`'s own tree: `at` holds every line of it.
    const holds = async (at: string) => {
      const [mt, t] = await Promise.all([
        low(top, ["--attr-source", empty, "-c", "core.attributesFile=/dev/null", "merge-tree", "--write-tree", "--no-messages", at, tip], { env, timeout: 60_000 }),
        lowOut(top, ["rev-parse", `${at}^{tree}`]),
      ]);
      return mt.code === 0 && !!t && mt.out.trim().split("\n")[0] === t.trim();
    };
    if (changes && (await holds(baseTip))) return { how: "whole", at: baseTip };
    const mine = (await lowOut(top, ["log", "--format=%s", `${baseTip}..${tip}`, "--"]))?.split("\n").filter(Boolean);
    const theirs = (await lowOut(top, ["log", "--first-parent", `--max-count=${BASE_LOG}`, "--format=%H%x00%s", `${fork}..${baseTip}`, "--"]))?.split("\n").filter(Boolean).map((l) => { const [sha, subject] = l.split("\0"); return { sha: sha!, subject: subject ?? "" }; });
    if (!mine || !theirs) return undefined;
    const subjects = new Set(mine);
    // The commit the landing queue landed it as counts only while the base holds it (a base reset before it does not).
    const row = await queuedAs(store, tip);
    const queued = row && /^[0-9a-f]{40,64}$/.test(row) && (await low(top, ["merge-base", "--is-ancestor", row, baseTip])).code === 0 ? row : undefined;
    if (changes) for (const at of rules.candidatesOf(theirs, subjects, queued)) if (at !== baseTip && (await holds(at))) return { how: "earlier", at };
    const on = new Set(theirs.map((c) => c.subject));
    const rec = rules.recordOf({ commits: subjects.size, matched: [...subjects].filter((s) => on.has(s)).length, newest: theirs.find((c) => subjects.has(c.subject))?.sha, queued, reviewed: await reviewedYes(store, tip) });
    return rec ? { how: "changed", ...rec } : undefined;
  } finally {
    rmSync(objects, { recursive: true, force: true });
  }
}
// The commit the landing queue landed this tip as, and whether a review said land it: small tables, read off the loop.
const queuedAs = async (store: Store, tip: string) => (await readsOf(store).sql<{ landed: string }>("SELECT landed FROM landing_queue WHERE tip = ? AND state = 'landed' AND landed IS NOT NULL ORDER BY updated DESC LIMIT 1", [tip]).catch(() => []))[0]?.landed ?? undefined;
const reviewedYes = async (store: Store, tip: string) => (await readsOf(store).sql<{ n: number }>("SELECT count(*) AS n FROM review_verdicts WHERE commit_sha = ? AND land = 'yes'", [tip]).catch(() => []))[0]?.n ? true : false;

// The owner's processes and the folder each works in, read once: a worktree a process works in is not removed
// (a command run by hand, another harness's session, an editor's server). The daemon is not one of them.
type Cwd = { pid: number; cwd: string; name: string };
function cwds(): Cwd[] {
  const uid = process.getuid?.();
  const out: Cwd[] = [];
  let names: string[] = [];
  try { names = readdirSync("/proc").filter((n) => /^\d+$/.test(n)); } catch { return out; }
  for (const n of names) {
    const pid = Number(n);
    if (pid === process.pid) continue;
    try {
      if (uid !== undefined && statSync(`/proc/${n}`).uid !== uid) continue;
      out.push({ pid, cwd: readlinkSync(`/proc/${n}/cwd`), name: readFileSync(`/proc/${n}/comm`, "utf8").trim() });
    } catch {} // gone, or not ours to read
  }
  return out;
}
const workingIn = (all: Cwd[], dir: string): string | undefined => {
  const d = realOf(dir);
  const p = all.find((x) => contains(d, x.cwd));
  return p ? `a process works in it: pid ${p.pid} (${p.name})` : undefined;
};

// `report`: the report this end makes (an agent given another task ends again with another).
export type AgentEnd = { id: string; session_id: string; parent_id: string; created: number; worktree?: string | null; branch?: string | null; report?: string };
// `workspace`: the daemon's own folder, whose repository counts as one Keel knows of.
type Ctx = { store: Store; isRunning: (sessionId: string) => boolean; workspace?: string };

// Processes of a session's commands that still run (the owner's own terminal commands aside), with their ports.
// A connection to a port from another command of the same agent is its own: it ends with it.
async function procsOf(jobs: Job[]): Promise<(rules.ProcLeft & { j: Job })[]> {
  const mine = jobs.filter((j) => j.by !== "owner");
  const found = await processesOf(mine);
  const all = [...found.values()].flatMap((ps) => ps.map((p) => p.pid));
  const out: (rules.ProcLeft & { j: Job })[] = [];
  for (const j of mine) {
    const pids = (found.get(j.id) ?? []).map((p) => p.pid);
    if (!pids.length) continue;
    const ports = (portsOf(new Map([[j.id, pids]])).get(j.id) ?? []).map((p) => p.port);
    const clients = ports.reduce((n, p) => n + clientsOf(pids, p, all), 0);
    out.push({ j, job: j.id, command: j.description || j.command, pids, ports, clients });
  }
  return out;
}

// Whether something other than the ending agent works in a folder: a command of another session, a live
// session, or any process of the owner's.
function busyIn(open: Row[], procs: Cwd[], dir: string, self: string, live: (sessionId: string) => boolean): string | undefined {
  const d = realOf(dir);
  const job = jobsIn(dir).find((j) => j.sessionId !== self && contains(d, realOf(j.cwd)));
  if (job) return `a command of another session runs in it: ${job.command.slice(0, 60)}`;
  const other = open.find((s) => s.id !== self && contains(d, realOf(s.workspace)) && live(s.id));
  if (other) return `the session "${other.title || other.id}" works in it`;
  return workingIn(procs, dir);
}

// At an agent's end: stop what it left running, and list what is new in its repositories since it started.
// Nothing is removed here (the worktree Keel made for it is settled by ownWorktree).
export async function settle(c: Ctx, a: AgentEnd): Promise<string> {
  const { store } = c;
  const jobs = jobsOf(a.session_id);
  const report = a.report ?? a.id;
  const s = earlier(store, a.id, report);
  const record = (kind: string, fate: string, o: { repo?: string; path?: string; name?: string }) =>
    store.db.query("INSERT INTO leftovers (agent_id, session_id, parent_id, kind, repo, path, name, fate, at, report) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(a.id, a.session_id, a.parent_id, kind, o.repo ?? null, o.path ?? null, o.name ?? null, fate, Date.now(), report);
  for (const p of await procsOf(jobs)) {
    const fate = rules.processFate(p);
    if (fate.act === "keep") { s.kept.push({ ...p, why: fate.why }); record("process", `kept: ${fate.why}`, { name: p.command }); continue; }
    const left = await stopJob(p.j, "was stopped: its agent ended");
    s.stopped.push({ ...p, left });
    record("process", left.length ? `still runs: pid ${left.join(", ")}` : "stopped", { name: p.command });
  }
  for (const u of unitsOf(jobs)) if (!s.units?.includes(u)) { (s.units ??= []).push(u); record("unit", "not stopped", { name: u }); }
  // What is new in the repositories read at its start. Keel's own worktree and branch for it are told apart.
  // (Keel's own scratch worktrees: a fails-before run's, src/checks/before-run.ts, and the landing queue's, src/landing/queue.ts.)
  const skip = { trees: new Set(a.worktree ? [a.worktree] : []), branches: new Set(a.branch ? [a.branch] : []), under: [join(store.stateDir, ...BEFORE_DIR), join(store.stateDir, ...BESIDE_DIR), join(store.stateDir, "landing")] };
  const readings = store.db.query<{ repo: string; snap: string }, [string]>("SELECT repo, snap FROM agent_git_before WHERE agent_id = ?").all(a.id);
  for (const row of readings) {
    const top = topOf(row.repo);
    const r = repoAt(top);
    if (!r || r.common !== row.repo) continue;
    const [list, heads] = await Promise.all([trees(r.top), branches(r.top)]);
    if (!list || !heads) continue;
    const fresh = rules.newSince(JSON.parse(row.snap) as rules.GitSnap, list, heads, skip, realOf);
    for (const t of fresh.trees) {
      const gone = !existsSync(t.path);
      const [st, unique] = gone ? [{ dirty: 0, ignored: [] }, 0] : await Promise.all([statusOf(t.path), uniqueOf(t.path, "HEAD", t.branch)]);
      const holds = gone ? "its folder is gone" : rules.treeHolds({ dirty: st?.dirty ?? 0, ignored: st?.ignored, unique: unique ?? 0, unknown: st === undefined || unique === undefined ? "its status could not be read" : undefined });
      s.found.push({ kind: "worktree", repo: r.top, path: t.path, name: t.branch, holds });
      record("worktree", `found: ${holds}`, { repo: r.common, path: t.path, name: t.branch });
    }
    // A new branch a new worktree has out is said with that worktree.
    const outIn = new Map(list.filter((t) => t.branch).map((t) => [t.branch!, t.path]));
    for (const b of fresh.branches) {
      if (fresh.trees.some((t) => t.branch === b)) continue;
      const unique = await uniqueOf(r.top, `refs/heads/${b}`, b);
      const holds = rules.branchHolds({ unique: unique ?? 0, out: outIn.get(b), unknown: unique === undefined ? "its commits could not be counted" : undefined });
      s.found.push({ kind: "branch", repo: r.top, name: b, holds });
      record("branch", `found: ${holds}`, { repo: r.common, name: b });
    }
  }
  store.db.query("DELETE FROM agent_git_before WHERE agent_id = ?").run(a.id);
  return rules.leftLine(s);
}

// The worktree Keel made for an agent (the managed worktree of its session): removed with its branch when
// nothing of it would be lost and nothing else works in it, kept and named otherwise. Returns the note its
// report carries ("" when it has none). `live`: whether a session may still work in a folder. A row that does
// not name a worktree of Keel's own folder and branch naming is never acted on.
export async function ownWorktree(c: { store: Store; wts: Worktrees }, sessionId: string, live: (sessionId: string) => boolean): Promise<string> {
  const w = c.wts.get(sessionId);
  if (!w || w.state !== "active") return "";
  if (!c.wts.owns(w)) return `\n\nWorktree ${w.path} (branch ${w.branch}) was kept: it is not in Keel's worktree folder on a branch of Keel's naming.`;
  return oneAtATime(realOf(w.repo_root), () => settleOwn(c, w, sessionId, live));
}

// One check and removal at a time in a repository: two agents ending together would each count the other's
// branch as holding a commit they share, and both would go.
const repoTurns = new Map<string, Promise<unknown>>();
function oneAtATime<T>(key: string, f: () => Promise<T>): Promise<T> {
  const run = (repoTurns.get(key) ?? Promise.resolve()).then(f, f);
  const tail = run.catch(() => {});
  repoTurns.set(key, tail);
  void tail.then(() => { if (repoTurns.get(key) === tail) repoTurns.delete(key); });
  return run;
}

// Folders under the ignored paths of a worktree that hold a repository of their own (`git worktree remove`
// deletes ignored files without a word). Links are not followed. Past `cap` entries the answer is unknown.
async function reposUnder(top: string, ignored: string[], cap = 200_000): Promise<string[] | undefined> {
  const found: string[] = [];
  const todo = ignored.filter((p) => p.endsWith("/")).map((p) => p.replace(/\/$/, ""));
  let seen = 0;
  while (todo.length) {
    const rel = todo.pop()!;
    let list;
    try { list = await readdir(join(top, rel), { withFileTypes: true }); } catch { continue; }
    if ((seen += list.length) > cap) return undefined;
    for (const e of list) {
      if (e.name === ".git") { found.push(rel); break; }
      if (e.isDirectory()) todo.push(`${rel}/${e.name}`);
    }
  }
  return found;
}

// Files git is told not to look at (assume-unchanged, skip-worktree) that differ from what the index holds:
// `git status` and `git worktree remove` do not see such an edit. A skip-worktree file that is not on disk is
// what a sparse checkout leaves out. Past 2,000 of them the answer is unknown.
async function hiddenEdits(dir: string): Promise<number | undefined> {
  const out = await run(dir, ["ls-files", "-v", "-z"]);
  if (out === undefined) return undefined;
  const flagged = out.split("\0").filter((r) => r.length > 2 && (/^[a-z]/.test(r) || r[0] === "S")).map((r) => ({ skip: /^[sS]/.test(r), path: r.slice(2) }));
  if (!flagged.length) return 0;
  if (flagged.length > 2000) return undefined;
  const staged = await run(dir, ["ls-files", "-s", "-z", "--", ...flagged.map((f) => `:(literal)${f.path}`)]);
  if (staged === undefined) return undefined;
  const want = new Map(staged.split("\0").filter(Boolean).map((r) => { const tab = r.indexOf("\t"); return [r.slice(tab + 1), r.split(" ")[1]!] as const; }));
  const present = flagged.filter((f) => existsSync(join(dir, f.path)));
  let n = flagged.filter((f) => !f.skip && !existsSync(join(dir, f.path))).length;
  if (present.length) {
    const r = await git(dir, ["hash-object", "--stdin-paths"], { read: true, input: present.map((f) => f.path).join("\n") + "\n", timeout: 60_000 });
    if (r.code !== 0) return undefined;
    const got = r.out.split("\n").filter(Boolean);
    present.forEach((f, i) => { if (got[i] !== want.get(f.path)) n++; });
  }
  return n;
}

// A stash entry made on the branch: its work is not on the branch, and the entry says the branch's name.
async function stashOn(repo: string, branch: string): Promise<string | undefined> {
  const out = await run(repo, ["stash", "list", "--format=%gd%x00%gs"]);
  for (const l of (out ?? "").split("\n")) {
    const [ref, subject] = l.split("\0");
    const on = /^(?:WIP on|On) (.+?): /.exec(subject ?? "")?.[1];
    if (on === branch) return `a stash entry was made on its branch (${ref})`;
  }
  return undefined;
}

async function settleOwn(c: { store: Store; wts: Worktrees }, w: Worktree, sessionId: string, live: (sessionId: string) => boolean): Promise<string> {
  const st = await c.wts.status(w);
  if (st.unknown) return `\n\nWorktree ${w.path} (branch ${w.branch}): git could not read it: ${st.unknown}`;
  if (st.branch_missing) { await c.wts.removeClean(w, null); return ""; }
  const at = st.exists ? w.path : w.repo_root;
  const sha = (await run(at, ["rev-parse", "--verify", "--quiet", `refs/heads/${w.branch}`]))?.trim() || null;
  // Its branch's commits, on the commit that would be deleted. The branches of Keel's other worktrees here do
  // not count as holding them: each goes at its own agent's end.
  const others = c.wts.all().filter((x) => x.session_id !== sessionId && x.state === "active" && realOf(x.repo_root) === realOf(w.repo_root)).map((x) => x.branch);
  // A worktree made from another of Keel's live branches (a child agent's, from its parent's) holds that branch's
  // commits as its base, not as work of its own: they are on the branch they came from, and only that branch's own
  // end decides them. (A hash for a base is no branch: its commits count.)
  const over = others.includes(w.base) ? w.base : undefined;
  const unique = sha ? await uniqueOf(at, sha, [w.branch, ...others], over) : 0;
  const head = st.exists ? (await run(w.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim() : w.branch;
  const moved = head === w.branch ? undefined : `its HEAD is ${head ? `on ${head}` : "detached"}, not on ${w.branch}`;
  const look = st.exists ? await statusOf(w.path) : { dirty: 0, ignored: [] };
  const nested = look ? await reposUnder(w.path, look.ignored) : undefined;
  const hidden = st.exists ? await hiddenEdits(w.path) : 0;
  const inner = st.inner?.length ? `${st.inner.length === 1 ? "a repository inside it holds" : `${st.inner.length} repositories inside it hold`} work of its own (${st.inner.slice(0, 3).join(", ")})`
    : nested?.length ? `${nested.length === 1 ? "an ignored folder holds a repository" : `ignored folders hold ${nested.length} repositories`} (${nested.slice(0, 3).join(", ")})` : undefined;
  const busy = moved ?? await stashOn(w.repo_root, w.branch) ?? (st.exists ? busyIn(await openSessions(c.store), cwds(), w.path, sessionId, live) : undefined);
  const unknown = unique === undefined ? "its commits could not be counted" : look === undefined || nested === undefined ? "its ignored files could not be looked through" : hidden === undefined ? "the files git is told not to look at could not be compared" : undefined;
  const dirty = Math.max(st.dirty, look?.dirty ?? 0) + (hidden ?? 0);
  // Commits only its branch holds: the base may still hold their work (a rebase or cherry-pick that changed the patch).
  const landed = unique && sha && !unknown && !inner && !busy && !dirty ? await landedOn(c.store, w.repo_root, sha) : undefined;
  const fate = rules.ownTreeFate({ dirty, unique: unique ?? 0, inner, busy, unknown, landed });
  if (fate.act === "remove") {
    // (Read before the worktree and branch go.)
    const lends = !!over && !!sha && !!(await uniqueOf(at, sha, [w.branch, ...others]));
    const r = await c.wts.removeClean(w, sha);
    if (r.removed) {
      // Its ignored files went with it: said by count and the first names.
      const names = look?.ignored ?? [];
      const gone = names.length ? `, and ${rules.count(names.length, "ignored path")} with it: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", ..." : ""}` : "";
      if (!st.commits_ahead) {
        const lent = lends ? `; the commits it started from are on ${over}` : "";
        return `\n\n(The agent changed no files; its worktree was removed${gone}${lent}.)`;
      }
      if (unique && landed) return `\n\nIts ${rules.count(st.commits_ahead, "commit")} over ${w.base} landed with another patch (${rules.landedWords(landed)}): its worktree ${w.path}${r.branch_deleted ? ` and branch ${w.branch} were` : " was"} removed${gone}.`;
      const on = (await run(w.repo_root, ["for-each-ref", "--count=4", `--contains=${sha}`, "--format=%(refname:short)", "refs/heads", "refs/remotes", "refs/tags"]))?.split("\n").filter((x) => x && x !== w.branch) ?? [];
      return `\n\nIts ${rules.count(st.commits_ahead, "commit")} over ${w.base} ${st.commits_ahead === 1 ? "is" : "are"} also on ${on.slice(0, 3).join(", ") || "other branches"}: its worktree ${w.path}${r.branch_deleted ? ` and branch ${w.branch} were` : " was"} removed${gone}.`;
    }
    return `\n\nWorktree ${w.path} (branch ${w.branch}) was kept: ${r.reason}.`;
  }
  const why = (fate as { why: string }).why;
  if (!dirty && landed && landed.how !== "whole") return `\n\nIts work is on branch ${w.branch} in the worktree ${w.path}, kept: it ${rules.landedWords(landed)}, so the base does not hold its every line as it is. Settings, Leftovers removes the worktree with the landed ones and keeps the branch.`;
  if (!unknown && !inner && !busy && (dirty || unique)) return `\n\nIts work is on branch ${w.branch} in the worktree ${w.path}: ${rules.count(st.commits_ahead, "commit")} over ${w.base}, ${rules.count(dirty, "uncommitted file")}. Review and merge it from there (git merge ${w.branch}).${await landingOf(c.store, w, sha, dirty)}`;
  return `\n\nWorktree ${w.path} (branch ${w.branch}) was kept: ${why}.`;
}

// What landing the branch needs, on lines of their own (landing.ts): its tip, the base's commits it lacks, its
// conflict with the base from the overlap forecast's table, and the named checks that passed on its files as
// they are (the check ledger, by the tree they ran on). Read as the agent ends; nothing is fetched.
const FORECAST_WAIT_MS = 10_000;
// The facts of the lines just written, for the agent's record: taken once by the end that wrote them.
const landings = new Map<string, Omit<AgentLanding, "proof">>();
export function takeLanding(sessionId: string): Omit<AgentLanding, "proof"> | undefined {
  const l = landings.get(sessionId);
  landings.delete(sessionId);
  return l;
}
async function landingOf(store: Store, w: Worktree, sha: string | null, dirty: number): Promise<string> {
  try {
    const ov = forecastOf(store);
    // (The forecast's pass is bounded by its git calls only: an agent's report does not wait on it past
    // FORECAST_WAIT_MS.)
    const late = Symbol("late");
    const asked = ov && sha ? await Promise.race([ov.againstBase(w.repo_root, w.branch).catch(() => undefined), Bun.sleep(FORECAST_WAIT_MS).then(() => late)]) : undefined;
    const against = asked === late ? undefined : (asked as Awaited<ReturnType<NonNullable<typeof ov>["againstBase"]>> | undefined);
    const base = against?.base ?? w.base;
    const conflict: BaseConflict = !ov ? { state: "unknown", why: "no overlap forecast runs here" }
      : asked === late ? { state: "unknown", why: "the forecast did not finish in time" }
      : !against ? { state: "unknown", why: "the repository has no base branch, or the branch has no tip" }
      : against.state === "stale" ? { state: "unknown", why: "the forecast holds no row of these tips" }
      : against.state === "error" ? { state: "unknown", why: `git could not merge them: ${against.why}` }
      : against.state === "conflict" ? { state: "conflict", files: against.files }
      : { state: against.state };
    const behindOut = sha ? await run(w.repo_root, ["rev-list", "--count", `${sha}..${against?.base_tip ?? base}`, "--"]) : undefined;
    const behind = behindOut === undefined || !/^\d+$/.test(behindOut.trim()) ? null : Number(behindOut.trim());
    const aheadOut = sha ? await run(w.repo_root, ["rev-list", "--count", `${against?.base_tip ?? base}..${sha}`, "--"]) : undefined;
    const ahead = aheadOut === undefined || !/^\d+$/.test(aheadOut.trim()) ? null : Number(aheadOut.trim());
    const checks = await checksAt(w.path);
    const landing: Landing = { base, tip: sha, behind, dirty, conflict, checks };
    landings.set(w.session_id, {
      ...landing,
      conflict: conflict.state === "conflict" ? { state: "conflict", files: conflict.files.slice(0, FILES_KEPT) } : conflict,
      branch: w.branch, ahead, landed: ahead === 0 || conflict.state === "nothing" ? true : ahead === null ? null : false,
    });
    return landingLines(landing);
  } catch {
    return "";
  }
}

// The repository's named checks as they stand on the work tree's files now.
async function checksAt(path: string): Promise<ChecksOn> {
  if (!existsSync(path)) return { state: "unknown", why: "its worktree is gone" };
  const repo = repoOf(path);
  if (!repo) return { state: "unknown", why: "git could not read its worktree" };
  const named = namedFor(repo)?.checks ?? [];
  if (!named.length) return { state: "none" };
  const look = await treeOf(repo);
  if (!look) return { state: "unknown", why: "the tree of its files could not be read" };
  if (look.tree === null) return { state: "unknown", why: look.why };
  // A run counts in the check's own folder, and for a check that names inputs, with the inputs it has now.
  const by = new Map(named.map((c) => [c.name, { dir: c.dir, inputs: inputsOf(repo.top, c.inputs) ?? null }]));
  const runs = decidedOn(look.tree).filter((r) => { const c = by.get(r.name); return !!c && (c.dir === "*" || c.dir === r.dir) && c.inputs === (r.inputs ?? null); });
  return { state: "known", ...checksOnTree(named, runs) };
}

// ---- the page: what is left across sessions

export type Survey = {
  // `scope`: what the last pass over job scopes found of its scope (scopes.ts): its memory, since when it is
  // idle, its build daemons and what becomes of it. `earlier`: a daemon before this one started it.
  processes: { session_id: string; title: string; agent?: { id: string; status: string }; job_id: string; command: string; cwd: string; started: number; running: boolean; pids: number[]; ports: number[]; contain?: string; earlier?: boolean; scope?: Omit<scopes.ScopeView, "job_id" | "session_id"> }[];
  // What the job scopes left running hold, and the job scopes of other daemons (no record here: never touched).
  held?: scopes.Held;
  // The job scopes that run and are not this daemon's job (another daemon's, or one whose processes carry another
  // daemon's mark): what each holds. Keel never signals one by itself; the owner stops it here.
  foreign?: Awaited<ReturnType<typeof scopes.foreignScopes>>;
  // `landed`: the base holds its branch's work (leftover-rules.ts, Landed), with `bytes` it holds on disk.
  worktrees: { repo: string; top: string; path: string; branch?: string; head: string; made?: number; dirty?: number; ignored?: string[]; ahead?: number; base?: string; locked?: boolean; missing?: boolean; by?: By; removable: boolean; why?: string; landed?: rules.Landed & { words: string }; bytes?: number }[];
  branches: { repo: string; top: string; name: string; sha: string; at: number; base?: string; ahead?: number; behind?: number; merged: boolean; by?: By }[];
  repos: string[];
};

// Who a worktree or branch is known by. "keel": Keel made it for that session (its managed worktree and branch).
// "found": it was new in the repository when that agent ended; who made it is not known.
export type By = { session_id: string; title: string; how: "keel" | "found" };

// The sessions that are not archived, read on the read thread (the whole table).
type Row = { id: string; title: string; workspace: string; machine: string | null };
const openSessions = (store: Store) => readsOf(store).sql<Row>(`SELECT id, title, workspace, ${store.columnExists("sessions", "machine") ? "machine" : "NULL AS machine"} FROM sessions WHERE archived = 0 AND outside IS NULL`).catch(() => [] as Row[]);

type Ag = { id: string; session_id: string; status: string; parent_id: string };
async function agentsBy(store: Store): Promise<Map<string, Ag>> {
  const rows = await readsOf(store).sql<Ag>("SELECT id, session_id, status, parent_id FROM agents").catch(() => [] as Ag[]);
  return new Map(rows.map((r) => [r.session_id, r]));
}
const ended = (a?: Ag) => !!a && a.status !== "running" && a.status !== "waiting";

// The repositories Keel knows of: where sessions work, its managed worktrees, what agents left.
async function knownRepos(c: Ctx, open: Row[], extra: string[]): Promise<Repo[]> {
  const dirs = new Set<string>(extra);
  for (const s of open) if (!s.machine) dirs.add(s.workspace);
  const rows = await readsOf(c.store).sql<{ d: string }>("SELECT DISTINCT repo_root AS d FROM worktrees UNION SELECT DISTINCT repo AS d FROM leftovers WHERE repo IS NOT NULL").catch(() => [] as { d: string }[]);
  for (const r of rows) dirs.add(r.d.endsWith("/.git") ? dirname(r.d) : r.d);
  return reposOf(dirs, 100);
}

async function baseOf(top: string): Promise<string | undefined> {
  const origin = (await run(top, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]))?.trim();
  if (origin) return origin;
  for (const b of ["main", "master"]) if ((await run(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]))?.trim()) return b;
  return undefined;
}

// Branch tips with their date, and how far each is ahead of and behind the base (one call where git has
// ahead-behind, 2.41 and later; else one count each, the first 300).
async function heads(top: string, base?: string): Promise<{ name: string; sha: string; at: number; ahead?: number; behind?: number }[]> {
  const f = "%(refname:short)%00%(objectname)%00%(committerdate:unix)";
  let out = base ? await run(top, ["for-each-ref", `--format=${f}%00%(ahead-behind:${base})`, "refs/heads"]) : undefined;
  const ab = out !== undefined;
  out ??= await run(top, ["for-each-ref", `--format=${f}`, "refs/heads"]);
  const list = (out ?? "").split("\n").filter(Boolean).map((l) => {
    const [name, sha, at, counts] = l.split("\0");
    const [ahead, behind] = (counts ?? "").split(" ").map(Number);
    return { name: name!, sha: sha!, at: Number(at) * 1000, ...(ab ? { ahead, behind } : {}) };
  });
  if (!ab && base) for (const h of list.slice(0, 300)) {
    const n = await run(top, ["rev-list", "--count", "--left-right", `${base}...refs/heads/${h.name}`]);
    if (n) { const [behind, ahead] = n.trim().split(/\s+/).map(Number); Object.assign(h, { ahead, behind }); }
  }
  return list;
}

// Why a clean worktree on a landed branch is still not the pass's: an edit git is told not to look at, a repository
// in an ignored folder, a stash entry made on its branch (what the agent's end reads, settleOwn).
async function landedHeld(top: string, path: string, branch: string, ignored: string[]): Promise<string | undefined> {
  const hidden = await hiddenEdits(path);
  if (hidden === undefined) return "the files git is told not to look at could not be compared";
  if (hidden) return `${rules.count(hidden, "file")} git is told not to look at changed`;
  const nested = await reposUnder(path, ignored);
  if (nested === undefined) return "its ignored files could not be looked through";
  if (nested.length) return `${nested.length === 1 ? "an ignored folder holds a repository" : `ignored folders hold ${nested.length} repositories`} (${nested.slice(0, 3).join(", ")})`;
  return await stashOn(top, branch);
}

// What a worktree holds on disk, in bytes (du, off the loop), kept ten minutes for its path and HEAD.
const sizes = new Map<string, { bytes: number; at: number }>();
async function sizeOf(path: string, head: string): Promise<number | undefined> {
  const key = `${path}\0${head}`, k = sizes.get(key);
  if (k && Date.now() - k.at < 600_000) return k.bytes;
  try {
    const p = Bun.spawn(["du", "-sbx", path], { stdout: "pipe", stderr: "ignore" });
    const t = setTimeout(() => p.kill(), 60_000);
    const out = await readText(p.stdout, "du");
    clearTimeout(t);
    if ((await p.exited) !== 0 && !out) return undefined;
    const bytes = Number(out.split(/\s/)[0]);
    if (!Number.isFinite(bytes)) return undefined;
    if (sizes.size > 4096) sizes.clear();
    sizes.set(key, { bytes, at: Date.now() });
    return bytes;
  } catch { return undefined; }
}

async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k]!); } }));
  return out;
}

export async function survey(c: Ctx, o: { extra?: string[]; only?: string } = {}): Promise<Survey> {
  const { store } = c;
  const ags = await agentsBy(store);
  const live = (sid: string) => { const s = store.session(sid); return !!s && !s.archived && !ended(ags.get(sid)); };
  const title = (sid: string) => store.session(sid)?.title || sid;
  // What the job scopes hold, measured within the last 15 seconds (scopes.ts measures once a minute).
  if (!o.only) await scopes.fresh(15_000);
  const out: Survey = { processes: [], worktrees: [], branches: [], repos: [], held: scopes.heldNow(), foreign: o.only ? undefined : await scopes.foreignScopes().catch(() => []) };
  const since = Date.now() - process.uptime() * 1000;
  // Commands with processes alive, except the one a running turn waits on in front and the owner's own.
  const candidates = allJobs().filter((j) => j.by !== "owner" && !(!j.background && j.ended === undefined && c.isRunning(j.sessionId)));
  const found = await processesOf(candidates);
  for (const j of candidates) {
    const pids = (found.get(j.id) ?? []).map((p) => p.pid);
    if (!pids.length) continue;
    const a = ags.get(j.sessionId);
    const v = scopes.viewOf(j.id);
    out.processes.push({ session_id: j.sessionId, title: title(j.sessionId), ...(a ? { agent: { id: a.id, status: a.status } } : {}), job_id: j.id, command: j.description || j.command, cwd: j.cwd, started: j.started,
      running: j.ended === undefined, pids, ports: (portsOf(new Map([[j.id, pids]])).get(j.id) ?? []).map((p) => p.port), contain: j.contain,
      ...(j.started < since ? { earlier: true } : {}), ...(v ? { scope: { memory_bytes: v.memory_bytes, idle_since: v.idle_since, command_ended: v.command_ended, builds: v.builds, fate: v.fate, keep: v.keep } } : {}) });
  }
  // Who a worktree or a branch is known by: the session whose managed worktree it is (Keel made it), else the
  // agent at whose end it was found new.
  const left = await readsOf(store).sql<{ session_id: string; path: string | null; name: string | null; repo: string }>("SELECT session_id, path, name, repo FROM leftovers WHERE repo IS NOT NULL AND kind IN ('worktree', 'branch') ORDER BY at").catch(() => []);
  const managed = await readsOf(store).sql<{ session_id: string; path: string; branch: string }>("SELECT session_id, path, branch FROM worktrees").catch(() => []);
  type Known = { sid: string; how: By["how"] };
  const byPath = new Map<string, Known>(), byBranch = new Map<string, Known>();
  for (const l of left) { if (l.path) byPath.set(l.path, { sid: l.session_id, how: "found" }); if (l.name) byBranch.set(`${l.repo}\0${l.name}`, { sid: l.session_id, how: "found" }); }
  for (const m of managed) { byPath.set(m.path, { sid: m.session_id, how: "keel" }); byBranch.set(m.branch, { sid: m.session_id, how: "keel" }); }
  const who = (k?: Known): By | undefined => (k ? { session_id: k.sid, title: title(k.sid), how: k.how } : undefined);
  const open = await openSessions(store);
  const repos = (await knownRepos(c, open, o.extra ?? (c.workspace ? [c.workspace] : []))).filter((r) => !o.only || r.common === o.only || r.top === o.only);
  out.repos = repos.map((r) => r.top);
  // Where live sessions work: a worktree that holds one is not left behind.
  const workspaces = open.filter((x) => !ended(ags.get(x.id))).map((x) => realOf(x.workspace));
  const procs = cwds();
  await pool(repos, 3, async (r) => {
    const list = await trees(r.top);
    if (!list) return;
    const base = await baseOf(r.top);
    const tips = await heads(r.top, base);
    const out_ = new Set(list.map((t) => t.branch).filter(Boolean));
    const baseName = base?.replace(/^origin\//, "");
    const landBase = await landingBase(r.top);
    const orphans = list.filter((t) => !t.main && !workspaces.some((w) => contains(realOf(t.path), w)) && !jobsIn(t.path).length);
    const rows = await pool(orphans, 4, async (t) => {
      const missing = !existsSync(t.path);
      const st = missing ? { dirty: 0, ignored: [] } : await statusOf(t.path);
      const ahead = base && !missing ? Number((await run(t.path, ["rev-list", "--count", `${base}..HEAD`]))?.trim() ?? NaN) : undefined;
      // A detached one: the commits only it holds go with it (the base may not exist, or not be what they are on).
      const loose = t.branch || missing ? 0 : await uniqueOf(t.path, "HEAD");
      const sid = byPath.get(t.path) ?? (t.branch ? byBranch.get(t.branch) ?? byBranch.get(`${r.common}\0${t.branch}`) : undefined);
      const why = t.locked ? "it is locked" : st === undefined ? "git could not read its status" : st.dirty ? `${rules.count(st.dirty, "uncommitted file")}`
        : loose === undefined ? "its commits could not be counted" : loose ? `${rules.count(loose, "commit")} on no branch` : missing ? undefined : workingIn(procs, t.path);
      // A clean one on a branch whose work the base holds: the landed pass takes it (and its branch, when whole).
      let landed = !why && t.branch && !missing && landBase && t.branch !== landBase.replace(/^origin\//, "") ? await landedOn(store, r.top, t.head, landBase) : undefined;
      // What the agent's end looks for and git status does not see: none of it may be in a worktree the pass takes.
      const held = landed && st ? await landedHeld(r.top, t.path, t.branch!, st.ignored) : undefined;
      if (held) landed = undefined;
      const bytes = landed ? await sizeOf(t.path, t.head) : undefined;
      const kept = why ?? held;
      return { repo: r.common, top: r.top, path: t.path, branch: t.branch, head: t.head, made: treeMade(t.path), dirty: st?.dirty, ignored: st?.ignored.length ? st.ignored : undefined,
        ahead: Number.isFinite(ahead) ? ahead : undefined, base, locked: t.locked, missing: missing || undefined, by: who(sid), removable: !kept, why: kept,
        ...(landed ? { landed: { ...landed, words: rules.landedWords(landed) }, bytes } : {}) };
    });
    out.worktrees.push(...rows);
    for (const h of tips) {
      if (out_.has(h.name) || h.name === baseName || h.name === "main" || h.name === "master") continue;
      const sid = byBranch.get(h.name) ?? byBranch.get(`${r.common}\0${h.name}`);
      if (sid && live(sid.sid)) continue;
      out.branches.push({ repo: r.common, top: r.top, name: h.name, sha: h.sha, at: h.at, base, ahead: h.ahead, behind: h.behind, merged: h.ahead === 0, by: who(sid) });
    }
  });
  out.branches.sort((x, y) => Number(y.ahead !== 0) - Number(x.ahead !== 0) || y.at - x.at);
  out.worktrees.sort((x, y) => (y.made ?? 0) - (x.made ?? 0));
  return out;
}

// The owner's acts on the page, each checked again against the repository as it is now, and against what the
// owner was shown: an item that changed since it was listed is refused.
export async function stopLeft(sessionId: string, jobId: string, store?: Store): Promise<{ stopped: boolean; left: number[] }> {
  const j = findJob(sessionId, jobId);
  if (!j) throw new Error("no such command");
  if (scopeHoldsSelf(j)) throw new Error(HOLDS_SELF);
  const left = await stopJob(j, "was stopped by the owner from Leftovers");
  if (!left.length) store?.db.query("DELETE FROM scope_keeps WHERE job_id = ?").run(jobId);
  return { stopped: !left.length, left };
}

// The owner's stop of a job scope that is not this daemon's job, as it was listed (its marks).
export const stopForeign = (cgroup: string, marks: string[]) => scopes.stopForeign(cgroup, { marks });

// The owner's mark on a command left running: kept, its scope is never stopped by Keel (scopes.ts).
export function keepLeft(store: Store, sessionId: string, jobId: string, keep: boolean): { keep: boolean } {
  if (!findJob(sessionId, jobId)) throw new Error("no such command");
  if (keep) store.db.query("INSERT OR REPLACE INTO scope_keeps (job_id, session_id, at) VALUES (?, ?, ?)").run(jobId, sessionId, Date.now());
  else store.db.query("DELETE FROM scope_keeps WHERE job_id = ?").run(jobId);
  scopes.marked(jobId, keep);
  return { keep };
}
// The idle marks of job scopes and their build daemons (scopes.ts), kept so a restart goes on counting.
export const loadIdle = (store: Store) => new Map(store.db.query<{ key: string; cpu: number; at: number; since: number }, []>("SELECT key, cpu, at, since FROM scope_idle").all().map((r) => [r.key, { cpu: r.cpu, at: r.at, since: r.since }]));
export function saveIdle(store: Store, marks: Map<string, { cpu: number; at: number; since: number }>) {
  const put = store.db.query("INSERT INTO scope_idle (key, cpu, at, since) VALUES (?, ?, ?, ?)");
  store.db.transaction(() => {
    store.db.run("DELETE FROM scope_idle");
    for (const [k, m] of marks) put.run(k, m.cpu, m.at, m.since);
  })();
}
// What a stop of a job scope is told (scopes.ts): once for its key, across restarts, in the failures scope
// of the command's session, or when that session is gone, of the session that started its agent. The told
// keys are kept 30 days. Returns the session told, or nothing when it was told before or nobody can be.
const TOLD_DAYS = 30;
export function tellLeft(store: Store, sessionId: string, line: string, key: string, seen: (sid: string, line: string) => void): string | undefined {
  const parent = () => { try { return store.db.query<{ parent_id: string }, [string]>("SELECT parent_id FROM agents WHERE session_id = ? ORDER BY created DESC LIMIT 1").get(sessionId)?.parent_id; } catch { return undefined; } };
  const to = store.session(sessionId) ? sessionId : parent();
  if (!to || !store.session(to)) return undefined;
  const now = Date.now();
  if (!store.db.query("INSERT OR IGNORE INTO scope_told (key, at) VALUES (?, ?)").run(key, now).changes) return undefined;
  store.db.query("DELETE FROM scope_told WHERE at < ?").run(now - TOLD_DAYS * 86_400_000);
  seen(to, to === sessionId ? line : `Of an agent's session that is gone: ${line}`);
  return to;
}
// A job scope that is not this daemon's job, said once for the scope and the mark of the record that names it,
// across restarts (the told keys above). True the first time only.
// A refusal for another reason is a new thing to say (the mark's own start changed, a state folder came and went).
export function foreignFirst(store: Store, cgroup: string, mark: string, why = ""): boolean {
  const now = Date.now();
  const first = store.db.query("INSERT OR IGNORE INTO scope_told (key, at) VALUES (?, ?)").run(`foreign:${cgroup}:${mark}:${createHash("sha1").update(why).digest("hex").slice(0, 12)}`, now).changes > 0;
  if (first) store.db.query("DELETE FROM scope_told WHERE at < ?").run(now - TOLD_DAYS * 86_400_000);
  return first;
}
export const keeps = (store: Store) => new Set(store.db.query<{ job_id: string }, []>("SELECT job_id FROM scope_keeps").all().map((r) => r.job_id));

// How a session ended, for what its commands left running: its row is gone, it is archived, or it is an
// agent's and the agent ended. Nothing while it lives (an owner's session that is not archived lives).
export function endedOf(store: Store, sessionId: string): string | undefined {
  const s = store.db.query<{ archived: number }, [string]>("SELECT archived FROM sessions WHERE id = ?").get(sessionId);
  if (!s) return "its session is gone";
  if (s.archived) return "its session is archived";
  const a = store.columnExists("agents", "status") ? store.db.query<{ status: string }, [string]>("SELECT status FROM agents WHERE session_id = ? ORDER BY created DESC LIMIT 1").get(sessionId) : null;
  if (a && a.status !== "running" && a.status !== "waiting") return `its agent ${a.status === "failed" ? "failed" : "ended"}`;
  return undefined;
}

// A worktree as the owner saw it listed: its HEAD, and how many ignored paths they were told go with it.
export type TreeSeen = { repo: string; path: string; head?: string; ignored?: number };
// A branch as listed: its tip.
export type BranchSeen = { repo: string; branch: string; sha?: string };

function treeCheck(s: Survey, seen: TreeSeen) {
  const t = s.worktrees.find((w) => w.path === seen.path);
  if (!t) throw new Error("that worktree is not listed as left behind (a session works in it, or it is gone)");
  if (!t.removable) throw new Error(`not removed: ${t.why}`);
  if (seen.head !== undefined && t.head !== seen.head) throw new Error(`not removed: it changed since it was listed (its HEAD is ${t.head.slice(0, 10) || "gone"} now, not ${seen.head.slice(0, 10)})`);
  if ((t.ignored?.length ?? 0) > (seen.ignored ?? 0)) throw new Error(`not removed: it holds ${rules.ignoredWords(t.ignored!)} now, more than when it was listed`);
  return t;
}
function branchCheck(s: Survey, seen: BranchSeen) {
  const b = s.branches.find((x) => x.name === seen.branch);
  if (!b) throw new Error("that branch is not listed as left behind (checked out, a live session's, or gone)");
  if (seen.sha !== undefined && b.sha !== seen.sha) throw new Error(`not deleted: it changed since it was listed (it points at ${b.sha.slice(0, 10)} now, not ${seen.sha.slice(0, 10)})`);
  if (!b.merged) throw new Error(`not deleted: ${b.ahead === undefined ? "it could not be compared with a base" : `${rules.count(b.ahead, "commit")} not on ${b.base}`}`);
  return b;
}
// Without force: git itself refuses a folder with a changed or untracked file made after the check.
async function dropTree(c: Ctx, t: Survey["worktrees"][number]) {
  const r = await git(t.top, ["worktree", "remove", t.path], { timeout: 60_000 });
  if (r.code !== 0) throw new Error(`git would not remove it: ${r.err.trim().split("\n").at(-1)}`);
  // One Keel made for a session is told removed there too (the table is the worktree manager's).
  if (c.store.columnExists("worktrees", "path")) c.store.db.query("UPDATE worktrees SET state = 'removed', updated = ? WHERE path = ? AND state = 'active'").run(Date.now(), t.path);
}
// By the tip that was checked: a branch that moved since is not deleted.
async function dropBranch(b: Survey["branches"][number]) {
  const r = await git(b.top, ["update-ref", "-d", `refs/heads/${b.name}`, b.sha], { timeout: 30_000 });
  if (r.code !== 0) throw new Error(`git would not delete it: ${r.err.trim().split("\n").at(-1)}`);
}

export async function removeTree(c: Ctx, seen: TreeSeen): Promise<void> {
  await dropTree(c, treeCheck(await survey(c, { only: seen.repo }), seen));
}
export async function deleteBranch(c: Ctx, seen: BranchSeen): Promise<void> {
  await dropBranch(branchCheck(await survey(c, { only: seen.repo }), seen));
}

// The landed pass: every worktree listed as landed, each checked as above and again for its landing as it was
// listed. A whole landing takes its branch too (deleted by the tip that was checked); a changed one leaves it.
export type LandedSeen = TreeSeen & { how: rules.Landed["how"] };
export async function removeLanded(c: Ctx, items: LandedSeen[]): Promise<{ removed: string[]; deleted: string[]; refused: { what: string; why: string }[]; bytes: number }> {
  const out = { removed: [] as string[], deleted: [] as string[], refused: [] as { what: string; why: string }[], bytes: 0 };
  for (const repo of [...new Set(items.map((x) => x.repo))]) {
    const s = await survey(c, { only: repo });
    for (const seen of items.filter((x) => x.repo === repo)) {
      try {
        const t = treeCheck(s, seen);
        const pass = rules.landedPass(t);
        if (!pass) throw new Error("not removed: its branch's work is not on the base now");
        if (t.landed!.how !== seen.how) throw new Error(`not removed: it changed since it was listed (it ${t.landed!.words} now)`);
        // The list was read before the drops before this one: what started in it since keeps it.
        const job = jobsIn(t.path)[0];
        if (job) throw new Error(`not removed: a command runs in it now: ${job.command.slice(0, 60)}`);
        const ags = await agentsBy(c.store);
        const live = (await openSessions(c.store)).find((x) => !ended(ags.get(x.id)) && contains(realOf(t.path), realOf(x.workspace)));
        if (live) throw new Error(`not removed: the session "${live.title || live.id}" works in it now`);
        await dropTree(c, t);
        out.removed.push(seen.path);
        out.bytes += t.bytes ?? 0;
        if (pass === "tree-and-branch") {
          const r = await git(t.top, ["update-ref", "-d", `refs/heads/${t.branch}`, t.head], { timeout: 30_000 });
          if (r.code === 0) out.deleted.push(t.branch!);
          else out.refused.push({ what: t.branch!, why: `its worktree went; git would not delete the branch: ${r.err.trim().split("\n").at(-1)}` });
        }
      } catch (e) { out.refused.push({ what: seen.path, why: (e as Error).message }); }
    }
  }
  return out;
}

// The whole list in one act: every worktree and branch the owner was shown, each checked as above (the
// worktrees first: a branch one of them had out is listed again after). What is refused is said with its reason.
export async function removeAll(c: Ctx, items: { worktrees?: TreeSeen[]; branches?: BranchSeen[] }): Promise<{ removed: string[]; deleted: string[]; refused: { what: string; why: string }[] }> {
  const out = { removed: [] as string[], deleted: [] as string[], refused: [] as { what: string; why: string }[] };
  const repos = [...new Set([...(items.worktrees ?? []), ...(items.branches ?? [])].map((x) => x.repo))];
  for (const repo of repos) {
    const s = await survey(c, { only: repo });
    for (const seen of (items.worktrees ?? []).filter((x) => x.repo === repo)) {
      try { await dropTree(c, treeCheck(s, seen)); out.removed.push(seen.path); } catch (e) { out.refused.push({ what: seen.path, why: (e as Error).message }); }
    }
    for (const seen of (items.branches ?? []).filter((x) => x.repo === repo)) {
      try { await dropBranch(branchCheck(s, seen)); out.deleted.push(seen.branch); } catch (e) { out.refused.push({ what: seen.branch, why: (e as Error).message }); }
    }
  }
  return out;
}
