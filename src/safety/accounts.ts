// Writes with the owner's accounts, and whose namespace they land in. Pure: the gate reads the git remotes and
// package manifests of the folders a command runs in (looked.ts) and hands the answers in.
//
// The owner names his namespaces (Settings > Permissions): GitHub users and organizations, other forges' groups,
// registries' scopes and package names. A write to an account beyond them (a push to another owner's repository,
// a comment, review or release on one, a publish of a package he does not own) is his to make: it asks him in
// every mode, and an agent is refused it. Reading is not looked at.
//
// A namespace is written `HOST/OWNER[/GROUP...]` (a bare `OWNER` is on github.com), or `npm:@scope`, `npm:name`,
// `pypi:name`, `crates:name`. Host and names compare in lower case. An entry holds what is under it: `gitlab.com/g`
// holds `gitlab.com/g/sub/repo`.

export type Namespace = { kind: "forge"; host: string; path: string[] } | { kind: "package"; registry: Registry; name: string };
export type Registry = "npm" | "pypi" | "crates";
// What a command writes to: a repository (`path` is owner, group... and repository), or a package.
export type Account = { kind: "forge"; host: string; path: string[] } | { kind: "package"; registry: Registry; name: string };
// One write found in a command. `account` is null when the rules cannot tell where it lands (`why` says).
export type Write = { does: string; account: Account | null; why?: string };

const lower = (s: string) => s.toLowerCase();
const REGISTRIES: Record<string, Registry> = { npm: "npm", pypi: "pypi", pip: "pypi", crates: "crates", cargo: "crates" };

// One entry of the owner's list, or null when it names nothing the rules can match.
export function parseNamespace(entry: string): Namespace | null {
  const s = entry.trim();
  if (!s || /\s/.test(s)) return null;
  const pkg = /^([a-z]+):(.+)$/i.exec(s);
  if (pkg && REGISTRIES[lower(pkg[1]!)]) {
    const name = lower(pkg[2]!).replace(/^\/+|\/+$/g, "");
    return name && !/[*?]/.test(name) ? { kind: "package", registry: REGISTRIES[lower(pkg[1]!)]!, name } : null;
  }
  const bare = s.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const parts = bare.split("/").filter(Boolean).map(lower);
  if (!parts.length || parts.some((p) => /[*?:@]/.test(p))) return null;
  if (parts.length === 1) return /^[\w.-]+$/.test(parts[0]!) && !parts[0]!.includes(".") ? { kind: "forge", host: "github.com", path: parts } : null;
  // (`host/owner`: the first part is a host when it has a dot or the entry has more than the owner and a repository.)
  return /\./.test(parts[0]!) ? { kind: "forge", host: parts[0]!, path: parts.slice(1) } : { kind: "forge", host: "github.com", path: parts };
}

export const parseNamespaces = (list: readonly string[]): Namespace[] => list.map(parseNamespace).filter((x): x is Namespace => !!x);

// How a namespace or an account is said, on a card and to the judge.
export function say(a: Namespace | Account): string {
  return a.kind === "forge" ? `${a.host}/${a.path.join("/")}` : `${a.registry}:${a.name}`;
}

// Whether an account is under one of the owner's namespaces.
export function owned(list: readonly Namespace[], a: Account): boolean {
  return list.some((n) => {
    if (n.kind === "package") return a.kind === "package" && n.registry === a.registry && (a.name === n.name || (n.name.startsWith("@") && !n.name.includes("/") && a.name.startsWith(`${n.name}/`)));
    return a.kind === "forge" && n.host === a.host && n.path.length <= a.path.length && n.path.every((p, i) => p === a.path[i]);
  });
}

// ---- where a repository address points ----

// The host and path of a git or forge address, or null for a folder on this machine (not an account).
export function repoOf(url: string): { host: string; path: string[] } | null {
  const u = url.trim().replace(/^git\+/, "");
  if (!u) return null;
  let host: string, rest: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(u);
  if (scheme) {
    if (/^file$/i.test(scheme[1]!)) return null;
    host = scheme[2]!.replace(/^.*@/, "").replace(/:\d*$/, "");
    rest = scheme[3] ?? "";
  } else {
    // scp-like: [user@]host:path (a path with a slash before the first colon is a folder).
    const scp = /^(?:[^@/:\s]+@)?([^/:\s]+):(?!\/\/)(.*)$/.exec(u);
    if (!scp || /^[a-z]$/i.test(scp[1]!)) return null; // (a drive letter is a folder)
    host = scp[1]!;
    rest = `/${scp[2]!.replace(/^\/+/, "")}`;
  }
  host = lower(host);
  const path = rest.split(/[?#]/)[0]!.split("/").filter(Boolean).map(lower);
  if (!host || !path.length) return null;
  if (path.length) path[path.length - 1] = path[path.length - 1]!.replace(/\.git$/, "");
  return { host, path };
}

// `[HOST/]OWNER/REPO`, as gh's -R and GH_REPO say it.
function slugOf(s: string, defaultHost: string): { host: string; path: string[] } | null {
  const p = s.replace(/^https?:\/\//i, "").replace(/\.git$/, "").split("/").filter(Boolean).map(lower);
  if (p.length === 2) return { host: defaultHost, path: p };
  if (p.length >= 3 && p[0]!.includes(".")) return { host: p[0]!, path: p.slice(1) };
  return null;
}

// ---- what the disk says (looked.ts), as the rules read it ----

// A repository's remotes: each remote's push addresses, what `gh` marked as its base, and where a bare push goes.
export type Remotes = {
  push: Record<string, string[]>;
  fetch: Record<string, string>;
  resolved: Record<string, string>; // remote.NAME.gh-resolved
  pushDefault?: string;
  branch?: string;
  branchRemote?: string;
  branchPushRemote?: string;
};
export type Manifest = { npm?: string; pypi?: string; crates?: string; private?: true };
export type Answer<T> = T | null | "late";
// `remotes(dir)`, `manifest(dir)`: the answers the disk gave (null: nothing there; "late": it did not answer).
export type Env = { dir: string | null; remotes?: (dir: string) => Answer<Remotes>; manifest?: (dir: string) => Answer<Manifest>; set?: string[] };

const lateWhy = (what: string) => `the rules could not read ${what}`;

// The remote a bare `git push` goes to, as git picks it.
function pushRemote(r: Remotes): string {
  const pick = (n: string | undefined) => (n && (n in r.push || n in r.fetch) ? n : undefined);
  return pick(r.branchPushRemote) ?? pick(r.pushDefault) ?? pick(r.branchRemote) ?? "origin";
}

// The repository `gh` acts on without -R: the one marked with `gh repo set-default`, else the first remote in its order
// (upstream, github, origin, then the others).
export function ghBase(r: Remotes, host = "github.com"): { host: string; path: string[] } | null {
  const names = Object.keys(r.fetch);
  const marked = names.find((n) => r.resolved[n] === "base") ?? names.find((n) => r.resolved[n] && r.resolved[n] !== "base");
  if (marked) {
    const v = r.resolved[marked]!;
    return v === "base" ? repoOf(r.fetch[marked]!) : slugOf(v, host);
  }
  const order = ["upstream", "github", "origin"];
  const first = order.find((n) => n in r.fetch) ?? [...names].sort()[0];
  return first ? repoOf(r.fetch[first]!) : null;
}

const shown = (a: { host: string; path: string[] }): Account => ({ kind: "forge", host: a.host, path: a.path });
const dynamic = (w: string) => /[$`*?{}]|^~/.test(w);

// ---- the commands ----

// git push [options] [REMOTE-or-URL] [refspecs]: the addresses it writes to.
function gitPush(args: string[], env: Env): Write[] {
  const does = "git push";
  const pos: string[] = [];
  let repo: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") { pos.push(...args.slice(i + 1)); break; }
    if (a === "--repo") { repo = args[++i]; continue; }
    if (a.startsWith("--repo=")) { repo = a.slice(7); continue; }
    if (a === "-o" || a === "--push-option" || a === "--receive-pack" || a === "--exec") { i++; continue; }
    if (a.startsWith("-") && a !== "-") continue;
    pos.push(a);
  }
  const target = repo ?? pos[0];
  if (target !== undefined && dynamic(target)) return [{ does, account: null, why: `the remote ${target.slice(0, 80)} is spelled with an expansion` }];
  // An address the command spells out.
  if (target !== undefined) {
    const spelled = repoOf(target);
    if (spelled) return [{ does, account: shown(spelled) }];
    // Not an address: a configured remote's name, or a folder.
    if (/^[\w.-]+$/.test(target) && !/^\.{1,2}$/.test(target)) return viaRemote(does, target, env);
    return [];
  }
  return viaRemote(does, null, env);
}

const nowhere = (does: string): Write[] => [{ does, account: null, why: "the folder it runs in is not known to the rules (a cd they cannot follow)" }];

function viaRemote(does: string, name: string | null, env: Env): Write[] {
  if (!env.remotes) return [];
  if (env.dir === null) return nowhere(does);
  const r = env.remotes(env.dir);
  if (r === "late") return [{ does, account: null, why: lateWhy("where the remote points") }];
  if (r === null) return [];
  const remote = name ?? pushRemote(r);
  const urls = r.push[remote] ?? (r.fetch[remote] ? [r.fetch[remote]!] : []);
  if (!urls.length) return [];
  return urls.flatMap((u) => { const a = repoOf(u); return a ? [{ does, account: shown(a) }] : []; });
}

// gh: the group, the verb, and the writes among them.
const GH_WRITES: Record<string, string[]> = {
  pr: ["create", "comment", "review", "merge", "close", "reopen", "edit", "ready", "lock", "unlock", "update-branch", "revert"],
  issue: ["create", "comment", "close", "reopen", "edit", "delete", "lock", "unlock", "pin", "unpin", "transfer", "develop"],
  release: ["create", "delete", "edit", "upload", "delete-asset"],
  repo: ["create", "delete", "edit", "rename", "archive", "unarchive", "sync", "deploy-key"],
  label: ["create", "edit", "delete", "clone"],
  workflow: ["run", "enable", "disable"],
  run: ["rerun", "cancel", "delete"],
  secret: ["set", "delete", "remove"],
  variable: ["set", "delete", "remove"],
  cache: ["delete"],
};
// The options that take a value in the next word (the rest are flags), for finding the operands.
const GH_VALUED = /^(-R|--repo|-t|--title|-b|--body|-F|--body-file|-B|--base|-H|--head|-a|--assignee|-l|--label|-m|--milestone|-p|--project|-r|--reviewer|--target|--notes-file|-n|--notes|--discussion-category|--notes-start-tag|-e|--env|--org|--body-env|-f|--field|--raw-field|-X|--method|-q|--jq|-t|--template|--hostname|-H|--header|--input|--cache|-d|--delete-branch|--subject|--match-head-commit|--add-reviewer|--add-label|--remove-label|--add-assignee|--add-project|--add-milestone|--remote-url)$/;

function ghTarget(args: string[], env: Env, set: string[]): { account?: Account | null; why?: string; none?: true } {
  const host = lower(set.find((s) => s.startsWith("GH_HOST="))?.slice(8) ?? "github.com");
  let repo: string | undefined = set.find((s) => s.startsWith("GH_REPO="))?.slice(8);
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-R" || a === "--repo") { repo = args[++i]; continue; }
    if (a.startsWith("--repo=")) { repo = a.slice(7); continue; }
    if (/^-R./.test(a)) { repo = a.slice(2); continue; }
    if (a.startsWith("-")) { if (!a.includes("=") && GH_VALUED.test(a)) i++; continue; }
    operands.push(a);
  }
  // A pull request or issue given by its address is in the repository the address names.
  for (const o of operands) {
    const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/(?:pull|issues)\/\d+/i.exec(o);
    if (m) return { account: shown({ host: lower(m[1]!), path: [lower(m[2]!), lower(m[3]!)] }) };
  }
  if (repo !== undefined) {
    if (dynamic(repo)) return { account: null, why: `the repository ${repo.slice(0, 80)} is spelled with an expansion` };
    const s = slugOf(repo, host);
    return s ? { account: shown(s) } : { account: null, why: `the repository ${repo.slice(0, 80)} is not in a form the rules read` };
  }
  return { none: true };
}

function gh(words: string[], env: Env, set: string[]): Write[] {
  const group = words[1] ?? "", verb = words.slice(2).find((a) => !a.startsWith("-")) ?? "";
  const rest = words.slice(2);
  if (group === "api") return ghApi(rest, env, set);
  const writes = GH_WRITES[group];
  if (!writes?.includes(verb) && !(group === "repo" && verb === "fork" && rest.some((a) => /^--org(=|$)/.test(a)))) return [];
  const does = `gh ${group} ${verb}`;
  const args = rest.slice(rest.indexOf(verb) + 1);
  // gh repo create OWNER/NAME names the owner; a bare name is under the account gh is signed in as.
  if (group === "repo" && (verb === "create" || verb === "delete" || verb === "rename" || verb === "archive" || verb === "unarchive" || verb === "edit" || verb === "sync" || verb === "deploy-key")) {
    const named = args.find((a) => !a.startsWith("-"));
    if (named && /\//.test(named)) { const s = slugOf(named, "github.com"); if (s) return [{ does, account: shown(s) }]; }
    if (verb === "create" && !named) return [];
    if (verb === "create" && named) return args.some((a) => /^--(team|org)/.test(a)) ? [{ does, account: null, why: "it creates the repository under an organization or team the rules do not read" }] : [];
  }
  if (group === "repo" && verb === "fork") {
    const org = args.find((a, i) => /^--org=/.test(a) || args[i - 1] === "--org");
    return org ? [{ does, account: { kind: "forge", host: "github.com", path: [lower(org.replace(/^--org=/, ""))] } }] : [];
  }
  const t = ghTarget(args, env, set);
  if ("account" in t) return t.account ? [{ does, account: t.account }] : [{ does, account: null, why: t.why }];
  // No repository named: the one gh acts on in the folder.
  if (!env.remotes) return [];
  if (env.dir === null) return nowhere(does);
  const r = env.remotes(env.dir);
  if (r === "late") return [{ does, account: null, why: lateWhy("the repository gh acts on") }];
  if (r === null) return [];
  const base = ghBase(r, lower(set.find((s) => s.startsWith("GH_HOST="))?.slice(8) ?? "github.com"));
  return base ? [{ does, account: shown(base) }] : [];
}

// gh api: a request that is not a read, to a repository, an organization or a mutation.
function ghApi(args: string[], env: Env, set: string[]): Write[] {
  const does = "gh api";
  let method = "", fields = false, path: string | undefined, host = lower(set.find((s) => s.startsWith("GH_HOST="))?.slice(8) ?? "github.com");
  const text: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-X" || a === "--method") { method = (args[++i] ?? "").toUpperCase(); continue; }
    if (a.startsWith("--method=")) { method = a.slice(9).toUpperCase(); continue; }
    if (/^-X./.test(a)) { method = a.slice(2).toUpperCase(); continue; }
    if (a === "--hostname") { host = lower(args[++i] ?? host); continue; }
    if (a === "-f" || a === "-F" || a === "--field" || a === "--raw-field" || a === "--input") { fields = true; text.push(args[++i] ?? ""); continue; }
    if (/^(-f|-F).+/.test(a) || /^--(field|raw-field|input)=/.test(a)) { fields = true; text.push(a); continue; }
    if (a.startsWith("-")) { if (!a.includes("=") && /^(-H|--header|-q|--jq|-t|--template|--cache|-p|--preview)$/.test(a)) i++; continue; }
    if (path === undefined) path = a;
  }
  const writes = method ? !/^(GET|HEAD)$/.test(method) : fields;
  if (!writes && !(path === "graphql" && text.some((t) => /mutation/i.test(t)))) return [];
  if (path === undefined) return [];
  if (path === "graphql") return text.some((t) => /mutation/i.test(t)) ? [{ does, account: null, why: "a GraphQL mutation names no repository the rules read" }] : [];
  if (dynamic(path)) return [{ does, account: null, why: "the request address is spelled with an expansion" }];
  const p = path.replace(/^\/+/, "").split("?")[0]!.split("/").filter(Boolean).map(lower);
  if (p[0] === "repos" && p.length >= 3) return [{ does, account: { kind: "forge", host, path: [p[1]!, p[2]!] } }];
  if ((p[0] === "orgs" || p[0] === "users") && p[1]) return p[0] === "users" && p.length <= 2 ? [] : [{ does, account: { kind: "forge", host, path: [p[1]!] } }];
  if (p[0] === "user" || p[0] === "gists" || p[0] === "notifications") return []; // the signed-in account itself
  return [{ does, account: null, why: `the request ${path.slice(0, 80)} is not in a form the rules read` }];
}

// glab (GitLab's own CLI): -R [HOST/]GROUP/PROJECT.
function glab(words: string[], env: Env): Write[] {
  const group = words[1] ?? "", verb = words[2] ?? "";
  if (!/^(mr|issue|release|repo|label|ci|variable)$/.test(group) || !/^(create|note|merge|close|reopen|update|delete|approve|unapprove|subscribe|rebase|set|run|retry|cancel|archive|transfer)$/.test(verb)) return [];
  const does = `glab ${group} ${verb}`;
  const args = words.slice(3);
  const i = args.findIndex((a) => a === "-R" || a === "--repo" || a.startsWith("--repo="));
  const repo = i < 0 ? undefined : args[i]!.startsWith("--repo=") ? args[i]!.slice(7) : args[i + 1];
  if (repo !== undefined) {
    const s = slugOf(repo.includes("/") && !repo.split("/")[0]!.includes(".") ? `gitlab.com/${repo}` : repo, "gitlab.com");
    return s ? [{ does, account: shown(s) }] : [{ does, account: null, why: `the project ${repo.slice(0, 80)} is not in a form the rules read` }];
  }
  if (!env.remotes) return [];
  if (env.dir === null) return nowhere(does);
  const r = env.remotes(env.dir);
  if (r === "late") return [{ does, account: null, why: lateWhy("the project glab acts on") }];
  const base = r ? ghBase(r, "gitlab.com") : null;
  return base ? [{ does, account: shown(base) }] : [];
}

// Publishes and the changes to a package's owners and versions.
function publish(words: string[], env: Env): Write[] {
  const prog = words[0]!.slice(words[0]!.lastIndexOf("/") + 1);
  const verb = words.slice(1).find((a) => !a.startsWith("-")) ?? "";
  const args = words.slice(1);
  const operands = (from: string) => { const k = args.indexOf(from); return args.slice(k + 1).filter((a, j, all) => !a.startsWith("-") && !/^(--tag|--otp|--access|--registry|--tolerate-republish)$/.test(all[j - 1] ?? "")); };
  const here = (registry: Registry, does: string, pick: (m: Manifest) => string | undefined): Write[] => {
    if (!env.manifest) return [];
    if (env.dir === null) return nowhere(does);
    const m = env.manifest(env.dir);
    if (m === "late") return [{ does, account: null, why: lateWhy("the package's manifest") }];
    if (m === null) return []; // (no manifest in the folder: there is no package to publish)
    const name = pick(m);
    return name ? [{ does, account: { kind: "package", registry, name: lower(name) } }] : [{ does, account: null, why: "its manifest does not name the package" }];
  };
  if (prog === "npm" || prog === "pnpm" || prog === "yarn" || prog === "bun" || prog === "npx") {
    if (verb === "publish") {
      const ops = operands("publish").filter((o) => !/^\.{0,2}\/?$/.test(o));
      if (ops.length) return [{ does: `${prog} publish`, account: null, why: `it publishes ${ops[0]!.slice(0, 80)}, a folder or archive whose package the rules do not read` }];
      return here("npm", `${prog} publish`, (m) => m.npm);
    }
    if (prog === "npm" && /^(unpublish|deprecate|dist-tag|owner|access)$/.test(verb)) {
      const ops = operands(verb).filter((o) => !/^(add|rm|remove|ls|list|set|get|grant|revoke|public|restricted|2fa-required|2fa-not-required)$/.test(o));
      const spec = ops.find((o) => /^@?[\w][\w.-]*(\/[\w.-]+)?(@[^/]*)?$/.test(o) && !/^(add|rm)$/.test(o));
      if (/^(ls|list|get)$/.test(operands(verb)[0] ?? "") || (verb === "dist-tag" && /^(ls|list)$/.test(operands(verb)[0] ?? ""))) return [];
      if (!spec) return here("npm", `npm ${verb}`, (m) => m.npm);
      const name = spec.replace(/^(@[^/@]+\/[^@]+|[^@]+)@.*$/, "$1");
      return [{ does: `npm ${verb}`, account: { kind: "package", registry: "npm", name: lower(name) } }];
    }
    return [];
  }
  if (prog === "cargo") {
    if (verb !== "publish" && verb !== "yank" && verb !== "owner") return [];
    const p = args.findIndex((a) => a === "-p" || a === "--package");
    const named = p >= 0 ? args[p + 1] : args.find((a) => a.startsWith("--package="))?.slice(10);
    if (named) return [{ does: `cargo ${verb}`, account: { kind: "package", registry: "crates", name: lower(named) } }];
    if (args.some((a) => /^--manifest-path/.test(a))) return [{ does: `cargo ${verb}`, account: null, why: "it names a manifest of its own" }];
    return here("crates", `cargo ${verb}`, (m) => m.crates);
  }
  if (prog === "twine" || prog === "uv" || /^python/.test(prog) || prog === "poetry" || prog === "flit" || prog === "hatch" || prog === "maturin") {
    const t = prog === "twine" ? verb === "upload" : prog === "uv" ? verb === "publish" : prog === "poetry" || prog === "hatch" || prog === "flit" || prog === "maturin" ? verb === "publish" : args.some((a, i) => a === "twine" && /^upload$/.test(args[i + 1] ?? ""));
    if (!t) return [];
    return here("pypi", `${prog === "uv" || prog === "twine" ? prog : prog} ${prog === "twine" ? "upload" : "publish"}`, (m) => m.pypi);
  }
  if (prog === "docker" || prog === "podman" || prog === "buildah") {
    if (verb !== "push") return [];
    const ref = operands("push")[0];
    if (!ref) return [];
    if (dynamic(ref)) return [{ does: `${prog} push`, account: null, why: "the image name is spelled with an expansion" }];
    const parts = ref.replace(/:[^/:]*$/, "").replace(/@.*$/, "").split("/").map(lower);
    const hosted = parts.length > 1 && (parts[0]!.includes(".") || parts[0]!.includes(":") || parts[0] === "localhost");
    if (hosted && /^(localhost|127\.|\[::1\])/.test(parts[0]!)) return [];
    if (hosted) return [{ does: `${prog} push`, account: { kind: "forge", host: parts[0]!.replace(/:\d+$/, ""), path: parts.slice(1) } }];
    return [{ does: `${prog} push`, account: { kind: "forge", host: "docker.io", path: parts.length > 1 ? parts : ["library", ...parts] } }];
  }
  return [];
}

// The writes one command (its words, with what was set in front of it) makes to accounts.
export function writesOf(words: string[], env: Env): Write[] {
  const first = words[0]?.slice(words[0].lastIndexOf("/") + 1);
  if (!first) return [];
  const set = [...(env.set ?? [])];
  try {
    if (first === "git") return gitWrites(words, env);
    if (first === "gh") return gh(words, env, set);
    if (first === "glab") return glab(words, env);
    return publish(words, env);
  } catch {
    return [{ does: first, account: null, why: "the rules could not read the command" }];
  }
}

// git [-C dir] push ...: the folder of a -C is the one asked about.
function gitWrites(words: string[], env: Env): Write[] {
  let i = 1, dir = env.dir;
  while (i < words.length && words[i]!.startsWith("-")) {
    const o = words[i]!;
    if (o === "-C") { const p = words[++i]; dir = p === undefined || dynamic(p) || dir === null ? null : p.startsWith("/") ? p : `${dir}/${p}`; }
    else if (o === "-c" || o === "--git-dir" || o === "--work-tree" || o === "--namespace") i++;
    i++;
  }
  if (words[i] !== "push") return [];
  return gitPush(words.slice(i + 1), { ...env, dir });
}

// The first write in a line the owner has no namespace for, or null. `unsure`: writes the rules could not place.
export function foreign(list: readonly Namespace[], writes: Write[]): { write: Write; account: Account | null } | null {
  for (const w of writes) if (!w.account || !owned(list, w.account)) return { write: w, account: w.account };
  return null;
}

// The sentence of the card: what the command does and whose namespace it is not.
export function whyForeign(f: { write: Write; account: Account | null }, list: readonly Namespace[]): string {
  const yours = list.length ? `your namespaces are ${list.map(say).join(", ")}` : "you have named no namespaces yet (Settings > Permissions)";
  if (!f.account) return `${f.write.does}: ${f.write.why ?? "the rules cannot tell where it writes"}, so they cannot tell whether it is one of your accounts (${yours})`;
  return `${f.write.does} writes to ${say(f.account)}, which is not one of your namespaces (${yours})`;
}

// For the judge: each account write found in a line, and whether it is under the owner's namespaces.
export function accountFacts(writes: Write[], list: readonly Namespace[]): string {
  if (!writes.length) return "";
  const lines = writes.map((w) => `- ${w.does}: ${w.account ? `writes to ${say(w.account)}, ${owned(list, w.account) ? "under the owner's namespaces" : "NOT under the owner's namespaces"}` : `where it lands is unknown (${w.why ?? "not read"})`}`);
  return `Writes with the owner's accounts in this command (the owner's namespaces: ${list.length ? list.map(say).join(", ") : "none named"}):\n${lines.join("\n")}`;
}

// ---- an MCP tool that writes with an account ----

// The owners an MCP call's input names: the values of fields called owner, org, organization, namespace, group, and the
// owner part of repo, repository, full_name, project or url fields.
export function namedOwners(input: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 3 || !v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x === "string") {
        const key = lower(k);
        if (/^(owner|org|organization|namespace|group|account|workspace)$/.test(key) && /^[\w.-]{1,100}$/.test(x)) out.add(lower(x));
        else if (/^(repo|repository|full_name|project|repo_name|slug)$/.test(key) && /^[\w.-]+\/[\w.-]+$/.test(x)) out.add(lower(x.split("/")[0]!));
        else if (/^(url|html_url|repo_url|repository_url)$/.test(key)) { const r = repoOf(x); if (r) out.add(r.path[0]!); }
      } else walk(x, depth + 1);
    }
  };
  walk(input, 0);
  return [...out];
}

// Whether an owner an MCP input names is one of the owner's (on any forge): such a write is judged as any other.
export const ownsOwner = (list: readonly Namespace[], owner: string) => list.some((n) => n.kind === "forge" && n.path[0] === owner);
