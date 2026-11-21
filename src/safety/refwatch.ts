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

export type RefState = { refs: Map<string, string>; branch?: string };
export type Watch = { dir: string; common: string; own: string; before: RefState };

async function read(dir: string, own: string): Promise<RefState | undefined> {
  // (Through src/core/git.ts, as every git the daemon runs.)
  const { code, out } = await git(dir, ["for-each-ref", "--format=%(refname) %(objectname)"], { read: true, timeout: 10_000 });
  if (code !== 0) return undefined;
  const refs = new Map<string, string>();
  for (const line of out.split("\n")) {
    const at = line.lastIndexOf(" ");
    if (at > 0) refs.set(line.slice(0, at), line.slice(at + 1));
  }
  return { refs, branch: branchOf(own) };
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
    const before = await read(workspace, at.own);
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
  const parts = [moved.length ? `moved ${list(moved)}` : "", deleted.length ? `deleted ${list(deleted)}` : ""].filter(Boolean);
  return parts.length ? `While this command ran, what this worktree shares with the repository's other checkouts changed: ${parts.join("; ")}.` : undefined;
}

export async function report(w: Watch): Promise<string | undefined> {
  try {
    const after = await read(w.dir, w.own);
    // The other checkouts are read only when something is there to explain.
    return after && changed(w.before, after) && changed(w.before, after, others(w.common, w.own));
  } catch {
    return undefined;
  }
}

// What the profile of a linked worktree closes at the top of the repository's
// git directory (src/safety/sandbox.ts), as git says it when a command runs
// into it. One sentence for the command's result, so the refusal is not read
// as a broken repository.
const CLOSED = new RegExp(`/${SCRATCH}/packed-refs\\.\\d+\\.new|/(gc\\.pid|shallow)\\.lock'?: Read-only file system|could not lock config file [^\\n]*: Read-only file system|could not create directory of '[^']*/worktrees/[^']*': Read-only file system`);
export function closed(output: string): string | undefined {
  return CLOSED.test(output)
    ? "This worktree's sandbox keeps the top of the repository's git directory read-only (the main checkout's own state is there). Closed in it: deleting a branch or tag that is packed, git pack-refs, git gc, git config, git worktree add, and changing a shallow clone's depth. Commits, branches, merges, rebases, stashes and fetches work. Ask to run the command outside the sandbox if it is needed."
    : undefined;
}
