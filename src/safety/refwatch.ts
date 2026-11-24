// What changed in the repository a linked worktree shares with the other
// checkouts while a confined command ran in it.
//
// The sandbox cannot keep such a command to its own branch: a commit needs
// lock files next to the refs it writes, so every ref of the repository is
// writable (src/safety/sandbox.ts). So the refs are read before the command
// and after it, and what changed outside the session's own branch is said in
// the command's result and in the session's activity.
//
// It names what changed while the command ran, not who changed it: nothing
// ties a ref update to a process. One case is ruled out, because it is the
// common one where several sessions work in one repository: a branch that
// another checkout has out, moved to the commit that checkout's own HEAD log
// ends at, is that checkout's commit.
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { git } from "../core/git.ts";
import { realOf } from "../core/paths.ts";
import { madeNow, madeNowSync } from "./made.ts";
import { linkedWorktree, linkedWorktreeAsync, SCRATCH } from "./sandbox.ts";
import { readdir as readdirP, readFile as readFileP, realpath, stat as statP } from "node:fs/promises";
import type { Shared, Stash } from "./shared-branches.ts";

// A ref's value: the commit it names, and the ref it points at when it is a symbolic one.
export type RefState = { refs: Map<string, string>; branch?: string };
export type Watch = { dir: string; common: string; own: string; before: RefState };

async function read(dir: string, own: string): Promise<RefState | undefined> {
  // (Through src/core/git.ts, as every git the daemon runs.)
  const { code, out } = await git(dir, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"], { read: true, timeout: 10_000 });
  if (code !== 0) return undefined;
  const refs = new Map<string, string>();
  for (const line of out.split("\n")) {
    const at = line.indexOf(" ");
    if (at > 0) refs.set(line.slice(0, at), line.slice(at + 1).trimEnd());
  }
  let branch = branchOf(own);
  // (A reftable repository keeps a stub in HEAD: the branch is asked of git.)
  if (!branch || branch === "refs/heads/.invalid") {
    const head = await git(dir, ["symbolic-ref", "-q", "HEAD"], { read: true, timeout: 10_000 });
    branch = head.code === 0 ? head.out.trim() || undefined : undefined;
  }
  return { refs, branch };
}

const branchOf = (gitDir: string): string | undefined => {
  try { return /^ref: (\S+)/.exec(readFileSync(join(gitDir, "HEAD"), "utf8"))?.[1]; } catch { return undefined; }
};
// The commit a checkout's own HEAD log ends at.
function lastOf(log: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(log, "r");
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, 2048));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    return /^[0-9a-f]+ ([0-9a-f]+) /.exec(buf.toString("utf8").trimEnd().split("\n").at(-1) ?? "")?.[1];
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
// The branches the other checkouts have out, each with the commit that
// checkout's own log ends at. A confined command cannot write those logs:
// the other worktrees' directories and the main checkout's HEAD log are
// read-only in its sandbox.
function others(common: string, own: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  const add = (gitDir: string, log: string) => { const b = branchOf(gitDir); if (b) out.set(b, lastOf(log)); };
  add(common, join(common, "logs/HEAD"));
  try {
    for (const name of readdirSync(join(common, "worktrees"))) {
      const dir = join(common, "worktrees", name);
      if (dir !== own) add(dir, join(dir, "logs/HEAD"));
    }
  } catch {} // no linked worktrees left
  return out;
}

// The checkouts a linked worktree shares its branches with, for the rule that
// keeps an agent to its own branch (src/safety/shared-branches.ts): every other
// checkout's folder and the branch each has out. Read from the files, a few
// small ones a checkout; undefined when `root` is not a linked worktree.
//
// Kept while nothing it was read from changed: the repository's config, its
// list of worktrees, and each checkout's HEAD (a branch taken out replaces
// that file), by their marks on the disk.
const kept = new Map<string, { mark: string; shared: Shared }>();
const markOf = (p: string) => { try { const st = statSync(p); return `${st.mtimeMs}:${st.ino}:${st.size}`; } catch { return "-"; } };
export function checkoutsOf(root: string, branch: string, base: string | null, kids: string[] = []): Shared | undefined {
  const at = linkedWorktree(root);
  if (!at) return undefined;
  let names: string[] = [];
  try { names = readdirSync(join(at.common, "worktrees")); } catch {} // no linked worktrees but this one
  const key = `${root}\0${branch}\0${base ?? ""}`;
  const mark = [markOf(join(at.common, "config")), markOf(join(at.common, "HEAD")), ...names.flatMap((n) => [n, markOf(join(at.common, "worktrees", n, "HEAD")), markOf(join(at.common, "worktrees", n, "gitdir"))])].join("|");
  let shared: Shared;
  const was = kept.get(key);
  if (was && was.mark === mark) shared = was.shared;
  else {
    shared = readCheckouts(root, branch, base, at, names);
    kept.set(key, { mark, shared });
    if (kept.size > 256) kept.delete(kept.keys().next().value!);
  }
  // (The branches are read when a command names one: they change with every branch made, which no mark here sees.)
  return { ...shared, kids, foreign: () => foreignBranches(at.common, at.own, branch, kids), stashes: () => stashesOf(at.common, at.own, branch, kids) };
}

// checkoutsOf with the asynchronous file calls (the same answer, off the loop). `withForeign`: the branches that are
// not this worktree's are read now (a command that names git), else when a rule asks, as checkoutsOf does.
const markOfAsync = async (p: string) => { try { const st = await statP(p); return `${st.mtimeMs}:${st.ino}:${st.size}`; } catch { return "-"; } };
export async function checkoutsOfAsync(root: string, branch: string, base: string | null, kids: string[] = [], withForeign = false): Promise<Shared | undefined> {
  const at = await linkedWorktreeAsync(root);
  if (!at) return undefined;
  let names: string[] = [];
  try { names = await readdirP(join(at.common, "worktrees")); } catch {} // no linked worktrees but this one
  const key = `${root}\0${branch}\0${base ?? ""}`;
  const marks = await Promise.all([markOfAsync(join(at.common, "config")), markOfAsync(join(at.common, "HEAD")), ...names.map(async (n) => [n, await markOfAsync(join(at.common, "worktrees", n, "HEAD")), await markOfAsync(join(at.common, "worktrees", n, "gitdir"))].join("|"))]);
  const mark = marks.join("|");
  let shared: Shared;
  const was = kept.get(key);
  if (was && was.mark === mark) shared = was.shared;
  else {
    shared = await readCheckoutsAsync(root, branch, base, at, names);
    kept.set(key, { mark, shared });
    if (kept.size > 256) kept.delete(kept.keys().next().value!);
  }
  const stashes = () => stashesOf(at.common, at.own, branch, kids);
  if (!withForeign) return { ...shared, kids, foreign: () => foreignBranches(at.common, at.own, branch, kids), stashes };
  const set = await foreignBranchesAsync(at.common, at.own, branch, kids);
  return { ...shared, kids, foreign: () => set, stashes };
}

const realAsync = async (p: string) => { try { return await realpath(p); } catch { return realOf(p); } };
const branchOfAsync = async (gitDir: string): Promise<string | undefined> => {
  try { return /^ref: (\S+)/.exec(await readFileP(join(gitDir, "HEAD"), "utf8"))?.[1]; } catch { return undefined; }
};
async function readCheckoutsAsync(root: string, branch: string, base: string | null, at: { own: string; common: string }, names: string[]): Promise<Shared> {
  const out = new Map<string, string>();
  const folders: string[] = [];
  const gitDirs: string[] = [];
  const add = async (gitDir: string, folder: string | undefined) => {
    gitDirs.push(gitDir);
    if (!folder) return;
    const real = await realAsync(folder);
    folders.push(real);
    const b = await branchOfAsync(gitDir);
    if (b?.startsWith("refs/heads/")) out.set(b.slice(11), real);
  };
  await add(at.common, basename(at.common) === ".git" ? dirname(at.common) : undefined);
  // (In the order of the names, as the synchronous reading has them.)
  const dirs = names.map((name) => join(at.common, "worktrees", name)).filter((d) => d !== at.own);
  const where = await Promise.all(dirs.map(async (dir) => { try { return dirname((await readFileP(join(dir, "gitdir"), "utf8")).trim()); } catch { return undefined; } }));
  for (let k = 0; k < dirs.length; k++) await add(dirs[k]!, where[k]);
  let remotes: Map<string, string[]> | undefined;
  try { remotes = parseRemotes(await readFileP(join(at.common, "config"), "utf8")); } catch { /* none */ }
  return { root: await realAsync(root), gitDir: at.own, common: at.common, branch, base, out, folders, gitDirs, remotes, hosts: [hostname().toLowerCase()], real: realOf };
}

// localBranches, asynchronously.
export async function localBranchesAsync(common: string): Promise<Set<string> | undefined> {
  const out = new Set<string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const e of await readdirP(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(dir, e.name), `${prefix}${e.name}/`);
      else if (!e.name.endsWith(".lock")) out.add(`${prefix}${e.name}`);
    }
  };
  try { await walk(join(common, "refs/heads"), ""); } catch { /* none loose */ }
  try {
    for (const line of (await readFileP(join(common, "packed-refs"), "utf8")).split("\n")) {
      const m = /^[0-9a-f]+ refs\/heads\/(.+)$/.exec(line);
      if (m) out.add(m[1]!);
    }
  } catch { /* none packed */ }
  try { if ((await statP(join(common, "reftable"))).isDirectory()) return undefined; } catch { /* files backend */ }
  return out;
}

// Every branch of the repository, by name (the loose ones and the packed ones). undefined for a repository whose refs are
// kept another way (reftable).
export function localBranches(common: string): Set<string> | undefined {
  const out = new Set<string>();
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
      else if (!e.name.endsWith(".lock")) out.add(`${prefix}${e.name}`);
    }
  };
  try { walk(join(common, "refs/heads"), ""); } catch { /* none loose */ }
  try {
    for (const line of readFileSync(join(common, "packed-refs"), "utf8").split("\n")) {
      const m = /^[0-9a-f]+ refs\/heads\/(.+)$/.exec(line);
      if (m) out.add(m[1]!);
    }
  } catch { /* none packed */ }
  try { if (statSync(join(common, "reftable")).isDirectory()) return undefined; } catch { /* files backend */ }
  return out;
}
// The branches that exist and that this worktree did not make: neither its own, the one its HEAD is on, one made by its
// own git (the ledger, src/safety/made.ts), nor one an agent under it made. In small letters (a file system that
// ignores case takes MAIN for main).
function foreignOf(all: Set<string> | undefined, branch: string, kids: string[], head: string | undefined, made: Set<string>): Set<string> {
  const out = new Set<string>();
  if (!all) return out;
  const mine = new Set([branch, ...kids, head?.replace(/^refs\/heads\//, "") ?? ""].map((b) => b.toLowerCase()));
  for (const b of all) if (!mine.has(b.toLowerCase()) && !made.has(b.toLowerCase())) out.add(b.toLowerCase());
  return out;
}
function foreignBranches(common: string, own: string, branch: string, kids: string[]): Set<string> {
  return foreignOf(localBranches(common), branch, kids, branchOf(own), madeNowSync(common, own));
}
async function foreignBranchesAsync(common: string, own: string, branch: string, kids: string[]): Promise<Set<string>> {
  const [all, made] = await Promise.all([localBranchesAsync(common), madeNow(common, own)]);
  return foreignOf(all, branch, kids, await branchOfAsync(own), made);
}
// The repository's stash list, newest first (stash@{0} first), from the stash's own log in the shared git directory.
// A stash is made on a branch (`WIP on <branch>: ...`, `On <branch>: ...`); `mine`: that branch is this worktree's own,
// the one its HEAD is on, one its git made, or one an agent under it made. A subject of another form (git stash store -m)
// names no branch and is no one's the rules can tell.
export function stashesOf(common: string, own: string, branch: string, kids: string[]): Stash[] {
  let text = "";
  try { text = readFileSync(join(common, "logs", "refs", "stash"), "utf8"); } catch { return []; }
  const head = branchOf(own)?.replace(/^refs\/heads\//, "");
  let made: Set<string> | undefined;
  const mineSet = (): Set<string> => (made ??= new Set([branch, ...kids, ...(head ? [head] : []), ...madeNowSync(common, own)].map((b) => b.toLowerCase())));
  const lines = text.split("\n").filter((l) => l.length > 0);
  return lines.reverse().map((line, n) => {
    const subject = line.slice(line.indexOf("\t") + 1);
    const b = /^(?:WIP on|On) ([^:]+?): /.exec(subject)?.[1] ?? null;
    return { n, branch: b, mine: b !== null && mineSet().has(b.toLowerCase()), subject };
  });
}
function readCheckouts(root: string, branch: string, base: string | null, at: { own: string; common: string }, names: string[]): Shared {
  const out = new Map<string, string>();
  const folders: string[] = [];
  const gitDirs: string[] = [];
  const add = (gitDir: string, folder: string | undefined) => {
    gitDirs.push(gitDir);
    if (!folder) return;
    folders.push(realOf(folder));
    const b = branchOf(gitDir);
    if (b?.startsWith("refs/heads/")) out.set(b.slice(11), realOf(folder));
  };
  // The main checkout (none for a bare repository).
  add(at.common, basename(at.common) === ".git" ? dirname(at.common) : undefined);
  for (const name of names) {
    const dir = join(at.common, "worktrees", name);
    if (dir === at.own) continue;
    let folder: string | undefined;
    try { folder = dirname(readFileSync(join(dir, "gitdir"), "utf8").trim()); } catch {}
    add(dir, folder);
  }
  return { root: realOf(root), gitDir: at.own, common: at.common, branch, base, out, folders, gitDirs, remotes: remotesOf(at.common), hosts: [hostname().toLowerCase()], real: realOf };
}

// The repository's remotes and their URLs, from its config file ([remote "x"] url and pushurl).
function remotesOf(common: string): Map<string, string[]> | undefined {
  let text: string;
  try { text = readFileSync(join(common, "config"), "utf8"); } catch { return undefined; }
  return parseRemotes(text);
}
function parseRemotes(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let at: string | undefined;
  for (const line of text.split("\n")) {
    const head = /^\s*\[\s*([^\]\s"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (head) { at = head[1]!.toLowerCase() === "remote" && head[2] !== undefined ? head[2] : undefined; if (at !== undefined && !out.has(at)) out.set(at, []); continue; }
    const kv = at === undefined ? null : /^\s*(url|pushurl)\s*=\s*(.*?)\s*$/i.exec(line);
    if (kv) out.get(at!)!.push(kv[2]!.replace(/^"(.*)"$/, "$1"));
  }
  return out;
}

export async function watch(workspace: string): Promise<Watch | undefined> {
  const at = linkedWorktree(workspace);
  if (!at) return undefined;
  try {
    const before = await read(workspace, at.own);
    return before && { dir: workspace, common: at.common, own: at.own, before };
  } catch {
    return undefined;
  }
}

const short = (ref: string) => ref.replace(/^refs\/heads\//, "branch ").replace(/^refs\/tags\//, "tag ");
const LISTED = 6;
const list = (items: string[]) => (items.length > LISTED ? `${items.slice(0, LISTED).join(", ")} and ${items.length - LISTED} more` : items.join(", "));
// Where a new ref is ordinary work and says nothing: a branch, a tag, what a
// fetch brings, a stash, and the refs a checkout keeps for itself (a bisect,
// a rebase). (Not Keel's own, refs/keel/: a parked worktree's state and a
// move's are kept there, and a command that makes one is said.)
const ORDINARY = /^refs\/(heads|tags|remotes|bisect|worktree|rewritten)\/|^refs\/stash$/;
const commit = (v: string) => v.split(" ")[0]!;
const target = (v: string) => v.split(" ")[1] ?? "";

// What differs between two readings, as one sentence, or nothing.
// `out`: the branches the other checkouts have out, with the commit each
// one's own log ends at. `own`: the refs the session's own commands made
// earlier in this turn; what this command made is added to it.
export function changed(before: RefState, after: RefState, out: Map<string, string | undefined> = new Map(), own: Set<string> = new Set()): string | undefined {
  const moved: string[] = [], deleted: string[] = [], made: string[] = [], pointed: string[] = [];
  for (const [ref, was] of before.refs) {
    // The session's own branch (as it was, and as it is now), what it made itself this turn, and what a fetch moves by design.
    if (ref === before.branch || ref === after.branch || own.has(ref) || ref.startsWith("refs/remotes/")) continue;
    const now = after.refs.get(ref);
    if (now === undefined) deleted.push(short(ref));
    else if (target(now) !== target(was)) pointed.push(`${short(ref)} (now ${target(now) ? `a name for ${short(target(now))}` : "a ref of its own"})`);
    else if (commit(now) !== commit(was) && out.get(ref) !== commit(now)) moved.push(`${short(ref)} (${commit(was).slice(0, 7)} to ${commit(now).slice(0, 7)})`);
  }
  for (const [ref, now] of after.refs) {
    if (before.refs.has(ref)) continue;
    // A ref that changes what other checkouts read (a replacement of a
    // commit, notes, a namespace of someone else's), or a new name that
    // points at another ref.
    if (!ORDINARY.test(ref) || target(now)) made.push(target(now) ? `${short(ref)} (a name for ${short(target(now))})` : short(ref));
  }
  const parts = [moved.length ? `moved ${list(moved)}` : "", pointed.length ? `changed what ${list(pointed)} points at` : "", deleted.length ? `deleted ${list(deleted)}` : "", made.length ? `created ${list(made)}` : ""].filter(Boolean);
  return parts.length ? `While this command ran, what this worktree shares with the repository's other checkouts changed: ${parts.join("; ")}.` : undefined;
}

export async function report(w: Watch, own: Set<string> = new Set()): Promise<string | undefined> {
  try {
    const after = await read(w.dir, w.own);
    if (!after) return undefined;
    // The other checkouts are read only when something is there to explain.
    const said = changed(w.before, after, undefined, own) && changed(w.before, after, others(w.common, w.own), own);
    // What this command made is the session's own for the rest of the turn: deleting it again is not a change to report.
    for (const ref of after.refs.keys()) if (!w.before.refs.has(ref)) own.add(ref);
    return said || undefined;
  } catch {
    return undefined;
  }
}

// What a confined command ran into, as git and the network tools say it:
// each case gets one sentence on the command's result, so a refusal of the
// sandbox is not read as a broken repository or a broken network.
// `linked`: the session works in a linked worktree (the top of the shared git
// directory is read-only, src/safety/sandbox.ts). `network`: the session's
// network is on. `escape`: how this tool asks to run a command outside the
// sandbox, in its own words. `shut`: why the profile opens none of git's
// files for this session, when it opens none (asked only for a command that
// git could not write for).
const TOP = new RegExp(`/${SCRATCH}/packed-refs\\.\\d+\\.new|/(gc\\.pid|shallow|packed-refs|HEAD)\\.lock'?: Read-only file system|could not create directory (of )?'[^']*/(worktrees/[^']*|rr-cache|lfs[^']*)'|/info/[^'\\s:]*'?: Read-only file system|cannot lock ref '(main-worktree|worktrees)/`);
const CONFIG = /could not (lock|write) config file|unable to write upstream branch configuration|update of config-file failed/;
const NETWORK = /Could not resolve host|Could not resolve hostname|Temporary failure in name resolution|Network is unreachable|Couldn't connect to server|Failed to connect to/i;
const GIT_WRITE = /\.lock'?: Read-only file system|\.git\/[^\n']*'?: Read-only file system|insufficient permission for adding an object|could not (lock|write) config file/;
// With the network on: what the sandbox's proxy refused while the command ran, and what a command says when it
// went around the proxy (a name it resolved itself, another protocol, this machine's localhost).
// What a program says when the proxy it was pointed at is not there.
const PROXY_GONE = /Proxy CONNECT aborted|CONNECT tunnel failed|proxy.*(refused|closed|reset)|Failed to connect to 127\.0\.0\.1 port|ECONNREFUSED|ECONNRESET|socket hang up|Connection refused|Connection reset/i;
const NETWORK_ON = /Could not resolve host|Could not resolve hostname|Temporary failure in name resolution|Name or service not known|Network is unreachable|No route to host|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|Failed to connect to (localhost|127\.0\.0\.1|\[?::1\]?)|connect ECONNREFUSED (127\.0\.0\.1|::1)/i;
export function sandboxSaid(output: string, at: { linked: boolean; network: boolean; escape: string; shut?: () => string | undefined; refused?: () => { host: string; port: number; why: string }[]; closed?: () => boolean }): string[] {
  const said: string[] = [];
  // None of git's files is open to this session: that is the whole story of a failed git write.
  const shut = GIT_WRITE.test(output) ? at.shut?.() : undefined;
  if (shut) said.push(`git could not write here: ${shut}. ${at.escape}`);
  if (!shut && at.linked && TOP.test(output)) said.push(`This worktree's sandbox keeps the top of the repository's git directory read-only (the main checkout's own state is there). Closed in it: deleting a branch or tag that is packed, git pack-refs, git gc, git worktree add, changing a shallow clone's depth, a first rerere or LFS store, and the files under info (a repack still packs, and says it could not update them). Commits, branches, merges, rebases and stashes work. ${at.escape}`);
  // (A deleted branch whose settings could not be taken out of the config is deleted: git's own warning says the rest.)
  const onlyDeleted = /^Deleted branch /m.test(output) && !/fatal:|unable to write upstream/.test(output);
  if (!shut && CONFIG.test(output) && !onlyDeleted) said.push(`The repository's config is read-only in a sandboxed session (git runs what it names). What writes it fails or is half done: git config, git remote add, git branch -u, git push -u and --track; git branch -m renames the branch and then exits 128, because the branch's settings cannot be moved; deleting a branch leaves its settings behind. Branches made in this session track nothing. ${at.escape}`);
  if (!at.network && NETWORK.test(output)) said.push(`This session's network is off, so fetch, pull, push and whatever else needs the network fail in its sandbox. The owner turns it on in the session's permissions ("Network in the sandbox"). ${at.escape}`);
  if (at.network && at.closed?.() && (NETWORK.test(output) || NETWORK_ON.test(output) || PROXY_GONE.test(output))) said.push("Keel's sandbox proxy is not running: its thread kept failing and was not started again, so nothing leaves a sandbox until the daemon is restarted. The owner sees why in Errors.");
  else if (at.network) {
    const refused = at.refused?.() ?? [];
    const named = [...new Set(refused.map((r) => `${r.host}:${r.port}`))].slice(0, 8);
    // Keel's own API is the owner's: no way around is offered for it.
    const own = refused.some((r) => /Keel's own API/.test(r.why));
    if (named.length) said.push(`This session's sandbox reaches the network only through Keel's proxy, which refused ${named.join(", ")}: ${own ? "Keel's own API is never reachable from a sandbox, and neither is any other address on this machine or a private network" : "an address on this machine or a private network is not reachable from a sandbox"}. Public hosts are.${own ? "" : ` ${at.escape}`}`);
    else if (NETWORK_ON.test(output)) said.push(`This session's sandbox has a network of its own. Public hosts are reached through Keel's proxy, over HTTP and HTTPS, by programs that use the proxy variables (HTTP_PROXY, HTTPS_PROXY), and by ssh. A program that resolves names itself or speaks another protocol cannot connect, and localhost there is the sandbox's own: this machine's services are not on it. ${at.escape}`);
  }
  return said;
}
