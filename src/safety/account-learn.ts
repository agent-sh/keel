// Where the owner's namespaces are learned from: his own config, read once when he asks and shown for him to confirm.
// Nothing here is added to his list by itself.
//
//   remotes   the owner of each git remote in the repositories his sessions work in (a repository he cloned from
//             someone else counts too: that is why he confirms)
//   gh        the user gh is signed in as on each host (gh's hosts.yml, read as a file; no request is made)
//   npm       the scopes his .npmrc maps to a registry
//   GitHub    below: his login and the organizations he administers, asked of GitHub at his press
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hostnameOf, remotesIn } from "./looked.ts";
import { parseNamespace, repoOf, say } from "./accounts.ts";
import { homeDir } from "../core/paths";
import { outputOf } from "../core/proc.ts";

export type Candidate = { namespace: string; why: string; count?: number };

// The users in gh's hosts.yml: `host:` lines at the margin, each with an indented `user:` (or the users of a `users:` map).
export function ghUsers(text: string): { host: string; user: string }[] {
  const out: { host: string; user: string }[] = [];
  let host: string | undefined, inUsers = false;
  for (const line of text.split("\n")) {
    const h = /^([A-Za-z0-9.-]+):\s*$/.exec(line);
    if (h) { host = h[1]!.toLowerCase(); inUsers = false; continue; }
    if (!host) continue;
    if (/^\s+users:\s*$/.test(line)) { inUsers = true; continue; }
    const u = /^\s{4}([A-Za-z0-9][A-Za-z0-9-]*):\s*$/.exec(line);
    if (inUsers && u) { out.push({ host, user: u[1]! }); continue; }
    const one = /^\s+user:\s*([A-Za-z0-9][A-Za-z0-9-]*)\s*$/.exec(line);
    if (one) out.push({ host, user: one[1]! });
  }
  return out;
}

// The scopes a .npmrc gives a registry of their own.
export const npmScopes = (text: string): string[] => [...text.matchAll(/^\s*(@[A-Za-z0-9._-]+):registry\s*=/gm)].map((m) => m[1]!.toLowerCase());

const readIf = (path: string) => { try { return existsSync(path) ? readFileSync(path, "utf8").slice(0, 262_144) : ""; } catch { return ""; } };

// Who gh is signed in as on each host, from its hosts.yml read as a file: no request is made and no token is read.
export function ghSignedIn(home = homeDir(), env: Record<string, string | undefined> = process.env): { host: string; user: string }[] {
  const ghDir = env.GH_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "gh");
  return ghUsers(readIf(join(ghDir, "hosts.yml")));
}
// Whether a namespace is the account gh is signed in as (a personal account, not an organization): the card's press says so.
export function ghOwnLogin(namespace: string, home = homeDir(), env: Record<string, string | undefined> = process.env): boolean {
  const n = parseNamespace(namespace);
  return !!n && n.kind === "forge" && n.path.length === 1 && ghSignedIn(home, env).some((u) => u.host === n.host && u.user.toLowerCase() === n.path[0]);
}

export async function learnNamespaces(folders: string[], home = homeDir(), env: Record<string, string | undefined> = process.env): Promise<Candidate[]> {
  const found = new Map<string, Candidate>();
  const add = (namespace: string, why: string, count?: number) => {
    const n = parseNamespace(namespace);
    if (!n) return;
    const key = say(n);
    const had = found.get(key);
    if (!had) found.set(key, { namespace: key, why, ...(count ? { count } : {}) });
    else if (count) found.set(key, { ...had, count: (had.count ?? 0) + count, why: had.why.includes("remote") ? had.why : `${had.why}; ${why}` });
  };
  // gh: the user it is signed in as.
  for (const { host, user } of ghSignedIn(home, env)) add(`${host}/${user}`, `gh is signed in as ${user} on ${host}`);
  // npm: scopes with a registry of their own.
  for (const s of npmScopes(readIf(join(home, ".npmrc")))) add(`npm:${s}`, "a scope your .npmrc maps to a registry");
  // The remotes of the repositories he works in, counted by owner.
  const owners = new Map<string, number>();
  const seen = new Set<string>();
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < folders.length; i = next++) {
      const r = await remotesIn(folders[i]!);
      if (!r || r === "late") continue;
      const top = new Set<string>();
      for (const url of Object.values(r.fetch)) {
        const a = repoOf(url);
        if (!a || a.path.length < 2) continue;
        // (An ssh name of his config stands for the host it says.)
        const named = a.ssh ? await hostnameOf(a.host) : null;
        const host = named === null || named === "late" ? a.host : named;
        top.add(`${host}/${a.path[0]}`);
      }
      // (A folder inside a repository already counted through another folder of it counts once per owner.)
      const key = [...top].sort().join(" ");
      if (!key || seen.has(`${folders[i]}`)) continue;
      seen.add(`${folders[i]}`);
      for (const o of top) owners.set(o, (owners.get(o) ?? 0) + 1);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  for (const [o, n] of [...owners].sort((a, b) => b[1] - a[1]).slice(0, 40)) add(o, `a remote of ${n} of the folders your sessions work in`, n);
  return [...found.values()].sort((a, b) => Number(b.why.startsWith("gh")) - Number(a.why.startsWith("gh")) || (b.count ?? 0) - (a.count ?? 0));
}

// ---- what the owner's own GitHub sign-in says (only when he presses) ----
//
// The login `gh` is signed in as and the organizations it administers, asked of GitHub with reads only (`gh api user`,
// `gh api --paginate user/memberships/orgs`, every page of it): no write, no token read by Keel, nothing added to his
// list. It runs when the owner presses the button in Settings > Permissions, never by itself. A host is asked only when
// gh's hosts.yml lists it, and each read names its host (`--hostname`), so a GH_HOST in the environment moves none.

export type Ran = { out: string } | { error: string };
export type GhRun = (args: string[], env: Record<string, string | undefined>) => Promise<Ran>;

const GH_MS = 15_000;
// gh itself, with nothing to ask the owner and nothing sent but the read.
export const runGh: GhRun = async (args, env) => {
  try {
    const p = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...env, GH_HOST: undefined, GH_REPO: undefined, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" } });
    const timer = setTimeout(() => p.kill(), GH_MS);
    const { out, err, code } = await outputOf(p, { where: "gh api" });
    clearTimeout(timer);
    return code === 0 ? { out: out.slice(0, 1_048_576) } : { error: err.trim().split("\n")[0]?.slice(0, 160) || `gh exited with ${code}` };
  } catch {
    return { error: "gh is not installed" };
  }
};

export const ghLogin = (json: string): string | null => {
  try { const l = (JSON.parse(json) as { login?: unknown }).login; return typeof l === "string" && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(l) ? l : null; } catch { return null; }
};

// The organizations the sign-in administers: an active membership with the admin role. gh applies the filter to each
// page and prints a login a line.
export const ADMIN_ORGS = '.[] | select(.state == "active" and .role == "admin") | .organization.login';
export const ghAdminOrgs = (lines: string): string[] => lines.split("\n").map((l) => l.trim()).filter((l) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(l));

export async function learnFromGh(home = homeDir(), env: Record<string, string | undefined> = process.env, run: GhRun = runGh): Promise<{ candidates: Candidate[]; note: string }> {
  const hosts = [...new Set(ghSignedIn(home, env).map((u) => u.host))];
  if (!hosts.length) return { candidates: [], note: "gh is not signed in on this machine, so there is nothing to ask GitHub." };
  const candidates: Candidate[] = [];
  const notes: string[] = [];
  for (const host of hosts) {
    const at = ["--hostname", host];
    const who = await run(["api", ...at, "user"], env);
    if ("error" in who) { notes.push(`${host}: ${who.error}`); continue; }
    const login = ghLogin(who.out);
    if (login) candidates.push({ namespace: `${host}/${login.toLowerCase()}`, why: `the account gh is signed in as on ${host}` });
    const orgs = await run(["api", ...at, "--paginate", "user/memberships/orgs?state=active&per_page=100", "--jq", ADMIN_ORGS], env);
    if ("error" in orgs) { notes.push(`${host}: ${orgs.error}`); continue; }
    for (const o of ghAdminOrgs(orgs.out)) candidates.push({ namespace: `${host}/${o.toLowerCase()}`, why: `an organization your ${host} sign-in administers` });
  }
  const seen = new Set<string>();
  const unique = candidates.flatMap((c) => { const n = parseNamespace(c.namespace); const k = n ? say(n) : ""; if (!k || seen.has(k)) return []; seen.add(k); return [{ ...c, namespace: k }]; });
  return { candidates: unique, note: notes.join("; ") };
}
