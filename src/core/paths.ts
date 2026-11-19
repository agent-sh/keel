import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// The daemon's state folder: --state-dir, else KEEL_STATE_DIR, else the XDG state home.
export const defaultStateDir = () =>
  resolve(process.env.KEEL_STATE_DIR || join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "keel-bun"));

// contains(root, p): true when `p` is `root` or below it. Both must be absolute and already
// resolved the same way (realpath where symlinks matter). A child named
// "..foo" is inside; "../x" and another drive are not.
export function contains(root: string, p: string): boolean {
  const r = relative(root, p);
  return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(".." + sep));
}
