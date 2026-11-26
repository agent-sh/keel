// An agent in a worktree Keel made for it changes its own branch, and the
// branches it makes itself, only. A branch that exists and that it did not make
// (the owner's, another agent's, one left by an agent that is gone) is not
// moved, renamed or deleted from it: the ones it made are the ones its own git
// noted (src/safety/ref-guard.ts) and the ones of the agents under it. The
// worktree shares the repository's branches with every other checkout (the
// owner's main one, other agents'), and a git command run from it can move
// one of them: `git branch -f main`, `git update-ref refs/heads/main`, `git
// push . HEAD:main`, `git checkout -B main`, a fetch into main, a rebase of
// another branch, `git symbolic-ref`, `git fast-import`, or any write in
// another checkout reached by `-C`, `cd`, `env -C`, `--git-dir`, GIT_DIR or
// core.worktree. It does not write the other object stores git reads
// (objects/info/alternates) or make a link in the shared git data either;
// what a script leaves there is set aside after the command (src/safety/plants.ts).
// Such a command is refused before it runs, in every mode,
// Full auto included; a branch reaches its base through the landing queue
// (src/landing/queue.ts), which rebases it, runs the repository's checks and
// lands it. Claude Code refuses the same for subagents isolated in a worktree
// ("commands must not rewrite what its worktree shares with the user's own
// checkout"). The owner's own sessions are not held to it.
//
// A command gate reads what a command spells out. What it cannot read (a
// script the agent wrote and runs, a program that runs git by itself) is held
// at git's own door: every git the agent's commands start carries a
// reference-transaction hook that refuses an update of a shared branch
// (src/safety/ref-guard.ts). A plain write of git's files by such a script is
// neither: what changed is said after the command (src/safety/refwatch.ts).
//
// Pure: the gate reads the checkouts from the disk (refwatch.ts checkoutsOf).
import { isAbsolute, join, resolve } from "node:path";
import { SHELL_GIT_SETTINGS } from "../core/git.ts";
import { guardEnv, PAD } from "./ref-guard.ts";
import { outputsOf } from "./outputs.ts";
import { laid } from "./risk.ts";
import { evalGiven, name, redirected, scriptsOf, shellGiven, SHELLS, type Run } from "./risk-words.ts";
import { isReadOnly, splitCommand, type Simple } from "./shell.ts";

// One stash entry: its place in the list (stash@{n}), the branch it was made on (null: its subject names none), whether
// that branch is this worktree's, and its subject.
export type Stash = { n: number; branch: string | null; mine: boolean; subject: string };

// The checkouts an agent's worktree shares its branches with.
// `root`: the agent's worktree; `gitDir`: its own git directory
// (<common>/worktrees/<name>); `branch`: its own branch; `base`: the branch it
// was made from, when that is a branch; `out`: each branch another checkout has
// out, with that checkout's folder; `folders`: every other checkout's folder;
// `gitDirs`: their git directories. `remotes`: the repository's remotes and
// their URLs, when its config was read (a name not among them is a path).
// `hosts`: the names this machine answers to over ssh. `real`: a folder with
// its links followed (the folders here are), for the one the command starts in.
export type Shared = {
  root: string; gitDir: string; common: string; branch: string; base: string | null; out: Map<string, string>; folders: string[];
  gitDirs?: string[]; remotes?: Map<string, string[]>; hosts?: string[]; real?: (p: string) => string;
  // The branches that exist, other than this worktree's own, the one it is on and the ones it made itself (or an
  // agent under it did), in small letters. They are no one's but another's: the owner's, another agent's, one
  // left by an agent that is gone. Read when a command names a branch, not before. Absent: not known.
  foreign?: () => Set<string>;
  // The repository's stash list, newest first. The list is shared by every worktree of the repository. Read when a
  // stash command names an entry. Absent: not known.
  stashes?: () => Stash[];
  // The branches an agent under this one made (each with its own worktree), for the hook's script.
  kids?: string[];
};

const within = (dir: string, p: string) => p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
// A word the shell changes before git sees it: an expansion, a pattern, or braces (`{main,x}`, `{1..3}`; a
// `HEAD@{1}` stays as it is).
const unread = (w: string) => /[$`*?[]/.test(w) || /\{[^{}]*(,|\.\.)[^{}]*\}/.test(w);
// A ref as git takes it: no doubled slashes, no `./` step.
const normRef = (w: string) => w.replace(/\/{2,}/g, "/").replace(/(^|\/)(\.\/)+/g, "$1");
// A branch as a command names it: a refspec's side, a full ref, or `heads/x`.
const branchOf = (w: string) => normRef(w.replace(/^\+/, "")).replace(/^refs\/heads\//, "").replace(/^heads\//, "");
const shq = (w: string) => (/^[A-Za-z0-9_.\/@:+,%^=-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);
const joined = (words: string[]) => words.map(shq).join(" ");

// git's options before the subcommand that take a value in the next word.
const GLOBAL_VALUED = /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env|--attr-source)$/;
type Git = { sub: string; args: string[]; c: string[]; config: [string, string | undefined][]; gitDir?: string; workTree?: string };
function gitOf(words: string[]): Git | null {
  const c: string[] = [];
  const config: [string, string | undefined][] = [];
  let gitDir: string | undefined, workTree: string | undefined;
  let i = 1;
  for (; i < words.length && words[i]!.startsWith("-"); i++) {
    const w = words[i]!;
    const eq = w.indexOf("=");
    // (`-c key=value` takes the whole next word; `--git-dir=x` gives its value after the sign.)
    if (w === "-c" || w === "--config-env") {
      const kv = words[++i];
      if (kv === undefined) break;
      const at = kv.indexOf("=");
      config.push(at < 0 ? [kv, undefined] : [kv.slice(0, at), w === "-c" ? kv.slice(at + 1) : undefined]);
      continue;
    }
    // (`-ckey=value`, the attached form.)
    if (/^-c.+/.test(w)) { const kv = w.slice(2), at = kv.indexOf("="); config.push(at < 0 ? [kv, undefined] : [kv.slice(0, at), kv.slice(at + 1)]); continue; }
    if (w.startsWith("--config-env=")) { const kv = w.slice(13), e = kv.indexOf("="); config.push([e < 0 ? kv : kv.slice(0, e), undefined]); continue; }
    const key = eq > 0 ? w.slice(0, eq) : w;
    const value = eq > 0 ? w.slice(eq + 1) : GLOBAL_VALUED.test(w) ? words[i + 1] : undefined;
    if (eq < 0 && GLOBAL_VALUED.test(w)) i++;
    if (value === undefined) continue;
    if (key === "-C") c.push(value);
    else if (key === "--git-dir") gitDir = value;
    else if (key === "--work-tree") workTree = value;
  }
  if (words[i] === undefined) return null;
  // core.worktree given for the command is its work tree, as --work-tree is.
  const wt = config.findLast(([k, v]) => k.toLowerCase() === "core.worktree" && v !== undefined);
  return { sub: words[i]!, args: words.slice(i + 1), c, config, gitDir, workTree: workTree ?? wt?.[1] };
}

// The words that are not options, past the options that take a value.
function operands(args: string[], valued: RegExp): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === "--") { out.push(...args.slice(k + 1)); break; }
    if (a.startsWith("-")) { if (!a.includes("=") && valued.test(a)) k++; continue; }
    out.push(a);
  }
  return out;
}
const has = (args: string[], re: RegExp) => args.some((a) => re.test(a));
const flag = (args: string[], long: string[], letter: string) => args.some((a) => long.includes(a) || (/^-[a-zA-Z]+$/.test(a) && a.includes(letter)));
// The values of an option, as `--opt x`, `--opt=x` or `-ox` for a short one.
function valuesOf(args: string[], long: string[], short?: string): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === "--") break;
    if (long.includes(a) || a === short) { if (args[k + 1] !== undefined) out.push(args[++k]!); continue; }
    const l = long.find((o) => a.startsWith(`${o}=`));
    if (l) out.push(a.slice(l.length + 1));
    else if (short && a.startsWith(short) && a.length > short.length && !a.startsWith("--")) out.push(a.slice(short.length));
  }
  return out;
}

// Where a git command acts: the agent's own worktree, another checkout of the
// repository (its folder), a folder the command does not spell out, or
// somewhere else (another repository: not this rule's).
type Place = { at: "own" } | { at: "other"; folder: string } | { at: "unknown"; what: string } | { at: "elsewhere" };
const pathOf = (base: string | null, p: string, home: string): string | null => {
  if (unread(p)) return null;
  const x = p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p.startsWith("file://") ? p.slice(7) : p;
  return isAbsolute(x) ? resolve(x) : base === null ? null : resolve(base, x);
};
function placeOf(g: Git, dir: string | null, env: Map<string, string>, home: string, s: Shared): Place {
  let folder = dir;
  for (const c of g.c) folder = folder === null ? null : pathOf(folder, c, home);
  const gitDir = g.gitDir ?? env.get("GIT_DIR");
  const workTree = g.workTree ?? env.get("GIT_WORK_TREE");
  if (gitDir !== undefined) {
    const d = pathOf(folder, gitDir, home);
    if (d === null) return { at: "unknown", what: `a git directory the command does not spell out (${gitDir})` };
    if (within(s.gitDir, d) || within(s.root, d)) {
      if (workTree === undefined) return { at: "own" };
    } else {
      // (Another checkout's .git, or the repository's git directory: the main checkout's, or another worktree's in it.)
      for (const f of s.folders) if (d === join(f, ".git")) return { at: "other", folder: f };
      if (within(s.common, d)) return { at: "other", folder: d };
      return { at: "elsewhere" };
    }
  }
  if (workTree !== undefined) {
    const w = pathOf(folder, workTree, home);
    if (w === null) return { at: "unknown", what: `a work tree the command does not spell out (${workTree})` };
    // Another checkout's files under this worktree's git: its reset and checkout write them.
    for (const f of s.folders) if (within(f, w) && !within(s.root, w)) return { at: "other", folder: f };
    folder = gitDir !== undefined ? s.root : folder;
  }
  if (folder === null) return { at: "unknown", what: "a folder the command does not spell out" };
  // The nearest checkout that holds the folder (one checkout may sit inside another's folder).
  let best: Place = { at: "elsewhere" }, len = -1;
  if (within(s.root, folder)) { best = { at: "own" }; len = s.root.length; }
  for (const f of s.folders) if (within(f, folder) && f.length > len) { best = { at: "other", folder: f }; len = f.length; }
  if (len < 0 && within(s.common, folder)) best = { at: "other", folder: s.common };
  return best;
}

// A git setting an agent's command may not give, in any scope: what would make git run a command the rules do not
// read (an alias, an include), point it at another work tree, turn off the hook that holds the shared branches, or
// change what every checkout of the repository reads. `value`: what it is set to, when the command says.
function keyRefused(key: string, value: string | undefined, dir: string | null, home: string, s: Shared): string | null {
  const k = key.toLowerCase();
  if (k.startsWith("alias.")) return `sets the git alias ${key.slice(6)}, a command the rules cannot read`;
  if (k === "core.worktree") return "points git at another work tree (core.worktree)";
  if (k === "core.hookspath") return "changes where git finds its hooks (core.hooksPath), which also takes away the hook that keeps the shared branches where they are";
  if (k === "core.bare") return "marks the repository bare (core.bare), which every checkout of it reads";
  if (k.startsWith("include.") || k.startsWith("includeif.")) return "makes git read another config file, which the rules cannot read";
  if (k.startsWith("extensions.") || k === "core.repositoryformatversion") return `changes ${key}, which every checkout of the repository reads`;
  if (k === "receive.denycurrentbranch") return "lets a push move a branch a checkout has out (receive.denyCurrentBranch)";
  const branch = /^branch\.(.+)\.[^.]+$/.exec(key)?.[1];
  if (branch !== undefined && branch !== s.branch && sharedSet(s).has(branchOf(branch).toLowerCase())) return `changes the settings of the branch ${branch}, which this worktree shares`;
  if (/^remote\..+\.(url|pushurl)$/.test(k) && value !== undefined && dir !== null && isLocal(value, dir, home, s, true) !== false) return `points the remote ${key.slice(7, key.lastIndexOf("."))} at this repository itself`;
  return null;
}

// Settings whose value git runs as a command (git-config(1)): the value is read as a shell line.
const RUNS_COMMAND = /^(core\.(fsmonitor|pager|editor|sshcommand|askpass)|credential\.(.+\.)?helper|diff\.external|diff\..+\.(textconv|command)|tar\..+\.command|filter\..+\.(clean|smudge|process)|merge\..+\.driver|sequence\.editor|gpg\.(.+\.)?program|pager\..+|uploadpack\.packobjectshook|core\.alternaterefscommand|remote\..+\.(receivepack|uploadpack)|interactive\.difffilter)$/;
const commandOf = (value: string) => value.replace(/^!/, "");

// What `git config` writes, when it writes one of those settings.
const CONFIG_READS = /^(--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|-l|--list|--show-origin|--show-scope|--name-only)$/;
const CONFIG_WRITES = /^(--add|--replace-all|--unset|--unset-all|--rename-section|--remove-section)$/;
function configWrite(args: string[], dir: string, home: string, s: Shared): string | null {
  const p = operands(args, /^(-f|--file|--blob|--default|--type|-t|--comment|--value|--regexp|--url)$/);
  const files = valuesOf(args, ["--file"], "-f");
  // A file of another checkout's git data, by name.
  for (const f of files) {
    const at = pathOf(dir, f, home);
    if (at === null) continue;
    const what = gitStoreOf(at, s);
    if (what && at !== join(s.common, "config") && !within(s.gitDir, at)) return `writes ${what}`;
  }
  const sub = /^(set|unset|rename-section|remove-section|edit|get|list|get-regexp|get-urlmatch|get-color|get-colorbool)$/.test(p[0] ?? "") ? p.shift() : undefined;
  const section = has(args, /^--(rename|remove)-section$/) || sub === "rename-section" || sub === "remove-section";
  if (section && p[0] !== undefined) return /^(alias|include|includeif|extensions|core)(\.|$)/i.test(p[0]) ? `changes the git settings under ${p[0]}, which every checkout of the repository reads` : null;
  return null;
}

// The setting a `git config` command writes, with its value when it gives one.
function configSet(args: string[]): [string, string | undefined] | null {
  const p = operands(args, /^(-f|--file|--blob|--default|--type|-t|--comment|--value|--regexp|--url)$/);
  const sub = /^(set|unset|rename-section|remove-section|edit|get|list|get-regexp|get-urlmatch|get-color|get-colorbool)$/.test(p[0] ?? "") ? p.shift() : undefined;
  if (sub && sub !== "set" && sub !== "unset") return null;
  if (has(args, CONFIG_READS) && !has(args, CONFIG_WRITES)) return null;
  if (has(args, /^--(rename|remove)-section$/)) return null;
  const writes = sub !== undefined || has(args, CONFIG_WRITES) || p.length >= 2;
  return writes && p[0] !== undefined ? [p[0], p[1]] : null;
}

// Paths an agent may not write by itself: the repository's git directory but the objects (another checkout's HEAD
// and index, the shared refs and packed-refs, config, hooks), what in its own says what it has out and where the
// repository is, and each checkout's .git.
// `link`: the command makes a link (`ln`): none is made anywhere in the shared store.
export function gitStoreOf(p: string, s: Shared, link = false): string | null {
  const objects = join(s.common, "objects");
  if (within(objects, p)) {
    // What a command writes there by hand is a redirect: another store git reads (objects/info/alternates, http-alternates,
    // and the rest of info), or a link.
    if (link) return `${p}, where a link makes git read or write another file`;
    if (within(join(objects, "info"), p) || /(^|\/)(http-)?alternates$/.test(p)) return `${p}, which makes git in every checkout read another object store`;
    return null;
  }
  if (link && within(s.common, p)) return `${p}, where a link makes git read or write another file`;
  if (within(s.gitDir, p)) return ["HEAD", "commondir", "gitdir", PAD].some((f) => p === join(s.gitDir, f)) || p.startsWith(`${join(s.gitDir, PAD)}.`) ? `${p}, which says what this worktree has out, where its repository is and which branches its git made while a command runs` : null;
  if (within(s.common, p)) return `${p}, in the repository's git directory, which every checkout shares`;
  if (p === join(s.root, ".git")) return `${p}, which says which repository this worktree is in`;
  for (const f of s.folders) if (within(join(f, ".git"), p)) return `${p}, another checkout's git data`;
  return null;
}

// A remote that is this repository itself: `.`, a path to one of its checkouts or its git directory (relative, or
// one git reads as a path because it names no host), or a named remote whose URL is one. null: the command does not
// spell it out. `url`: a URL, not a remote's name.
function isLocal(remote: string, dir: string, home: string, s: Shared, url = false): boolean | null {
  if (remote === "." || remote === "./") return true;
  if (unread(remote)) return null;
  const urls = url ? undefined : s.remotes?.get(remote);
  if (urls) return urls.some((u) => isLocal(u, dir, home, s, true) !== false) ? true : false;
  let path = remote;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) { if (!/^file:\/\//i.test(remote)) return false; path = remote.slice(7); }
  else if (/^[^/]*:/.test(remote)) return false; // host:path, git's ssh form
  // (A name, when the remotes were not read: one, not a path.)
  else if (!url && !s.remotes && !/^(\/|\.\.?(\/|$)|~)/.test(path) && !path.includes("/") && !/\.git$/.test(path)) return false;
  const p = pathOf(dir, path, home);
  if (p === null) return null;
  return [s.root, s.common, ...s.folders].some((f) => within(f, p));
}

// The branches the worktree shares, by name in small letters (a file system that ignores case takes MAIN for main).
const sharedSet = (s: Shared) => new Set([...s.out.keys(), ...(s.base ? [s.base] : [])].filter((b) => b !== s.branch).map((b) => b.toLowerCase()));
// Those and every other branch that exists and is not this worktree's: the ones a command may not move, rename or delete.
const heldSet = (s: Shared) => new Set([...sharedSet(s), ...(s.foreign?.() ?? [])]);

// git archive only reads the repository and writes the archive to its output, so from another checkout it
// is a read, as git show is: a reviewer builds a candidate's tree with `git archive REV | tar -x -C DIR`.
// Where the archive goes is judged apart: tar's extraction target by the write rules, and git's own
// -o / --output by the check below, so only the options that name no place and run nothing are let
// through (--remote reaches another repository and --exec runs a program there; a word the shell
// expands could be either).
const ARCHIVE_OPTION = /^(--|-[0-9]+|-[lv]+|--(format|prefix|add-file|add-virtual-file|mtime)(=.*)?|--(list|verbose|worktree-attributes))$/;
// A setting given for the command is let through only when it is known to run nothing: tar.<format>.command
// is a program the archive is piped through, and any other key could be one too.
const ARCHIVE_SETTING = /^(tar\.umask|core\.(quotepath|autocrlf|eol|safecrlf|precomposeunicode))$/;
function archiveReads(g: Git): boolean {
  return g.sub === "archive" && g.config.every(([k]) => ARCHIVE_SETTING.test(k.toLowerCase())) && g.args.every((a) => !unread(a) && (!a.startsWith("-") || ARCHIVE_OPTION.test(a)));
}

// What a git command run in the agent's own worktree does to a branch it shares, if anything.
function movesShared(g: Git, dir: string, home: string, s: Shared, resolved = false): string | null {
  const shared = sharedSet(s);
  // `named`: a branch this command may not move, rename or delete. `onto`: one it may not put the worktree on
  // either, which is only what the other checkouts use (a branch left by an agent that is gone can be read).
  let held: Set<string> | undefined;
  const named = (w: string) => unread(w) || shared.has(branchOf(w).toLowerCase()) || (held ??= heldSet(s)).has(branchOf(w).toLowerCase());
  const what = (w: string) => (unread(w) ? `a branch it names with an expansion (${w})` : `the branch ${branchOf(w)}${s.out.has(branchOf(w)) ? ", which another checkout has out" : shared.has(branchOf(w).toLowerCase()) ? ", this worktree's base" : ", which this worktree did not make"}`);
  const { sub, args } = g;
  // A file the command writes by name (git log --output=FILE, diff, show, format-patch) is no place in the git data.
  // A name with an expansion is not read: it could be the pad or a ref, as it is for a branch name.
  for (const f of valuesOf(args, ["--output"])) {
    // (Beside the line written out, which judges the file by its name: there it is read.)
    if (unread(f)) { if (resolved) continue; return `writes a file it names with an expansion (${f}), which the rules cannot read (--output)`; }
    const at = pathOf(dir, f, home);
    const what = at === null ? null : gitStoreOf(at, s);
    if (what) return `writes ${what} (--output)`;
  }
  if (sub === "branch") {
    const p = operands(args, /^(-u|--set-upstream-to|--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format|--column)$/);
    if (flag(args, ["--delete"], "d") || flag(args, [], "D")) { const hit = p.find(named); return hit ? `deletes ${what(hit)}` : null; }
    if (flag(args, ["--move", "--copy"], "m") || flag(args, [], "M") || flag(args, [], "c") || flag(args, [], "C")) {
      const [from, to] = p.length >= 2 ? [p[0]!, p[1]!] : [null, p[0]];
      const copy = flag(args, ["--copy"], "c") || flag(args, [], "C");
      if (to !== undefined && named(to)) return `${copy ? "copies a branch over" : "renames a branch onto"} ${what(to)}`;
      if (from !== null && !copy && named(from)) return `renames ${what(from)}`;
      return null;
    }
    if (has(args, /^(-u|--set-upstream-to(=.*)?|--unset-upstream)$/)) { const hit = p[0]; return hit !== undefined && named(hit) ? `changes what ${what(hit)} follows` : null; }
    if (flag(args, ["--force"], "f") && p[0] !== undefined && named(p[0])) return `moves ${what(p[0])}`;
    return null;
  }
  if (sub === "update-ref") {
    if (has(args, /^--stdin$/)) return "reads the refs it changes from its input, which the rules cannot read";
    const ref = operands(args, /^-m$/)[0];
    if (ref === undefined || !(unread(ref) || normRef(ref).startsWith("refs/heads/"))) return null;
    return named(ref) ? `${has(args, /^(-d|--delete)$/) ? "deletes" : "moves"} ${what(ref)}` : null;
  }
  if (sub === "symbolic-ref") {
    const p = operands(args, /^-m$/);
    const ref = p[0];
    if (ref === undefined) return null;
    if (has(args, /^(-d|--delete)$/)) return ref !== "HEAD" && named(ref) ? `deletes ${what(ref)}` : null;
    if (p[1] === undefined) return null; // (a read)
    if (ref === "HEAD") return named(p[1]) ? `puts this worktree on ${what(p[1])}` : null;
    return named(ref) ? `makes ${what(ref)} a link to ${p[1]}` : null;
  }
  if (sub === "fast-import") return "reads the refs it changes from its input, which the rules cannot read";
  if (sub === "filter-branch" || sub === "filter-repo") return `rewrites branches with ${sub}, which can move every branch of the repository: rebase this worktree's own branch instead`;
  if (sub === "push") {
    const p = operands(args, /^(-o|--push-option|--receive-pack|--exec|--repo)$/);
    const remote = valuesOf(args, ["--repo"]).at(-1) ?? p.shift();
    if (remote === undefined) return null;
    const local = isLocal(remote, dir, home, s);
    if (local === false) return null;
    const into = local ? "" : ` of a repository it does not spell out (${remote})`;
    if (local && has(args, /^--(all|mirror|branches)$/)) return "pushes every branch into this repository";
    const del = has(args, /^(-d|--delete)$/);
    for (const spec of p) {
      const dst = del ? spec : spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec;
      if (dst && named(dst)) return `${del || spec.startsWith(":") ? "deletes" : "pushes into"} ${what(dst)}${into}`;
    }
    return null;
  }
  if (sub === "fetch" || sub === "pull") {
    if (has(args, /^(--update-head-ok|-u)$/)) return "passes --update-head-ok, which lets git move a branch another checkout has out";
    const p = operands(args, /^(--depth|--deepen|--shallow-since|--shallow-exclude|--upload-pack|--negotiation-tip|--server-option|-o|--refmap|-j|--jobs|-s|--strategy|-X|--strategy-option)$/);
    for (const spec of p.slice(1)) if (spec.includes(":")) {
      const dst = spec.slice(spec.indexOf(":") + 1);
      // (Remote-tracking refs, a glob there included, are no branch: refs/remotes/ written out with no expansion but the glob.)
      if (/^refs\/remotes\/[^$`{}\s]*$/.test(dst) && !dst.includes("..")) continue;
      if (dst && named(dst)) return `fetches into ${what(dst)}`;
    }
    return null;
  }
  if (sub === "checkout" || sub === "switch") {
    if (has(args, /^--ignore-other-worktrees$/)) return "passes --ignore-other-worktrees, which lets git take a branch another checkout has out";
    const k = args.findIndex((a) => a === "-B" || (sub === "switch" && (a === "-C" || a === "--force-create")));
    const b = k >= 0 ? args[k + 1] : undefined;
    if (b !== undefined && named(b)) return `resets ${what(b)}`;
    // Onto a shared branch itself (the base, when no checkout has it out): its commits would move it. Files from it
    // are fine, and so is its commit detached (--detach; switch's -d): a commit there moves no branch.
    if (has(args, /^--detach$/) || (sub === "switch" && has(args, /^-d$/))) return null;
    const p = operands(args, /^(-b|-B|-c|-C|--orphan|-t|--track|--conflict|--pathspec-from-file)$/);
    // (A branch made from it, `checkout -b new START`, puts the worktree on the new one.)
    const makes = args.some((a) => /^(-b|-c|-C|--orphan|--create|--force-create)/.test(a));
    return k < 0 && !makes && !args.includes("--") && p.length === 1 && named(p[0]!) && !unread(p[0]!) ? `puts this worktree on ${what(p[0]!)}` : null;
  }
  if (sub === "stash" && s.stashes && /^(pop|apply|drop|clear|branch)$/.test(args[0] ?? "")) return takesStash(args[0]!, args.slice(1), s.stashes(), s);
  if (sub === "worktree" && args[0] === "add") {
    const rest = args.slice(1);
    const k = rest.findIndex((a) => a === "-B");
    if (k >= 0 && rest[k + 1] !== undefined && named(rest[k + 1]!)) return `resets ${what(rest[k + 1]!)}`;
    const p = operands(rest, /^(-b|-B|--reason)$/);
    // (A new checkout of a shared branch: its commits there would move it.)
    if (p[1] !== undefined && !has(rest, /^(-b|-B|--detach|-d)$/) && named(p[1])) return `checks out ${what(p[1])} in a new worktree`;
    return null;
  }
  if (sub === "worktree" && (args[0] === "remove" || args[0] === "move")) {
    const at = operands(args.slice(1), /^--reason$/)[0];
    const p = at === undefined || unread(at) ? null : resolve(dir, at);
    return p !== null && s.folders.some((f) => within(p, f)) ? `${args[0] === "remove" ? "removes" : "moves"} another checkout of this repository (${p})` : null;
  }
  if (sub === "rebase") {
    const p = operands(args, /^(--onto|-s|--strategy|-X|--strategy-option|-x|--exec|-C|--whitespace)$/);
    return p[1] !== undefined && named(p[1]) ? `rebases ${what(p[1])} (rebase your own branch: git rebase <upstream> while on ${s.branch}, with no branch argument, or git rebase --onto <new> <old> without a third argument)` : null;
  }
  if (sub === "subtree") {
    const split = valuesOf(args, ["--branch"], "-b").find(named);
    if (split !== undefined) return `makes ${what(split)} with git subtree`;
    const p = operands(args, /^(-P|--prefix|-m|--message|-b|--branch|--onto|--annotate)$/);
    if (p[0] === "push" && p[1] !== undefined && isLocal(p[1], dir, home, s) !== false && p[2] !== undefined && named(p[2].slice(p[2].indexOf(":") + 1))) return `pushes into ${what(p[2].slice(p[2].indexOf(":") + 1))}`;
    return null;
  }
  if (sub === "worktree" && args[0] === "repair") {
    const p = operands(args.slice(1), /^$/).map((a) => pathOf(dir, a, home));
    return p.some((x) => x === null || s.folders.some((f) => within(f, x))) ? "rewrites how another checkout of this repository finds its git data" : null;
  }
  if (sub === "init") {
    const sep = valuesOf(args, ["--separate-git-dir"]);
    const p = [...sep, ...operands(args, /^(--template|--separate-git-dir|-b|--initial-branch|--object-format|--ref-format|--shared)$/)].map((a) => pathOf(dir, a, home));
    return sep.length || p.some((x) => x === null || within(s.root, x) || s.folders.some((f) => within(f, x)) || within(s.common, x)) ? "makes a repository again where a checkout of this one is" : null;
  }
  if (sub === "replace") return args.length && !has(args, /^(-l|--list|--format(=.*)?)$/) ? "swaps one commit for another in every checkout of the repository" : null;
  if (sub === "config") return configWrite(args, dir, home, s);
  if (sub === "remote" && (args[0] === "add" || args[0] === "set-url")) {
    const p = operands(args.slice(1), /^(-t|-m)$/);
    const url = p[1];
    return url !== undefined && isLocal(url, dir, home, s, true) !== false ? `points the remote ${p[0]} at this repository itself, where a push to it moves the shared branches` : null;
  }
  return null;
}

// git stash pop|apply|drop|clear|branch: the stash list is the repository's, not the worktree's, so a bare `git stash pop`
// takes whatever was stashed last, in any checkout. Held when an entry it takes was made on another branch.
function takesStash(verb: string, rest: string[], list: Stash[], s: Shared): string | null {
  const other = (e: Stash) => !e.mine;
  const whose = (e: Stash) => (e.branch !== null ? `on the branch ${e.branch}` : `with no branch in its subject ("${e.subject.slice(0, 60)}")`);
  const hold = (e: Stash, how: string) =>
    `${how} stash@{${e.n}}, which was made ${whose(e)}, not on this worktree's branch (${s.branch}). The stash list is shared by every worktree of the repository, so that entry is another checkout's work: keep your own work in a commit (a WIP commit on ${s.branch}), not in a stash`;
  const verbs: Record<string, string> = { pop: "takes", apply: "applies", drop: "drops", clear: "clears the stash list, which holds", branch: "takes" };
  if (verb === "clear") { const e = list.find(other); return e ? hold(e, verbs.clear!) : null; }
  // The entry it names: the last operand (`branch` takes the branch name first), else the newest.
  const ops = operands(rest, /^$/);
  const named = verb === "branch" ? ops[1] : ops[0];
  if (named === undefined) return list[0] && other(list[0]) ? hold(list[0], verbs[verb]!) : null;
  const m = /^(?:stash@\{(\d+)\}|(\d+))$/.exec(named);
  // An entry the rules cannot place (a date, a commit, an expansion) may be any: held when any entry is another's.
  if (!m) { const e = list.find(other); return e ? `${verbs[verb]} an entry it names as ${named}, which the rules cannot place, while the stash list holds one made ${whose(e)}, not on this worktree's branch (${s.branch}). Name it as stash@{N}, or keep your own work in a commit` : null; }
  const e = list[Number(m[1] ?? m[2])];
  return e && other(e) ? hold(e, verbs[verb]!) : null;
}

// The commands a git command runs by itself, as shell text: rebase --exec, bisect run, submodule foreach.
function bodiesOf(g: Git): string[] {
  if (g.sub === "rebase") return valuesOf(g.args, ["--exec"], "-x");
  if (g.sub === "bisect" && g.args[0] === "run") return g.args.length > 1 ? [joined(g.args.slice(1))] : [];
  if (g.sub === "submodule") {
    const k = g.args.indexOf("foreach");
    if (k < 0) return [];
    const rest = g.args.slice(k + 1).filter((a, j, all) => !(a.startsWith("-") && all.slice(0, j).every((b) => b.startsWith("-"))));
    return rest.length ? [rest.length === 1 ? rest[0]! : joined(rest)] : [];
  }
  return [];
}

// The setting of git's config through the environment that a command makes: the pairs Keel gives every command are
// numbered (GIT_CONFIG_COUNT), and one set over them takes theirs away.
const GIT_ENV = /^(GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_PARAMETERS|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY)=(.*)$/s;
// The settings the daemon gives a command of this agent: Keel's pairs, then the guard's (the ones that hold its git
// to its own branch), read from the guard as the gate asks for it. A command that starts without the environment
// (env -i) is allowed only when it gives all of them back, each as given, so what it sets is what it would have had.
export function sessionSettings(s: Shared): string[] {
  const guard = guardEnv(s, { ...process.env, GIT_CONFIG_COUNT: SHELL_GIT_SETTINGS[0]!.slice("GIT_CONFIG_COUNT=".length) });
  const pairs = Object.entries(guard).map(([k, v]) => `${k}=${v}`);
  return pairs.length ? [...SHELL_GIT_SETTINGS.slice(1), ...pairs] : [...SHELL_GIT_SETTINGS];
}
function envRefused(assigned: string[], dir: string | null, home: string, s: Shared): string | null {
  const given = sessionSettings(s);
  const whole = given.every((a) => assigned.includes(a));
  for (const w of assigned) {
    if (whole && given.includes(w)) continue;
    const m = GIT_ENV.exec(w);
    if (!m) continue;
    if (m[1] === "GIT_INDEX_FILE" || m[1] === "GIT_OBJECT_DIRECTORY") { const at = pathOf(dir, m[2]!, home); const what = at === null ? null : gitStoreOf(at, s); if (what) return `points git at ${what} (${m[1]})`; continue; }
    if (m[1] !== "GIT_CONFIG_PARAMETERS") return `sets ${m[1]}, which replaces the git settings Keel gives the command (give one with git -c instead)`;
    for (const kv of m[2]!.matchAll(/'([^'=]+)'(?:='([^']*)')?/g)) { const why = keyRefused(kv[1]!, kv[2], dir, home, s); if (why) return why; }
    if (/alias\.|core\.(worktree|hookspath|bare)|include/i.test(m[2]!)) return "sets git settings in GIT_CONFIG_PARAMETERS that the rules do not read";
  }
  return null;
}

// What an agent is told when a command starts without the environment (env -i): its own words, not the paragraph
// about other checkouts' branches.
export const ENV_I = "starts it without the environment Keel gives the command (env -i)";
// A word for a copy into a command line: as it is when the shell reads it as one plain word, else in single quotes.
const shellWord = (w: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`);
export const envIMessage = (s: Shared) =>
  `Refused: env -i (or env -) drops the git settings Keel gives every command, which hold an agent to its own branch (${s.branch}), and the rules cannot read what the command then runs (a shell, git, a script, an interpreter such as python3 -c or node -e). Keep the environment instead: \`env NAME=value cmd\` adds a variable and \`env -u NAME cmd\` removes one. A scratch daemon needs no empty environment: \`env -u NAME ... bash scripts/dev.sh PORT\` drops what it must not inherit (provider keys, DBUS_SESSION_BUS_ADDRESS), and the KEEL_* settings scripts/dev.sh reads (KEEL_DEV_DIR, KEEL_SCRIPTED_PROVIDER, KEEL_DEFAULT_MODEL, KEEL_KEYRING_SERVICE, KEEL_DESKTOP_NOTIFY) go in as \`env NAME=value\`. The one way to keep env -i is to give back the whole settings in the same command, each as one word: ${sessionSettings(s).map(shellWord).join(" ")}`;
// A word of env's, or the program's, that the shell fills in: env -i may hide in it.
export const ENV_UNREAD = "starts env or a program through a word the rules cannot read:";
const shown = (w: string) => (w.length > 60 ? `${w.slice(0, 57)}...` : w);
export const envUnreadMessage = (why: string) =>
  `Refused: the command ${why}. A variable or a substitution there can be \`-i\`, or env itself, and env -i drops the git settings Keel gives every command, which hold an agent to its own branch. Write the program and env's options out as words (\`env NAME=value cmd\`; a path may start with $HOME), and keep a value that needs an expansion as the value of a named assignment (\`env NAME=$VALUE cmd\`).`;
// A program word the shell fills in only with a variable that names a known folder, then a written-out path.
export const KNOWN_PATH = /^(?:\$\{?(?:HOME|PWD|OLDPWD|TMPDIR|USER)\}?|~)\/[^$`]*$/;
// What an option of env does: -i, --ignore-environment or a lone dash clear the environment (also inside a cluster,
// -vi); -S splits a string into more words; an option with its own value (-u, -C) ends a cluster.
function envOption(w: string): "clear" | "split" | undefined {
  if (w === "-" || w === "--ignore-environment") return "clear";
  if (w.startsWith("--split-string")) return "split";
  if (/^--/.test(w) || !/^-[A-Za-z0-9]+$/.test(w)) return /^-[A-Za-z0-9]*S/.test(w) ? "split" : undefined;
  for (const c of w.slice(1)) { if (c === "i") return "clear"; if (c === "S") return "split"; if ("uCPa".includes(c)) return undefined; }
  return undefined;
}

// Programs that write the files they name: each, and which of its words are the files.
const WRITES: Record<string, "all" | "last" | "inplace"> = {
  tee: "all", cp: "last", install: "last", ln: "last", rsync: "last", mv: "all", rm: "all", unlink: "all", truncate: "all", shred: "all", touch: "all",
  chmod: "all", chown: "all", sed: "inplace", perl: "inplace",
};
// The options of each that take the next word as their value (rm's -f takes none).
const VALUED: Record<string, RegExp> = {
  sed: /^(-e|--expression|-f|--file|-l|--line-length)$/, perl: /^(-e|-E)$/,
  cp: /^(-t|--target-directory|-S|--suffix)$/, mv: /^(-t|--target-directory|-S|--suffix)$/, ln: /^(-t|--target-directory|-S|--suffix)$/,
  install: /^(-t|--target-directory|-S|--suffix|-o|--owner|-g|--group|-m|--mode)$/, rsync: /^(-e|--rsh|-f|--filter|--exclude|--include|-T|--temp-dir)$/,
  truncate: /^(-s|--size|-r|--reference)$/, touch: /^(-t|-d|--date|-r|--reference)$/, shred: /^(-n|--iterations|-s|--size)$/,
  chmod: /^--reference$/, chown: /^--reference$/,
};
// The ones whose -t names the folder they write in.
const TARGETS = new Set(["cp", "mv", "ln", "install"]);
function writtenPaths(part: Simple, run: Run): string[] {
  const out = redirected(part).map((r) => r.to).filter((t) => !/^(&|\/dev\/)/.test(t));
  const w = run.words, prog = name(w[0]);
  if (prog === "dd") for (const a of w) if (a.startsWith("of=")) out.push(a.slice(3));
  // (git's own --output is judged apart, by movesShared, with its own words.)
  out.push(...outputsOf(w).filter((o) => prog !== "git" || !(w[o.at]!.startsWith("--output=") || w[o.at - 1] === "--output")).map((o) => o.to));
  const how = WRITES[prog];
  if (!how) return out;
  const args = w.slice(1);
  if (how === "inplace" && !args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))) return out;
  if (TARGETS.has(prog)) out.push(...valuesOf(args, ["--target-directory"], "-t"));
  const p = operands(args, VALUED[prog] ?? /^$/);
  out.push(...(how === "last" ? p.slice(-1) : p));
  return out;
}

// Programs that run their text as a shell line: the option before it, or (tmux) the last word.
const RUNS_TEXT: Record<string, RegExp> = { script: /^(-[a-zA-Z]*c|--command)$/, su: /^(-[a-zA-Z]*c|--command)$/, runuser: /^(-[a-zA-Z]*c|--command)$/ };
const TMUX_RUNS = /^(new|new-session|new-window|neww|split-window|splitw|run-shell|run|respawn-pane|respawnp|respawn-window|respawnw)$/;
const SSH_VALUED = /^-[bcDEeFIiJLlmOopQRSWw]$/;
const LOCAL_HOSTS = /^(localhost|localhost\.localdomain|127(\.\d+){3}|::1|0\.0\.0\.0|\[::1\])$/i;

// Why a command run from the agent's worktree is refused, or null. `cwd`: the folder it starts in.
// `resolved`: the line is judged beside the one its variables written out (resolved-line.ts), which has the program words
// this one cannot read: they are not refused here.
export function sharedRefusal(command: string, cwd: string | null, home: string, s: Shared, depth = 0, resolved = false): string | null {
  const parts = splitCommand(command);
  if (!parts) return /\bgit\b/.test(command) ? "runs git in text the rules cannot read" : null;
  const start = depth === 0 && s.real && cwd !== null ? s.real(cwd) : cwd;
  const { runs, dirs } = laid(parts, start, home);
  // The folders a part may run in when the line leaves its folder unknown (a `cd` then `;` in a subshell, whose end
  // the parts do not show): where the line starts, each folder known for a part before it, and each one a `cd` there
  // names from those.
  const maybe = (i: number): string[] => {
    const out = new Set<string>();
    if (start !== null) out.add(start);
    for (let j = 0; j < i; j++) {
      const d = dirs[j];
      if (d) out.add(d);
      const w = runs[j]!.words;
      const arg = w[0] === "cd" || w[0] === "pushd" ? w.slice(1).find((a) => !a.startsWith("-")) : undefined;
      if (arg !== undefined) for (const from of [...out]) { const p = pathOf(from, arg, home); if (p !== null) out.add(p); }
    }
    return [...out];
  };
  const inner = (text: string, dir: string | null): string | null =>
    depth >= 4 ? (/\bgit\b/.test(text) ? "runs git nested deeper than the rules read" : null) : sharedRefusal(text, dir, home, s, depth + 1);
  // GIT_DIR and GIT_WORK_TREE given for the rest of the line (`export GIT_DIR=...`, or a line of assignments alone).
  const line = new Map<string, string>();
  // The program a run of here-document lines feeds: a shell runs them.
  let feeder: string | undefined;
  for (let i = 0; i < parts.length; i++) {
    const part: Simple = parts[i]!, run: Run = runs[i]!;
    const words = run.words;
    if (part.heredoc) { if (!feeder || !SHELLS.test(feeder)) continue; }
    else feeder = name(words[0]);
    const lead = words[0] === "export" ? words.slice(1) : words.length === 0 ? part.words : [];
    for (const w of lead) { const m = /^(GIT_DIR|GIT_WORK_TREE)=(.*)$/s.exec(w); if (m) line.set(m[1]!, m[2]!); }
    const env = envRefused([...lead, ...run.set], dirs[i] ?? null, home, s);
    if (env) return env;
    // A plain write of git's own files: a branch moved, or a checkout broken, under git.
    const written = writtenPaths(part, run);
    for (const t of written) for (const from of dirs[i] != null ? [dirs[i]!] : [null, ...maybe(i)]) {
      const p = pathOf(from, t, home);
      const what = p === null ? null : gitStoreOf(p, s, name(words[0]) === "ln");
      if (what) return `writes ${what}`;
    }
    if (!words.length) continue;
    const prog = name(words[0]);
    if (prog === "unset" && words.some((w) => /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(w))) return "unsets the git settings Keel gives the command";
    // A program the shell names with an expansion (`$X -i ...`, `$(which env)`) may be env, or anything: it is not read.
    if (!resolved && !KNOWN_PATH.test(words[0]!) && /[$`]/.test(words[0]!)) return `${ENV_UNREAD} the program word ${shown(words[0]!)}`;
    // `env -i` and `env -u GIT_CONFIG_COUNT` take away what Keel gives the command; `env -C DIR` moves it. Any program
    // that starts without the settings may run git (an interpreter, a script of the worktree), so each is refused
    // unless the command gives the whole settings back. A word of env's own the shell fills in is not read: it may be -i.
    const whole = sessionSettings(s).every((a) => run.set.includes(a));
    let dir = dirs[i] ?? null;
    for (let k = 0, wrap = ""; k < run.at; k++) {
      const w = part.words[k]!;
      const assign = /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
      if (wrap === "env" && !assign && /[$`]/.test(w)) return `${ENV_UNREAD} the word ${shown(w)} among env's options`;
      if (!w.startsWith("-")) { if (!assign) wrap = name(w); continue; }
      if (wrap !== "env" && wrap !== "sudo") continue;
      if (wrap === "env") {
        const o = envOption(w);
        if (o === "split") return `${ENV_UNREAD} env's -S string (${shown(w)}), which env splits into more words`;
        if (o === "clear" && !whole) return ENV_I;
      }
      const unsetName = w === "-u" || w === "--unset" ? part.words[++k] : /^(--unset=|-u)(.+)$/.exec(w)?.[2];
      if (wrap === "env" && unsetName && /[$`]/.test(unsetName)) return `${ENV_UNREAD} the name ${shown(unsetName)} that env -u removes`;
      if (unsetName && /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(unsetName)) return "unsets the git settings Keel gives the command";
      const to = (wrap === "env" && (w === "-C" || w === "--chdir")) || (wrap === "sudo" && (w === "-D" || w === "--chdir")) ? part.words[++k] : /^(--chdir=|-C)(.+)$/.exec(w)?.[2];
      if (to !== undefined) dir = pathOf(dir, to, home);
    }
    // A shell given the line as text: read through, where it starts. One reading its input: the here-string or the
    // words a plain echo gives it.
    if (SHELLS.test(prog)) {
      const bodies = scriptsOf(shellGiven(words.slice(1)));
      if (bodies.length) { for (const body of bodies) { const why = inner(body.script, dir); if (why) return why; } continue; }
      if (part.here !== undefined) { const why = inner(part.here, dir); if (why) return why; }
      const prev = i > 0 && !parts[i - 1]!.heredoc && (parts[i - 1]!.sep === "|" || parts[i - 1]!.sep === "|&") ? runs[i - 1]! : undefined;
      if (prev && /^(echo|printf)$/.test(name(prev.words[0])) && !prev.words.slice(1).some(unread)) { const why = inner(prev.words.slice(1).filter((w) => !/^-[neE]+$/.test(w)).join(" ").replace(/\\n/g, "\n"), dir); if (why) return why; }
      continue;
    }
    if (prog === "eval") { const why = inner(evalGiven(words.slice(1)), dir); if (why) return why; continue; }
    // A wrapper given the command as one word (watch 'git ...').
    if (words.length === 1 && /\s/.test(words[0]!)) { const why = inner(words[0]!, dir); if (why) return why; continue; }
    if (RUNS_TEXT[prog]) {
      for (const body of words.flatMap((w, j) => (RUNS_TEXT[prog]!.test(w) && words[j + 1] !== undefined ? [words[j + 1]!] : []))) { const why = inner(body, dir); if (why) return why; }
      continue;
    }
    if (prog === "tmux" && words.slice(1).some((w) => TMUX_RUNS.test(w))) {
      const last = words.at(-1)!;
      if (!last.startsWith("-") && !TMUX_RUNS.test(last)) { const why = inner(last, dir); if (why) return why; }
      continue;
    }
    // ssh to this machine runs the rest of its words here, from the home folder.
    if (prog === "ssh") {
      const p: string[] = [];
      for (let k = 1; k < words.length; k++) { const w = words[k]!; if (p.length === 0 && w.startsWith("-")) { if (SSH_VALUED.test(w)) k++; continue; } p.push(w); }
      const host = p[0]?.replace(/^[^@]*@/, "");
      if (host !== undefined && p.length > 1 && (LOCAL_HOSTS.test(host) || s.hosts?.includes(host.toLowerCase()))) { const why = inner(p.slice(1).join(" "), home); if (why) return why; }
      continue;
    }
    if (prog !== "git") continue;
    // What xargs, parallel or find gives it is not known: a word of its own the rules cannot read.
    let gw = words;
    if (run.fed) {
      const token = run.fed === "xargs" ? valuesOf(part.words.slice(0, run.at), ["--replace"], "-I").at(-1) ?? (part.words.slice(0, run.at).some((w) => w === "-i") ? "{}" : undefined) : "{}";
      gw = [...words.map((w) => (token !== undefined && w.includes(token) ? w.replaceAll(token, "$FED") : w)), ...(run.fed === "xargs" && token === undefined ? ["$FED"] : [])];
    }
    const g = gitOf(gw);
    if (!g) continue;
    const env2 = new Map(line);
    for (const w of run.set) { const m = /^(GIT_DIR|GIT_WORK_TREE)=(.*)$/s.exec(w); if (m) env2.set(m[1]!, m[2]!); }
    const place = placeOf(g, dir, env2, home, s);
    if (place.at === "elsewhere") continue;
    const at = place.at === "own" ? (g.c.length ? g.c.reduce<string | null>((d, c) => (d === null ? null : pathOf(d, c, home)), dir) : dir) ?? s.root : null;
    // The settings it gives: refused ones, and a command one runs, read as a line of its own.
    const set = [...g.config, ...(g.sub === "config" ? [configSet(g.args)].filter((x): x is [string, string | undefined] => !!x) : [])];
    for (const [k, v] of set) {
      const why = keyRefused(k, v, dir, home, s);
      if (why) return why;
      if (RUNS_COMMAND.test(k.toLowerCase()) && v !== undefined) { const ran = inner(commandOf(v), at ?? dir); if (ran) return `sets ${k} to a command that ${ran}`; }
    }
    for (const body of bodiesOf(g)) { const why = inner(body, at ?? dir); if (why) return why; }
    const reads = archiveReads(g) || isReadOnly({ words: ["git", g.sub, ...g.args], text: "", redirects: false });
    if (place.at === "other" && !reads) return `runs git ${g.sub} in ${place.folder}, another checkout of this repository`;
    if (place.at === "unknown" && !reads) return `runs git ${g.sub} in ${place.what}, which may be another checkout of this repository`;
    if (place.at === "own") { const why = movesShared(g, at!, home, s, resolved); if (why) return why; }
  }
  return null;
}

// What the agent is told: what the command would do, and the way its work lands instead.
export function sharedMessage(why: string, s: Shared, what = "the command"): string {
  if (why === ENV_I) return envIMessage(s);
  if (why.startsWith(ENV_UNREAD)) return envUnreadMessage(why);
  return `Refused: ${what} ${why}. This worktree shares the repository's branches with its other checkouts (the owner's and other agents'), so an agent here changes its own branch (${s.branch}) and the branches it makes itself only: commit there, and reset or rebase it as you need. A branch reaches ${s.base ?? "its base"} through Keel's landing queue (keel__landing_queue), which rebases it, runs the repository's checks and lands it. Leave the other branches as they are, even to undo a mistake, and say in your report what you wanted done.`;
}
