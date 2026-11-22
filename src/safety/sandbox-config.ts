// The owner's settings for the sandbox: what a confined command may read
// beyond the toolchains, for every workspace and per workspace, whether a
// workspace's commands may use the SSH agent, and the names of environment
// variables a command keeps beside the ones a build needs. One file in Keel's config
// folder (sandbox.json), edited only here, through src/core/ownfile.ts: a
// session cannot read or write it (the sandbox hides the config folder, and
// an edit there is the owner's alone), and nothing in a workspace counts.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeOwnFile } from "../core/ownfile.ts";
import { contains } from "../core/paths.ts";
import { configDir } from "../providers/config.ts";
import { ownFolders, ownerHome, readPath, type ReadOpts } from "./sandbox-view.ts";

export type WorkspaceSandbox = { read?: string[]; ssh_agent?: boolean };
export type SandboxConfig = { read: string[]; env: string[]; workspaces: Record<string, WorkspaceSandbox> };

const file = () => join(configDir(), "sandbox.json");
const stamp = () => { try { const st = statSync(file(), { bigint: true }); return `${st.ino}:${st.size}:${st.mtimeNs}`; } catch { return "-"; } };
let kept: { stamp: string; config: SandboxConfig } | undefined;
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);

// The file as it is now (read again only when it changed on disk). A file
// that cannot be read as this is no settings: nothing more is readable.
export function sandboxConfig(): SandboxConfig {
  const now = stamp();
  if (kept?.stamp === now) return kept.config;
  let config: SandboxConfig = { read: [], env: [], workspaces: {} };
  try {
    const raw = JSON.parse(readFileSync(file(), "utf8"));
    const workspaces: Record<string, WorkspaceSandbox> = {};
    if (raw?.workspaces && typeof raw.workspaces === "object") for (const [k, v] of Object.entries(raw.workspaces as Record<string, any>)) {
      if (!k.startsWith("/") || !v || typeof v !== "object") continue;
      workspaces[k] = { ...(strings(v.read).length ? { read: strings(v.read) } : {}), ...(v.ssh_agent === true ? { ssh_agent: true } : {}) };
    }
    config = { read: strings(raw?.read), env: strings(raw?.env).filter((n) => ENV_NAME.test(n)), workspaces };
  } catch {} // no file yet, or not this shape
  kept = { stamp: now, config };
  return config;
}

// What the view of a workspace's commands adds to the toolchains.
export function readOptsFor(scope: string): ReadOpts {
  const c = sandboxConfig();
  const own = Object.hasOwn(c.workspaces, scope) ? c.workspaces[scope]! : {};
  return { read: [...c.read, ...(own.read ?? [])], sshAgent: own.ssh_agent === true, ...(c.env.length ? { env: c.env } : {}) };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// Folders at the top of the file system that a sandbox has as its own: the machine's are not to be listed.
const NOT_LISTED = ["/run", "/proc", "/sys", "/dev", "/tmp", "/var/run"];
const realOf = (p: string) => { try { return realpathSync(p); } catch { return p; } };

// Why an entry of a read list is not taken, or nothing when it is. Judged
// where the entry really is: a link to the home is the home.
export function refusedRead(entry: string, home = ownerHome()): string | undefined {
  const named = readPath(entry, home);
  if (!named) return `${entry} is not a folder or a file: give a full path, or one under ~`;
  const p = realOf(named);
  if (p === "/" ) return `${entry} is the whole file system`;
  if (p === home || contains(p, home)) return `${entry} would open all of the home folder: name the folders a command needs, or turn the sandbox off for the session`;
  // (A folder that holds Keel's own is taken: they are hidden inside it.)
  if (ownFolders().some((own) => contains(own, p))) return `${entry} is one of Keel's own files (sessions, its token, its settings), which no sandbox shows`;
  if (NOT_LISTED.some((d) => contains(d, p))) return `${entry} is where this machine's running programs keep their sockets and state (the session bus, the keyring, the agents): a sandbox has its own, and the machine's is not shown`;
  return undefined;
}

// A change the owner made. Returns why it was not taken, else nothing.
export function setSandboxConfig(patch: { read?: unknown; env?: unknown; workspace?: { scope?: unknown; read?: unknown; ssh_agent?: unknown } }): string | undefined {
  const cur = sandboxConfig();
  const next: SandboxConfig = { read: [...cur.read], env: [...cur.env], workspaces: { ...cur.workspaces } };
  if (patch.env !== undefined) {
    if (!Array.isArray(patch.env) || patch.env.some((x) => typeof x !== "string")) return "the variables are a list of names";
    const names = [...new Set((patch.env as string[]).map((x) => x.trim()).filter(Boolean))];
    const bad = names.find((n) => !ENV_NAME.test(n));
    if (bad) return `${bad} is not the name of an environment variable`;
    if (names.length > 64) return "at most 64 names";
    next.env = names;
  }
  const list = (v: unknown): string[] | string => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return "a read list is a list of paths";
    const out = [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))];
    if (out.length > 64) return "a read list holds 64 paths at most";
    for (const e of out) { const no = refusedRead(e); if (no) return no; }
    return out;
  };
  if (patch.read !== undefined) {
    const l = list(patch.read);
    if (typeof l === "string") return l;
    next.read = l;
  }
  if (patch.workspace) {
    const scope = patch.workspace.scope;
    if (typeof scope !== "string" || !scope.startsWith("/")) return "a workspace is named by its folder's full path";
    const own: WorkspaceSandbox = { ...(Object.hasOwn(next.workspaces, scope) ? next.workspaces[scope] : {}) };
    if (patch.workspace.read !== undefined) {
      const l = list(patch.workspace.read);
      if (typeof l === "string") return l;
      if (l.length) own.read = l; else delete own.read;
    }
    if (patch.workspace.ssh_agent !== undefined) { if (patch.workspace.ssh_agent === true) own.ssh_agent = true; else delete own.ssh_agent; }
    if (own.read?.length || own.ssh_agent) next.workspaces[scope] = own; else delete next.workspaces[scope];
  }
  writeOwnFile(file(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  kept = undefined;
  return undefined;
}
