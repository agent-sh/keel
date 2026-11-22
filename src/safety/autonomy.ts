// Full auto without waiting on the owner: what rules settle about a high-risk
// command before a judge model is asked (a narrow allow where the facts show
// the effect stays on the session's own, recoverable work), and what no judge
// and no mode lets run on its own (never allowed). Pure: the gate supplies the
// repository facts through `look`.
import { isAbsolute, resolve } from "node:path";
import { highRisk, isReadOnly, lineRisk, type Simple } from "./shell.ts";

// What the gate reads of a repository, lazily (each is one local git command,
// never the network).
export type RepoFacts = {
  root: string;
  branch: string | null;                        // the checked-out branch
  upstream: string | null;                      // its upstream, "origin/feat-x"
  remotes: Record<string, string>;              // name: URL
  defaultOf(remote: string): string | null;     // the remote's default branch, from its HEAD as last fetched
  dirty(): number | null;                       // tracked files with uncommitted changes
  untracked(): number | null;
  merged(remote: string, branch: string): boolean | null; // the remote's branch, as last fetched, is in its default branch
};
export type Look = (dir: string) => RepoFacts | null;

// A branch name that marks a shared, release or deploy line: never treated as
// a session's own work, whatever the remote's default is.
const PROTECTED = /^(main|master|trunk|develop|development|dev|default|stable|staging|production|prod|live|gh-pages|release|releases)$|^(release|releases|hotfix|production|prod|deploy)[/-]/;

// A path without the slashes that end it. No pattern: one that tries every slash as a start takes the square of a long run of them.
const unslashed = (p: string) => { let n = p.length; while (n > 0 && p[n - 1] === "/") n--; return p.slice(0, n); };
const expand = (p: string, home: string) => (p === "~" ? home : p.startsWith("~/") ? home + p.slice(1) : p.replace(/^\$\{?HOME\}?(?=\/|$)/, home));
const literal = (p: string) => !/[$`*?[\]{}]/.test(p) && !p.startsWith("~") || /^~(\/[^$`*?[\]{}]*)?$/.test(p);

// Each simple command with the directory it runs in: a top-level `cd` to a
// literal path moves it; a `cd` anywhere else (a substitution, a subshell, a
// group, a variable) leaves it unknown (null) from there on.
export function located(parts: Simple[], cwd: string, home: string): { s: Simple; dir: string | null }[] {
  let dir: string | null = cwd;
  return parts.map((s) => {
    const here = dir;
    const w = afterEnv(s.words);
    if (w[0] === "cd" || w[0] === "pushd" || w[0] === "popd") {
      const arg = w.slice(1).find((a) => !a.startsWith("-") || a === "-");
      if (s.nested || w[0] === "popd" || arg === "-" || (arg !== undefined && !literal(arg))) dir = null;
      else if (dir !== null) dir = arg === undefined ? home : resolve(dir, expand(arg, home));
      else if (arg && isAbsolute(expand(arg, home))) dir = resolve(expand(arg, home));
    }
    return { s, dir: here };
  });
}

const afterEnv = (w: string[]) => {
  let i = 0;
  while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]!)) i++;
  return w.slice(i);
};

// git's own options before the subcommand: where it runs (-C), and the rest.
export function gitCall(words: string[], dir: string | null, home: string): { dir: string | null; sub: string; args: string[] } | null {
  const w = afterEnv(words);
  if (w[0] !== "git") return null;
  let i = 1;
  let at = dir;
  while (i < w.length && w[i]!.startsWith("-")) {
    const o = w[i]!;
    if (o === "-C") { const p = w[++i]; at = p === undefined || !literal(p) || at === null ? null : resolve(at, expand(p, home)); }
    else if (o === "-c" || o === "--git-dir" || o === "--work-tree" || o === "--namespace") return null; // judged, never settled by a rule
    else if (o.startsWith("--git-dir=") || o.startsWith("--work-tree=") || o.startsWith("--exec-path")) return null;
    i++;
  }
  const sub = w[i];
  return sub ? { dir: at, sub, args: w.slice(i + 1) } : null;
}

export type Update = { dst: string; branch: boolean; force: boolean; delete: boolean };
export type PushPlan = { remote: string; known: boolean; updates: Update[]; wide?: string };

// What `git push ARGS` would change on the remote, from its arguments and the
// repository's branch and upstream. null: a form the rules do not read.
export function pushPlan(args: string[], f: Pick<RepoFacts, "branch" | "upstream" | "remotes">): PushPlan | null {
  let force = false;
  let del = false;
  let wide: string | undefined;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") { pos.push(...args.slice(i + 1)); break; }
    if (!a.startsWith("-") || a === "-") { pos.push(a); continue; }
    if (a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || a === "--force-if-includes") force ||= a !== "--force-if-includes";
    else if (a === "-d" || a === "--delete") del = true;
    else if (a === "--mirror" || a === "--all" || a === "--branches" || a === "--tags" || a === "--prune") wide = a;
    else if (a === "-o" || a === "--push-option" || a === "--repo" || a === "--receive-pack" || a === "--exec") { if (a !== "-o" && a !== "--push-option") return null; i++; }
    else if (/^-[qvnuf]+$/.test(a)) { if (a.includes("f")) force = true; }
    else if (/^--(quiet|verbose|dry-run|set-upstream|no-verify|verify|progress|no-progress|atomic|no-atomic|porcelain|follow-tags|no-follow-tags|thin|no-thin|signed|no-signed|ipv4|ipv6|push-option=.*|recurse-submodules=(check|on-demand|no))$/.test(a)) {}
    else return null;
  }
  const upRemote = f.upstream ? Object.keys(f.remotes).find((r) => f.upstream!.startsWith(`${r}/`)) : undefined;
  const remote = pos[0] ?? upRemote ?? "origin";
  const known = remote in f.remotes;
  let specs = pos.slice(1);
  if (!specs.length) {
    if (wide) return { remote, known, updates: [], wide };
    if (!f.branch) return null;
    const up = f.upstream && upRemote === remote ? f.upstream.slice(remote.length + 1) : f.branch;
    specs = [`${f.branch}:${up}`];
  }
  const updates: Update[] = [];
  for (const raw of specs) {
    const plus = raw.startsWith("+");
    const spec = plus ? raw.slice(1) : raw;
    const c = spec.indexOf(":");
    let src = c < 0 ? spec : spec.slice(0, c);
    let dst = c < 0 ? (del ? spec : "") : spec.slice(c + 1);
    const deleting = del || (c === 0);
    if (del && c > 0) return null;
    if (!deleting && !dst) {
      // `git push r NAME` updates NAME on the remote; HEAD is the current branch.
      if (src === "HEAD") src = f.branch ?? "";
      if (!src) return null;
      if (src.startsWith("refs/")) { if (!src.startsWith("refs/heads/")) return null; }
      else if (Object.keys(f.remotes).some((r) => src.startsWith(`${r}/`)) || /^[0-9a-f]{7,40}$/.test(src) || /[~^@]/.test(src)) return null;
      dst = src;
    }
    if (!dst || dst.includes("*")) return null;
    const branch = !dst.startsWith("refs/") || dst.startsWith("refs/heads/");
    updates.push({ dst: dst.replace(/^refs\/heads\//, ""), branch, force: !deleting && (force || plus), delete: deleting });
  }
  return { remote, known, updates, wide };
}

export const protectedBranch = (name: string, remoteDefault: string | null) => name === remoteDefault || PROTECTED.test(name);

// A high-risk command the rules allow without a judge, with why; null when
// the judge decides. Every high-risk part of the line must be covered.
export function preAllow(command: Simple[], cwd: string, home: string, look: Look): string | null {
  if (lineRisk(command)) return null;
  const parts = located(command, cwd, home);
  const why: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const { s, dir } = parts[i]!;
    if (!highRisk(s)) continue;
    const g = gitCall(s.words, dir, home);
    if (!g || !g.dir) return null;
    const f = look(g.dir);
    if (!f) return null;
    if (g.sub === "push") {
      const plan = pushPlan(g.args, f);
      if (!plan || plan.wide || !plan.updates.length) return null;
      const def = plan.known ? f.defaultOf(plan.remote) : null;
      for (const u of plan.updates) {
        if (!u.force && !u.delete) continue;
        if (!u.branch || protectedBranch(u.dst, def)) return null;
        // A delete only of a branch the remote's default branch already holds.
        if (u.delete && !(plan.known && def && f.merged(plan.remote, u.dst) === true)) return null;
      }
      const forced = plan.updates.filter((u) => u.force).map((u) => u.dst);
      const gone = plan.updates.filter((u) => u.delete).map((u) => u.dst);
      if (forced.length) why.push(`force-pushes ${forced.join(", ")}, not the remote's default or a release branch`);
      if (gone.length) why.push(`deletes ${gone.join(", ")} on the remote, already merged into ${def}`);
      continue;
    }
    // Discarding local changes when there are none: only when nothing before
    // it on the line could have made some.
    const earlier = parts.slice(0, i).every((p) => isReadOnly(p.s) || afterEnv(p.s.words)[0] === "cd");
    const discard = (g.sub === "reset" && g.args.includes("--hard")) || g.sub === "checkout" || g.sub === "restore";
    if (discard && earlier && f.dirty() === 0) { why.push(`${g.sub} has no uncommitted change to discard`); continue; }
    if (g.sub === "clean" && earlier && !g.args.some((a) => /^-[a-zA-Z]*[xX]/.test(a)) && f.untracked() === 0) { why.push("clean has no untracked file to delete"); continue; }
    return null;
  }
  return why.length ? `The command ${why.join("; ")}.` : null;
}

// System and home roots: a recursive delete of one, or of what contains one, is never run on its own.
const ROOTS = ["/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64", "/opt", "/proc", "/root", "/sbin", "/srv", "/sys", "/usr", "/var", "/Users", "/System", "/Library", "/Applications"];

// Where a credential lives (private keys, tokens, cloud and registry logins, the keyring).
export const CRED_PATH = /(^|[\s'"=@:/])(?:~|\$\{?HOME\}?|\/home\/[^/\s]+|\/Users\/[^/\s]+|\/root)?\/?\.(?:ssh(?![^\s'"]{0,300}\.pub\b)(?:\/[^\s'"]*)?(?=$|[\s'"])|aws\/credentials|aws\/config|netrc|git-credentials|docker\/config\.json|kube\/config|config\/gh\/hosts\.yml|npmrc|pypirc|gnupg\b[^\s'"]*|config\/gcloud[^\s'"]*|azure[^\s'"]*|password-store[^\s'"]*)|\/etc\/(shadow|gshadow|sudoers)\b|\bid_(rsa|ed25519|ecdsa|dsa)\b(?!\.pub)/;
const CRED_PROGRAM = /^(secret-tool|security|pass|gpg|keyring|op|bw|vault|aws-vault)$/;
const KEY_USERS = new Set(["ssh", "scp", "sftp", "rsync", "ssh-add", "ssh-keygen", "ssh-copy-id", "git", "chmod", "chown", "ls", "stat", "test", "["]);
const INTERPRETERS = /^(python3?|node|perl|ruby|bun|deno|php)$/;
const SENDERS = new Set(["curl", "wget", "nc", "ncat", "netcat", "socat", "scp", "sftp", "ftp", "telnet", "ssh", "rsync", "mail", "mailx", "sendmail", "mutt", "http", "https", "xh"]);

// Why a command is never run without the owner, in any mode, whatever a judge
// says: destroying the machine's or the home's data, or sending credentials out.
export function neverAllowed(command: Simple[], cwd: string, home: string): string | null {
  const parts = located(command, cwd, home);
  const homeAndUp = (p: string) => p === home || home.startsWith(p.endsWith("/") ? p : p + "/") || ROOTS.includes(p) || [home + "/.ssh", home + "/.gnupg"].includes(p);
  let reads = false;
  let sends = false;
  for (const { s, dir } of parts) {
    const w = afterEnv(s.words);
    const [prog, ...args] = w;
    // A credential file read through a redirect, whatever reads it (a loop's `done < file` has no command word).
    if (s.inputs?.some((t) => CRED_PATH.test(t))) reads = true;
    if (!prog) continue;
    const run = prog === "sudo" || prog === "doas" ? sudoBody(args) : w;
    const [p, ...a] = run;
    if (p === "rm" || p === "shred") {
      const recursive = a.some((x) => /^-[a-zA-Z]*[rR]/.test(x) || x === "--recursive") || p === "shred";
      if (a.includes("--no-preserve-root")) return "deletes the root directory";
      for (const t of a.filter((x) => !x.startsWith("-"))) {
        const e = expand(unslashed(t.endsWith("/*") ? t.slice(0, -2) : t) || "/", home);
        if (/[$`]/.test(e)) continue;
        const abs = isAbsolute(e) ? resolve(e) : dir ? resolve(dir, e) : null;
        if (recursive && abs && homeAndUp(abs)) return `deletes ${abs === home ? "the home directory" : abs} recursively`;
      }
    }
    if (p && (/^mkfs/.test(p) || p === "wipefs" || p === "fdisk" || p === "sfdisk" || p === "parted" || p === "sgdisk")) return "formats or repartitions a disk";
    if (p === "dd" && a.some((x) => /^of=\/dev\/(?!(null|stdout|stderr)$)/.test(x))) return "writes a raw device";
    if ((p === "chmod" || p === "chown") && a.some((x) => /^-[a-zA-Z]*R/.test(x)) && a.some((x) => { const e = expand(unslashed(x) || "/", home); return isAbsolute(e) && homeAndUp(resolve(e)); }))
      return "changes ownership or modes of a whole system or home tree";
    if (p && SENDERS.has(p)) sends = true;
    // Code given to an interpreter on the command line that talks to the network.
    if (p && INTERPRETERS.test(p) && a.some((x) => /https?:\/\/|\bsocket\b|urlopen|requests\.(post|put)|fetch\(/.test(x))) sends = true;
    if (s.text.includes("/dev/tcp/") || s.text.includes("/dev/udp/")) sends = true;
    if (p && CRED_PROGRAM.test(p)) reads = true;
    if (p === "gh" && a[0] === "auth" && a[1] === "token") reads = true;
    if ((p === "printenv" || p === "env") && a.length === 0) reads = true;
    // A credential file read or sent (an ssh key given to ssh as its identity is not).
    if (p && !KEY_USERS.has(p) && w.slice(1).some((x) => CRED_PATH.test(x))) reads = true;
  }
  if (reads && sends) return "reads credentials and sends data over the network";
  return null;
}

// The command sudo runs, past its own options.
function sudoBody(args: string[]): string[] {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += /^-[ugCDhprT]$/.test(args[i]!) ? 2 : 1;
  return args.slice(i);
}

// The same check on a command the parser could not split: the plainest forms only.
export function neverAllowedText(command: string, home: string): string | null {
  const t = command.replace(/\\\n/g, " ");
  const h = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // rm, its options, then a root or the home. The options are taken as words and looked at afterwards: a pattern
  // that looked for the r inside them could match the same letters two ways, and take the square of a long word.
  const rm = new RegExp(`(?:^|[;&|(\\s])(?:sudo\\s+)?rm\\s+((?:-\\S+\\s+)+)(?:"|')?(?:/|/\\*|~/?|~/\\*|\\$\\{?HOME\\}?/?|${h}/?)(?:"|')?(?:\\s|$|;|&)`, "g");
  for (const m of t.matchAll(rm))
    if (m[1]!.split(/\s+/).some((o) => o === "--recursive" || (/^-[a-zA-Z]+$/.test(o) && /[rR]/.test(o)))) return "deletes a root or home directory recursively";
  if (/(^|[;&|\s])(sudo\s+)?(mkfs[.\w]*|wipefs|fdisk|sfdisk|parted)\s/.test(t)) return "formats or repartitions a disk";
  // dd with a device as its output, looked for in each command of the line apart.
  for (const part of t.split(/[;&|]/)) if (/(^|\s)dd\s/.test(part) && /of=\/dev\/(?!(null|stdout|stderr)\b)/.test(part)) return "writes a raw device";
  return null;
}
