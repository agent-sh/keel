// Hosts of the owner's ssh configuration: every concrete `Host` alias, in file
// order, following `Include` (at most 16 levels, OpenSSH's own bound). Patterns
// (`*`, `?`, `!`) configure other hosts and are not machines. Only names are
// read; what a host resolves to is left to ssh.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { readText } from "../core/proc.ts";
import { homeDir } from "../core/paths";

const MAX_DEPTH = 16;

export const plainAlias = (a: string) => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(a);

// The configuration read: the owner's, or the file KEEL_SSH_CONFIG names (a
// scratch daemon's, which includes the owner's and adds its stand-in host).
const configFile = (home: string) => process.env.KEEL_SSH_CONFIG || join(home, ".ssh", "config");

export function sshHosts(home = homeDir()): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const sshDir = join(home, ".ssh");
  const read = (file: string, depth: number) => {
    if (depth > MAX_DEPTH || !existsSync(file)) return;
    let text: string;
    try { if (!statSync(file).isFile()) return; text = readFileSync(file, "utf8"); } catch { return; }
    parse(text, (alias) => { if (!seen.has(alias)) { seen.add(alias); out.push(alias); } }, (pattern) => {
      const p = pattern.startsWith("~/") ? join(home, pattern.slice(2)) : isAbsolute(pattern) ? pattern : join(sshDir, pattern);
      for (const f of expand(p)) read(f, depth + 1);
    });
  };
  read(configFile(home), 0);
  return out;
}

export function parse(text: string, host: (alias: string) => void, include: (pattern: string) => void) {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^(\w+)\s*(?:=\s*|\s)\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const words = (m[2]!.match(/"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^"|"$/g, ""));
    if (key === "host") for (const w of words) { if (!/[*?!]/.test(w) && plainAlias(w)) host(w); }
    else if (key === "include") words.forEach(include);
  }
}

function expand(p: string): string[] {
  if (!/[*?[]/.test(p)) return [p];
  try {
    return [...new Bun.Glob(p.slice(dirname(p).length + 1)).scanSync({ cwd: dirname(p), absolute: true })].sort();
  } catch {
    return [];
  }
}

// Options of the daemon's own ssh calls: no prompt, a 5 s connect, none of what
// the owner's configuration adds for interactive use (agent, shared master).
export const SSH_BASE = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ForwardAgent=no", "-o", "ControlMaster=no", "-o", "ControlPath=none"];
export const SSH_ONE_SHOT = [...SSH_BASE, "-o", "ClearAllForwardings=yes"];
export const sshProgram = () => process.env.KEEL_SSH ?? "ssh";

// Whether ssh reaches the host, with ssh's own words when it does not.
export async function sshReach(alias: string): Promise<{ ok: true; detail: string } | { ok: false; reason: string }> {
  if (!plainAlias(alias)) return { ok: false, reason: `${alias} is not a plain host alias` };
  const p = Bun.spawn([sshProgram(), ...SSH_ONE_SHOT, alias, "uname -sm"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => p.kill(), 12_000);
  const [out, err, code] = await Promise.all([readText(p.stdout), readText(p.stderr), p.exited]);
  clearTimeout(timer);
  return code === 0 ? { ok: true, detail: out.trim() } : { ok: false, reason: (err.trim().split("\n").pop() || `ssh exited ${code}`).slice(0, 300) };
}

// The hosts of the configuration grouped by the box they reach: aliases whose
// `ssh -G` gives the same user and host key name (HostKeyAlias, else HostName)
// are routes to one machine. The machine is named by the alias that names it
// directly (its HostName is the key), else the first alias that is not an
// address. `ssh -G` reads the configuration only; nothing connects.
export type HostGroup = { key: string; alias: string; routes: string[]; user?: string; hostname?: string; port?: number };

const isAddress = (a: string) => /^\d+(\.\d+){3}$/.test(a) || a.includes(":");
let groupsCache: { stamp: string; groups: HostGroup[] } | undefined;

export function resolveAlias(alias: string): { user?: string; hostname?: string; port?: number; hostkeyalias?: string } {
  const r = Bun.spawnSync([sshProgram(), "-G", alias], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const out: Record<string, string> = {};
  if (r.exitCode === 0) for (const l of r.stdout.toString().split("\n")) { const i = l.indexOf(" "); if (i > 0) out[l.slice(0, i)] ??= l.slice(i + 1).trim(); }
  return { user: out.user, hostname: out.hostname, port: out.port ? Number(out.port) : undefined, hostkeyalias: out.hostkeyalias && out.hostkeyalias !== "none" ? out.hostkeyalias : undefined };
}

export function hostGroups(home = homeDir()): HostGroup[] {
  const hosts = sshHosts(home);
  let stamp = hosts.join(",");
  try { stamp += statSync(configFile(home)).mtimeMs; } catch {}
  if (groupsCache?.stamp === stamp) return groupsCache.groups;
  const byKey = new Map<string, HostGroup & { direct?: string }>();
  for (const a of hosts) {
    const r = resolveAlias(a);
    const key = `${r.user ?? ""}@${(r.hostkeyalias ?? r.hostname ?? a).toLowerCase()}`;
    const g = byKey.get(key) ?? { key, alias: a, routes: [], user: r.user, hostname: r.hostname, port: r.port };
    g.routes.push(a);
    if (!r.hostkeyalias && !g.direct && !isAddress(a)) g.direct = a;
    byKey.set(key, g);
  }
  const groups = [...byKey.values()].map(({ direct, ...g }) => {
    const alias = direct ?? g.routes.find((r) => !isAddress(r)) ?? g.routes[0]!;
    return { ...g, alias, routes: [alias, ...g.routes.filter((r) => r !== alias)] };
  });
  groupsCache = { stamp, groups };
  return groups;
}

export const groupOf = (alias: string) => hostGroups().find((g) => g.routes.includes(alias));
