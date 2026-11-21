// What changed in the repository a linked worktree shares with the other
// checkouts while a confined command ran in it.
//
// The sandbox cannot keep such a command to its own branch: a commit needs
// lock files next to the refs it writes, so every ref of the repository is
// writable, and so is the top of the common git directory, where the main
// checkout keeps the state of a merge or a rebase (src/safety/sandbox.ts).
// So the refs and that folder are read before the command and after it, and
// what changed outside the session's own branch is said in the command's
// result and in the session's activity.
//
// It names what changed while the command ran, not who changed it: nothing
// ties a ref update to a process. One case is ruled out, because it is the
// common one where several sessions work in one repository: a branch that
// another checkout has out, moved to the commit that checkout's own HEAD log
// ends at, is that checkout's commit.
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { git } from "../core/git.ts";
import { linkedWorktree } from "./sandbox.ts";

export type RefState = { refs: Map<string, string>; top: Set<string>; branch?: string };
export type Watch = { dir: string; common: string; own: string; before: RefState };

// What a linked worktree's git makes at the top of the common directory. Any
// other new entry there is the main checkout's state (MERGE_HEAD,
// rebase-merge, an index lock), which git run in a linked worktree never
// writes.
const SHARED = new Set(["packed-refs", "gc.pid", "gc.log", "shallow", "lfs", "rr-cache", "logs", "info", "objects", "refs", "hooks", "worktrees", "modules", "config", "config.worktree", "description", "branches", "remotes", "reftable", "svn"]);

async function read(dir: string, common: string, own: string): Promise<RefState | undefined> {
  // (Through src/core/git.ts, as every git the daemon runs.)
  const { code, out } = await git(dir, ["for-each-ref", "--format=%(refname) %(objectname)"], { read: true, timeout: 10_000 });
  if (code !== 0) return undefined;
  const refs = new Map<string, string>();
  for (const line of out.split("\n")) {
    const at = line.lastIndexOf(" ");
    if (at > 0) refs.set(line.slice(0, at), line.slice(at + 1));
  }
  return { refs, top: new Set(readdirSync(common)), branch: branchOf(own) };
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
// The branches the other checkouts have out, each with the commit that checkout's own log ends at.
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
    const before = await read(workspace, at.common, at.own);
    return before && { dir: workspace, common: at.common, own: at.own, before };
  } catch {
    return undefined;
  }
}

const short = (ref: string) => ref.replace(/^refs\/heads\//, "branch ").replace(/^refs\/tags\//, "tag ");
const LISTED = 6;
const list = (items: string[]) => (items.length > LISTED ? `${items.slice(0, LISTED).join(", ")} and ${items.length - LISTED} more` : items.join(", "));

// What differs between two readings, as one sentence, or nothing. `out`: the
// branches the other checkouts have out, with the commit each one's own log
// ends at.
export function changed(before: RefState, after: RefState, out: Map<string, string | undefined> = new Map()): string | undefined {
  const moved: string[] = [], deleted: string[] = [];
  for (const [ref, was] of before.refs) {
    // The session's own branch (as it was, and as it is now), and what a fetch moves by design.
    if (ref === before.branch || ref === after.branch || ref.startsWith("refs/remotes/")) continue;
    const now = after.refs.get(ref);
    if (now === undefined) deleted.push(short(ref));
    else if (now !== was && out.get(ref) !== now) moved.push(`${short(ref)} (${was.slice(0, 7)} to ${now.slice(0, 7)})`);
  }
  const made = [...after.top].filter((n) => !before.top.has(n) && !SHARED.has(n) && !n.endsWith(".lock")).sort();
  const parts = [
    moved.length ? `moved ${list(moved)}` : "",
    deleted.length ? `deleted ${list(deleted)}` : "",
    made.length ? `new at the top of the repository's git directory, where the main checkout keeps its own state: ${list(made)}` : "",
  ].filter(Boolean);
  return parts.length ? `While this command ran, what this worktree shares with the repository's other checkouts changed: ${parts.join("; ")}.` : undefined;
}

export async function report(w: Watch): Promise<string | undefined> {
  try {
    const after = await read(w.dir, w.common, w.own);
    // The other checkouts are read only when something is there to explain.
    return after && changed(w.before, after) && changed(w.before, after, others(w.common, w.own));
  } catch {
    return undefined;
  }
}
