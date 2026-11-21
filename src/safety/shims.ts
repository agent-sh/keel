// Whether a program's name on this machine is the program itself. A version
// manager's shim (volta, mise, asdf, rustup, pyenv, rbenv, corepack) stands
// under the name of a tool and may download and install the version a
// project pins the first time it runs, even for `--version`. The permission
// gate reads this at each call for the few programs whose reading forms
// depend on it (shell-reads.ts, SHIMMED); nothing is kept between calls.
import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

// Where the managers keep their shims, under the home folder, and the folders
// a profile commonly adds. A login shell's profile may put one of these first
// on its PATH whatever this process has, so they are looked at as well.
const SHIM_DIRS = [".volta/bin", ".local/share/mise/shims", ".local/share/rtx/shims", ".asdf/shims", ".pyenv/shims", ".rbenv/shims", ".nodenv/shims", ".proto/shims"];
const PROFILE_DIRS = [".cargo/bin", ".local/bin", "bin"];

// True when every file by that name on the PATH is the program: a file whose
// real name is the program's (python3 is python3.14, gcc is
// x86_64-linux-gnu-gcc-15), outside any shims folder, and not a script a
// shell runs (a wrapper). False when there is
// none, when a manager's folder holds one, or when the PATH has a relative
// entry (what it finds depends on the folder the command runs in).
export function realProgram(prog: string, path = process.env.PATH ?? "", home = homedir()): boolean {
  if (!prog || prog.includes("/")) return false;
  if (SHIM_DIRS.some((d) => existsSync(join(home, d, prog)))) return false;
  const named = new RegExp(`^([a-z0-9_]+-)*${prog.replace(/[.+]/g, "\\$&")}([-.]?\\d[\\d.]*)?$`);
  let found = 0;
  for (const dir of [...path.split(":"), ...PROFILE_DIRS.map((d) => join(home, d))]) {
    if (!isAbsolute(dir)) return false;
    const file = join(dir, prog);
    if (!existsSync(file)) continue;
    found++;
    try {
      const real = realpathSync(file);
      if (!named.test(basename(real)) || /\/(shims|\.volta|\.rustup|corepack)\//.test(real + "/") || /\/shims\//.test(file)) return false;
      const head = Buffer.alloc(64);
      const fd = openSync(real, "r");
      let n = 0;
      try { n = readSync(fd, head, 0, 64, 0); } finally { closeSync(fd); }
      const line = head.subarray(0, n).toString("latin1").split("\n")[0]!;
      // A script run by a shell (or by whatever env finds) is a wrapper around something else.
      if (line.startsWith("#!") && /(^|[/\s])(sh|bash|dash|zsh|ksh|env)(\s|$)/.test(line.slice(2))) return false;
    } catch { return false; }
  }
  return found > 0;
}
