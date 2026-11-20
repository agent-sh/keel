// OS confinement for shell commands: bubblewrap with a workspace-write or a
// read-only profile, the network on or off, inside a systemd user scope that
// runs at a lower CPU and IO weight (and a memory cap when one is set). When
// bwrap is missing or cannot start, sandboxing is unavailable and says why;
// a session never believes it is confined when it is not.
import { existsSync } from "node:fs";
import { join } from "node:path";
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
  }
  for (const p of typeof scratch === "string" ? [scratch] : scratch ?? []) if (p && existsSync(p)) b.push("--bind", p, p);
  b.push("--", ...argv);
  return st.scope ? [...scopeHead(), ...scopeProps(), "--", ...b] : b;
}
