// The one place the daemon runs git. Nothing else in src spawns it (a lint
// test in src/conventions.test.ts fails on a new spawn).
//
// Why: git runs programs that a repository's own files name. Its local config
// can name a file-system monitor, a hooks folder, a pager, an editor, an
// external diff, a credential helper, an ssh or proxy command, the program
// behind `ext::` and upload-pack, and filter, textconv and merge drivers
// under any name, which `.gitattributes` or `info/attributes` then turn on.
// A session can write such a config: in a repository it made inside its
// folder, in its folder's own `.git` when the sandbox is off, in a nested
// repository. The daemon runs git in those folders by itself (repository
// facts for the gate, the file picker, the Changes panel, worktrees), outside
// any confinement, so a planted program would run as the owner.
//
// A list of dangerous keys can never be complete (a driver has any name), so
// the daemon's git does not read a repository's local config at all:
//
// 1. The repository is addressed through a view: `GIT_DIR` is its real git
//    directory (HEAD, index and the other per-worktree files), `GIT_COMMON_DIR`
//    is a folder of Keel's own, and `GIT_WORK_TREE` is the folder its `.git`
//    is in. git takes the shared files, `config` among them, from the common
//    directory (git(1), GIT_COMMON_DIR: "non-worktree files that are normally
//    in $GIT_DIR will be taken from this path instead"). The view links the
//    repository's objects, refs and logs, has no `hooks` and no
//    `info/attributes`, and its `config` holds only the keys of the real one
//    that are plain data and that git needs to read the repository right (the
//    format and its extensions, line-ending and file-mode settings, sparse
//    checkout, remotes' addresses, branches' upstreams, the identity, the
//    file of exclude patterns). The real file is read as a file (`git config
//    --file`, which follows no include), never as a config in force.
//    `core.worktree` is not taken, so a planted one cannot point a checkout
//    at another folder. One filter is carried: Git LFS, when its section is
//    exactly what `git lfs install --local` writes (STOCK_LFS).
//    The owner's global and system config still apply: a filter they set up
//    themselves (git-lfs) keeps working.
//    Naming the git directory skips git's own ownership check, so the helper
//    makes it (`ours`): a repository of another user is not opened.
// 2. Every call also gets, at command-line precedence (git-config(1),
//    GIT_CONFIG_COUNT: "will override values in configuration files"), the
//    keys below, and the environment for the rest. This is what covers a call
//    that cannot go through the view: the worktree list is kept by path in
//    the real common directory, so `git worktree add|remove|prune` run on it,
//    without a checkout; the checkout is then made through the view.
// 3. A diff never runs an external diff or a textconv (`--no-ext-diff`,
//    `--no-textconv`, git-diff(1)), and nothing is fetched on demand
//    (GIT_NO_LAZY_FETCH, git(1)): a planted promisor remote would be reached
//    from outside the session's network setting.
// 4. git is never run inside a repository the work tree holds (a submodule,
//    a nested clone) from outside it: that git would read the inner
//    repository's own config. See "repositories inside a work tree" below.
// 5. A shell script of the daemon's own that runs git (a session's move, a
//    remote agent's worktree) gets the same keys as exports (GIT_SHELL_ENV),
//    and the view's environment where it reads or fills a work tree (gitEnv).
//
// No call takes a subcommand from outside, so an alias is never run (git
// ignores an alias that hides a command of its own).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { privateHost } from "./hosts.ts";
import { defaultStateDir } from "./paths.ts";
import { chunks, chunksUntil, readText } from "./proc.ts";

// `bytes`: the output as git wrote it, for a call with `raw` (blobs: `out` is then empty).
export type GitResult = { code: number; out: string; err: string; bytes?: Uint8Array };
export type GitOpts = {
  // "repo" (the default): the repository `dir` is in, through its view.
  // "own": a git directory of Keel's own (`gitDir`), with `workTree` when it has one.
  // "plain": no repository's config in force is wanted (`init`, `diff --no-index`, `merge-file`).
  mode?: "repo" | "own" | "plain";
  gitDir?: string;
  workTree?: string;
  index?: string;
  env?: Record<string, string>;
  input?: string | Uint8Array;
  timeout?: number;
  signal?: AbortSignal;
  // Only reads: no optional lock is taken (a status never rewrites the index).
  read?: boolean;
  // The output is bytes, not text (`cat-file --batch` of blobs): in `bytes`.
  raw?: boolean;
  // Background upkeep (a repack): niced, and its disk use at the lowest weight where ionice is.
  low?: boolean;
  // The call puts files into a work tree (the fill of a new worktree, the
  // checkout of a restore): in a partial clone it may fetch the objects the
  // repository was promised. Through the view that fetch knows the remote's
  // address and nothing else of the repository's own config (no upload-pack
  // program, ssh command, credential helper, proxy or url rewrite), so it
  // runs the owner's own transport only. Reads never fetch.
  // The address is the repository's to name, so the fetch reaches no further
  // than the session the files are for reaches with its own commands (the
  // caller says which): "any" address when that session is not confined;
  // "public": none on this machine or a private network, which the web
  // tools refuse too; absent: nothing is fetched. Only https, http, ssh and
  // git are spoken, and a folder on this machine the repository names
  // itself: no other transport program is started.
  fetch?: GitFetch;
  // Keys of this call's own, after the ones every call gets (git reads them in
  // order and a later key wins): what a fetch of Keel's own needs (the
  // transports it may speak, a header with a token). Through the environment,
  // never the command line, so a token is not in the process list.
  config?: [string, string][];
};
export type GitFetch = "any" | "public";
// How far the daemon's git may fetch for a session: as far as that
// session's own commands reach. Set where the sessions' permissions are
// known (the gate). Without it, and for work no session is behind (the
// owner's own act in the page or on the command line), what the web tools
// reach.
let reach: (sessionId?: string) => GitFetch | undefined = () => "public";
export const setGitReach = (f: (sessionId?: string) => GitFetch | undefined) => { reach = f; };
export const gitReach = (sessionId?: string) => reach(sessionId);

// Where a folder's repository is, found from the files, without running git:
// the folder that holds `.git`, its git directory and the common directory.
// `top` is absent for a bare repository.
export type Where = { top?: string; gitDir: string; common: string };

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

function gitDirAt(p: string): Where | null {
  if (!isFile(join(p, "HEAD"))) return null;
  let common = p;
  try { common = resolve(p, readFileSync(join(p, "commondir"), "utf8").trim()); } catch {} // no commondir file: its own
  if (!isDir(join(common, "objects")) || !(isDir(join(common, "refs")) || isDir(join(common, "reftable")))) return null;
  try { return { gitDir: realpathSync(p), common: realpathSync(common) }; } catch { return null; }
}

// The owner's own config (system and global), which git trusts whatever a
// repository says: read at most once in a while, for the two things the
// helper decides from it.
let trusted: { at: number; safe: string[]; lfs: boolean } | undefined;
function trustedConfig() {
  if (trusted && Date.now() - trusted.at < 30_000) return trusted;
  let safe: string[] = [], lfs = false;
  try {
    const r = Bun.spawnSync(["git", "config", "--list", "-z"], { cwd: "/", stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 10_000, env: baseEnv() });
    for (const rec of r.success ? r.stdout.toString().split("\0") : []) {
      const nl = rec.indexOf("\n");
      const key = nl < 0 ? rec : rec.slice(0, nl), value = nl < 0 ? "" : rec.slice(nl + 1);
      // (An empty value clears the list, as git reads it.)
      if (key === "safe.directory") safe = value ? [...safe, value] : [];
      if (key === "filter.lfs.clean" || key === "filter.lfs.process") lfs = true;
    }
  } catch {} // no git: nothing is trusted beyond the owner's own files
  return (trusted = { at: Date.now(), safe, lfs });
}

// git opens a repository only when its folder, its git directory and the
// `.git` file between them are the user's own, or the owner listed it in
// safe.directory (git-config(1), safe.directory; ensure_valid_ownership in
// setup.c). Naming the git directory in the environment skips that check in
// git, so the helper makes it: a repository of another user is not one Keel
// opens.
function ours(w: Where): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return true;
  const mine = (p: string) => { try { return lstatSync(p).uid === uid; } catch { return false; } };
  const dot = w.top ? join(w.top, ".git") : undefined;
  if (mine(w.gitDir) && (!w.top || mine(w.top)) && (!dot || !isFile(dot) || mine(dot))) return true;
  // (As git compares them: the folder itself, however the entry spells it, with a slash at its end or through a link.)
  const at = w.top ?? w.gitDir;
  const real = (v: string) => { try { return realpathSync(v); } catch { return v.replace(/\/+$/, "") || "/"; } };
  return trustedConfig().safe.some((v) => v === "*" || (v.endsWith("/*") ? at.startsWith(`${real(v.slice(0, -2))}/`) : real(v) === at));
}

// Where the repository of a folder is, when it is one Keel opens.
export function locate(dir: string): Where | null {
  const w = find(dir);
  return w && ours(w) ? w : null;
}

function find(dir: string): Where | null {
  let d: string;
  try { d = realpathSync(dir); } catch { return null; }
  for (;;) {
    const dot = join(d, ".git");
    let named: string | undefined;
    try {
      const st = statSync(dot);
      named = st.isDirectory() ? dot : st.isFile() ? /^gitdir: (.+)$/m.exec(readFileSync(dot, "utf8"))?.[1]?.trim() : undefined;
    } catch {} // no .git here
    const found = named ? gitDirAt(resolve(d, named)) : null;
    if (found) return { top: d, ...found };
    // A `.git` file that names no git directory: git stops there too, and
    // does not take the folder for a part of the repository around it.
    if (named && isFile(dot)) return null;
    // The folder is a git directory itself (a bare repository, or inside `.git`).
    const bare = gitDirAt(d);
    if (bare) return bare;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// ---- the view ----

// The keys of a repository's config the view keeps: plain data that changes
// how git reads the repository, and nothing that names a program or a file
// to load. Sections and names are lower case, as `git config --list` gives them.
const KEPT: Record<string, RegExp> = Object.assign(Object.create(null), {
  // (core.excludesFile names a file of patterns, which is data: without it the
  // files it leaves out show up as new and get committed by a park.
  // core.attributesFile stays out: attributes turn drivers on.)
  core: /^(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|sparsecheckout|sparsecheckoutcone|checkstat|trustctime|protecthfs|protectntfs|excludesfile)$/,
  extensions: /^(?!worktreeconfig$).+$/,
  index: /^(version|sparse|skiphash)$/,
  // (gh-resolved and gh-merge-base are what `gh` keeps there: the repository a fork's pull requests go to.)
  remote: /^(url|pushurl|fetch|promisor|partialclonefilter|gh-resolved)$/,
  branch: /^(remote|merge|pushremote|gh-merge-base)$/,
  user: /^(name|email)$/,
});
// The one filter taken from a repository's own config: Git LFS, and only when
// its four lines are exactly what `git lfs install --local` writes
// (git-lfs-install(1); the program is the owner's git-lfs, found on the
// daemon's PATH). Any other value there, or any other filter, is not carried.
const STOCK_LFS: Record<string, string> = {
  "filter.lfs.clean": "git-lfs clean -- %f",
  "filter.lfs.smudge": "git-lfs smudge -- %f",
  "filter.lfs.process": "git-lfs filter-process",
  "filter.lfs.required": "true",
};
// What git takes from the common directory (its own list, common_list in
// path.c, with the reftable store and what git-lfs keeps beside the objects):
// linked into a view when the repository has it. Everything else in a git
// directory is per checkout and is read from the real one.
const SHARED = ["objects", "refs", "logs", "worktrees", "branches", "remotes", "rr-cache", "svn", "lost-found", "common", "reftable", "lfs"];
// Linked also when missing: git makes these by replacing the file a link points at.
const ALWAYS = ["packed-refs", "shallow"];

let stateDir: string | undefined;
// The views live in the daemon's state folder. A confined command cannot
// write them, also when its folder holds the state folder: the sandbox binds
// this folder read-only (src/safety/sandbox.ts), and a view's config is
// compared with what was written before each call.
export const gitViewsDir = () => join(stateDir ?? defaultStateDir(), "git-views");
const viewRoot = gitViewsDir;
// At a start: the state folder is named, and the views of git directories that are gone are removed.
export function setGitViews(dir: string) {
  stateDir = dir;
  trusted = undefined;
  pruneViews();
}
// Also once in a process that is no daemon (the helper an ssh machine runs,
// the command line): the first view it makes looks for the ones to remove.
let pruned = false;
function pruneViews() {
  pruned = true;
  let names: string[] = [];
  try { names = readdirSync(viewRoot()); } catch {} // no view was made yet
  for (const name of names) {
    const view = join(viewRoot(), name);
    let origin: string | undefined;
    try { origin = readFileSync(join(view, ORIGIN), "utf8").trim(); } catch {} // a view from before this file was written
    if (!origin || !existsSync(origin)) rmSync(view, { recursive: true, force: true });
  }
}
// In a view: the git directory it is of.
const ORIGIN = "keel-origin";

const quoted = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;

// The entries of a config file as git parses them, the file read as a file.
function entries(file: string): [string, string][] {
  if (!isFile(file)) return [];
  const r = Bun.spawnSync(["git", "config", "--file", file, "--list", "-z"], { cwd: "/", stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 10_000, env: baseEnv() });
  if (!r.success) return [];
  return r.stdout.toString().split("\0").filter(Boolean).map((rec) => {
    const nl = rec.indexOf("\n");
    return nl < 0 ? [rec, "true"] : [rec.slice(0, nl), rec.slice(nl + 1)];
  });
}

const shq = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
// The folders the repository of `w` has checked out: its main checkout and
// every linked worktree, from the files git keeps of them.
export function checkouts(w: Where): string[] {
  const out = new Set<string>();
  const add = (p: string | undefined) => { if (p) try { out.add(realpathSync(p)); } catch { out.add(resolve(p)); } };
  add(w.top);
  if (basename(w.common) === ".git") add(dirname(w.common));
  try {
    for (const name of readdirSync(join(w.common, "worktrees"))) {
      const at = textOf(join(w.common, "worktrees", name, "gitdir"))?.trim();
      if (at) add(dirname(at));
    }
  } catch {} // no linked worktrees
  return [...out];
}
// git-lfs as the daemon's PATH finds it, by its real path, unless it is inside one of `tops`.
function lfsProgram(tops: string[]): string | undefined {
  try {
    const found = Bun.which("git-lfs", { PATH: process.env.PATH ?? "" });
    if (!found) return undefined;
    const real = realpathSync(resolve(found));
    return tops.some((top) => real === top || real.startsWith(top + "/")) ? undefined : real;
  } catch {
    return undefined;
  }
}

// The programs git runs in the repository at the other end of a push or a
// fetch, when that repository is a folder on this machine (git-push(1)
// --receive-pack, git-fetch(1) --upload-pack; remote.<name>.receivepack and
// .uploadpack in git-config(1)). That repository's config is its own, and a
// session may have written it: no hook, no file-system monitor and no
// alternate-refs program of it runs, a push into a branch that is checked
// out there is refused (updating its files would run its filters), and no
// gc is started there.
const INTO = "-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.alternateRefsCommand=true";
const RECEIVE_PACK = `git ${INTO} -c receive.denyCurrentBranch=refuse -c receive.autogc=false receive-pack`;
const UPLOAD_PACK = `git ${INTO} upload-pack`;

// Beyond its remotes' addresses, what a repository's own config says of where they lead: `rewrites`, its url
// rewrites (url.<base>.insteadOf and .pushInsteadOf, as git lists the keys), and `includes`, whether it includes
// other config files. Neither is in the view: Keel's own git rewrites no address and reads no file a repository
// names. They are kept for the one read that says where the owner's own git would push (remotesAsRun).
type Leads = { rewrites: [string, string][]; includes: boolean };
function viewConfig(w: Where): { config: string; leads: Leads } {
  const all = entries(join(w.common, "config"));
  // A repository with per-worktree config: this checkout's own file applies after the shared one.
  if (all.some(([k, v]) => k === "extensions.worktreeconfig" && /^(true|yes|on|1)$/i.test(v))) all.push(...entries(join(w.gitDir, "config.worktree")));
  const out = ["# Written by Keel: the keys of the repository's config that are plain data. The repository's own file is not read."];
  const addresses = new Map<string, { url?: string; pushurl?: string }>();
  let format = false;
  for (const [key, value] of all) {
    const first = key.indexOf("."), last = key.lastIndexOf(".");
    if (first < 0) continue;
    const section = key.slice(0, first), name = key.slice(last + 1), sub = first === last ? undefined : key.slice(first + 1, last);
    if (!KEPT[section]?.test(name) || (sub === undefined) !== (section !== "remote" && section !== "branch")) continue;
    // The work tree is named for every call, so a repository that calls itself bare is not one here.
    if (key === "core.bare" && w.top) continue;
    if (key === "core.repositoryformatversion") format = true;
    out.push(sub === undefined ? `[${section}]` : `[${section} ${quoted(sub)}]`, `\t${name} = ${quoted(value)}`);
    if (section === "remote" && (name === "url" || name === "pushurl")) (addresses.get(sub!) ?? (addresses.set(sub!, {}), addresses.get(sub!)!))[name] = value;
  }
  // A remote that is a folder here: what runs in it is named by Keel (see
  // RECEIVE_PACK). A push goes to the push address when the remote has one.
  for (const [remote, a] of addresses) {
    const lines = [...(a.url !== undefined && localPath(a.url) ? [`\tuploadpack = ${quoted(UPLOAD_PACK)}`] : []), ...(localPath(a.pushurl ?? a.url ?? "x:") ? [`\treceivepack = ${quoted(RECEIVE_PACK)}`] : [])];
    if (lines.length) out.push(`[remote ${quoted(remote)}]`, ...lines);
  }
  if (!format) out.push("[core]", "\trepositoryformatversion = 0");
  const lfs = all.filter(([k]) => k.startsWith("filter.lfs."));
  if (lfs.length === 4 && lfs.every(([k, v]) => STOCK_LFS[k] === v)) {
    // The program is named by its whole path, found now: the name alone would
    // be looked up again at each run, and a PATH with a relative entry or one
    // inside a work tree would find a program a session wrote. One that is
    // inside any checkout of the repository is not run at all.
    const program = lfsProgram(checkouts(w));
    if (program) out.push('[filter "lfs"]', ...Object.entries(STOCK_LFS).map(([k, v]) => `\t${k.slice("filter.lfs.".length)} = ${quoted(v.replace(/^git-lfs/, shq(program)))}`));
  }
  const leads: Leads = { rewrites: all.filter(([k]) => /^url\..+\.(insteadof|pushinsteadof)$/.test(k)), includes: all.some(([k]) => /^include(if\..*)?\.path$/.test(k)) };
  return { config: out.join("\n") + "\n", leads };
}

// What a view was made from (the two config files and which of the shared
// stores the repository has) and the config written into it. A view is made
// again when one of those changed, or when its config is not what was written
// (a session that is not confined can write the state folder). Files that
// come and go at the top of a git directory (FETCH_HEAD, a lock) change nothing.
const made = new Map<string, { from: string; config: string; leads: Leads }>();
const textOf = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } };
const stamp = (p: string) => { try { const st = statSync(p, { bigint: true }); return `${st.ino}:${st.size}:${st.mtimeNs}`; } catch { return "-"; } };

// A link put in place whole: made under a name of its own and renamed over
// what is there, so two processes that make the same view never find a half
// of it (the command line and the daemon share the state folder).
function link(target: string, at: string) {
  let now: string | undefined;
  try { now = readlinkSync(at); } catch {} // nothing there, or no link
  if (now === target) return;
  const tmp = `${at}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.lock`;
  symlinkSync(target, tmp);
  try {
    renameSync(tmp, at);
  } catch {
    // A folder is in the way (it has no place in a view).
    rmSync(at, { recursive: true, force: true });
    renameSync(tmp, at);
  }
}

function viewOf(w: Where): string {
  if (!pruned) pruneViews();
  const view = join(viewRoot(), createHash("sha256").update(w.gitDir).digest("hex").slice(0, 24));
  const names = SHARED.filter((n) => existsSync(join(w.common, n)));
  const from = [stamp(join(w.common, "config")), stamp(join(w.gitDir, "config.worktree")), stamp(join(w.common, "worktrees")), names.join("/")].join("|");
  const kept = made.get(view);
  if (kept?.from === from && textOf(join(view, "config")) === kept.config) return view;
  mkdirSync(join(view, "info"), { recursive: true, mode: 0o700 });
  const wanted = new Set([...names, ...ALWAYS]);
  for (const n of wanted) link(join(w.common, n), join(view, n));
  // What the repository no longer has, and whatever else got in (not another process's file on its way in).
  for (const n of readdirSync(view)) if (n !== "config" && n !== "info" && n !== ORIGIN && !n.endsWith(".lock") && !wanted.has(n)) rmSync(join(view, n), { recursive: true, force: true });
  // Nothing in info but the link: an attributes file there would turn drivers on.
  for (const n of readdirSync(join(view, "info"))) if (n !== "exclude" && !n.endsWith(".lock")) rmSync(join(view, "info", n), { recursive: true, force: true });
  if (textOf(join(view, ORIGIN)) !== w.gitDir) writeFileSync(join(view, ORIGIN), w.gitDir, { mode: 0o600 });
  link(join(w.common, "info/exclude"), join(view, "info/exclude"));
  // Whole or not at all: a call that reads the view meanwhile sees the old file or the new one.
  const tmp = join(view, `config.${process.pid}.${Math.random().toString(36).slice(2, 8)}.lock`);
  const { config, leads } = viewConfig(w);
  // A repository that uses Git LFS and has stored no object yet has no `lfs`
  // folder to link. git-lfs would then make one inside the view and keep its
  // objects there, where the repository never finds them. So the folder is
  // made where git-lfs itself makes it at first use, and linked.
  const usesLfs = () => config.includes('[filter "lfs"]') || (trustedConfig().lfs && !!w.top && /filter=lfs\b/.test(textOf(join(w.top, ".gitattributes")) ?? ""));
  if (!wanted.has("lfs") && usesLfs()) {
    try { mkdirSync(join(w.common, "lfs")); link(join(w.common, "lfs"), join(view, "lfs")); names.push("lfs"); } catch {} // not ours to make: git-lfs says so when it runs
  }
  writeFileSync(tmp, config, { mode: 0o600 });
  renameSync(tmp, join(view, "config"));
  made.set(view, { from: [stamp(join(w.common, "config")), stamp(join(w.gitDir, "config.worktree")), stamp(join(w.common, "worktrees")), names.join("/")].join("|"), config, leads });
  if (made.size > 512) made.delete(made.keys().next().value!);
  return view;
}

// ---- the environment and the keys every call gets ----

// Set at command-line precedence for every call. Each is the documented way
// to turn the thing off (git-config(1) under the key's name).
const KEYS: [string, string][] = [
  ["core.fsmonitor", "false"],             // a file-system monitor program
  ["core.hooksPath", "/dev/null"],         // every hook
  ["core.pager", "cat"],
  ["core.editor", "true"],
  ["sequence.editor", "true"],
  ["protocol.ext.allow", "never"],         // the ext:: transport runs a command
  ["protocol.file.allow", "never"],        // a local path as a remote (see FILE_USER): never, but for the calls that say so
  ["submodule.recurse", "false"],
  ["diff.ignoreSubmodules", "dirty"],      // a status or a diff never runs git inside a submodule
  ["status.submoduleSummary", "false"],
  ["fetch.recurseSubmodules", "false"],
  ["push.recurseSubmodules", "no"],
  ["log.showSignature", "false"],          // no gpg program on a log
  ["gc.auto", "0"],                        // nothing is started in the background
  ["maintenance.auto", "false"],
];
// What addresses a repository or adds config, in the environment the daemon was started with: none of it reaches a call.
const DROPPED = /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|EXTERNAL_DIFF|ATTR_SOURCE|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/;

// For a call that may fetch: only these transports are spoken, so no other
// transport program (a `git-remote-<name>` found on PATH) is ever started
// (git-config(1), protocol.allow and protocol.<name>.allow).
export const FETCH_KEYS: [string, string][] = [
  ["protocol.allow", "never"],
  ["protocol.https.allow", "always"],
  ["protocol.http.allow", "always"],
  ["protocol.ssh.allow", "always"],
  ["protocol.git.allow", "always"],
];

// `file`: what the file transport is allowed. "user" is git's own default
// (git-config(1), protocol.allow): a local path the command itself names is
// used, one a submodule or a redirect names is not.
// `fetches`: the call may fetch (FETCH_KEYS).
function baseEnv(file: "never" | "user" = "never", fetches = false): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !DROPPED.test(k)) env[k] = v;
  const keys = fetches ? [...KEYS, ...FETCH_KEYS] : KEYS;
  Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_CONFIG_COUNT: String(keys.length) });
  keys.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = k === "protocol.file.allow" ? file : v; });
  return env;
}

// The same keys for a shell script that runs git by itself on another
// machine (a session's move): one line of exports to put before it. Such a
// script is not run through a view.
// (Without the file transport's key: a move carries its state as a bundle file.)
// Nothing is fetched on demand by a script either, whatever the route that
// runs it does with the view: a daemon of an older build ignores the view,
// and its git would read a nested repository's own promisor remote.
const SHELL_KEYS = KEYS.filter(([k]) => k !== "protocol.file.allow");
// Before the fill of a new worktree in such a script: the fetch is turned on
// only when the route that runs the script allowed it for the repository in
// its folder (it then sets KEEL_GIT_FETCH: see gitEnv), with the transports
// of FETCH_KEYS. A machine of an older build never sets it: nothing is fetched there.
const SHELL_FETCH: [string, string][] = [...FETCH_KEYS, ["protocol.file.allow", "user"]];
export const GIT_SHELL_FETCH = `if [ -n "\${KEEL_GIT_FETCH:-}" ]; then unset GIT_NO_LAZY_FETCH; export GIT_CONFIG_COUNT=${SHELL_KEYS.length + SHELL_FETCH.length} ${SHELL_FETCH.map(([k, v], i) => `GIT_CONFIG_KEY_${SHELL_KEYS.length + i}=${k} GIT_CONFIG_VALUE_${SHELL_KEYS.length + i}=${v}`).join(" ")}; fi\n`;
// The settings of GIT_SHELL_ENV as assignments: what a command that starts without the environment (env -i) gives
// back (src/safety/shared-branches.ts reads them).
export const SHELL_GIT_SETTINGS: readonly string[] = [`GIT_CONFIG_COUNT=${SHELL_KEYS.length}`, ...SHELL_KEYS.flatMap(([k, v], i) => [`GIT_CONFIG_KEY_${i}=${k}`, `GIT_CONFIG_VALUE_${i}=${v}`])];
export const GIT_SHELL_ENV = `export GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true ${SHELL_GIT_SETTINGS.join(" ")}`;

// git's options that come before the subcommand, with the ones that take a value.
const TAKES_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix", "--attr-source"]);
const subcommandAt = (args: string[]) => {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += TAKES_VALUE.has(args[i]!) ? 2 : 1;
  return i;
};
const DIFFS = new Set(["diff", "diff-tree", "diff-index", "diff-files", "show", "log", "whatchanged", "format-patch"]);
// The worktree list is kept in the real common directory by path: these run on it.
const LIST_ADMIN = new Set(["add", "remove", "prune", "list", "repair", "move", "lock", "unlock"]);
// After `worktree add`: the options that take a value, to find the path.
const ADD_VALUES = new Set(["-b", "-B", "--reason", "--orphan"]);

// `refused`: why this call fetches nothing on demand. `intoFolder`: a push into a repository that is a folder on this machine.
type Plan = { argv: string[]; env: Record<string, string>; cwd: string; after?: { dir: string; branch?: string }; refused?: string; intoFolder?: true; pushTo?: string } | { fail: string };
// Told of each push the daemon's git made to an address off this machine, when it ended (the outward ledger,
// src/safety/egress.ts, wires it): called where the push was asked for, so it is that call's.
let pushed: ((p: { to: string; ok: boolean; err: string }) => void) | undefined;
export const onGitPush = (f: typeof pushed) => void (pushed = f);
// The keys of a call's environment, set again for what it may reach.
function setKeys(env: Record<string, string>, file: "never" | "user", fetches: boolean) {
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) delete env[k];
  for (const [k, v] of Object.entries(baseEnv(file, fetches))) if (k.startsWith("GIT_CONFIG_")) env[k] = v;
}

// A remote's address that is a folder on this machine.
const localPath = (url: string) => url.startsWith("file://") || url.startsWith("/") || url.startsWith("./") || url.startsWith("../") || (!url.includes("://") && !/^[^/]*:/.test(url));
// The remotes of a view's config, as viewConfig writes them: each one's
// address, and whether missing objects are fetched from it (a promisor).
type Remote = { url?: string; pushurl?: string; promisor?: boolean };
function remotesOf(config: string): Map<string, Remote> {
  const out = new Map<string, Remote>();
  let name: string | undefined, extensions = false;
  const unq = (v: string) => { try { return JSON.parse(v) as string; } catch { return v; } };
  const of = (n: string) => out.get(n) ?? (out.set(n, {}), out.get(n)!);
  for (const line of config.split("\n")) {
    const head = /^\[remote (".*")\]$/.exec(line);
    if (line.startsWith("[")) { name = head ? unq(head[1]!) : undefined; extensions = line === "[extensions]"; }
    else if (name !== undefined && line.startsWith("\turl = ")) of(name).url = unq(line.slice("\turl = ".length));
    else if (name !== undefined && line.startsWith("\tpushurl = ")) of(name).pushurl = unq(line.slice("\tpushurl = ".length));
    else if (name !== undefined && line.startsWith("\tpromisor = ")) of(name).promisor = /^(true|yes|on|1)$/i.test(unq(line.slice("\tpromisor = ".length)));
    else if (extensions && line.startsWith("\tpartialclone = ")) of(unq(line.slice("\tpartialclone = ".length))).promisor = true;
  }
  return out;
}
// The host a remote's address names, or nothing for a folder on this machine.
function hostOf(url: string): string | undefined {
  if (localPath(url)) return undefined;
  if (url.includes("://")) { try { return new URL(url).hostname; } catch { return ""; } }
  // (The short ssh form, [user@]host:path.)
  return /^(?:[^@/]*@)?([^:/]+):/.exec(url)?.[1] ?? "";
}
// Why a fetch on demand is not made for the repository of a view, or nothing
// when it may be: `allowed` is how far the session it is for reaches.
function noFetch(view: string, allowed: GitFetch | undefined): string | undefined {
  if (!allowed) return "Keel fetches nothing for a session whose own commands cannot reach the network";
  for (const [name, r] of remotesOf(made.get(view)?.config ?? "")) {
    if (!r.promisor || r.url === undefined) continue;
    // (`<name>::<address>`: a transport program of that name, gitremote-helpers(7).)
    const other = /^([A-Za-z0-9][A-Za-z0-9+.-]*)::/.exec(r.url)?.[1];
    if (other) return `the remote ${name} uses the transport ${other}, and Keel's git speaks https, http, ssh and git only`;
    if (allowed === "any") continue;
    const host = hostOf(r.url);
    if (host !== undefined && (host === "" || privateHost(host))) return `the remote ${name} is at an address on this machine or a private network (${host || r.url}), which Keel fetches from only for a session whose sandbox is off`;
  }
  return undefined;
}

function plan(dir: string, args: string[], o: GitOpts): Plan {
  const env = { ...baseEnv(), ...o.env };
  if (o.read) env.GIT_OPTIONAL_LOCKS = "0";
  if (o.index) env.GIT_INDEX_FILE = o.index;
  const at = subcommandAt(args);
  const sub = args[at];
  // (The plumbing diffs do not read diff.ignoreSubmodules: the flag says it for every one.)
  const argv = ["git", "--no-pager", ...args.slice(0, at + 1), ...(sub && DIFFS.has(sub) ? ["--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty"] : sub === "status" ? ["--ignore-submodules=dirty"] : []), ...args.slice(at + 1)];
  let after: { dir: string; branch?: string } | undefined;
  let mode = o.mode ?? "repo";
  if (mode === "repo" && sub === "worktree" && LIST_ADMIN.has(args[at + 1] ?? "")) {
    mode = "plain";
    if (args[at + 1] === "add") {
      // Made without a checkout (no filter, no hook), then checked out through the view.
      let i = at + 2;
      while (i < args.length && args[i]!.startsWith("-")) i += ADD_VALUES.has(args[i]!) ? 2 : 1;
      if (args[i] === undefined) return { fail: "git worktree add: no path" };
      // (`-b`: the branch is this call's own, and goes with a worktree that could not be filled.)
      const made = args.indexOf("-b", at + 2);
      after = { dir: resolve(dir, args[i]!), ...(made > 0 && made < i ? { branch: args[made + 1] } : {}) };
      if (!args.includes("--no-checkout")) argv.splice(argv.indexOf("add") + 1, 0, "--no-checkout");
    }
  }
  // A clone names what it fetches on its own command line: the transports a
  // fetch may use, and a local path as git's own default allows it ("user").
  if (sub === "clone") setKeys(env, "user", true);
  if (mode === "plain") return { argv, env, cwd: dir, after };
  if (mode === "own") {
    if (!o.gitDir) return { fail: "git: no git directory given" };
    env.GIT_DIR = o.gitDir;
    if (o.workTree) env.GIT_WORK_TREE = o.workTree;
    return { argv, env, cwd: dir };
  }
  const w = find(dir);
  if (!w) return { fail: `fatal: not a git repository: ${dir}` };
  if (!ours(w)) return { fail: `fatal: detected dubious ownership in repository at '${w.top ?? w.gitDir}': it is another user's, and not listed in safe.directory` };
  env.GIT_DIR = w.gitDir;
  const view = viewOf(w);
  env.GIT_COMMON_DIR = view;
  if (w.top) env.GIT_WORK_TREE = w.top;
  // Objects a partial clone lacks are fetched only for a call that says how
  // far it may reach, and only from where that reaches (see `fetch`).
  const refused = noFetch(view, o.fetch);
  if (refused) env.GIT_NO_LAZY_FETCH = "1";
  else setKeys(env, "user", true);
  // A push or a fetch to a remote the repository names by a folder on this
  // machine: the file transport is used as git's default allows it, and
  // what runs in that folder is named in the view (RECEIVE_PACK).
  let intoFolder = false;
  if (sub === "push" || sub === "fetch") {
    const remote = args.slice(at + 1).find((a) => !a.startsWith("-"));
    const named = remote === undefined ? undefined : remotesOf(made.get(view)?.config ?? "").get(remote);
    const url = sub === "push" ? named?.pushurl ?? named?.url : named?.url;
    intoFolder = url !== undefined && localPath(url);
    if (intoFolder || sub === "fetch") setKeys(env, intoFolder ? "user" : "never", sub === "fetch");
    // (A push names its remote, or an address in its place.)
    const to = sub === "push" ? url ?? (remote !== undefined && !localPath(remote) ? remote : undefined) : undefined;
    if (to !== undefined && !localPath(to)) return { argv, env, cwd: dir, ...(refused ? { refused } : {}), pushTo: to };
  }
  return { argv, env, cwd: dir, ...(refused ? { refused } : {}), ...(intoFolder && sub === "push" ? { intoFolder: true as const } : {}) };
}

const bytes = (input: GitOpts["input"]) => (input === undefined ? "ignore" as const : typeof input === "string" ? new TextEncoder().encode(input) : input);

async function readBytes(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of chunks(s)) parts.push(c);
  return Buffer.concat(parts);
}

// git in `dir`. Never throws for a failed command: the code says.
const LOW = [...(Bun.which("nice") ? ["nice", "-n", "10"] : []), ...(Bun.which("ionice") ? ["ionice", "-c2", "-n7"] : [])];
export async function git(dir: string, args: string[], o: GitOpts = {}): Promise<GitResult> {
  let p: Plan;
  try { p = plan(dir, args, o); } catch (e) { return { code: 128, out: "", err: `git: ${(e as Error).message}` }; }
  if ("fail" in p) return { code: 128, out: "", err: p.fail };
  if (o.config?.length) {
    const n = Number(p.env.GIT_CONFIG_COUNT ?? 0);
    o.config.forEach(([k, v], i) => { p.env[`GIT_CONFIG_KEY_${n + i}`] = k; p.env[`GIT_CONFIG_VALUE_${n + i}`] = v; });
    p.env.GIT_CONFIG_COUNT = String(n + o.config.length);
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(o.low ? [...LOW, ...p.argv] : p.argv, { cwd: p.cwd, env: p.env, stdin: bytes(o.input), stdout: "pipe", stderr: "pipe", timeout: o.timeout ?? 120_000, killSignal: "SIGKILL", signal: o.signal });
  } catch (e) {
    return { code: 127, out: "", err: `git could not start: ${(e as Error).message}` };
  }
  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  const [got, err, code] = await Promise.all([o.raw ? readBytes(stdout) : readText(stdout), readText(proc.stderr as ReadableStream<Uint8Array>), proc.exited]);
  const out = typeof got === "string" ? got : "";
  if (typeof got !== "string") return { code: proc.signalCode ? -1 : code, out, err, bytes: got };
  if (p.pushTo) try { pushed?.({ to: p.pushTo, ok: code === 0, err }); } catch {} // a ledger row never fails the push
  if (code === 0 && p.after) {
    // The new worktree's files, as `git worktree add` itself puts them there.
    const filled = await git(p.after.dir, ["reset", "-q", "--hard", "--no-recurse-submodules"], { env: o.env, timeout: o.timeout, signal: o.signal, fetch: o.fetch });
    if (filled.code !== 0) {
      // Nothing of a worktree that could not be filled stays: its folder,
      // its entry in the repository and the branch this call made for it.
      await git(dir, ["worktree", "remove", "--force", p.after.dir], { timeout: 30_000 });
      if (p.after.branch) await git(dir, ["branch", "-D", p.after.branch], { timeout: 30_000 });
      const missing = /promisor|could not fetch|missing blob|lazy fetching disabled|transport '[^']*' not allowed/i.test(filled.err);
      // (Why nothing was fetched, when Keel itself held the fetch back.)
      const held = missing ? whyNoFetch(dir, o.fetch) : undefined;
      return { ...filled, err: missing ? `${filled.err.trim()}\nThe repository is a partial clone and a file of that commit could not be fetched${held ? `: ${held}` : ""}. Fetch its files first (git -C ${dir} archive ${args.at(-1)} >/dev/null), then try again.` : filled.err };
    }
  }
  // A push into a branch that is checked out in a folder on this machine is refused there (RECEIVE_PACK): say why.
  if (code !== 0 && p.intoFolder && /checked out/i.test(err)) {
    return { code, out, err: `${err.trim()}\nKeel does not push into a branch that is checked out in the repository it pushes to (updating the files there would run that repository's own programs): check out another branch there, or push to a bare repository.` };
  }
  return { code: proc.signalCode ? -1 : code, out, err };
}

// `git remote -v` in `dir` as the owner's own git prints it there: the remotes of the view, their addresses rewritten
// by the repository's own url.<base>.insteadOf and .pushInsteadOf as well as the owner's (git applies them: the
// repository's are this read's own keys, after the owner's as in a repository's config, and a listing connects
// nowhere). `includes`: the repository's config includes other files, which Keel does not read, so the listing may
// not be the one his git uses.
export async function remotesAsRun(dir: string, timeout: number): Promise<GitResult & { includes?: true }> {
  let leads: Leads | undefined;
  try { const w = locate(dir); if (w) leads = made.get(viewOf(w))?.leads; } catch {} // the listing below says what failed
  const r = await git(dir, ["remote", "-v"], { read: true, timeout, ...(leads?.rewrites.length ? { config: leads.rewrites } : {}) });
  return leads?.includes ? { ...r, includes: true } : r;
}

// The entries a listing prints (with -z), handed to `each` a pipe's chunk at a time as they come, so the
// listing is never held whole: one of a folder that holds many repositories printed 48 MB, and reading
// that into one string and splitting it held the loop for seconds. `each` returns false to stop: git is
// killed there (`stopped`), and when `each` throws (which it passes on). Never throws for a failed command:
// the code says.
export async function gitEach(dir: string, args: string[], o: GitOpts, each: (entries: string[]) => boolean): Promise<{ code: number; err: string; stopped?: true }> {
  let p: Plan;
  try { p = plan(dir, args, o); } catch (e) { return { code: 128, err: `git: ${(e as Error).message}` }; }
  if ("fail" in p) return { code: 128, err: p.fail };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(p.argv, { cwd: p.cwd, env: p.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: o.timeout ?? 120_000, killSignal: "SIGKILL", signal: o.signal });
  } catch (e) {
    return { code: 127, err: `git could not start: ${(e as Error).message}` };
  }
  const err = readText(proc.stderr as ReadableStream<Uint8Array>);
  const text = new TextDecoder();
  let rest = "", stopped = false, read = false;
  try {
    // (Left early, chunks() cancels the pipe.)
    for await (const value of chunks(proc.stdout as ReadableStream<Uint8Array>)) {
      const buf = rest + text.decode(value, { stream: true });
      const parts = buf.split("\0");
      rest = parts.pop()!;
      if (parts.length && !each(parts)) { stopped = true; break; }
      // A pipe that holds more resolves the next read at once, as a microtask: without a turn of the
      // loop between chunks the whole listing would still run as one task, and nothing else would.
      await new Promise<void>((done) => setImmediate(done));
    }
    if (!stopped && rest) stopped = !each([rest]);
    read = !stopped;
  } finally {
    // Stopped, or `each` threw: git would wait on a full pipe until its timeout.
    if (!read) {
      try { proc.kill("SIGKILL"); } catch { /* gone already */ }
      err.catch(() => {});
    }
  }
  const code = await proc.exited;
  const e = await err;
  if (stopped) return { code: 0, err: e, stopped: true };
  return { code: proc.signalCode ? -1 : code, err: e };
}

// The first `max` names a listing prints (with -z), and no more: git is stopped there, so a listing over a very
// large index costs what its first names cost. `pick`: only the entries it takes are counted. `none`: no
// repository here. `late`: it did not answer in time. `failed`: git refused the call (a path outside the
// repository). The deadline is the call's own: git and what it started are killed there, and a pipe that one of
// them still holds open is not waited for.
export async function gitNames(dir: string, args: string[], max: number, timeout: number, pick?: (entry: string) => boolean): Promise<{ names: string[]; none?: true; late?: true; failed?: true }> {
  let p: Plan;
  try { p = plan(dir, args, { read: true }); } catch { return { names: [], failed: true }; }
  if ("fail" in p) return { names: [], none: true };
  let proc: ReturnType<typeof Bun.spawn>;
  try { proc = Bun.spawn(p.argv, { cwd: p.cwd, env: p.env, stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true }); } catch { return { names: [], failed: true }; }
  const stop = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch { /* gone already */ } } };
  let late = false, timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((done) => { timer = setTimeout(() => { late = true; stop(); done(); }, timeout); });
  const names: string[] = [];
  const text = new TextDecoder();
  let rest = "";
  try {
    for await (const chunk of chunksUntil(proc.stdout as ReadableStream<Uint8Array>, deadline)) {
      rest += text.decode(chunk, { stream: true });
      for (let at = rest.indexOf("\0"); at >= 0 && names.length < max; at = rest.indexOf("\0")) { const entry = rest.slice(0, at); if (!pick || pick(entry)) names.push(entry); rest = rest.slice(at + 1); }
      if (names.length >= max) break;
      if (rest.length > 65_536) rest = rest.slice(-4_096); // one name longer than any path: not kept whole
    }
    if (names.length >= max) { stop(); return { names }; }
    if (late) return { names, late: true };
    const code = await Promise.race([proc.exited, deadline.then(() => null)]);
    if (code === null || late) return { names, late: true };
    return code === 0 ? { names } : { names: [], failed: true };
  } finally {
    clearTimeout(timer);
  }
}

// Why a call in `dir` that may fetch as far as `fetch` fetches nothing, or nothing when it may.
function whyNoFetch(dir: string, fetch: GitFetch | undefined): string | undefined {
  try {
    const p = plan(dir, ["status"], { fetch });
    return "fail" in p ? undefined : p.refused;
  } catch {
    return undefined;
  }
}

// The environment for a program that runs git by itself in `dir` (gh, a
// script of the daemon's own): its git calls go through the same view.
// `fetch`: the script fills a work tree and may fetch that far (see
// GitOpts.fetch); KEEL_GIT_FETCH is set when the repository's remotes are
// within it, which the script's own lines look for (GIT_SHELL_FETCH).
export function gitEnv(dir: string, fetch?: GitFetch): Record<string, string> {
  try {
    const p = plan(dir, ["status"], { fetch });
    if ("fail" in p) return baseEnv();
    return fetch && !p.refused ? { ...p.env, KEEL_GIT_FETCH: "1" } : p.env;
  } catch {
    return baseEnv();
  }
}

export function gitSync(dir: string, args: string[], o: Omit<GitOpts, "signal"> = {}): GitResult {
  let p: Plan;
  try { p = plan(dir, args, o); } catch (e) { return { code: 128, out: "", err: `git: ${(e as Error).message}` }; }
  if ("fail" in p) return { code: 128, out: "", err: p.fail };
  if (p.after) return { code: 128, out: "", err: "git worktree add is not run in the loop" };
  try {
    const r = Bun.spawnSync(p.argv, { cwd: p.cwd, env: p.env, stdin: bytes(o.input), stdout: "pipe", stderr: "pipe", timeout: o.timeout ?? 10_000 });
    return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
  } catch (e) {
    return { code: 127, out: "", err: `git could not start: ${(e as Error).message}` };
  }
}

// ---- repositories inside a work tree ----
//
// A work tree can hold other repositories: a submodule that is checked out
// (a gitlink in the index, with a `.git` in its folder) and a folder with a
// `.git` of its own that the outer repository does not track. git asks such
// a repository about itself by running git inside it (`add` does, and
// `status` unless told not to), and that git reads the inner repository's own
// config and attributes: a filter named there would run for the daemon. So
// the daemon's git never goes into one from outside:
// - a status never looks inside (diff.ignoreSubmodules=dirty in KEYS);
// - an add leaves every inner repository out (exclude pathspecs) and records
//   it as git itself would, a gitlink at the commit it has out, read through
//   the inner repository's own view;
// - whether one holds uncommitted work is asked of it through its own view.

// The checked-out gitlinks of a listing (`ls-files -s -z`), by path.
const linksIn = (top: string, listing: string) =>
  listing.split("\0").filter((r) => r.startsWith("160000 ")).map((r) => r.slice(r.indexOf("\t") + 1)).filter((p) => existsSync(join(top, p, ".git")));
// The untracked repositories of a listing (`ls-files -o --exclude-standard -z`):
// git names such a folder, at any depth, and does not go in.
export const nestedIn = (listing: string) => listing.split("\0").filter((p) => p.endsWith("/")).map((p) => p.slice(0, -1));
// The folder of an inner repository, when the repository found from it is
// its own. One whose `.git` is damaged is found as a part of the repository
// around it: asking that for its state would answer for the outer one.
function innerDir(top: string, path: string): string | null {
  try {
    const dir = realpathSync(join(top, path));
    return locate(dir)?.top === dir ? dir : null;
  } catch {
    return null;
  }
}

// The commit an inner repository has out, as addAll asks for it; undefined for one with no commit yet, or that cannot be read.
export async function innerHead(top: string, path: string): Promise<string | undefined> {
  const dir = innerDir(top, path);
  const r = dir ? await git(dir, ["rev-parse", "--verify", "-q", "HEAD"], { read: true, timeout: 10_000 }) : undefined;
  return r?.code === 0 && /^[0-9a-f]+$/.test(r.out.trim()) ? r.out.trim() : undefined;
}

// A caller's own way to run git at the top of its work tree (its index, its git directory): stdout, or it throws.
export type RunGit = (args: string[], input?: string) => Promise<string>;

export async function innerRepos(top: string, run: RunGit): Promise<{ path: string; tracked: boolean }[]> {
  const [staged, others] = await Promise.all([run(["ls-files", "-s", "-z"]), run(["ls-files", "-o", "--exclude-standard", "-z"])]);
  const tracked = linksIn(top, staged);
  return [...tracked.map((path) => ({ path, tracked: true })), ...nestedIn(others).filter((p) => !tracked.includes(p)).map((path) => ({ path, tracked: false }))];
}

// `git add -A` over the whole work tree without git running inside an inner
// repository. `flags`: the caller's own (--ignore-errors, --sparse).
// Returns the inner repositories, each as it was recorded.
export async function addAll(top: string, run: RunGit, flags: string[] = []): Promise<{ path: string; tracked: boolean; head?: string }[]> {
  const inner = await innerRepos(top, run);
  await run(["add", "-A", ...flags, "--", ".", ...inner.map((i) => `:(top,exclude,literal)${i.path}`)]);
  // The length of an object name in the outer store: a repository of another
  // hash format has no commit this index can point at, and is left out, as
  // git's own add leaves it.
  const length = (await run(["rev-parse", "--show-object-format"])).trim() === "sha256" ? 64 : 40;
  const out: { path: string; tracked: boolean; head?: string }[] = [];
  for (const i of inner) {
    // (One that cannot be read, or has no commit yet, is left as it is: there is nothing to point at.)
    const dir = innerDir(top, i.path);
    // (The name its HEAD holds, as git's own add reads it: a partial clone may not have the object.)
    const r = dir ? await git(dir, ["rev-parse", "--verify", "-q", "HEAD"], { read: true, timeout: 10_000 }) : undefined;
    const head = r?.code === 0 && /^[0-9a-f]+$/.test(r.out.trim()) && r.out.trim().length === length ? r.out.trim() : undefined;
    out.push({ ...i, head });
  }
  const links = out.filter((i) => i.head);
  if (links.length) await run(["update-index", "--add", "-z", "--index-info"], links.map((i) => `160000 ${i.head}\t${i.path}\0`).join(""));
  return out;
}

// What the submodules of a work tree hold that the outer repository does not:
// - `dirty`: uncommitted work (git's own status counts such a submodule as a changed entry);
// - `unpushed`: commits of its own that none of its remote-tracking refs holds.
//   They live in the submodule's git directory, which goes with a worktree.
//   A commit that the main checkout's copy of the same submodule holds is
//   not lost with the worktree's copy, and is not counted (a pull request's
//   head fetched by name, a shallow submodule);
// - `unknown`: the ones that could not be asked, never read as clean.
// Submodules inside submodules are asked too, a few levels down.
const DEPTH = 6;
export type InnerWork = { dirty: string[]; unpushed: string[]; unknown: string[] };
// `main`: the git directory the main checkout has for the repository of
// `top`, when `top` is in a linked worktree (found at the first level).
export async function innerWork(top: string, depth = 0, main?: string): Promise<InnerWork> {
  const out: InnerWork = { dirty: [], unpushed: [], unknown: [] };
  const staged = await git(top, ["ls-files", "-s", "-z"], { read: true, timeout: 30_000 });
  if (staged.code !== 0) return { ...out, unknown: ["."] };
  const outer = find(top);
  if (depth === 0 && outer && outer.gitDir !== outer.common) main = outer.common;
  for (const path of linksIn(top, staged.out)) {
    const dir = innerDir(top, path);
    if (!dir || depth >= DEPTH) { out.unknown.push(path); continue; }
    const [st, own] = await Promise.all([
      git(dir, ["status", "--porcelain", "-z"], { read: true, timeout: 30_000 }),
      git(dir, ["rev-list", "-n", "1", "HEAD", "--not", "--remotes", "--"], { read: true, timeout: 30_000 }),
    ]);
    if (st.code !== 0 || own.code !== 0) { out.unknown.push(path); continue; }
    if (st.out) out.dirty.push(path);
    // The main checkout's copy of this submodule: the same place under its git directory.
    const inner = find(dir);
    const copy = main && outer && inner && inner.gitDir.startsWith(`${outer.gitDir}/`) ? join(main, inner.gitDir.slice(outer.gitDir.length + 1)) : undefined;
    let mine = own.out.trim();
    if (mine && copy && isDir(copy) && (await git(dir, ["cat-file", "-e", `${mine}^{commit}`], { mode: "own", gitDir: copy, read: true, timeout: 30_000, env: { GIT_NO_LAZY_FETCH: "1" } })).code === 0) mine = "";
    if (mine) out.unpushed.push(path);
    const deeper = await innerWork(dir, depth + 1, copy);
    if (deeper.dirty.length && !st.out) out.dirty.push(path);
    if (deeper.unpushed.length && !mine) out.unpushed.push(path);
    out.unknown.push(...deeper.unknown.map((p) => (p === "." ? path : join(path, p))));
  }
  return out;
}
// The same for the repository facts, which are read in one go (`unpushed` is not asked there).
export function innerWorkSync(top: string, depth = 0): InnerWork {
  const out: InnerWork = { dirty: [], unpushed: [], unknown: [] };
  const staged = gitSync(top, ["ls-files", "-s", "-z"], { read: true, timeout: 3_000 });
  if (staged.code !== 0) return { ...out, unknown: ["."] };
  for (const path of linksIn(top, staged.out)) {
    const dir = innerDir(top, path);
    if (!dir || depth >= DEPTH) { out.unknown.push(path); continue; }
    const st = gitSync(dir, ["status", "--porcelain", "-z"], { read: true, timeout: 3_000 });
    if (st.code !== 0) { out.unknown.push(path); continue; }
    if (st.out) { out.dirty.push(path); continue; }
    const deeper = innerWorkSync(dir, depth + 1);
    if (deeper.dirty.length) out.dirty.push(path);
    out.unknown.push(...deeper.unknown.map((p) => (p === "." ? path : join(path, p))));
  }
  return out;
}
