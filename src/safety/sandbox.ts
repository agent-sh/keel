// OS confinement for shell commands: bubblewrap with a workspace-write or a
// read-only profile, the network on or off, inside a systemd user scope that
// runs at a lower CPU and IO weight (and a memory cap when one is set). When
// bwrap is missing or cannot start, sandboxing is unavailable and says why;
// a session never believes it is confined when it is not.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { atCwd, contains, realOf } from "../core/paths.ts";
import { basename, dirname, join, resolve } from "node:path";
import { gitViewsDir } from "../core/git.ts";
import type { SessionPerm } from "./gate.ts";
import { IN_SANDBOX, proxyDir, RELAY_START, relayFiles, viewOnThread } from "./net-proxy.ts";
import { sandboxRoot, sandboxScope, scopeDir } from "./sandbox-scope.ts";
import { FILTER_FD, filterFile, withFilter } from "./seccomp.ts";
import { envPlan, flockPath, forgetViews, namedConfig, offeredPaths, overlays, readView, SLOT, type ReadOpts, type View } from "./sandbox-view.ts";

const SSH_SNIPPETS = "/etc/ssh/ssh_config.d";
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// `seccomp`: every command also runs under the syscall filter (src/safety/seccomp.ts). A machine where bubblewrap
// cannot load it still sandboxes, without it, and `seccompReason` says why.
export type SandboxStatus = { available: boolean; reason?: string; bwrap?: string; scope: boolean; scopeReason?: string; seccomp: boolean; seccompReason?: string };

let status: SandboxStatus | undefined;
// The file the filter is read from (made again by `confine` when it is gone).
let filterPath: string | undefined;

export function sandboxStatus(): SandboxStatus {
  if (status) return status;
  const bwrap = Bun.which("bwrap");
  let available = false;
  let reason: string | undefined;
  let seccomp = false;
  let seccompReason: string | undefined;
  if (!bwrap) reason = "bubblewrap (bwrap) is not installed; install it from the distribution's package to sandbox commands";
  else {
    const probe = [bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-net"];
    let file: string | undefined;
    try { file = filterFile(); } catch (e) { seccompReason = `the filter file could not be written: ${e instanceof Error ? e.message : e}`; }
    if (file) {
      const f = Bun.spawnSync([...withFilter(file), ...probe, "--seccomp", String(FILTER_FD), "true"], { stdout: "ignore", stderr: "pipe" });
      if (f.success) { seccomp = true; filterPath = file; } else seccompReason = `bubblewrap could not load the syscall filter: ${f.stderr.toString().trim().slice(0, 300) || `exit ${f.exitCode}`}`;
    } else seccompReason ??= `no syscall filter for ${process.platform}/${process.arch}`;
    const r = seccomp ? { success: true } as const : Bun.spawnSync([...probe, "true"], { stdout: "ignore", stderr: "pipe" });
    available = r.success;
    if (!r.success) reason = `bwrap cannot start a sandbox here: ${r.stderr.toString().trim().slice(0, 300) || `exit ${r.exitCode}`} (on Ubuntu, load the bwrap-userns-restrict AppArmor profile)`;
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
  status = { available, reason, bwrap: bwrap ?? undefined, scope, scopeReason, seccomp, seccompReason };
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

// A program in a scope of its own, with the scope's weights and more
// properties (a memory limit), whether `argv` is confined or not: a long-lived
// program the daemon starts for a session (a language server) is held to its
// own limits there, never counted in the daemon's own unit. Where there is no
// systemd user manager the argv is returned as it is.
export function inScope(argv: string[], props: string[]): string[] {
  if (!sandboxStatus().scope) return argv;
  const inner = splitScope(argv);
  return [...scopeHead(), ...(inner.props.length ? inner.props : scopeProps()), ...props, "--", ...inner.argv];
}

// ---- the repository's files that run code outside the sandbox later ----
//
// git runs what a repository's files name: its hooks, and its config
// (core.fsmonitor, core.hooksPath, an alias, a filter driver). `config.worktree`
// is config too, as soon as the repository turns per-worktree config on
// (sparse checkout does, also long after a file was planted). A confined
// command must not write any of them, for its own checkout or another's.
//
// They are closed by the folder that holds them, never by a bind of the file
// alone. A bind of a file holds the file it found when the command started: git
// rewrites its config by writing a new file and renaming it over the old one
// (git config, git push -u, git remote add), and the kernel then takes the
// bind away from the name in every sandbox that had it (a mount on a name
// replaced from outside is detached). The name is then the new file, in a
// folder the command can write, for as long as the command runs: a terminal or
// a dev server of the session. A read-only bind of the folder holds whatever
// the folder holds, now and later, and a mount point of the sandbox's own is
// never renamed or removed from inside it.
//
// So a git directory whose top holds that code is read-only as a whole: a
// normal clone's `.git`, and every submodule's under `modules`. git status,
// diff, log, show, blame and grep work there; a commit, staging, a checkout and
// a branch fail with "Read-only file system" until the owner runs them, or a
// session in a worktree of the repository does (below). A linked worktree's own
// directory holds no hooks and no config of the repository: it stays writable
// for its commits, see linkedGitBinds.

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

// Where a path that exists is, as the kernel walks it (realOf: never by the path's text). It throws for one that is
// not there, as realpath does.
function there(p: string): string {
  const r = realOf(p);
  lstatSync(r);
  return r;
}

// A normal clone: `.git` is a folder of the workspace, read-only as a whole
// (its submodules' and its worktrees' directories with it). Anything else there
// (a link, a file that is no worktree pointer) gets no binding: what it points
// at is outside the workspace and stays read-only, and inside it is the
// session's own folder.
function cloneGitBinds(workspace: string): string[] {
  const git = join(workspace, ".git");
  return kindOf(git) === "dir" ? ro(git) : [];
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
//   at the top reaches the repository. Every mount point there is a folder of
//   Keel's own, which no git outside the sandbox renames, and each plain file
//   is a link read through one read-only bind of the whole top: a config that
//   git outside rewrites by a rename is the new file, read-only, for as long
//   as the command runs.
// - The worktree's own directory is writable, apart from its config.worktree
//   and the two files that say where it is. Its submodules' git directories
//   are read-only as a whole, as a clone's are.
//
//   Those three are binds of a file in a folder a commit must write, the one
//   place where the protection is the file's and not the folder's. git
//   rewrites `gitdir` and `commondir` in place (`git worktree repair` and
//   `move` keep the file), so their bind holds. `config.worktree` is renamed
//   into place by `git config --worktree` and `git sparse-checkout`: run by
//   hand in that worktree while a sandboxed command of it is running, they
//   leave that command a writable file until it ends; the next command gets a
//   bind of it again. git reads it only once the repository's config
//   (read-only above) turns per-worktree config on, and Keel's own git ignores
//   what it could name (src/core/git.ts).
//
//   Its `modules` folder is bound only when it is there. A first `git
//   submodule update --init` makes it, and the git directories in it are the
//   command's own until it ends; the session's kept profile is made again for
//   the next command (profileOf).
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
// command and says what changed (src/safety/refwatch.ts). One branch cannot
// be held read-only by a bind of its own: a bind holds the file of the moment
// the command started (a branch the owner moves since would read as it was),
// and a branch that is only in packed-refs is written as a new file beside
// the others. An agent in a worktree Keel made is held off the branches it
// shares at git's door instead, in the sandbox and out of it
// (src/safety/ref-guard.ts).
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
    const own = there(atCwd(workspace, named));
    const common = dirname(dirname(own));
    if (basename(dirname(own)) !== "worktrees") return undefined;
    if (there(atCwd(own, readFileSync(join(own, "commondir"), "utf8").trim())) !== common) return undefined;
    const back = atCwd(own, readFileSync(join(own, "gitdir"), "utf8").trim());
    if (there(dirname(back)) !== there(workspace) || basename(back) !== ".git") return undefined;
    if (!["HEAD", "objects", "refs"].every((p) => existsSync(join(common, p)))) return undefined;
    return { dot, own, common };
  } catch {
    return undefined;
  }
}

// linkedWorktree, read with the asynchronous file calls: the same answer, off the loop.
export async function linkedWorktreeAsync(workspace: string): Promise<{ dot: string; own: string; common: string } | undefined> {
  try {
    const dot = join(workspace, ".git");
    if (!(await lstat(dot)).isFile()) return undefined;
    const named = /^gitdir: (.+)$/m.exec(await readFile(dot, "utf8"))?.[1]?.trim();
    if (!named) return undefined;
    const own = await realpath(atCwd(workspace, named));
    const common = dirname(dirname(own));
    if (basename(dirname(own)) !== "worktrees") return undefined;
    if ((await realpath(atCwd(own, (await readFile(join(own, "commondir"), "utf8")).trim()))) !== common) return undefined;
    const back = atCwd(own, (await readFile(join(own, "gitdir"), "utf8")).trim());
    if ((await realpath(dirname(back))) !== (await realpath(workspace)) || basename(back) !== ".git") return undefined;
    for (const p of ["HEAD", "objects", "refs"]) await access(join(common, p));
    return { dot, own, common };
  } catch {
    return undefined;
  }
}

// The shared stores at the top of a common directory: writable for a linked
// worktree. `info` is not one: its exclude, attributes, sparse-checkout and
// grafts files steer the main checkout's own git.
const SHARED_STORES = new Set(["objects", "refs", "logs", "reftable", "lfs", "rr-cache"]);
const CODE = new Set(["hooks", "config", "config.worktree", "modules", "worktrees", "info"]);
// The scratch folder inside the private top: git's lock for packed-refs, the
// links to the file itself (more links than git resolves), and the top of the
// repository as it is, read-only (`top`).
export const SCRATCH = "keel-sandbox";
const LINKS = 8;
// The files git itself keeps at the top of a git directory, by name (the
// index, the pseudo-refs and the companions of an operation in progress:
// gitrepository-layout(5), git-merge(1), git-bisect(1)).
const TOP_FILES = [
  "index", "HEAD", "ORIG_HEAD", "FETCH_HEAD", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "MERGE_RR", "MERGE_AUTOSTASH", "AUTO_MERGE", "SQUASH_MSG",
  "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "COMMIT_EDITMSG", "shallow",
  "BISECT_LOG", "BISECT_START", "BISECT_EXPECTED_REV", "BISECT_ANCESTORS_OK", "BISECT_NAMES", "BISECT_TERMS", "BISECT_HEAD", "BISECT_FIRST_PARENT",
];
// bubblewrap takes this many arguments at most.
const ARGS_MAX = 9_000;

// The folder mounted in place of a common directory's top, kept in Keel's
// state folder (one per repository, read-only in every sandbox). It holds a
// folder for each folder the top has (the place a bind goes) and, for each
// plain file, a link into the read-only bind of the real top: a file is read
// where it is, as it is now. One bind per file would hold the file of the
// moment the command started (the main checkout's index and HEAD change under
// a running command: a prune then drops what was staged since, and a branch
// the main checkout switched to can be deleted), and would cost three
// arguments a file.
// Entries are added and links fixed, never a folder removed: it may be a
// mount point of a command that is running.
export const sandboxTopsDir = () => join(dirname(gitViewsDir()), "git-tops");
let topsPruned = false;
function topOf(common: string): string | null {
  const root = sandboxTopsDir();
  if (!topsPruned) {
    topsPruned = true;
    try {
      for (const name of readdirSync(root)) {
        let origin: string | undefined;
        try { origin = readFileSync(join(root, name, SCRATCH, "origin"), "utf8"); } catch {} // not one of these
        if (!origin || !existsSync(origin)) rmSync(join(root, name), { recursive: true, force: true });
      }
    } catch {} // none made yet
  }
  const top = join(root, createHash("sha256").update(common).digest("hex").slice(0, 24));
  mkdirSync(join(top, SCRATCH), { recursive: true, mode: 0o700 });
  if (kindOf(join(top, SCRATCH, "origin")) === "none") writeFileSync(join(top, SCRATCH, "origin"), common);
  const link = (name: string, target: string) => {
    const at = join(top, name);
    let now: string | undefined;
    try { now = readlinkSync(at); } catch {} // nothing there, or no link
    if (now === target) return true;
    if (now === undefined && kindOf(at) !== "none") return false; // a folder where a file is now: left closed
    const tmp = `${at}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.lock`;
    symlinkSync(target, tmp);
    renameSync(tmp, at);
    return true;
  };
  const have = new Set<string>([SCRATCH, "packed-refs"]);
  for (const name of readdirSync(common)) {
    if (name === "packed-refs" || name.endsWith(".lock")) continue;
    const p = join(common, name);
    const st = lstatSync(p);
    // The scratch name must be free, and the stores and the code plain
    // folders and files (a link could lead into the writable folder).
    if (name === SCRATCH || ((SHARED_STORES.has(name) || CODE.has(name)) && !st.isDirectory() && !st.isFile())) return null;
    if (SHARED_STORES.has(name) && !st.isDirectory()) return null;
    have.add(name);
    if (st.isDirectory()) {
      const k = kindOf(join(top, name));
      if (k === "other" || k === "file") rmSync(join(top, name), { force: true });
      if (k !== "dir") mkdirSync(join(top, name));
    } else if (st.isFile()) { if (!link(name, join(SCRATCH, "top", name))) return null; }
    else if (st.isSymbolicLink()) { if (!link(name, readlinkSync(p))) return null; }
  }
  // The files git keeps at the top by a fixed name, linked also when the
  // repository has none yet: a link to a file that is not there reads as
  // absent, goes live when the main checkout makes the file (a clone made
  // without a checkout gets its index at the first one), and cannot be
  // written through.
  for (const name of TOP_FILES) {
    if (have.has(name)) continue;
    if (!link(name, join(SCRATCH, "top", name))) return null;
    have.add(name);
  }
  if (!link("packed-refs", join(SCRATCH, "packed-refs.1"))) return null;
  // What the top no longer has: its link goes (a folder stays, empty).
  for (const name of readdirSync(top)) if (!have.has(name) && !name.endsWith(".lock") && kindOf(join(top, name)) !== "dir") rmSync(join(top, name), { force: true });
  return top;
}

export function linkedGitBinds(workspace: string): string[] {
  const at = linkedWorktree(workspace);
  if (!at) return [];
  const { dot, own, common } = at;
  try {
    // The session's own config.worktree, made empty when missing: a bind needs
    // a file, and one planted before the repository turns per-worktree config
    // on would be read from then on.
    if (!plainFile(join(own, "config.worktree"))) return [];
    // Its submodules' git directories, each with a config and hooks at its top: read-only as a whole.
    const subs = kindOf(join(own, "modules"));
    if (subs !== "none" && subs !== "dir") return [];
    const modules = subs === "dir" ? ro(join(own, "modules")) : [];
    // The logs of the shared refs are a store git makes at a first commit. A
    // bare repository has none, and nothing can be made at the top from
    // inside: the folder is made here (empty; git decides by itself what it
    // logs). A repository whose refs are in reftable keeps its logs there.
    const logs = join(common, "logs");
    if (kindOf(logs) !== "none" || kindOf(join(common, "reftable")) !== "dir") {
      if (!plainDir(logs) || !plainDir(join(logs, "refs"))) return [];
    }
    const top = topOf(common);
    if (!top) return [];
    const scratch = join(common, SCRATCH);
    const out = [...ro(dot), "--bind", top, common];
    for (const name of readdirSync(common).sort()) {
      const p = join(common, name);
      if (kindOf(p) !== "dir") continue;
      // The logs: the folder as it is, read-only, and in it the logs of the
      // shared refs writable. The main checkout's own HEAD log is then the
      // real file, read-only (it says which commits that checkout made
      // itself, see refwatch.ts; and git's walk over the logs, which a prune
      // and a repack keep commits by, steps over a link), and one that is
      // missing cannot be made. The session's own is in its own directory.
      out.push(...(name === "logs" ? [...ro(p), ...pin(join(p, "refs"))] : SHARED_STORES.has(name) ? pin(p) : ro(p)));
    }
    out.push(...pin(own));
    for (const f of ["config.worktree", "gitdir", "commondir"]) out.push(...ro(join(own, f)));
    out.push(...modules);
    // packed-refs: the links, the repository's top as it is (read-only), and
    // every name git could write a new file under, taken.
    out.push("--tmpfs", scratch, "--ro-bind", common, join(scratch, "top"));
    for (let i = 1; i <= LINKS; i++) {
      out.push("--symlink", i < LINKS ? `packed-refs.${i + 1}` : "top/packed-refs", join(scratch, `packed-refs.${i}`), "--dir", join(scratch, `packed-refs.${i}.new`));
    }
    // Last: the top itself. Nothing can be made in it from here on.
    out.push("--remount-ro", common);
    return out.length > ARGS_MAX - 200 ? [] : out;
  } catch {
    return [];
  }
}

// What git is told in every sandbox, where the repository's config is
// read-only: a new branch records no upstream (`git checkout -b x
// origin/main` would fail on the write of the tracking lines, and leave HEAD
// where it was).
const SANDBOX_GIT: [string, string][] = [["branch.autoSetupMerge", "false"]];
// And in a linked worktree's view of the top:
// - no gc and no maintenance is started after a commit: neither can run
//   there (each would print that it cannot take its lock). A session in the
//   main checkout can gc, and is left to;
// - packed-refs is a link there: git fsck would report it as a broken ref file;
// - info is read-only: a repack would say it cannot write the server info
//   (info/refs, for a dumb http server) after packing.
const LINKED_GIT: [string, string][] = [["gc.auto", "0"], ["maintenance.auto", "false"], ["fsck.badRefFiletype", "ignore"], ["repack.updateServerInfo", "false"]];
// The shell line that adds settings to the environment it is run in and then
// becomes the command (its arguments). The names and values are Keel's own.
// `defaults`: variables set unless the command's environment has them (the sandbox's cache folders).
const shq = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
const withGit = (settings: [string, string][], defaults: [string, string][] = []) =>
  `${defaults.map(([k, v]) => `[ -n "\${${k}:-}" ] || export ${k}=${shq(v)}; `).join("")}export KEEL_SANDBOX_PATH="$PATH"; n=\${GIT_CONFIG_COUNT:-0}; case "$n" in ""|*[!0-9]*) n=0;; esac; ${settings.map(([k, v]) => `export "GIT_CONFIG_KEY_$n=${k}" "GIT_CONFIG_VALUE_$n=${v}"; n=$((n+1))`).join("; ")}; export GIT_CONFIG_COUNT=$n; exec "$@"`;

// Why a confined command in `workspace` cannot write git's files, when the
// profile opens none of them: said on a command that ran into it.
export function gitShut(workspace: string): string | undefined {
  try {
    const kind = kindOf(join(workspace, ".git"));
    if (kind === "none") {
      for (let dir = dirname(workspace); ; dir = dirname(dir)) {
        const up = kindOf(join(dir, ".git"));
        if (up !== "none") return `this session's folder is inside the repository at ${dir}, and that repository's git directory is outside the session's folder, so it is read-only here. Commits and every other git write fail. ${up === "dir" ? `A session in a worktree of ${dir}` : `A session opened at ${dir}`} can commit`;
        if (dir === dirname(dir)) return undefined;
      }
    }
    if (kind === "dir") return "this session's folder is the repository's main checkout, and its git directory is read-only in the sandbox as a whole: the repository's config and hooks are in it, and git runs what they name outside the sandbox. git status, diff, log, show, blame and grep work. Everything that writes it fails: git add, commit, restore, checkout and switch (also checkout -- FILE), branch, tag, stash, fetch and pull, merge, rebase, cherry-pick, reset. A session in a worktree of this repository commits: the owner moves this session to a new worktree, with its uncommitted work, by typing /worktree in its composer or by the command 'Move this session to a new worktree'";
    if (!linkedGitBinds(workspace).length) return "the sandbox could not open this worktree's git directories, so they are read-only here and commits fail: their layout is not the one git makes for a linked worktree, or the repository's git directory holds more folders than a sandbox can bind";
  } catch {} // unreadable: nothing to say
  return undefined;
}

// The argv that runs `argv` confined by the session's profile.
// `scratch` is the session's own tool folder (a command's working-directory
// file, spilled output), or several (an ACP agent's own folders): writable in
// every profile.
export function confine(argv: string[], perm: Pick<SessionPerm, "sandbox" | "network">, workspace: string, scratch?: string | string[], read: ReadOpts = {}): string[] {
  const st = sandboxStatus();
  if (perm.sandbox === "off" || !st.available) return argv;
  // The profile is the same for every command of a session until one of its
  // inputs changes: it is built once and kept for a short while (profileOf).
  const extra = (typeof scratch === "string" ? [scratch] : scratch ?? []).filter((p) => p && existsSync(p));
  const b = [...cleaned(profileOf(st.bwrap!, perm, workspace, extra, read), st.bwrap!, read, st.seccomp ? withFilter(filterPath && existsSync(filterPath) ? filterPath : (filterPath = filterFile()!)) : []), ...argv];
  return st.scope ? [...scopeHead(), ...scopeProps(), "--", ...b] : b;
}

// The command's environment is cleaned before bubblewrap starts, by env(1):
// bubblewrap is the first process inside, and what it was started with is
// read there (/proc/1/environ) whatever it then takes out for its child. What
// goes is judged by the daemon's environment as it is at this call (envPlan):
// everything of it that a build does not need, and a kept value that carries
// a sign-in goes in without it. What a caller adds for the command (the
// session's id, a secret the owner gave it under a name) is not the daemon's
// and stays.
const ENV_HERE = "\0keel-env\0";
let envProgram: string | null | undefined;
// `filter`: the head that opens the syscall filter's file on the descriptor bubblewrap reads it from, put right
// before bubblewrap (it becomes bubblewrap, so nothing of it stays around the command).
function cleaned(profile: string[], bwrap: string, read: ReadOpts, filter: string[]): string[] {
  const at = profile.indexOf(ENV_HERE);
  if (at < 0) return profile;
  if (envProgram === undefined) envProgram = ["/usr/bin/env", "/bin/env"].find((p) => existsSync(p)) ?? null;
  const plan = envPlan(process.env, read.env);
  const to = profile.indexOf(bwrap, at);
  const fixed = profile.slice(at + 1, to).filter((x) => x !== "-u");
  if (envProgram) return [...profile.slice(0, at), envProgram, ...[...plan.drop, ...fixed].flatMap((n) => ["-u", n]), ...plan.set.map(([k, v]) => `${k}=${v}`), ...filter, ...profile.slice(to)];
  // (No env program on this machine: bubblewrap takes them out for the command it starts; its own start keeps them.)
  return [...profile.slice(0, at), ...filter, bwrap, ...[...plan.drop, ...fixed].flatMap((n) => ["--unsetenv", n]), ...plan.set.flatMap(([k, v]) => ["--setenv", k, v]), ...profile.slice(to + 1)];
}

// A session's profile is kept: building one reads a few hundred names on
// disk, and a turn runs many commands. What it is made from is its key (the
// folders, the profile, the owner's lists and what Keel adds, the
// environment's toolchain names). What it reads on disk (which toolchains,
// caches and checkouts exist) is read again when a kept one is older than
// PROFILE_MS: the command at hand runs with the kept one, and the new one is
// made on the sandboxes' thread (src/safety/net-proxy-worker.ts), off this
// loop. Only a session's first profile is made here.
let PROFILE_MS = 5_000;
// (A test makes a kept profile old at once.)
export const setProfileAge = (ms: number) => void (PROFILE_MS = ms);
type Perm = { sandbox: "workspace-write" | "read-only"; network: boolean };
// `mark`: a name on disk whose kind the profile was made from and that a command can change, with that kind: a
// linked worktree's own `modules` folder, which is bound read-only only when it is there (see linkedGitBinds). A
// first `git submodule update --init` makes it: the next command gets a profile that binds it, not the kept one.
type Kept = { at: number; argv: string[]; busy?: boolean; view: View; mark?: [string, ReturnType<typeof kindOf>] };
const profiles = new Map<string, Kept>();
const markOf = (workspace: string, perm: Perm): Kept["mark"] => {
  if (perm.sandbox !== "workspace-write") return undefined;
  const own = linkedWorktree(workspace)?.own;
  return own ? [join(own, "modules"), kindOf(join(own, "modules"))] : undefined;
};
// Every kept profile is dropped (the owner changed what a sandbox shows; a test changed the disk).
export function forgetProfiles() { profiles.clear(); forgetViews(); }
function profileOf(bwrap: string, perm: Pick<SessionPerm, "sandbox" | "network">, workspace: string, scratch: string[], read: ReadOpts): string[] {
  const key = JSON.stringify([bwrap, perm.sandbox, perm.network, workspace, scratch, read, process.env.PATH, process.env.TMPDIR, process.env.SSH_AUTH_SOCK, namedConfig()]);
  const p = perm as Perm;
  const flock = flockPath();
  const layered = !!flock && overlays(bwrap);
  const have = profiles.get(key);
  if (have?.mark && kindOf(have.mark[0]) !== have.mark[1]) {
    // (The view is the kept one: only the binds of git's files are made again.)
    const mark = markOf(workspace, p);
    profiles.set(key, { at: have.at, view: have.view, mark, argv: compose(bwrap, p, workspace, scratch, have.view, flock, read.root, read.held, read.layers) });
    return profiles.get(key)!.argv;
  }
  if (have) {
    if (Date.now() - have.at >= PROFILE_MS && !have.busy) {
      const asked = viewOnThread({ workspace, profile: p.sandbox, read, env: { ...process.env }, layered, offers: offeredPaths(), state: dirname(gitViewsDir()) });
      if (asked) {
        have.busy = true;
        void asked.then((view) => {
          // (No answer: the kept one stays for another round.)
          if (profiles.get(key) !== have) return;
          if (view) profiles.set(key, { at: Date.now(), view, mark: markOf(workspace, p), argv: compose(bwrap, p, workspace, scratch, view, flock, read.root, read.held, read.layers) });
          else { have.busy = false; have.at = Date.now(); }
        });
      } else {
        const view = readView(workspace, p.sandbox, read, process.env, layered);
        profiles.set(key, { at: Date.now(), view, mark: markOf(workspace, p), argv: compose(bwrap, p, workspace, scratch, view, flock, read.root, read.held, read.layers) });
      }
    }
    return profiles.get(key)!.argv;
  }
  const view = readView(workspace, p.sandbox, read, process.env, layered);
  const mark = markOf(workspace, p);
  const argv = compose(bwrap, p, workspace, scratch, view, flock, read.root, read.held, read.layers);
  if (profiles.size > 256) profiles.clear();
  profiles.set(key, { at: Date.now(), view, mark, argv });
  return argv;
}

// The sandbox's arguments around a view (src/sandbox-view.ts: what the
// command can read: the system, the owner's toolchains and a home of the
// sandbox's own; the package caches layered when a lock program is there to
// hold a layer by).
// `root`: the folder the session was made in, as the gate pinned it (device and inode): checked inside, after the
// folder is bound, so a command never runs in a folder that took the session folder's name.
// `held`: what an agent's write scope keeps read-only (src/safety/write-scope.ts): the session's folder when no
// place of the scope holds it (the places in it are bound writable after it, with the scratch), and the refs of the
// branches another checkout has out, each one a file there now (a ref git writes is renamed into place, and a name
// that is a mount point is not renamed over: the update fails, the branch stays where it was).
function compose(bwrap: string, perm: Perm, workspace: string, scratch: string[], view: View, flock: string | null, root?: string, held?: ReadOpts["held"], over?: ReadOpts["layers"]): string[] {
  // A network namespace of its own, always: the host's loopback (Keel's own API among the listeners there), the
  // local network and the display's abstract sockets are not in it. With the session's network on, what leaves
  // goes through the proxy this process runs for the repository (src/safety/net-proxy.ts).
  // (ENV_HERE: where the command's environment is cleaned, before bubblewrap starts: confine puts it in per call.)
  const b = [ENV_HERE, ...view.unset.flatMap((name) => ["-u", name]), bwrap, "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-net",
    ...(sandboxStatus().seccomp ? ["--seccomp", String(FILTER_FD)] : []),
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", ...view.before];
  // The cache layers of the slot the command's wrapper takes: read by bubblewrap from a file of that slot (HOLD).
  const layers = view.layers && flock ? layerFiles(view.layers, perm.sandbox) : undefined;
  if (layers) b.push("--args", "8");
  // ssh's system snippets are root's, and in a user namespace they are nobody's: ssh refuses to start over one
  // ("Bad owner or permissions"). The folder is emptied, and holds the sandbox's own snippet when the network is on.
  const snippets = isDir(SSH_SNIPPETS);
  if (snippets) b.push("--tmpfs", SSH_SNIPPETS);
  // bubblewrap binds the session's folder by its name, at the moment it starts. A link that took that name between
  // the gate's look and this start (something outside a sandbox made it) would be bound in its place: the folder
  // bound is compared with the pin before the command runs, where no name can change any more.
  let prelude = root && /^\d+:\d+$/.test(root)
    ? `[ "$(stat -c %d:%i -- ${shq(workspace)} 2>/dev/null)" = ${shq(root)} ] || { echo "keel: this session's folder is not the folder the session was made in (${workspace.replace(/[^\w./ -]/g, "?")} leads somewhere else now): nothing runs in it." >&2; exit 75; }; `
    : "";
  if (perm.network) {
    const files = relayFiles(sandboxRoot());
    b.push("--ro-bind", proxyDir(scopeDir(sandboxScope(workspace))), IN_SANDBOX.net, "--ro-bind", process.execPath, IN_SANDBOX.exe, "--ro-bind", files.relay, IN_SANDBOX.relay);
    if (snippets) b.push("--ro-bind", files.ssh, join(SSH_SNIPPETS, "keel-proxy.conf"));
    prelude += RELAY_START;
  }
  // git settings for every confined command, after any the owner's
  // environment already carries (git-config(1), GIT_CONFIG_COUNT).
  const settings = [...SANDBOX_GIT];
  let own: string[];
  if (perm.sandbox === "workspace-write") {
    // The repository's hooks and config run code outside the sandbox later:
    // they stay read-only. Commits still work.
    const linked = linkedGitBinds(workspace);
    own = [held?.workspace ? "--ro-bind" : "--bind", workspace, workspace, ...cloneGitBinds(workspace), ...linked];
    for (const f of held?.refs ?? []) if (linked.length && kindOf(f) === "file") own.push(...ro(f));
    if (linked.length) settings.push(...LINKED_GIT);
    // A file of Keel's own configuration that the owner keeps inside the session's folder (KEEL_HOOKS and its kin)
    // is read-only there: Keel runs what it names, outside the sandbox. (One that is not there yet cannot be
    // closed, a bind needs the file: what a command makes of it is taken away after the call, src/safety/quarantine.ts.)
    const ws = realOf(workspace);
    for (const f of namedConfig()) if (f !== ws && contains(ws, f) && kindOf(f) === "file") own.push(...ro(f));
  } else own = ["--ro-bind", workspace, workspace];
  // The credential stores and Keel's own folders are hidden after the
  // workspace is bound: also for a session whose folder holds them. A
  // workspace inside one of Keel's own (a worktree it made) is bound again,
  // and what Keel gives the session from its own folders comes after.
  b.push(...own, ...view.masks, ...(view.again ? own : []), ...view.after);
  for (const p of scratch) b.push("--bind", p, p);
  b.push(...view.last);
  // A folder the command writes into a layer of its own, mounted last so no bind of the view covers it: what it
  // writes there is in the layer's upper folder, not in the folder.
  for (const l of over ?? []) b.push("--overlay-src", l.at, "--overlay", l.up, l.work, l.at);
  // The settings are added inside, after any the command's own environment
  // carries (git-config(1), GIT_CONFIG_COUNT): the count is the command's,
  // which only the command's own process knows.
  b.push("--", "/bin/sh", "-c", prelude + withGit(settings, view.defaults), "keel-sandbox");
  // The command takes a cache layer before the sandbox is built and holds it until its last process ends.
  return layers && flock ? ["/bin/sh", "-c", holdScript(), view.layers!.slots, flock, layers, ...b] : b;
}
// The layers' arguments and folders as two files beside the locks, the slot's number still to be put in
// (`<name>` nul-separated for bubblewrap, `<name>.dirs` a line each): written when they change.
const layerText = new Map<string, string>();
function layerFiles(l: { slots: string; args: string[]; dirs: string[] }, profile: string): string {
  const file = join(l.slots, `layers-${profile}.args`);
  const text = `${l.args.join("\0")}\0\n${l.dirs.join("\n")}\n`;
  if (layerText.get(file) !== text || !existsSync(file)) {
    let now = "";
    try { now = `${readFileSync(file, "utf8")}\n${readFileSync(`${file}.dirs`, "utf8")}`; } catch {} // not written yet
    if (now !== text) {
      mkdirSync(l.slots, { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.dirs`, `${l.dirs.join("\n")}\n`);
      writeFileSync(file, `${l.args.join("\0")}\0`);
    }
    if (layerText.size > 256) layerText.clear();
    layerText.set(file, text);
  }
  return file;
}
// The wrapper that takes a cache layer for a command: the first slot whose
// lock is free (the lock is held by the command and what it starts: file
// descriptor 9 stays open in them). bubblewrap reads the slot's layers from
// file descriptor 8.
//
// A repository has SLOTS_MAX layers, and one session holds at most
// SESSION_SHARE of them (descriptor 7: one of the session's own locks), so
// one session's commands cannot make every other session of the repository
// wait. Past its share, or with every layer held, a command waits
// SLOT_WAIT_S seconds and then ends with the sentence that says why.
//
// The layer's folders are made at every start (a test of each, a mkdir of
// one that is gone): what tends the layers, or the owner, may have removed
// them since the slot's arguments were written.
const SLOTS_MAX = 64;
const SESSION_SHARE = 16;
let SLOT_WAIT_S = 20;
// (A test waits less.)
export const setSlotWait = (seconds: number) => { SLOT_WAIT_S = seconds; forgetProfiles(); };
// (A command started for no session, a language server or an editor's MCP server, has no share: only the repository's bound.)
const holdScript = () => `d="$0"; f="$1"; t="$2"; shift 2; s="\${KEEL_SESSION:-}"; case "$s" in *[!A-Za-z0-9_-]*) s="";; esac; ` +
  `if [ -n "$s" ]; then [ -d "$d/by/$s" ] || mkdir -p "$d/by/$s"; j=0; while :; do if exec 7>"$d/by/$s/$j.lock" && "$f" -n 7; then break; fi; j=$((j+1)); ` +
  `if [ "$j" -ge ${SESSION_SHARE} ]; then exec 7>"$d/by/$s/0.lock"; "$f" -w ${SLOT_WAIT_S} 7 || { echo "keel: this session already runs ${SESSION_SHARE} sandboxed commands at once, the most one session may, and none ended in ${SLOT_WAIT_S} s. Stop one of them, or run this again when one has ended." >&2; exit 75; }; break; fi; done; fi; ` +
  `i=0; while :; do if exec 9>"$d/$i.lock" && "$f" -n 9; then break; fi; i=$((i+1)); ` +
  `if [ "$i" -ge ${SLOTS_MAX} ]; then i=0; exec 9>"$d/0.lock"; "$f" -w ${SLOT_WAIT_S} 9 || { echo "keel: ${SLOTS_MAX} sandboxed commands of this repository run at once, the most its sandbox takes, and none ended in ${SLOT_WAIT_S} s. Run this again when one has ended." >&2; exit 75; }; break; fi; done; ` +
  // The slot's own copy of the layers' arguments and folders, made again when the layers changed.
  `a="$d/$i.\${t##*/}"; if [ ! -f "$a" ] || [ ! -f "$a.dirs" ] || [ "$t" -nt "$a" ]; then sed "s/${SLOT}/$i/g" "$t.dirs" > "$a.dirs.new" && mv "$a.dirs.new" "$a.dirs" && sed "s/${SLOT}/$i/g" "$t" > "$a.new" && mv "$a.new" "$a" || exit 75; fi; ` +
  `while IFS= read -r x; do [ -d "$x" ] || mkdir -p "$x" || exit 75; done < "$a.dirs"; ` +
  `exec 8<"$a"; exec "$@"`;
