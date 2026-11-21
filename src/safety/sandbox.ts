// OS confinement for shell commands: bubblewrap with a workspace-write or a
// read-only profile, the network on or off, inside a systemd user scope that
// runs at a lower CPU and IO weight (and a memory cap when one is set). When
// bwrap is missing or cannot start, sandboxing is unavailable and says why;
// a session never believes it is confined when it is not.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
// worktree whose folder is inside `root` (the session made it, or works in
// it) keeps its directory writable but for its config.worktree; one checked
// out anywhere else is another checkout's, and read-only as a whole.
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
      const inner = budget.left-- > 0 && within(root, wt) && plainFile(join(wt, "config.worktree")) ? modulesOf(join(wt, "modules"), root, budget) : null;
      out.push(...(inner ? [...pin(wt), ...ro(join(wt, "config.worktree")), ...inner] : ro(wt)));
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
// `<common>/worktrees/<name>` (index, HEAD, logs) and the repository's common
// directory (objects, refs). A commit writes both, so both are writable.
// Read-only in them: the code (hooks, config, both config.worktree files),
// the other worktrees' directories, the main checkout's HEAD and index, the
// submodules, and the three files that say where this worktree is.
//
// What stays writable, and is not the session's own (a stated limit, since
// bubblewrap binds paths and a commit needs lock files next to what it
// writes):
// - Every ref of the repository. A command can move or delete a branch that
//   another checkout has out, a tag, a stash. The gate compares the refs
//   around each such command and says what changed (src/safety/refwatch.ts).
// - The top of the common directory, where the main checkout keeps the state
//   of a merge or a rebase it is in the middle of (MERGE_HEAD, rebase-merge)
//   next to packed-refs, which a branch deletion rewrites there. New entries
//   are named after the command with the refs.
// - Smaller files that hold no code: info/, shallow, objects/info/alternates.
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

export function linkedGitBinds(workspace: string): string[] {
  const at = linkedWorktree(workspace);
  if (!at) return [];
  const { dot, own, common } = at;
  try {
    const code = codeOf(common);
    const modules = join(common, "modules");
    // A missing modules folder is made empty: one a command could create would
    // be found, with its hooks, by the next `git submodule update` there.
    if (!code || !plainDir(modules) || !plainFile(join(own, "config.worktree"))) return [];
    const out = [...ro(dot), ...pin(common), ...code, ...ro(join(common, "worktrees")), ...ro(modules)];
    for (const p of ["HEAD", "index"]) if (kindOf(join(common, p)) === "file") out.push(...ro(join(common, p)));
    out.push(...pin(own));
    for (const p of ["config.worktree", "gitdir", "commondir"]) out.push(...ro(join(own, p)));
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
