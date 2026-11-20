// The repository facts the full-auto rules and judge read: local git commands
// only (never the network), each bounded, read when first asked and kept a few
// seconds for the calls of one line.
import { existsSync } from "node:fs";
import { contains } from "../core/paths.ts";
import type { Session } from "../core/types.ts";
import { gitCall, located, protectedBranch, pushPlan, type RepoFacts } from "./autonomy.ts";
import { highRisk, lineRisk, splitCommand } from "./shell.ts";

const KEEP_MS = 5_000;
const cache = new Map<string, { at: number; f: RepoFacts | null }>();

function git(dir: string, ...args: string[]): { ok: boolean; code: number; out: string } {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore", timeout: 3_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
  return { ok: r.success, code: r.exitCode ?? -1, out: r.stdout.toString().trim() };
}

export function lookRepo(dir: string): RepoFacts | null {
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.f;
  const f = read(dir);
  cache.set(dir, { at: Date.now(), f });
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  return f;
}

function read(dir: string): RepoFacts | null {
  if (!existsSync(dir)) return null;
  const top = git(dir, "rev-parse", "--show-toplevel");
  if (!top.ok || !top.out) return null;
  const branch = git(dir, "symbolic-ref", "-q", "--short", "HEAD");
  const up = git(dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  const remotes: Record<string, string> = {};
  for (const line of git(dir, "remote", "-v").out.split("\n")) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
    if (m) remotes[m[1]!] = m[2]!;
  }
  const defaults = new Map<string, string | null>();
  let status: string[] | null | undefined;
  const lines = () => {
    if (status === undefined) {
      const s = git(dir, "status", "--porcelain=v1", "--untracked-files=normal");
      status = s.ok ? s.out.split("\n").filter(Boolean) : null;
    }
    return status;
  };
  const defaultOf = (remote: string): string | null => {
    if (!(remote in remotes)) return null;
    if (!defaults.has(remote)) {
      const h = git(dir, "symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`);
      defaults.set(remote, h.ok && h.out.startsWith(`${remote}/`) ? h.out.slice(remote.length + 1) : null);
    }
    return defaults.get(remote)!;
  };
  return {
    root: top.out,
    branch: branch.ok && branch.out ? branch.out : null,
    upstream: up.ok && up.out ? up.out : null,
    remotes,
    defaultOf,
    dirty: () => lines()?.filter((l) => !l.startsWith("??")).length ?? null,
    untracked: () => lines()?.filter((l) => l.startsWith("??")).length ?? null,
    merged(remote, b) {
      const def = defaultOf(remote);
      if (!def) return null;
      const r = git(dir, "merge-base", "--is-ancestor", `refs/remotes/${remote}/${b}`, `refs/remotes/${remote}/${def}`);
      return r.code === 0 ? true : r.code === 1 ? false : null;
    },
  };
}

// When a local branch was created, from its reflog (null when it has none).
export function branchCreated(dir: string, b: string): number | null {
  const r = git(dir, "reflog", "show", "--date=unix", "--format=%gd %gs", `refs/heads/${b}`);
  const last = r.ok ? r.out.split("\n").filter(Boolean).at(-1) : undefined;
  const m = last?.match(/@\{(\d+)\} branch: Created/);
  return m ? Number(m[1]) * 1000 : null;
}

// The facts the judge gets about a high-risk command: where each risky part
// runs, that repository's branch, upstream, remotes and their default
// branches, uncommitted work, and for a push what it changes and whose
// branch that is. Every line is something git says locally, never a guess.
export function repoContext(command: string, cwd: string, home: string, session: Pick<Session, "workspace" | "created">): string {
  const parts = splitCommand(command);
  if (!parts) return "The command could not be split into its parts.";
  const out: string[] = [];
  const seen = new Set<string>();
  const yes = (b: boolean | null) => (b === null ? "unknown" : b ? "yes" : "no");
  for (const { s, dir } of located(parts, cwd, home)) {
    const risk = highRisk(s);
    if (!risk) continue;
    const g = gitCall(s.words, dir, home);
    const at = g?.dir ?? dir;
    out.push(`- \`${s.text.slice(0, 300)}\` ${risk}; it runs in ${at ?? "a folder the rules cannot follow (a cd through a variable or a subshell)"}${at ? ` (inside the session folder: ${yes(contains(session.workspace, at))})` : ""}.`);
    const f = at ? lookRepo(at) : null;
    if (!at || !f) continue;
    if (!seen.has(f.root)) {
      seen.add(f.root);
      const created = f.branch ? branchCreated(f.root, f.branch) : null;
      const remotes = Object.entries(f.remotes).map(([n, u]) => `${n} ${u} (default branch ${f.defaultOf(n) ?? "unknown"})`);
      out.push(`  Repository ${f.root}: branch ${f.branch ?? "(detached)"}${f.branch ? ` (created in this session: ${created === null ? "unknown" : yes(created >= session.created)})` : ""}, upstream ${f.upstream ?? "none"}; remotes: ${remotes.join("; ") || "none"}; uncommitted: ${f.dirty() ?? "unknown"} tracked changes, ${f.untracked() ?? "unknown"} untracked files.`);
    }
    if (g?.sub === "push") {
      const plan = pushPlan(g.args, f);
      if (!plan) { out.push("  The push's arguments are in a form the rules do not read."); continue; }
      const def = plan.known ? f.defaultOf(plan.remote) : null;
      const each = plan.updates.filter((u) => u.force || u.delete).map((u) => {
        const own = u.branch ? branchCreated(f.root, u.dst) : null;
        return `${u.delete ? "delete" : "forced update"} of ${u.branch ? `branch ${u.dst}` : `ref ${u.dst}`} (the remote's default: ${def ? yes(u.dst === def) : "unknown"}; a protected name: ${yes(protectedBranch(u.dst, null))}; local branch created in this session: ${own === null ? "unknown" : yes(own >= session.created)}${u.delete && def ? `; merged into ${def}: ${yes(f.merged(plan.remote, u.dst))}` : ""})`;
      });
      out.push(`  The push goes to ${plan.known ? `remote ${plan.remote}` : `${plan.remote}, which is not a configured remote`}${plan.wide ? ` with ${plan.wide}` : ""}: ${each.join("; ") || "no forced update or delete it could read"}.`);
    }
  }
  const whole = lineRisk(parts);
  if (whole) out.push(`- The line as a whole ${whole}: a program fetches from the network and a shell or interpreter runs what it reads.`);
  return out.join("\n") || "No part of the command was found high risk by the rules.";
}
