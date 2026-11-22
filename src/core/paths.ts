import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Under `bun test` (it sets NODE_ENV to "test") the owner's own folders are
// never the answer. A run from the repository root has scratch ones named
// before any test loads (bunfig.toml, test/preload.ts); a run that skipped
// that stops here rather than read or write the owner's files. This guards
// source runs only: the built binary is compiled with NODE_ENV fixed, so a
// shell that exports NODE_ENV=test never stops the daemon or the CLI, and
// what starts the binary in a test names its folders itself (test/cli).
export function ownersFolder(what: string, variable: string) {
  if (process.env.NODE_ENV === "test") throw new Error(`NODE_ENV is "test" and ${variable} is not set: under a test the owner's ${what} is never the default. Set ${variable} to a scratch folder (bun test does, when run from the repository root), or unset NODE_ENV.`);
}

// The daemon's state folder: --state-dir, else KEEL_STATE_DIR, else the XDG state home.
export const defaultStateDir = () => {
  if (!process.env.KEEL_STATE_DIR) ownersFolder("state folder", "KEEL_STATE_DIR");
  return resolve(process.env.KEEL_STATE_DIR || join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "keel-bun"));
};

// Where a session puts files made for the owner to look at (its artifacts):
// harness scratch beside the state, so edits there run where workspace edits do.
// A subagent on this machine uses its parent's (it runs on the parent's prompt).
export const artifactsDir = (stateDir: string, sessionId: string) => join(stateDir, "artifacts", sessionId);

// contains(root, p): true when `p` is `root` or below it. Both must be absolute and already
// resolved the same way (realpath where symlinks matter). A child named
// "..foo" is inside; "../x" and another drive are not.
export function contains(root: string, p: string): boolean {
  const r = relative(root, p);
  return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(".." + sep));
}

// Two folders that share files: one holds the other, compared where their
// links land (a link to a folder is that folder, however it is spelled).
export function overlaps(a: string, b: string): boolean {
  const ra = realOf(a), rb = realOf(b);
  return contains(ra, rb) || contains(rb, ra);
}

// A path as a tool or a command was given it, absolute: a relative one starts
// at `cwd`. `.` and doubled slashes go. A `..` stays: after a link it is the
// parent of the link's target, which only the walk (realOf) knows.
export function atCwd(cwd: string, p: string): string {
  const whole = isAbsolute(p) ? p : `${cwd}/${p}`;
  return whole.split("/").includes("..") ? whole : resolve(whole);
}

// A path as the kernel walks it: each part resolved in turn, links followed
// where they stand, and `..` applied to where the walk is (after a link, the
// parent of its target; never by the path's text). Through the deepest part
// that exists: where a write to it lands, even when the file itself does not
// exist yet. A dangling link is followed too (a write through it creates the
// file it names). This is the one function a path is judged by, and a file
// tool opens what it returns, so what is judged is what is opened.
export function realOf(p: string): string {
  const parts = (text: string) => text.split("/").filter((c) => c !== "" && c !== ".");
  const todo = parts(isAbsolute(p) ? p : `${process.cwd()}/${p}`);
  // `at` holds no link: every part of it was looked at. Past the first part that does not exist nothing can be a link.
  let at = "/", missing = false, links = 0;
  while (todo.length) {
    const c = todo.shift()!;
    if (c === "..") { at = dirname(at); continue; }
    const next = at === "/" ? `/${c}` : `${at}/${c}`;
    if (missing) { at = next; continue; }
    let link = false;
    try { link = lstatSync(next).isSymbolicLink(); } catch { missing = true; at = next; continue; }
    if (!link) { at = next; continue; }
    // (More links than the kernel follows: it refuses the path, and so does whatever opens what this returns.)
    if (++links > 40) return [next, ...todo].join("/");
    let to: string;
    try { to = readlinkSync(next); } catch { missing = true; at = next; continue; }
    if (to.startsWith("/")) at = "/";
    todo.unshift(...parts(to));
  }
  return at;
}
