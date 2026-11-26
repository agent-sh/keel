// Hosts of the owner's ssh configuration: every concrete `Host` alias, in file
// order, following `Include` (at most 16 levels, OpenSSH's own bound). Patterns
// (`*`, `?`, `!`) configure other hosts and are not machines. Only names are
// read; what a host resolves to is left to ssh.
import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { readText } from "../core/proc.ts";
import { ownerHome } from "../core/paths";

const MAX_DEPTH = 16;

export const plainAlias = (a: string) => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(a);

// The configuration read: the owner's, or the file KEEL_SSH_CONFIG names (a
// scratch daemon's, which includes the owner's and adds its stand-in host).
const configFile = (home: string) => process.env.KEEL_SSH_CONFIG || join(home, ".ssh", "config");
const includePath = (home: string, p: string) => p.startsWith("~/") ? join(home, p.slice(2)) : isAbsolute(p) ? p : join(home, ".ssh", p);

export function sshHosts(home = ownerHome()): string[] {
  const hosts = new Set<string>();
  const read = (file: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let text: string;
    try { if (!statSync(file).isFile()) return; text = readFileSync(file, "utf8"); } catch { return; }
    for (const [key, word] of directives(text)) {
      if (key === "host") hosts.add(word);
      else for (const f of expand(includePath(home, word))) read(f, depth + 1);
    }
  };
  read(configFile(home), 0);
  return [...hosts];
}

function* directives(text: string): Generator<["host" | "include", string]> {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^(\w+)\s*(?:=\s*|\s)\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const words = (m[2]!.match(/"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^"|"$/g, ""));
    if (key === "host") for (const w of words) { if (plainAlias(w)) yield [key, w]; }
    else if (key === "include") for (const w of words) yield [key, w];
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

const fieldsOf = (text: string) => {
  const out: Record<string, string> = {};
  for (const l of text.split("\n")) { const i = l.indexOf(" "); if (i > 0) out[l.slice(0, i)] ??= l.slice(i + 1).trim(); }
  return { user: out.user, hostname: out.hostname, port: out.port ? Number(out.port) : undefined, hostkeyalias: out.hostkeyalias && out.hostkeyalias !== "none" ? out.hostkeyalias : undefined };
};
type Resolved = ReturnType<typeof fieldsOf>;

async function resolveAlias(program: string, alias: string): Promise<Resolved> {
  const p = Bun.spawn([program, "-G", alias], { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 10_000, killSignal: "SIGKILL" });
  const [out, code] = await Promise.all([readText(p.stdout), p.exited]);
  return code === 0 ? fieldsOf(out) : fieldsOf("");
}

function grouped(hosts: string[], resolved: Resolved[]): HostGroup[] {
  const byKey = new Map<string, HostGroup & { direct?: string }>();
  hosts.forEach((a, n) => {
    const r = resolved[n]!;
    const key = `${r.user ?? ""}@${(r.hostkeyalias ?? r.hostname ?? a).toLowerCase()}`;
    const g = byKey.get(key) ?? { key, alias: a, routes: [], user: r.user, hostname: r.hostname, port: r.port };
    g.routes.push(a);
    if (!r.hostkeyalias && !g.direct && !isAddress(a)) g.direct = a;
    byKey.set(key, g);
  });
  return [...byKey.values()].map(({ direct, ...g }) => {
    const alias = direct ?? g.routes.find((r) => !isAddress(r)) ?? g.routes[0]!;
    return { ...g, alias, routes: [alias, ...g.routes.filter((r) => r !== alias)] };
  });
}
async function stampOf(home: string, file: string, program: string) {
  const hosts = new Set<string>();
  const inputs = [home, file, program];
  const read = async (path: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    let text: string;
    try { if (!(await stat(path)).isFile()) return; text = await readFile(path, "utf8"); } catch { return; }
    // An Include can change the destination even when the alias list and main file did not change.
    inputs.push(path, Bun.hash(text).toString());
    for (const [key, word] of directives(text)) {
      if (key === "host") { hosts.add(word); continue; }
      const p = includePath(home, word);
      if (!/[*?[]/.test(p)) { await read(p, depth + 1); continue; }
      const files: string[] = [];
      try {
        for await (const f of new Bun.Glob(p.slice(dirname(p).length + 1)).scan({ cwd: dirname(p), absolute: true })) files.push(f);
      } catch { continue; }
      for (const f of files.sort()) await read(f, depth + 1);
    }
  };
  await read(file, 0);
  return { hosts: [...hosts], stamp: JSON.stringify(inputs) };
}

// Cold reads join startup warmup, and changed configs wait for their own groups.
// Do not publish groups built while the files changed under `ssh -G`.
const refreshing = new Map<string, Promise<HostGroup[] | undefined>>();
export async function hostGroups(home = ownerHome()): Promise<HostGroup[]> {
  const file = configFile(home), program = sshProgram();
  for (;;) {
    const { hosts, stamp } = await stampOf(home, file, program);
    if (groupsCache?.stamp === stamp) return groupsCache.groups;
    let done = refreshing.get(stamp);
    if (!done) {
      done = Promise.all(hosts.map((a) => resolveAlias(program, a).catch(() => fieldsOf(""))))
        .then(async (resolved) => {
          if ((await stampOf(home, file, program)).stamp !== stamp) return;
          const groups = grouped(hosts, resolved);
          groupsCache = { stamp, groups };
          return groups;
        })
        .finally(() => refreshing.delete(stamp));
      refreshing.set(stamp, done);
    }
    const groups = await done;
    if (groups) return groups;
  }
}

export async function warmHostGroups(home = ownerHome()): Promise<void> { await hostGroups(home); }

export const groupOf = (groups: HostGroup[], alias: string) => groups.find((g) => g.routes.includes(alias));
