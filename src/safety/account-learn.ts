// Where the owner's namespaces are learned from: his own config, read once when he asks and shown for him to confirm.
// Nothing here is added to his list by itself.
//
//   remotes   the owner of each git remote in the repositories his sessions work in (a repository he cloned from
//             someone else counts too: that is why he confirms)
//   gh        the user gh is signed in as on each host (gh's hosts.yml, read as a file; no request is made)
//   npm       the scopes his .npmrc maps to a registry
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hostnameOf, remotesIn } from "./looked.ts";
import { parseNamespace, repoOf, say } from "./accounts.ts";

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

export async function learnNamespaces(folders: string[], home = homedir(), env: Record<string, string | undefined> = process.env): Promise<Candidate[]> {
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
  const ghDir = env.GH_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "gh");
  for (const { host, user } of ghUsers(readIf(join(ghDir, "hosts.yml")))) add(`${host}/${user}`, `gh is signed in as ${user} on ${host}`);
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
