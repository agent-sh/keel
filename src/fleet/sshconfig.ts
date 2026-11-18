// Hosts of the owner's ssh configuration: every concrete `Host` alias, in file
// order, following `Include` (at most 16 levels, OpenSSH's own bound). Patterns
// (`*`, `?`, `!`) configure other hosts and are not machines. Only names are
// read; what a host resolves to is left to ssh.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const MAX_DEPTH = 16;

export const plainAlias = (a: string) => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(a);

export function sshHosts(home = homedir()): string[] {
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
  read(join(sshDir, "config"), 0);
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
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return code === 0 ? { ok: true, detail: out.trim() } : { ok: false, reason: (err.trim().split("\n").pop() || `ssh exited ${code}`).slice(0, 300) };
}
