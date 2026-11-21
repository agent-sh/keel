// OS confinement for shell commands: bubblewrap with a workspace-write or a
// read-only profile, the network on or off, inside a systemd user scope that
// runs at a lower CPU and IO weight (and a memory cap when one is set). When
// bwrap is missing or cannot start, sandboxing is unavailable and says why;
// a session never believes it is confined when it is not.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { gitViewsDir } from "../core/git.ts";
import type { SessionPerm } from "./gate.ts";

export type SandboxStatus = { available: boolean; reason?: string; bwrap?: string; scope: boolean; scopeReason?: string };

let status: SandboxStatus | undefined;

export function sandboxStatus(): SandboxStatus {
  if (status) return status;
  const bwrap = Bun.which("bwrap");
  let available = false;
  let reason: string | undefined;
  if (!bwrap) reason = "bubblewrap (bwrap) is not installed; install it from the distribution's package to sandbox commands";
  else {
    const r = Bun.spawnSync([bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-net", "true"], { stdout: "ignore", stderr: "pipe" });
    available = r.success;
    if (!available) reason = `bwrap cannot start a sandbox here: ${r.stderr.toString().trim().slice(0, 300) || `exit ${r.exitCode}`} (on Ubuntu, load the bwrap-userns-restrict AppArmor profile)`;
  }
  const sr = Bun.which("systemd-run");
  let scope = false;
  let scopeReason: string | undefined;
  if (!sr) scopeReason = "systemd-run is not installed";
  else {
    const r = Bun.spawnSync([sr, "--user", "--scope", "--quiet", "--collect", "true"], { stdout: "ignore", stderr: "pipe" });
    scope = r.success;
    if (!scope) scopeReason = `no systemd user manager: ${r.stderr.toString().trim().slice(0, 200)}`;
  }
  status = { available, reason, bwrap: bwrap ?? undefined, scope, scopeReason };
  return status;
}

// The systemd-run head of a scope. systemd 254 and later expand $VAR and
// ${VAR} in the command line before it runs (--expand-environment, on by
// default), which blanks a shell's own ${x} and ${PIPESTATUS[0]}: the command
// must reach the shell as written. Older systemd has no such flag and does
// no expansion for --scope.
let head: string[] | undefined;
// A machine without systemd-run (macOS, a container) has no head: nothing is
// wrapped, and asking its version would fail every command.
export function scopeHead(): string[] {
  if (head) return head;
  if (!Bun.which("systemd-run")) return (head = []);
  const v = Number(/systemd (\d+)/.exec(Bun.spawnSync(["systemd-run", "--version"], { stdout: "pipe", stderr: "ignore" }).stdout.toString())?.[1] ?? 0);
  head = ["systemd-run", "--user", "--scope", "--quiet", "--collect", ...(v >= 254 ? ["--expand-environment=no"] : [])];
  return head;
}

// Resource limits of the scope. The lower weights let the desktop and the
// daemon win under contention without slowing an idle machine; a memory cap
// only when the owner sets one.
function scopeProps(): string[] {
  const p = ["-p", `CPUWeight=${process.env.KEEL_SANDBOX_CPU_WEIGHT ?? "50"}`, "-p", `IOWeight=${process.env.KEEL_SANDBOX_IO_WEIGHT ?? "50"}`];
  if (process.env.KEEL_SANDBOX_MEMORY_MAX) p.push("-p", `MemoryMax=${process.env.KEEL_SANDBOX_MEMORY_MAX}`);
  if (process.env.KEEL_SANDBOX_TASKS_MAX) p.push("-p", `TasksMax=${process.env.KEEL_SANDBOX_TASKS_MAX}`);
  return p;
}

// The scope part of a confined argv, split off: a job that runs in its own
// scope takes the properties into it, so nothing of the command lands in a
// scope of its own outside the job's (see startJob).
export function splitScope(argv: string[]): { props: string[]; argv: string[] } {
  const h = scopeHead();
  if (!h.length || !h.every((a, i) => argv[i] === a)) return { props: [], argv };
  const end = argv.indexOf("--", h.length);
  return end < 0 ? { props: [], argv } : { props: argv.slice(h.length, end), argv: argv.slice(end + 1) };
}

// ---- the repository's files that run code outside the sandbox later ----
//
// git runs what a repository's files name: its hooks, and its config
// (core.fsmonitor, core.hooksPath, an alias, a filter driver). `config.worktree`
// is config too, as soon as the repository turns per-worktree config on
// (sparse checkout does, also long after a file was planted). A confined
// command must not write any of them, for its own checkout or another's.
//
// A read-only bind does it for a path that exists, so the ones that are
// missing are made first, empty: a hooks folder a template left out, a
// config.worktree nobody wrote yet. And a path is only safe when it cannot be
// swapped: a folder that is no mount point can be renamed away and a copy
// put in its place, with the read-only files inside it left behind. So every
// folder between the writable root and a protected file is a mount point of
// its own (a bind onto itself), which the kernel refuses to rename or remove.
//
// Nothing pins a symbolic link. A git directory whose hooks or config is a
// link (or anything but a plain folder or file) is read-only as a whole:
// commits fail there with "Read-only file system" until the owner runs them.

const kindOf = (p: string): "dir" | "file" | "other" | "none" => {
  try {
    const st = lstatSync(p);
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  } catch {
    return "none";
  }
};
// A plain folder or file at the path, made empty when nothing is there.
function plainDir(p: string): boolean {
  if (kindOf(p) === "none") try { mkdirSync(p); } catch {} // not ours to make: the check below says what is there
  return kindOf(p) === "dir";
}
function plainFile(p: string): boolean {
  if (kindOf(p) === "none") try { writeFileSync(p, "", { flag: "wx" }); } catch {}
  return kindOf(p) === "file";
}
const ro = (p: string) => ["--ro-bind", p, p];
const pin = (p: string) => ["--bind", p, p];

// One git directory's hooks, config and config.worktree, read-only. Null when
// one of them cannot be pinned.
function codeOf(dir: string): string[] | null {
  const hooks = join(dir, "hooks"), config = join(dir, "config"), own = join(dir, "config.worktree");
  return plainDir(hooks) && plainFile(config) && plainFile(own) ? [...ro(hooks), ...ro(config), ...ro(own)] : null;
}

// The git directories one profile pins one by one (the repository's, its
// worktrees', its submodules'). Past this many the rest are read-only as a whole.
const GIT_DIRS_MAX = 256;

// A git directory inside the writable folder: a normal clone's `.git`, or a
// submodule's under `modules`. It stays writable (a commit writes it) with
// its code read-only, and so is the code of what lives inside it: each
// submodule's git directory, and each linked worktree's directory. A linked
// worktree checked out anywhere outside `root` is another checkout's, and
// read-only as a whole. One whose folder is inside `root` is the session's
// own (it made it, or it can write that folder and the `.git` file in it
// anyway): its directory stays writable and nothing in it is a mount point,
// so the session can also remove a worktree it made.
function guardGitDir(dir: string, root: string, budget: { left: number }): string[] {
  const code = budget.left-- > 0 ? codeOf(dir) : null;
  if (!code) return ro(dir);
  const out = [...pin(dir), ...code];
  const worktrees = join(dir, "worktrees");
  const kind = kindOf(worktrees);
  if (kind === "dir") {
    out.push(...pin(worktrees));
    for (const name of readdirSync(worktrees)) {
      const wt = join(worktrees, name);
      const k = kindOf(wt);
      if (k === "file") continue;
      if (k !== "dir") return ro(dir);
      if (!within(root, wt)) out.push(...ro(wt));
    }
  } else if (kind !== "none") return ro(dir);
  const modules = modulesOf(join(dir, "modules"), root, budget);
  return modules ? [...out, ...modules] : ro(dir);
}

// Whether the linked worktree a `worktrees/<name>` directory belongs to is
// checked out inside `root`. Its `gitdir` file names the folder's `.git`; a
// command can rewrite that file only for a directory it could already write.
function within(root: string, wt: string): boolean {
  try {
    const folder = realpathSync(dirname(resolve(wt, readFileSync(join(wt, "gitdir"), "utf8").trim())));
    return folder === root || folder.startsWith(root + sep);
  } catch {
    return false; // a folder that is gone: not the session's
  }
}

// The submodules' git directories under a `modules` folder (a submodule named
// a/b lives in modules/a/b). Null when the folder itself cannot be pinned.
function modulesOf(modules: string, root: string, budget: { left: number }): string[] | null {
  const kind = kindOf(modules);
  if (kind === "none") return [];
  if (kind !== "dir") return null;
  const out = pin(modules);
  for (const name of readdirSync(modules)) {
    const d = join(modules, name);
    const k = kindOf(d);
    if (k === "file") continue;
    if (k !== "dir") return null;
    if (budget.left <= 0) out.push(...ro(d));
    else if (kindOf(join(d, "HEAD")) === "file") out.push(...guardGitDir(d, root, budget));
    else out.push(...(modulesOf(d, root, (budget.left--, budget)) ?? ro(d))); // a part of a longer name
  }
  return out;
}

// A normal clone: `.git` is a folder of the workspace. Anything else there (a
// link, a file that is no worktree pointer) gets no binding: what it points
// at is outside the workspace and stays read-only, and inside it is the
// session's own folder.
function cloneGitBinds(workspace: string): string[] {
  const git = join(workspace, ".git");
  try {
    return kindOf(git) === "dir" ? guardGitDir(git, realpathSync(workspace), { left: GIT_DIRS_MAX }) : [];
  } catch {
    return ro(git); // a listing that failed halfway: closed
  }
}

// A linked worktree keeps git's files outside its folder: its own directory
// `<common>/worktrees/<name>` (index, HEAD, logs, the state of its own merge,
// rebase, cherry-pick, revert and bisect) and the repository's common
// directory (objects, refs). A commit writes both.
//
// The common directory is the main checkout's git directory too. Its top
// holds that checkout's HEAD and index and the state of a merge or a rebase
// it is in the middle of (MERGE_HEAD and its companions, CHERRY_PICK_HEAD,
// REVERT_HEAD, BISECT_*, AUTO_MERGE, rebase-merge, rebase-apply, sequencer).
// A `rebase-merge` planted there runs its `exec` line when the main checkout
// next continues a rebase, and a planted MERGE_HEAD gives its next commit a
// second parent. bubblewrap binds paths that exist: it cannot close a name
// that is not there yet in a folder that is writable. So the top is not
// bound writable at all:
//
// - A private, empty, read-only folder is mounted in its place, and what the
//   repository has at the top is bound into it one entry at a time. The
//   shared stores are writable (objects, refs, logs, info, and reftable, lfs
//   and rr-cache when the repository has them). Everything else is read-only:
//   the code (hooks, config, config.worktree), the main checkout's HEAD, index
//   and in-progress state, the other worktrees' directories, the submodules.
//   A name that is not there cannot be made: nothing a confined command does
//   at the top reaches the repository.
// - The worktree's own directory is writable, apart from its config.worktree
//   and the two files that say where it is. Its submodules' git directories
//   are guarded like a clone's.
// - `packed-refs` is the one file at the top that git rewrites from a linked
//   worktree, and it takes a lock beside it for every ref it deletes, the
//   ones of its own directory (CHERRY_PICK_HEAD, MERGE_HEAD) included. It is
//   reached through a chain of links that ends at the repository's own file,
//   read where it is (so a pack of the refs by another checkout is seen at
//   once: a copy taken when the command started would lose every branch that
//   was packed since, and a commit on one would start a new history). git
//   resolves a link at most five times before it puts its lock and its new
//   file beside the name it reached (lockfile.h: "symbolic links in the
//   destination path are resolved", and MAXDEPTH in lockfile.c), so both
//   land in a private scratch folder: the lock is taken, and the new file's
//   name is taken already, which refuses the rewrite before anything changed.
//
// What that closes, as plain errors: deleting a branch or a tag that is
// packed, `git pack-refs`, `git gc`, changing a shallow clone's depth, a
// first `git lfs` object or `git worktree add` (they make a folder at the
// top), and `git config`. The owner runs those outside the sandbox.
//
// What stays writable and is not the session's own (a stated limit, since a
// commit needs lock files next to what it writes): every ref of the
// repository. A command can move or delete a branch that another checkout
// has out, a tag, a stash. The gate compares the refs around each such
// command and says what changed (src/safety/refwatch.ts).
//
// The `.git` file that names the directory is read-only for a confined
// command, and is still not believed by itself (a command the owner let out
// of the sandbox can rewrite it): the layout must confirm it. The directory
// is `<common>/worktrees/<name>`, its `gitdir` file points back at this
// folder, and the common directory is a repository. A forged pointer needs
// those files in a place the sandbox could already write, so it gains nothing.
export function linkedWorktree(workspace: string): { dot: string; own: string; common: string } | undefined {
  try {
    const dot = join(workspace, ".git");
    if (kindOf(dot) !== "file") return undefined;
    const named = /^gitdir: (.+)$/m.exec(readFileSync(dot, "utf8"))?.[1]?.trim();
    if (!named) return undefined;
    const own = realpathSync(resolve(workspace, named));
    const common = dirname(dirname(own));
    if (basename(dirname(own)) !== "worktrees") return undefined;
    if (realpathSync(resolve(own, readFileSync(join(own, "commondir"), "utf8").trim())) !== common) return undefined;
    const back = resolve(own, readFileSync(join(own, "gitdir"), "utf8").trim());
    if (realpathSync(dirname(back)) !== realpathSync(workspace) || basename(back) !== ".git") return undefined;
    if (!["HEAD", "objects", "refs"].every((p) => existsSync(join(common, p)))) return undefined;
    return { dot, own, common };
  } catch {
    return undefined;
  }
}

// The shared stores at the top of a common directory: writable for a linked worktree.
const SHARED_STORES = new Set(["objects", "refs", "logs", "info", "reftable", "lfs", "rr-cache"]);
const CODE = new Set(["hooks", "config", "config.worktree", "modules", "worktrees"]);
// The scratch folder inside the private top: git's lock for packed-refs, and
// the links to the file itself. More links than git resolves.
export const SCRATCH = "keel-sandbox";
const LINKS = 8;

export function linkedGitBinds(workspace: string): string[] {
  const at = linkedWorktree(workspace);
  if (!at) return [];
  const { dot, own, common } = at;
  try {
    // The session's own config.worktree, made empty when missing (see codeOf).
    if (!plainFile(join(own, "config.worktree"))) return [];
    const modules = modulesOf(join(own, "modules"), realpathSync(workspace), { left: GIT_DIRS_MAX });
    if (!modules) return [];
    const scratch = join(common, SCRATCH);
    const out = [...ro(dot), "--tmpfs", common];
    for (const name of readdirSync(common).sort()) {
      const p = join(common, name);
      const kind = kindOf(p);
      // The stores and the code must be plain folders and files (a link could
      // lead into the writable folder), and the scratch name must be free:
      // else nothing is writable.
      if (name === SCRATCH || ((SHARED_STORES.has(name) || CODE.has(name)) && kind === "other")) return [];
      if (SHARED_STORES.has(name) && kind !== "dir") return [];
      if (name === "packed-refs" || name.endsWith(".lock")) continue;
      // Any other link is kept as the link it is; a socket or a pipe is left out.
      if (kind === "other") { if (lstatSync(p).isSymbolicLink()) out.push("--symlink", readlinkSync(p), p); continue; }
      out.push(...(kind === "dir" && SHARED_STORES.has(name) ? pin(p) : ro(p)));
    }
    out.push(...pin(own));
    for (const f of ["config.worktree", "gitdir", "commondir"]) out.push(...ro(join(own, f)));
    out.push(...modules);
    // packed-refs: the links, the repository's top as it is (read-only), and
    // every name git could write a new file under, taken.
    out.push("--tmpfs", scratch, "--ro-bind", common, join(scratch, "top"), "--symlink", join(SCRATCH, "packed-refs.1"), join(common, "packed-refs"));
    for (let i = 1; i <= LINKS; i++) {
      out.push("--symlink", i < LINKS ? `packed-refs.${i + 1}` : "top/packed-refs", join(scratch, `packed-refs.${i}`), "--dir", join(scratch, `packed-refs.${i}.new`));
    }
    // Last: the top itself. Nothing can be made in it from here on.
    out.push("--remount-ro", common);
    return out;
  } catch {
    return [];
  }
}

// The argv that runs `argv` confined by the session's profile.
// `scratch` is the session's own tool folder (a command's working-directory
// file, spilled output), or several (an ACP agent's own folders): writable in
// every profile.
export function confine(argv: string[], perm: Pick<SessionPerm, "sandbox" | "network">, workspace: string, scratch?: string | string[]): string[] {
  const st = sandboxStatus();
  if (perm.sandbox === "off" || !st.available) return argv;
  const b = [st.bwrap!, "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc",
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  if (!perm.network) b.push("--unshare-net");
  if (perm.sandbox === "workspace-write") {
    b.push("--bind", workspace, workspace);
    const tmp = process.env.TMPDIR;
    if (tmp && existsSync(tmp) && !tmp.startsWith("/tmp")) b.push("--bind", tmp, tmp);
    // The repository's hooks and config run code outside the sandbox later:
    // they stay read-only. Commits still work.
    b.push(...cloneGitBinds(workspace), ...linkedGitBinds(workspace));
  }
  // The views the daemon's own git reads repositories through (src/core/git.ts):
  // never writable, also for a session whose folder holds Keel's state folder.
  if (perm.sandbox === "workspace-write" && existsSync(gitViewsDir())) b.push("--ro-bind", gitViewsDir(), gitViewsDir());
  for (const p of typeof scratch === "string" ? [scratch] : scratch ?? []) if (p && existsSync(p)) b.push("--bind", p, p);
  b.push("--", ...argv);
  return st.scope ? [...scopeHead(), ...scopeProps(), "--", ...b] : b;
}
