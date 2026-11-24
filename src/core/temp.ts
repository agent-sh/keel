// The temporary folder of what Keel spawns. A program that finds no TMPDIR in its environment uses /tmp, and
// `bun install` leaves a file `.<16 hex>-0.hm` in its temporary folder (its probe of whether it can link files
// there) on every run: with an environment that names none, a hundred runs an hour fill the machine's /tmp
// (memory on many machines) with empty files nothing removes. Bun reads BUN_TMPDIR, then TMPDIR; so a command
// Keel starts is given the daemon's own temporary folder when its environment names none.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

let own: string | undefined;
// The daemon's state folder is where its temp folder lies when it was started with none of its own.
export function setOwnTemp(stateDir: string): void { own = join(stateDir, "tmp"); }

// The folder: the daemon's TMPDIR, else the one under its state folder. Undefined when neither is known (a process
// that is not a daemon, such as a command of the command line).
export function tempFolder(): string | undefined {
  const t = process.env.BUN_TMPDIR || process.env.TMPDIR || own;
  if (t && t === own) try { mkdirSync(t, { recursive: true, mode: 0o700 }); } catch {}
  return t;
}

// `env` with a temporary folder where it names none (TMPDIR and BUN_TMPDIR both absent, or TMPDIR empty): the same
// object when it names one, else a copy. A caller that sets TMPDIR itself after this sets BUN_TMPDIR with it.
export function tempEnv(env: Record<string, string>): Record<string, string> {
  if (env.BUN_TMPDIR || env.TMPDIR) return env;
  const t = tempFolder();
  return t ? { ...env, TMPDIR: t } : env;
}
