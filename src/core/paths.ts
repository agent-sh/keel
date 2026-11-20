import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// The daemon's state folder: --state-dir, else KEEL_STATE_DIR, else the XDG state home.
export const defaultStateDir = () =>
  resolve(process.env.KEEL_STATE_DIR || join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "keel-bun"));

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

// A path with its links resolved through the deepest part that exists: where a
// write to it lands, even when the file itself does not exist yet. A dangling
// link is followed too (a write through it creates the file it names).
export function realOf(p: string, depth = 0): string {
  let at = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return resolve(realpathSync(at), ...rest.reverse()); } catch {}
    try {
      if (depth < 40 && lstatSync(at).isSymbolicLink()) return resolve(realOf(resolve(dirname(at), readlinkSync(at)), depth + 1), ...rest.reverse());
    } catch {}
    const up = dirname(at);
    if (up === at) return resolve(p);
    rest.push(at.slice(up.length + (up.endsWith("/") ? 0 : 1)));
    at = up;
  }
}
