// What a turn PR Steward started may not do, whatever the permission mode:
// merge the pull request, approve it, turn on auto-merge, close it, change
// the repository or its settings, or push anywhere but its own branch (or push
// it forced). The watch is the owner's errand; these are the owner's own acts.
// Pure: the gate asks while such a turn runs (src/safety/gate.ts, `stewards`),
// the watch says when one does (src/steward/watch.ts).
//
// A command is read the way the gate reads one (src/safety/shell.ts): each
// simple command, behind wrappers (env, sudo, nice, timeout), inside a
// `sh -c` string. A line this cannot read that names gh or git is refused:
// a turn that must stay in its lane does not get the benefit of the doubt.
//
// gh is an allow-list, not a deny-list: reading the pull request, its checks
// and runs, commenting, and `gh api` as a read (or a comment on this
// repository's pull requests). Everything else of gh (alias, workflow run,
// release, repo, secret, pr edit/create/checkout ...) is not for this turn.
// git is an allow-list too (GIT_ALLOWED): a subcommand that runs a command or
// pushes by another road (rebase --exec, bisect run, difftool, filter-branch,
// send-pack, subtree, lfs, http-push ...) is not in it.
//
// What this does not read, by design (the rest of the safety layer holds it):
// a script or an interpreter run from the line (`bash run.sh`, `python x.py`,
// `make`, a package script) is not opened; the provenance gate holds an
// outside host named only in GitHub text (src/safety/provenance.ts, kind
// "steward" is outside); and an alias already in the owner's own git or gh
// configuration is not read (git cannot shadow a built-in with one, and gh
// aliases are refused to be set here, not unwound); hooks, merge drivers and
// filters that files of the repository or the owner's configuration set run
// when git does and are not read.
import { resolve } from "node:path";
import { contains } from "../core/paths.ts";
import { gitCall, pushPlan } from "../safety/autonomy.ts";
import { unwrap, name } from "../safety/risk-words.ts";
import { splitCommand, type Simple } from "../safety/shell.ts";

// What a turn the watch started may touch. `dir` and `head` are the watch's own worktree and the branch it is on
// (git rev-parse, asked when a push is read); a helper agent of the turn has neither and pushes nothing.
export type Guard = { branch: string; repo: string; number: number; dir?: string; head?: () => string | undefined; upstream?: () => string | undefined };

// The turns the watch started, and the sessions below them: what each may do while the turn runs.
export const stewards: { of?: (sessionId: string) => Guard | undefined } = {};

const MERGE_API = /\bpulls?\/\d+\/merge\b|\bauto_?merge\b|enablePullRequestAutoMerge|mergePullRequest|approvePullRequestReview|disablePullRequestAutoMerge/i;
const REVIEW_API = /\bpulls?\/\d+\/reviews\b|addPullRequestReview|submitPullRequestReview/i;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "eval"]);

const why = (what: string, g: Guard) =>
  `Refused: this turn belongs to PR Steward, and it may not ${what}. Merging, approving, auto-merge and closing are the owner's. Push fixes to ${g.branch} with a plain \`git push\`, and say what you did.`;

function words(s: Simple): string[] { return unwrap(s.words).words; }

// Flags of gh's pr, issue and run commands that take a value: the word after one is not a target.
const VALUED = new Set(["-b", "--body", "-F", "--body-file", "-t", "--title", "-q", "--jq", "--json", "-H", "--header", "-m", "--message", "--template", "-B", "--base", "-j", "--job", "-l", "--label", "--assignee", "-A", "--author", "-s", "--state", "-L", "--limit", "-S", "--search", "--hostname"]);

// The short flags of gh's pr, issue and run commands that take a value (a cluster of short flags ends at one).
const SHORT_VALUED = new Set([...VALUED].filter((f) => /^-[A-Za-z]$/.test(f)).map((f) => f[1]!));

// The words of a gh command that are not options or their values, and the repositories it names: -R and --repo take a
// value, attached or not (`-Rowner/repo`, `-R=owner/repo`, `-wR owner/repo`, `--repo=owner/repo`).
function ghWords(args: string[]): { group?: string; verb?: string; target?: string; repo?: string; repos: string[]; all: string[] } {
  const out: string[] = [];
  const repos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--repo") { repos.push(args[++i] ?? ""); continue; }
    if (a.startsWith("--repo=")) { repos.push(a.slice(7)); continue; }
    if (VALUED.has(a)) { i++; continue; }
    if (/^-[A-Za-z]/.test(a) && !a.startsWith("--")) {
      // A cluster of short flags: the first one that takes a value takes the rest of the word (or the next word).
      for (let k = 1; k < a.length; k++) {
        const c = a[k]!;
        if (c !== "R" && !SHORT_VALUED.has(c)) continue;
        const rest = a.slice(k + 1).replace(/^=/, "");
        const v = rest || args[++i] || "";
        if (c === "R") repos.push(v);
        break;
      }
      continue;
    }
    if (a.startsWith("-")) continue;
    out.push(a);
  }
  return { group: out[0], verb: out[1], target: out[2], repo: repos[0], repos, all: out };
}

// A pull request or issue named by a word of a command: a number, #N, a URL, owner/repo#N or a branch.
function targetOf(word: string): { repo?: string; number?: number; branch?: string } {
  const url = word.match(/github\.com[/:]([^/\s]+\/[^/\s#?]+?)(?:\.git)?(?:\/(?:pull|pulls|issues)\/(\d+))?(?:[/?#].*)?$/i);
  if (url) return { repo: url[1], ...(url[2] ? { number: Number(url[2]) } : {}) };
  const ref = word.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (ref) return { repo: ref[1], number: Number(ref[2]) };
  const n = word.match(/^#?(\d+)$/);
  if (n) return { number: Number(n[1]) };
  return { branch: word };
}

// Every word that names a repository (a URL, owner/repo#N) must name this one.
function namesOther(words: string[], g: Guard): string | undefined {
  for (const a of words) {
    const t = targetOf(a);
    if (t.repo && t.repo.toLowerCase() !== g.repo.toLowerCase()) return t.repo;
  }
  return undefined;
}

// What gh may do in this turn: the group and the verbs of it that read the pull request or say something on it.
const GH_ALLOWED: Record<string, readonly string[] | "any"> = {
  pr: ["view", "diff", "checks", "status", "list", "comment", "review"],
  run: ["view", "list", "watch", "rerun"],
  issue: ["view", "list", "status", "comment"],
  repo: ["view"],
  workflow: ["view", "list"],
  label: ["list"],
  auth: ["status"],
  search: "any", status: "any", browse: "any", api: "any", help: "any", version: "any",
};

const API_VALUED = new Set(["-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "--input", "-q", "--jq", "-t", "--template", "--cache", "--hostname", "-p", "--preview"]);
// The one place gh api may write: a comment on this repository's pull requests (or an issue of it).
const COMMENT_ENDPOINT = /^\/?repos\/([^/]+\/[^/]+)\/(?:issues|pulls)\/(\d+)\/comments(?:\/\d+\/replies)?$/;

function apiRefusal(args: string[], g: Guard): string | null {
  let endpoint: string | undefined;
  let method: string | undefined;
  let fields = false;
  let input = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--") && a.includes("=")) {
      const k = a.slice(0, a.indexOf("="));
      const v = a.slice(a.indexOf("=") + 1);
      if (k === "--method") method = v.toUpperCase();
      else if (k === "--field" || k === "--raw-field") fields = true;
      else if (k === "--input") input = true;
      else if (k === "--hostname") return why("use gh api on another host", g);
      continue;
    }
    if (/^-X./.test(a)) { method = a.slice(2).toUpperCase(); continue; }
    if (/^-[fF]./.test(a)) { fields = true; continue; }
    if (API_VALUED.has(a)) {
      const v = args[++i];
      if (a === "-X" || a === "--method") method = String(v ?? "").toUpperCase();
      else if (a === "-f" || a === "-F" || a === "--field" || a === "--raw-field") fields = true;
      else if (a === "--input") input = true;
      else if (a === "--hostname") return why("use gh api on another host", g);
      continue;
    }
    if (a.startsWith("-")) continue;
    endpoint ??= a;
  }
  if (!endpoint) return why("run gh api with no endpoint", g);
  if (/^\/?graphql\b/i.test(endpoint)) return why("use the GraphQL API (a mutation cannot be told from a query here)", g);
  const wrote = fields || input || (method !== undefined && method !== "GET");
  if (!wrote) return null;
  const m = endpoint.replace(/^https:\/\/api\.github\.com/i, "").replace(/\?.*$/, "").match(COMMENT_ENDPOINT);
  const own = m && (m[1] === "{owner}/{repo}" || m[1]!.toLowerCase() === g.repo.toLowerCase()) && Number(m[2]) === g.number;
  if (own && !input && (method === undefined || method === "POST")) return null;
  return why(`write through gh api (it reads, and comments on ${g.repo}#${g.number})`, g);
}

function ghRefusal(s: Simple, args: string[], g: Guard): string | null {
  const { group, verb, target, repos, all } = ghWords(args);
  const text = args.join(" ");
  // A word made by an expansion where the group or the verb stands: not known, so not allowed. gh api's endpoint too.
  if (s.dyn?.length && (s.dyn.some((i) => i <= 3) || group === "api")) return why("run a gh command it cannot read here", g);
  if (group === "pr" && verb === "merge") return why("merge the pull request", g);
  if (group === "pr" && (verb === "close" || verb === "reopen")) return why("close or reopen the pull request", g);
  if (group === "pr" && verb === "review" && args.some((a) => /^--approve(=|$)/.test(a) || /^-[a-z]*a[a-z]*$/.test(a))) return why("approve the pull request", g);
  if (group === "pr" && verb === "edit" && /auto-?merge/i.test(text)) return why("turn on auto-merge", g);
  if ((group === "api" || group === "graphql") && MERGE_API.test(text)) return why("merge, auto-merge or approve through the API", g);
  if (group === "api" && REVIEW_API.test(text) && /\bAPPROVE\b/i.test(text)) return why("approve the pull request", g);
  for (const repo of repos) if (repo.toLowerCase() !== g.repo.toLowerCase()) return why(`act on ${repo || "another repository"}: this turn belongs to ${g.repo}`, g);
  if (group !== "api") {
    const other = namesOther(all, g);
    if (other) return why(`act on ${other}: this turn belongs to ${g.repo}`, g);
    // Saying something is for this pull request only (an issue of the same number is the same thread).
    if ((group === "pr" && (verb === "comment" || verb === "review")) || (group === "issue" && verb === "comment")) {
      if (target !== undefined) {
        const t = targetOf(target);
        if (t.number !== undefined ? t.number !== g.number : t.branch !== g.branch) return why(`${verb} on ${target}: this turn belongs to ${g.repo}#${g.number}`, g);
      } else if (group === "issue") return why("comment with no pull request named", g);
    }
  }
  if (group !== undefined) {
    const ok = GH_ALLOWED[group];
    if (ok === undefined || (ok !== "any" && (verb === undefined || !ok.includes(verb)))) return why(`run gh ${[group, verb].filter(Boolean).join(" ")} (it reads the pull request, its checks and runs, and comments)`, g);
    if (group === "api") return apiRefusal(args.slice(args.indexOf("api") + 1), g);
  }
  return null;
}

// What git may do in this turn: the work on the tree and the plain exchange with origin. A subcommand that runs
// another command or reaches a remote by a road of its own is not here (bisect run, difftool, filter-branch, send-pack,
// subtree, lfs, http-push, submodule, remote, config, worktree, symbolic-ref, update-ref ...).
const GIT_ALLOWED = new Set(["status", "diff", "log", "show", "add", "commit", "push", "fetch", "pull", "rebase", "merge", "restore", "stash", "rev-parse", "rev-list", "branch", "checkout", "switch", "reset", "cherry-pick", "revert", "blame", "ls-files", "ls-tree", "cat-file", "show-ref", "merge-base", "diff-tree", "diff-index", "for-each-ref", "describe", "name-rev", "shortlog", "grep", "apply", "mv", "rm", "clean", "tag", "reflog", "help", "version", "whatchanged", "range-diff", "count-objects", "check-ignore", "merge-file"]);
// An option that runs a command, in any subcommand that takes it.
// git takes any unambiguous prefix of a long option (`--exe`, `--ex=`), so a name that starts one of these is one of them.
const RUNS_NAMES = ["exec", "upload-pack", "receive-pack", "open-files-in-pager", "ext-diff", "textconv", "tool", "extcmd"];
function runsCommand(a: string): boolean {
  if (/^-O./.test(a)) return true;
  const m = a.match(/^--([A-Za-z][A-Za-z-]*)(=.*)?$/s);
  return !!m && RUNS_NAMES.some((n) => n.startsWith(m[1]!.toLowerCase()));
}
// The remote of a branch's upstream or a start point: only origin is this turn's.
const originRef = (v: string | undefined) => v !== undefined && v.startsWith("origin/");
// `git branch -u X`, `--set-upstream-to[=]X` (or a prefix of it): where the branch's plain push and pull go from now on.
function upstreamTarget(args: string[]): string | undefined | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const lo = a.match(/^--([A-Za-z][A-Za-z-]*)(=(.*))?$/s);
    if (lo && "set-upstream-to".startsWith(lo[1]!.toLowerCase()) && lo[1]!.length >= 2) return lo[2] !== undefined ? lo[3] : (args[i + 1] ?? undefined);
    if (lo && "set-upstream".startsWith(lo[1]!.toLowerCase()) && lo[1]!.length >= 2) return lo[2] !== undefined ? lo[3] : (args[i + 1] ?? undefined);
    if (/^-[A-Za-z]*u/.test(a) && !a.startsWith("--")) { const rest = a.slice(a.indexOf("u") + 1); return rest || args[i + 1] || undefined; }
  }
  return null;
}
// The words of a push that are not options (the remote, then refspecs).
function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") { out.push(...args.slice(i + 1)); break; }
    if (a === "-o" || a === "--push-option") { i++; continue; }
    if (a.startsWith("-") && a !== "-") continue;
    out.push(a);
  }
  return out;
}
const GIT_MOVES = new Set(["checkout", "switch", "branch", "reset"]);
const ENV_SET = /^(GIT_[A-Za-z_]+|GH_REPO|GH_HOST|GH_TOKEN|GH_ENTERPRISE_TOKEN|GH_CONFIG_DIR|GH_PATH|GITHUB_TOKEN|GITHUB_ENTERPRISE_TOKEN)=/;

type Seen = { pushes: number; moves: number };

function part(s: Simple, g: Guard, depth: number, seen: Seen): string | null {
  const w = words(s);
  const prog = name(w[0]);
  if (s.words.some((a) => ENV_SET.test(a))) return why("set a git or gh variable that points them elsewhere", g);
  if (SHELLS.has(prog) && depth < 4) {
    // `bash -c 'gh pr merge 3'`: the string it runs is a command line of its own.
    for (const a of w.slice(1)) if (/\s/.test(a) || /^(gh|git)$/.test(a)) { const r = line(a, g, depth + 1, seen); if (r) return r; }
    return null;
  }
  if (prog === "cd" || prog === "pushd") {
    const t = w[1];
    if (g.dir === undefined) return null;
    if (t === undefined || t === "-" || /^[~$]/.test(t) || s.dyn?.length) return why("change to a folder it cannot read here", g);
    if (!contains(g.dir, resolve(g.dir, t))) return why(`change to ${t}, outside this worktree`, g);
    return null;
  }
  if (prog === "gh") return ghRefusal(s, w.slice(1), g);
  if (prog === "git") {
    const base = g.dir ?? "/";
    const c = gitCall(w, base, process.env.HOME || "/");
    if (!c) return why("run git in a form it cannot read here (-c, --git-dir, --work-tree, a GIT_ variable)", g);
    if (c.dir !== base && !(g.dir !== undefined && c.dir !== null && contains(g.dir, c.dir))) return why("run git in another folder (-C)", g);
    if (!GIT_ALLOWED.has(c.sub)) return why(`run git ${c.sub}: it may run another command or change where the work goes`, g);
    // rebase and difftool run what -x/--exec names (-x may stand in a cluster of short options).
    if (c.args.some((a) => runsCommand(a) || (c.sub === "rebase" && /^-[a-zA-Z]*x/.test(a)))) return why(`run git ${c.sub} with an option that runs a command`, g);
    if (GIT_MOVES.has(c.sub) || (c.sub === "rebase" && c.args.filter((a) => !a.startsWith("-")).length >= 2)) seen.moves++;
    if (c.sub === "branch") {
      const to = upstreamTarget(c.args);
      if (to !== null && !originRef(to)) return why(`set the upstream of a branch to ${to || "something it cannot read here"}: this turn pushes and pulls through origin`, g);
    }
    if (c.sub !== "push") return null;
    seen.pushes++;
    if (g.head === undefined) return why("push from here: a helper of this turn does not push", g);
    const here = g.head();
    if (!here) return why("push: it cannot tell which branch the worktree is on", g);
    if (here !== g.branch) return why(`push from ${here}: the worktree must be on ${g.branch}`, g);
    // A push that names no remote goes where the branch's upstream says; one whose upstream is not on origin names its place.
    const up = g.upstream?.();
    if (up && !originRef(up)) {
      const pos = positional(c.args);
      if (pos.length < 2) return why(`push with no remote and branch named: the branch follows ${up}, not origin (say \`git push origin ${g.branch}\`)`, g);
    }
    const plan = pushPlan(c.args, { branch: here, upstream: g.upstream?.() ?? `origin/${g.branch}`, remotes: { origin: "" } });
    if (!plan) return why("push in a form it cannot read here", g);
    if (plan.wide) return why(`push with ${plan.wide}`, g);
    if (plan.remote !== "origin") return why(`push to ${plan.remote}`, g);
    for (const u of plan.updates) {
      if (u.delete) return why(`delete ${u.dst} on the remote`, g);
      if (u.force) return why("force-push", g);
      if (!u.branch || u.dst !== g.branch) return why(`push to ${u.dst}`, g);
    }
    return null;
  }
  // Another way to the same API.
  if (prog === "curl" || prog === "wget" || prog === "http" || prog === "https") {
    const text = w.join(" ");
    if (MERGE_API.test(text)) return why("merge or approve through the API", g);
    if (/github\.com/i.test(text) && w.some((a, i) => /^(-X|--request|--method)$/.test(a) ? !/^GET$/i.test(w[i + 1] ?? "") : /^(-X.|-d|--data(-\w+)?(=.*)?|-F|--form|-T|--upload-file|--json|--post-data(=.*)?|--post-file(=.*)?|--body-data(=.*)?|--body-file(=.*)?|--method=(?!GET$).*)$/i.test(a) || /^(POST|PUT|PATCH|DELETE)$/.test(a))) return why("write to GitHub through curl (use gh pr comment)", g);
  }
  return null;
}

function line(command: string, g: Guard, depth = 0, seen: Seen = { pushes: 0, moves: 0 }): string | null {
  const parts = splitCommand(command);
  if (!parts) return /\b(gh|git)\b/.test(command) ? why("run a command line it cannot read here", g) : null;
  for (const s of parts) {
    const r = part(s, g, depth, seen);
    if (r) return r;
  }
  // `git switch other && git push`: the line is read before it runs, so what the push means is not what was checked.
  if (depth === 0 && seen.pushes && seen.moves) return why("push in the same line that moves the worktree to another branch", g);
  // The whole line once more, for the API forms a part may hide in a quoted string or a here-document.
  if (/\bgh\b|api\.github\.com/.test(command) && MERGE_API.test(command)) return why("merge, auto-merge or approve through the API", g);
  return null;
}

// A shell command line.
export const commandRefusal = (command: string, g: Guard): string | null => line(command, g);

// A tool of a connected server. Its name is read as words, whatever its case: mergePullRequest, merge-pull-request and
// merge_pull_request are one. Any tool with merge or approve in its name is refused on any server; a tool that
// touches a repository (a GitHub server's, or any tool with a repository word in its name) may only read and comment.
const GITHUBISH = /github|(^|[_.\-/])gh([_.\-/]|$)/i;
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const MERGE_WORDS = new Set(["merge", "merges", "automerge", "approve", "approves"]);
const REPO_WORDS = new Set(["pull", "pulls", "pr", "prs", "branch", "branches", "push", "commit", "commits", "fork", "workflow", "workflows", "release", "releases", "repo", "repository", "review", "reviews", "merge"]);
const REPO_NAMES = /create_or_update_file|delete_file|(^|_)(write|edit|move)_file($|_)/;
const READ_TOOL = /^(get|list|search|read|view|find)_/;
const COMMENT_TOOL = /comment/;
const COMMENT_EDIT = /(delete|update|edit|resolve|unresolve|minimize|dismiss|lock)/;
export function toolRefusal(tool: string, g: Guard): string | null {
  const bare = snake(tool.replace(/^mcp__/, "").split(/__|[./]/).pop()!);
  const tokens = bare.split("_");
  const all = snake(tool).split("_");
  if (tokens.some((t) => MERGE_WORDS.has(t)) || /auto_merge/.test(bare) || all.some((t) => t === "automerge")) return why(`use ${tool}: it merges or approves`, g);
  const touches = GITHUBISH.test(tool) || tokens.some((t) => REPO_WORDS.has(t)) || REPO_NAMES.test(bare);
  // Reading, and saying something on the pull request. The rest (create, update, push, fork, delete, a review's submit,
  // landing a branch ...) is for the owner.
  if (touches) {
    if (READ_TOOL.test(bare) || (COMMENT_TOOL.test(bare) && !COMMENT_EDIT.test(bare))) return null;
    return why(`use ${tool}: a tool that works on a repository may only read and comment in this turn`, g);
  }
  return null;
}
