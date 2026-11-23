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
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Store } from "../core/store.ts";
import { git, locate } from "../core/git.ts";
import { contains, realOf } from "../core/paths.ts";
import { clientsOf, portsOf } from "../fleet/portal.ts";
import { allJobs, findJob, jobsIn, jobsOf, processesOf, stopJob, type Job } from "../tools/jobs.ts";
import type { Worktrees } from "../worktree/manager.ts";
import { readsOf } from "../server/reads.ts";
import * as rules from "./leftover-rules.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_git_before (agent_id TEXT NOT NULL, repo TEXT NOT NULL, snap TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (agent_id, repo));
CREATE TABLE IF NOT EXISTS leftovers (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, parent_id TEXT NOT NULL, kind TEXT NOT NULL, repo TEXT, path TEXT, name TEXT, fate TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS leftovers_repo ON leftovers(repo, kind);
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
// Commits of `ref` that no other branch, remote branch or tag holds (`self`: the branch to leave out).
const uniqueOf = async (dir: string, ref: string, self?: string): Promise<number | undefined> => {
  const out = await run(dir, ["rev-list", "--count", ref, "--not", ...(self ? [`--exclude=${self}`] : []), "--branches", "--remotes", "--tags"]);
  return out === undefined ? undefined : Number(out.trim()) || 0;
};

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
  const skip = { trees: new Set(a.worktree ? [a.worktree] : []), branches: new Set(a.branch ? [a.branch] : []) };
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
// report carries ("" when it has none). `live`: whether a session may still work in a folder.
export async function ownWorktree(c: { store: Store; wts: Worktrees }, sessionId: string, live: (sessionId: string) => boolean): Promise<string> {
  const w = c.wts.get(sessionId);
  if (!w || w.state !== "active") return "";
  const st = await c.wts.status(w);
  if (st.unknown) return `\n\nWorktree ${w.path} (branch ${w.branch}): git could not read it: ${st.unknown}`;
  if (st.branch_missing) { await c.wts.removeClean(w, null); return ""; }
  const at = st.exists ? w.path : w.repo_root;
  const sha = (await run(at, ["rev-parse", "--verify", "--quiet", `refs/heads/${w.branch}`]))?.trim() || null;
  const unique = await uniqueOf(at, st.exists ? "HEAD" : `refs/heads/${w.branch}`, w.branch);
  const inner = st.inner?.length ? `${st.inner.length === 1 ? "a repository inside it holds" : `${st.inner.length} repositories inside it hold`} work of its own (${st.inner.slice(0, 3).join(", ")})` : undefined;
  const busy = st.exists ? busyIn(await openSessions(c.store), cwds(), w.path, sessionId, live) : undefined;
  const fate = rules.ownTreeFate({ dirty: st.dirty, unique: unique ?? 0, inner, busy, unknown: unique === undefined ? "its commits could not be counted" : undefined });
  if (fate.act === "remove") {
    const r = await c.wts.removeClean(w, sha);
    if (r.removed) {
      if (!st.commits_ahead) return "\n\n(The agent changed no files; its worktree was removed.)";
      const on = (await run(w.repo_root, ["for-each-ref", "--count=4", `--contains=${sha}`, "--format=%(refname:short)", "refs/heads", "refs/remotes", "refs/tags"]))?.split("\n").filter((x) => x && x !== w.branch) ?? [];
      return `\n\nIts ${rules.count(st.commits_ahead, "commit")} over ${w.base} ${st.commits_ahead === 1 ? "is" : "are"} also on ${on.slice(0, 3).join(", ") || "other branches"}: its worktree ${w.path}${r.branch_deleted ? ` and branch ${w.branch} were` : " was"} removed.`;
    }
    return `\n\nWorktree ${w.path} (branch ${w.branch}) was kept: ${r.reason}.`;
  }
  const why = (fate as { why: string }).why;
  if (st.dirty || unique) return `\n\nIts work is on branch ${w.branch} in the worktree ${w.path}: ${rules.count(st.commits_ahead, "commit")} over ${w.base}, ${rules.count(st.dirty, "uncommitted file")}. Review and merge it from there (git merge ${w.branch}).`;
  return `\n\nWorktree ${w.path} (branch ${w.branch}) was kept: ${why}.`;
}

// ---- the page: what is left across sessions

export type Survey = {
  processes: { session_id: string; title: string; agent?: { id: string; status: string }; job_id: string; command: string; cwd: string; started: number; running: boolean; pids: number[]; ports: number[]; contain?: string }[];
  worktrees: { repo: string; top: string; path: string; branch?: string; head: string; made?: number; dirty?: number; ignored?: string[]; ahead?: number; base?: string; locked?: boolean; missing?: boolean; by?: By; removable: boolean; why?: string }[];
  branches: { repo: string; top: string; name: string; sha: string; at: number; base?: string; ahead?: number; behind?: number; merged: boolean; by?: By }[];
  repos: string[];
};

// Who a worktree or branch is known by. "keel": Keel made it for that session (its managed worktree and branch).
// "found": it was new in the repository when that agent ended; who made it is not known.
export type By = { session_id: string; title: string; how: "keel" | "found" };

// The sessions that are not archived, read on the read thread (the whole table).
type Row = { id: string; title: string; workspace: string; machine: string | null };
const openSessions = (store: Store) => readsOf(store).sql<Row>(`SELECT id, title, workspace, ${store.columnExists("sessions", "machine") ? "machine" : "NULL AS machine"} FROM sessions WHERE archived = 0`).catch(() => [] as Row[]);

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
  const out: Survey = { processes: [], worktrees: [], branches: [], repos: [] };
  // Commands with processes alive, except the one a running turn waits on in front and the owner's own.
  const candidates = allJobs().filter((j) => j.by !== "owner" && !(!j.background && j.ended === undefined && c.isRunning(j.sessionId)));
  const found = await processesOf(candidates);
  for (const j of candidates) {
    const pids = (found.get(j.id) ?? []).map((p) => p.pid);
    if (!pids.length) continue;
    const a = ags.get(j.sessionId);
    out.processes.push({ session_id: j.sessionId, title: title(j.sessionId), ...(a ? { agent: { id: a.id, status: a.status } } : {}), job_id: j.id, command: j.description || j.command, cwd: j.cwd, started: j.started,
      running: j.ended === undefined, pids, ports: (portsOf(new Map([[j.id, pids]])).get(j.id) ?? []).map((p) => p.port), contain: j.contain });
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
      return { repo: r.common, top: r.top, path: t.path, branch: t.branch, head: t.head, made: treeMade(t.path), dirty: st?.dirty, ignored: st?.ignored.length ? st.ignored : undefined,
        ahead: Number.isFinite(ahead) ? ahead : undefined, base, locked: t.locked, missing: missing || undefined, by: who(sid), removable: !why, why };
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
export async function stopLeft(sessionId: string, jobId: string): Promise<{ stopped: boolean; left: number[] }> {
  const j = findJob(sessionId, jobId);
  if (!j) throw new Error("no such command");
  const left = await stopJob(j, "was stopped by the owner from Leftovers");
  return { stopped: !left.length, left };
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
