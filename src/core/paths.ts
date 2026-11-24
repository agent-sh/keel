import { closeSync, constants, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
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

// The home folder, the one place it is decided: $HOME as the process has it now
// (a scratch daemon is started with a scratch HOME, and a test preload sets one),
// else the account's. os.homedir() is not used anywhere else in src/ (a test in
// src/conventions.test.ts holds to it): it reads $HOME once, when the process
// starts, so a HOME set later in the process is not seen by it. (A child process
// started by Bun.spawn with no env of its own gets the environment the process
// started with, not one changed since: pass env when HOME must reach it.)
export function homeDir(): string {
  const h = process.env.HOME;
  return h && isAbsolute(h) ? h : homedir();
}

// The owner's default config folder (what a daemon uses when KEEL_CONFIG_DIR is not set).
export function defaultConfigDir(): string {
  const x = process.env.XDG_CONFIG_HOME;
  return join(x && x.startsWith("/") ? x : join(homeDir(), ".config"), "keel-bun");
}

// Whether this daemon may read what the owner keeps in the home folder: the
// other harnesses' sessions and setups, the ssh configuration, the memory and
// supervisor tools, the voice and browser bridges. It may when it is the
// owner's own (its config folder is the default one) or when its home is not
// the account's (a scratch HOME: what it reads there is its own). A scratch
// daemon started from the owner's shell (its own config and state folders, the
// account's HOME) may not: it would show and act on his data. A daemon names
// a stand-in for each of these by its own variable (KEEL_IMPORT_*, KEEL_SSH_CONFIG,
// TACIT_BIN, MOMENTUM_BIN, ...), which is always honoured.
export function mayReadHome(): boolean {
  const own = process.env.KEEL_CONFIG_DIR;
  if (!own || resolve(own) === resolve(defaultConfigDir())) return true;
  return resolve(homeDir()) !== resolve(accountHome());
}

// The account's own home folder, as the system names it: its entry in the
// password file (os.userInfo() answers with $HOME where that is set, so a
// scratch HOME would stand for the account). KEEL_ACCOUNT_HOME names it where
// a test needs another folder to stand for it.
let passwdHome: string | undefined;
function accountHome(): string {
  const named = process.env.KEEL_ACCOUNT_HOME;
  if (named && isAbsolute(named)) return named;
  if (passwdHome === undefined) {
    passwdHome = "";
    try {
      const uid = String(process.getuid?.() ?? "");
      for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
        const f = line.split(":");
        if (f[2] === uid && f[5] && isAbsolute(f[5])) { passwdHome = f[5]; break; }
      }
    } catch {}
  }
  return passwdHome || userInfo().homedir;
}

// The home folder to read the owner's files from: the home, or for a daemon
// that may not read it (mayReadHome) a folder that is never there, so every
// "~/.something" read finds nothing.
export function ownerHome(): string {
  return mayReadHome() ? homeDir() : join(resolve(process.env.KEEL_CONFIG_DIR!), ".owner-home-withheld");
}

// An environment variable that points into the owner's home (CODEX_HOME,
// CLAUDE_CONFIG_DIR, XDG_*): as set for a daemon that may read the home, else unset.
export const ownerEnv = (name: string): string | undefined => (mayReadHome() ? process.env[name] : undefined);

// The daemon's state folder: --state-dir, else KEEL_STATE_DIR, else the XDG state home.
export const defaultStateDir = () => {
  if (!process.env.KEEL_STATE_DIR) ownersFolder("state folder", "KEEL_STATE_DIR");
  return resolve(process.env.KEEL_STATE_DIR || join(process.env.XDG_STATE_HOME ?? join(homeDir(), ".local/state"), "keel-bun"));
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
//
// A path the kernel refuses is returned as it was given (absolute), so that
// opening it fails the same way: more links than the kernel follows (ELOOP),
// a part after a file or a file named as a folder (`file/x`, `file/`,
// `file/..`: ENOTDIR), `..` after a part that does not exist (ENOENT), a
// folder that may not be searched. Such a path is never canonical
// (canonical()), and a file tool opens only a canonical one.
export function realOf(p: string): string {
  const given = isAbsolute(p) ? p : `${process.cwd()}/${p}`;
  const parts = (text: string) => text.split("/").filter((c) => c !== "" && c !== ".");
  const todo = parts(given);
  // `at` holds no link: every part of it was looked at. `folder`: it is a folder that exists. Past the first part
  // that does not exist nothing can be a link.
  let at = "/", folder = true, missing = false, links = 0;
  while (todo.length) {
    const c = todo.shift()!;
    if (missing) {
      if (c === "..") return given;
      at = `${at}/${c}`;
      continue;
    }
    if (!folder) return given;
    if (c === "..") { at = dirname(at); continue; }
    const next = at === "/" ? `/${c}` : `${at}/${c}`;
    let st: ReturnType<typeof lstatSync>;
    try { st = lstatSync(next); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return given;
      missing = true;
      at = next;
      continue;
    }
    if (!st.isSymbolicLink()) { at = next; folder = st.isDirectory(); continue; }
    // More links than the kernel follows (40): it refuses the path. The path comes back as it was given, so
    // whatever opens it walks the same links from the start and is refused the same way. Never the rest of
    // the walk from here: opened, that would get a count of its own and reach a target nobody judged.
    if (++links > 40) return given;
    let to: string;
    try { to = readlinkSync(next); } catch { return given; }
    if (to.startsWith("/")) at = "/";
    todo.unshift(...parts(to));
  }
  // (Named as a folder, by a slash or a dot at its end, and it is a file.)
  if (!missing && !folder && /\/\.?$/.test(given)) return given;
  return at;
}

// Whether a path is the one text of where it is: absolute, no `.` or `..` in it, no doubled or closing slash, and
// no part of it a link. What realOf returns for a path the kernel takes is canonical; what it returns for one the
// kernel refuses is not.
export function canonical(p: string): boolean {
  if (!isAbsolute(p) || (p !== "/" && (p.endsWith("/") || p.includes("//")))) return false;
  let at = "";
  for (const c of p.split("/").slice(1)) {
    if (c === "." || c === "..") return false;
    at = `${at}/${c}`;
    try { if (lstatSync(at).isSymbolicLink()) return false; } catch (e) {
      // (Past a part that does not exist nothing is a link; any other failure is the kernel refusing the path.)
      return (e as NodeJS.ErrnoException).code === "ENOENT" && !p.slice(at.length).split("/").some((x) => x === "." || x === "..");
    }
  }
  return true;
}

// The same answer, the kernel asked on the thread pool: for a path that may be on a mount that stopped
// answering, which stalls the call that asks (a Stop ends it), not the loop. A path that is its own real path
// has no link, `.` or `..` in it: one question for a file that is there, and for one that is not, the folders
// above it up to the first that is (and a name that is a link to nowhere is a link).
export async function canonicalOf(p: string): Promise<boolean> {
  if (!isAbsolute(p) || (p !== "/" && (p.endsWith("/") || p.includes("//")))) return false;
  if (p.split("/").some((c) => c === "." || c === "..")) return false;
  for (let at = p; ; at = dirname(at)) {
    try { return (await realpath(at)) === at; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    try { await lstat(at); return false; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false; } // there as a link to nowhere
    if (dirname(at) === at) return true;
  }
}

// The names in a folder, read from the folder itself: it is opened without following a link at its name, what was
// opened is checked to be the folder the path names (the descriptor's own path), and the names are read through
// the descriptor. A folder that is a link, or became one, lists nothing. Where the descriptor's path cannot be
// read (no /proc), only a folder with no link in its path is listed, by its name.
export function namesIn(dir: string): string[] | null {
  if (!existsSync("/proc/self/fd")) { try { return canonical(dir) ? readdirSync(dir) : null; } catch { return null; } }
  let fd: number | undefined;
  try {
    fd = openSync(dir, 0o10000000 | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    return readlinkSync(`/proc/self/fd/${fd}`) === dir ? readdirSync(`/proc/self/fd/${fd}`) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {} // closed already
  }
}
