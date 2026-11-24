// Whether a program's name on this machine is the program itself. A version
// manager's shim (volta, mise, asdf, rustup, pyenv, rbenv, corepack) stands
// under the name of a tool and may download and install the version a
// project pins the first time it runs, even for `--version`. The permission
// gate asks this once for a call that names such a program (shell-reads.ts,
// SHIMMED), before it decides. The disk is read off the loop and within a
// deadline; nothing is kept between calls.
import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { homeDir } from "../core/paths";

// Where the managers keep their shims, under the home folder, and the folders
// a profile commonly adds. A login shell's profile may put one of these first
// on its PATH whatever this process has, so they are looked at as well.
const SHIM_DIRS = [".volta/bin", ".local/share/mise/shims", ".local/share/rtx/shims", ".asdf/shims", ".pyenv/shims", ".rbenv/shims", ".nodenv/shims", ".proto/shims"];
const PROFILE_DIRS = [".cargo/bin", ".local/bin", "bin"];

// The first bytes of a program the machine runs itself: ELF, Mach-O in either byte order, a universal binary.
const NATIVE = ["7f454c46", "cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe"];

// Folders whose look passed the deadline and has not come back (a mount that
// hangs): not looked at again until it does, so a hung mount holds the one
// thread it already has, not one more for every call.
const stuck = new Set<string>();

const exists = (p: string) => stat(p).then(() => true, () => false);

// One folder: null when it holds no such file, true when the file is the
// program's own binary, false otherwise. Its own binary: a file whose real
// name is the program's (python3 is python3.14, gcc is
// x86_64-linux-gnu-gcc-15), outside any shims folder, that the machine runs
// itself. A script is a wrapper around something else, whatever its first line.
async function inFolder(dir: string, prog: string, named: RegExp): Promise<boolean | null> {
  const file = join(dir, prog);
  if (!(await exists(file))) return null;
  try {
    const real = await realpath(file);
    if (!named.test(basename(real)) || /\/(shims|\.volta|\.rustup|corepack)\//.test(real + "/") || /\/shims\//.test(file)) return false;
    const head = Buffer.alloc(4);
    const fd = await open(real, "r");
    try { await fd.read(head, 0, 4, 0); } finally { await fd.close(); }
    return NATIVE.includes(head.toString("hex"));
  } catch { return false; }
}

// For each name, whether it is the program itself: every file by that name
// on the PATH, and in the folders a profile adds, is the program's own
// binary, and no manager's shim folder holds one. Not when there is none, nor
// when the PATH has a relative entry (what it finds depends on the folder the
// command runs in), nor for what the disk has not answered within the
// deadline: the call then asks.
export async function realPrograms(names: string[], o: { path?: string; home?: string; deadlineMs?: number } = {}): Promise<Map<string, boolean>> {
  const out = new Map(names.map((n) => [n, false]));
  const home = o.home ?? homeDir();
  const dirs = [...new Set([...(o.path ?? process.env.PATH ?? "").split(":"), ...PROFILE_DIRS.map((d) => join(home, d))])];
  const shims = SHIM_DIRS.map((d) => join(home, d));
  if ([...dirs, ...shims].some((d) => !isAbsolute(d) || stuck.has(d))) return out;
  const pending = new Map<string, number>();
  const look = <T>(dir: string, p: Promise<T>) => {
    pending.set(dir, (pending.get(dir) ?? 0) + 1);
    return p.finally(() => { const left = pending.get(dir)! - 1; if (left) pending.set(dir, left); else { pending.delete(dir); stuck.delete(dir); } });
  };
  const one = async (prog: string) => {
    if (!prog || prog.includes("/")) return;
    const named = new RegExp(`^([a-z0-9_]+-)*${prog.replace(/[.+]/g, "\\$&")}([-.]?\\d[\\d.]*)?$`);
    const [managed, found] = await Promise.all([
      Promise.all(shims.map((d) => look(d, exists(join(d, prog))))),
      Promise.all(dirs.map((d) => look(d, inFolder(d, prog, named)))),
    ]);
    out.set(prog, !managed.some(Boolean) && !found.includes(false) && found.includes(true));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((done) => { timer = setTimeout(() => done("late"), o.deadlineMs ?? 250); });
  const ended = await Promise.race([Promise.all(names.map(one)), late]);
  clearTimeout(timer);
  if (ended === "late") for (const d of pending.keys()) stuck.add(d);
  // A copy: an answer that arrives after the deadline changes nothing.
  return new Map(out);
}
