import { homedir } from "node:os";
import { join, resolve } from "node:path";

// The daemon's state folder: --state-dir, else KEEL_STATE_DIR, else the XDG state home.
export const defaultStateDir = () =>
  resolve(process.env.KEEL_STATE_DIR || join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "keel-bun"));
