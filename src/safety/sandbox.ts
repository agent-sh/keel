// OS confinement for shell commands: bubblewrap with a workspace-write or a
// read-only profile, the network on or off, inside a systemd user scope that
// runs at a lower CPU and IO weight (and a memory cap when one is set). When
// bwrap is missing or cannot start, sandboxing is unavailable and says why;
// a session never believes it is confined when it is not.
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

// A checkout's own config (`config.worktree` in its git directory) runs code
// as the repository's config does, when the repository turns per-worktree
// config on (sparse checkout does). It is read-only then; a missing one is
// made empty first, so a confined command cannot write it.
function worktreeConfig(common: string, own: string): string[] {
  const cfg = join(own, "config.worktree");
  try {
    if (!existsSync(cfg)) {
      if (!/^\s*worktreeconfig\s*=\s*(true|yes|on|1)\s*$/im.test(readFileSync(join(common, "config"), "utf8"))) return [];
      writeFileSync(cfg, "");
    }
    return ["--ro-bind", cfg, cfg];
  } catch {
    return [];
  }
}

// A linked worktree keeps git's files outside its folder: its own directory
// `<common>/worktrees/<name>` (index, HEAD, logs) and the repository's common
// directory (objects, refs). A commit writes both, so both are writable, and
// nothing else of the repository is: its hooks and config stay read-only (they
// run code outside the sandbox later), and so does what belongs to the other
// checkouts (the other worktrees' directories, the main checkout's HEAD,
// index and submodules).
//
// The `.git` file that names the directory is inside the writable folder, so
// a confined command can rewrite it. It is believed only when git's own
// layout confirms it: the directory is `<common>/worktrees/<name>`, its
// `gitdir` file points back at this folder, and the common directory is a
// repository. A forged pointer needs those files in a place the sandbox
// could already write, so it gains nothing.
export function linkedGitBinds(workspace: string): string[] {
  try {
    const dot = join(workspace, ".git");
    if (!statSync(dot).isFile()) return [];
    const named = /^gitdir: (.+)$/m.exec(readFileSync(dot, "utf8"))?.[1]?.trim();
    if (!named) return [];
    const own = realpathSync(resolve(workspace, named));
    const common = dirname(dirname(own));
    if (basename(dirname(own)) !== "worktrees") return [];
    if (realpathSync(resolve(own, readFileSync(join(own, "commondir"), "utf8").trim())) !== common) return [];
    const back = resolve(own, readFileSync(join(own, "gitdir"), "utf8").trim());
    if (realpathSync(dirname(back)) !== realpathSync(workspace) || basename(back) !== ".git") return [];
    if (!["HEAD", "objects", "refs"].every((p) => existsSync(join(common, p)))) return [];
    const out = ["--bind", common, common];
    for (const p of ["hooks", "config", "worktrees", "HEAD", "index", "modules"]) {
      const full = join(common, p);
      if (existsSync(full)) out.push("--ro-bind", full, full);
    }
    out.push("--bind", own, own, ...worktreeConfig(common, own));
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
    // The repository's hooks and config run code outside the sandbox later
    // (core.hooksPath, core.fsmonitor): they stay read-only. Commits still work.
    for (const p of [".git/hooks", ".git/config"]) {
      const full = join(workspace, p);
      if (existsSync(full)) b.push("--ro-bind", full, full);
    }
    if (existsSync(join(workspace, ".git/config"))) b.push(...worktreeConfig(join(workspace, ".git"), join(workspace, ".git")));
    b.push(...linkedGitBinds(workspace));
  }
  // The views the daemon's own git reads repositories through (src/core/git.ts):
  // never writable, also for a session whose folder holds Keel's state folder.
  if (perm.sandbox === "workspace-write" && existsSync(gitViewsDir())) b.push("--ro-bind", gitViewsDir(), gitViewsDir());
  for (const p of typeof scratch === "string" ? [scratch] : scratch ?? []) if (p && existsSync(p)) b.push("--bind", p, p);
  b.push("--", ...argv);
  return st.scope ? [...scopeHead(), ...scopeProps(), "--", ...b] : b;
}
