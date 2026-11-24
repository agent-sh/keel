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

// The first two words of a gh command that are not options, and the repository it names (-R/--repo take a value).
function ghWords(args: string[]): { group?: string; verb?: string; repo?: string } {
  const out: string[] = [];
  let repo: string | undefined;
  // The repository flag stands anywhere on the line; the group and the verb are the first two words that are not options.
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-R" || a === "--repo") { repo = args[++i]; continue; }
    if (a.startsWith("--repo=")) { repo = a.slice(7); continue; }
    if (a === "--hostname") { i++; continue; }
    if (a.startsWith("-")) continue;
    if (out.length < 2) out.push(a);
  }
  return { group: out[0], verb: out[1], repo };
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
const COMMENT_ENDPOINT = /^\/?repos\/([^/]+\/[^/]+)\/(?:issues\/\d+\/comments|pulls\/\d+\/comments|pulls\/\d+\/comments\/\d+\/replies)$/;

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
  const m = endpoint.replace(/\?.*$/, "").match(COMMENT_ENDPOINT);
  const own = m && (m[1] === "{owner}/{repo}" || m[1]!.toLowerCase() === g.repo.toLowerCase());
  if (own && !input && (method === undefined || method === "POST")) return null;
  return why(`write through gh api (it reads, and comments on ${g.repo}'s pull requests)`, g);
}

function ghRefusal(s: Simple, args: string[], g: Guard): string | null {
  const { group, verb, repo } = ghWords(args);
  const text = args.join(" ");
  // A word made by an expansion where the group or the verb stands: not known, so not allowed. gh api's endpoint too.
  if (s.dyn?.length && (s.dyn.some((i) => i <= 3) || group === "api")) return why("run a gh command it cannot read here", g);
  if (group === "pr" && verb === "merge") return why("merge the pull request", g);
  if (group === "pr" && (verb === "close" || verb === "reopen")) return why("close or reopen the pull request", g);
  if (group === "pr" && verb === "review" && args.some((a) => a === "--approve" || a === "-a" || /^-[a-z]*a[a-z]*$/.test(a))) return why("approve the pull request", g);
  if (group === "pr" && verb === "edit" && /auto-?merge/i.test(text)) return why("turn on auto-merge", g);
  if ((group === "api" || group === "graphql") && MERGE_API.test(text)) return why("merge, auto-merge or approve through the API", g);
  if (group === "api" && REVIEW_API.test(text) && /\bAPPROVE\b/i.test(text)) return why("approve the pull request", g);
  if (repo && repo.toLowerCase() !== g.repo.toLowerCase()) return why(`act on ${repo}: this turn belongs to ${g.repo}`, g);
  if (group !== undefined) {
    const ok = GH_ALLOWED[group];
    if (ok === undefined || (ok !== "any" && (verb === undefined || !ok.includes(verb)))) return why(`run gh ${[group, verb].filter(Boolean).join(" ")} (it reads the pull request, its checks and runs, and comments)`, g);
    if (group === "api") return apiRefusal(args.slice(args.indexOf("api") + 1), g);
  }
  return null;
}

// What changes where git pushes or what git is: refused by name in this turn.
const GIT_REFUSED = new Set(["remote", "config", "worktree", "submodule", "symbolic-ref", "update-ref", "credential", "alias"]);
const GIT_MOVES = new Set(["checkout", "switch", "branch", "symbolic-ref", "update-ref", "reset", "worktree"]);
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
    if (GIT_REFUSED.has(c.sub)) return why(`run git ${c.sub}: it changes where the work goes`, g);
    if (GIT_MOVES.has(c.sub)) seen.moves++;
    if (c.sub !== "push") return null;
    seen.pushes++;
    if (g.head === undefined) return why("push from here: a helper of this turn does not push", g);
    const here = g.head();
    if (!here) return why("push: it cannot tell which branch the worktree is on", g);
    if (here !== g.branch) return why(`push from ${here}: the worktree must be on ${g.branch}`, g);
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

// A tool of a connected server that merges or approves (the GitHub server's own tools: merge_pull_request ...).
const MERGE_TOOL = /(^|[_.\-/])(merge_pull_request|merge_pr|enable_auto_merge|auto_merge|approve_pull_request|approve_pr|approve)([_.\-/]|$)/i;
const GITHUBISH = /github|(^|[_.\-/])gh([_.\-/]|$)/i;
const READ_TOOL = /^(get|list|search|read|view|find)_/;
const COMMENT_TOOL = /comment/;
const COMMENT_EDIT = /(delete|update|edit|resolve|unresolve|minimize|dismiss|lock)/;
export function toolRefusal(tool: string, g: Guard): string | null {
  if (MERGE_TOOL.test(tool)) return why(`use ${tool}: it merges or approves`, g);
  const bare = tool.replace(/^mcp__/, "").split(/__|[./]/).pop()!.toLowerCase();
  // A GitHub server's tools: reading, and saying something on the pull request. The rest (create, update, push, fork,
  // delete, a review's submit ...) is for the owner.
  if (GITHUBISH.test(tool) || /pull_request|(^|_)pr(_|$)/.test(bare)) {
    if (READ_TOOL.test(bare) || (COMMENT_TOOL.test(bare) && !COMMENT_EDIT.test(bare))) return null;
    return why(`use ${tool}: a GitHub tool may only read and comment in this turn`, g);
  }
  return null;
}
