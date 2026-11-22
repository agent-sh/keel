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
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { git } from "../core/git.ts";
import { linkedWorktree, SCRATCH } from "./sandbox.ts";

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
// fetch brings, a stash, the refs a checkout keeps for itself (a bisect, a
// rebase), and Keel's own.
const ORDINARY = /^refs\/(heads|tags|remotes|bisect|worktree|rewritten|keel)\/|^refs\/stash$/;
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
// sandbox, in its own words.
const TOP = new RegExp(`/${SCRATCH}/packed-refs\\.\\d+\\.new|/(gc\\.pid|shallow|packed-refs|HEAD)\\.lock'?: Read-only file system|could not create directory (of )?'[^']*/(worktrees/[^']*|rr-cache|lfs[^']*)'|/info/[^'\\s:]*'?: Read-only file system|cannot lock ref '(main-worktree|worktrees)/`);
const CONFIG = /could not (lock|write) config file|unable to write upstream branch configuration|update of config-file failed/;
const NETWORK = /Could not resolve host|Could not resolve hostname|Temporary failure in name resolution|Network is unreachable|Couldn't connect to server|Failed to connect to/i;
export function sandboxSaid(output: string, at: { linked: boolean; network: boolean; escape: string }): string[] {
  const said: string[] = [];
  if (at.linked && TOP.test(output)) said.push(`This worktree's sandbox keeps the top of the repository's git directory read-only (the main checkout's own state is there). Closed in it: deleting a branch or tag that is packed, git pack-refs, git gc, git worktree add, changing a shallow clone's depth, a first rerere or LFS store, and the files under info (a repack still packs, and says it could not update them). Commits, branches, merges, rebases and stashes work. ${at.escape}`);
  // (A deleted branch whose settings could not be taken out of the config is deleted: git's own warning says the rest.)
  const onlyDeleted = /^Deleted branch /m.test(output) && !/fatal:|unable to write upstream/.test(output);
  if (CONFIG.test(output) && !onlyDeleted) said.push(`The repository's config is read-only in a sandboxed session (git runs what it names). What writes it fails or is half done: git config, git remote add, git branch -u, git push -u and --track; git branch -m renames the branch and then exits 128, because the branch's settings cannot be moved; deleting a branch leaves its settings behind. Branches made in this session track nothing. ${at.escape}`);
  if (!at.network && NETWORK.test(output)) said.push(`This session's network is off, so fetch, pull, push and whatever else needs the network fail in its sandbox. The owner turns it on in the session's permissions ("Network in the sandbox"). ${at.escape}`);
  return said;
}
