// What a turn PR Steward started may not do, whatever the permission mode:
// merge the pull request, approve it, turn on auto-merge, close it, or push
// anywhere but its own branch (or push it forced). The watch is the owner's
// errand; these are the owner's own acts. Pure: the gate asks while such a
// turn runs (src/safety/gate.ts, `stewards`), the watch says when one does
// (src/steward/watch.ts).
//
// A command is read the way the gate reads one (src/safety/shell.ts): each
// simple command, behind wrappers (env, sudo, nice, timeout), inside a
// `sh -c` string. A line this cannot read that names gh or git is refused:
// a turn that must stay in its lane does not get the benefit of the doubt.
import { gitCall, pushPlan } from "../safety/autonomy.ts";
import { unwrap, name } from "../safety/risk-words.ts";
import { splitCommand, type Simple } from "../safety/shell.ts";

// The turns the watch started: the branch each may push to, while the turn runs.
export const stewards: { of?: (sessionId: string) => { branch: string; repo: string; number: number } | undefined } = {};

const MERGE_API = /\bpulls?\/\d+\/merge\b|\bauto_?merge\b|enablePullRequestAutoMerge|mergePullRequest|approvePullRequestReview|disablePullRequestAutoMerge/i;
const REVIEW_API = /\bpulls?\/\d+\/reviews\b|addPullRequestReview|submitPullRequestReview/i;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "eval"]);

const why = (what: string, branch: string) =>
  `Refused: this turn belongs to PR Steward, and it may not ${what}. Merging, approving, auto-merge and closing are the owner's. Push fixes to ${branch} with a plain \`git push\`, and say what you did.`;

function words(s: Simple): string[] { return unwrap(s.words).words; }

// The first two words of a gh command that are not options (-R/--repo take a value).
function ghWords(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length && out.length < 2; i++) {
    const a = args[i]!;
    if (a === "-R" || a === "--repo" || a === "--hostname") { i++; continue; }
    if (a.startsWith("-")) continue;
    out.push(a);
  }
  return out;
}

function part(s: Simple, branch: string, depth: number): string | null {
  const w = words(s);
  const prog = name(w[0]);
  if (SHELLS.has(prog) && depth < 4) {
    // `bash -c 'gh pr merge 3'`: the string it runs is a command line of its own.
    for (const a of w.slice(1)) if (/\s/.test(a) || /^(gh|git)$/.test(a)) { const r = line(a, branch, depth + 1); if (r) return r; }
    return null;
  }
  if (prog === "gh") {
    const args = w.slice(1);
    const [group, verb] = ghWords(args);
    const text = args.join(" ");
    // A word made by an expansion where the group or the verb stands: not known, so not allowed.
    if (s.dyn?.length && s.dyn.some((i) => i <= 3)) return why("run a gh command it cannot read here", branch);
    if (group === "pr" && verb === "merge") return why("merge the pull request", branch);
    if (group === "pr" && (verb === "close" || verb === "reopen")) return why("close or reopen the pull request", branch);
    if (group === "pr" && verb === "review" && args.some((a) => a === "--approve" || a === "-a" || /^-[a-z]*a[a-z]*$/.test(a))) return why("approve the pull request", branch);
    if (group === "pr" && verb === "edit" && /auto-?merge/i.test(text)) return why("turn on auto-merge", branch);
    if (group === "api" || group === "graphql") {
      if (MERGE_API.test(text)) return why("merge, auto-merge or approve through the API", branch);
      if (REVIEW_API.test(text) && /\bAPPROVE\b/i.test(text)) return why("approve the pull request", branch);
    }
    return null;
  }
  if (prog === "git") {
    const g = gitCall(w, "/", "/");
    if (!g) return w.includes("push") ? why("push in a form it cannot read here", branch) : null;
    if (g.sub !== "push") return null;
    const plan = pushPlan(g.args, { branch, upstream: `origin/${branch}`, remotes: { origin: "" } });
    if (!plan) return why("push in a form it cannot read here", branch);
    if (plan.wide) return why(`push with ${plan.wide}`, branch);
    if (plan.remote !== "origin") return why(`push to ${plan.remote}`, branch);
    for (const u of plan.updates) {
      if (u.delete) return why(`delete ${u.dst} on the remote`, branch);
      if (u.force) return why("force-push", branch);
      if (!u.branch || u.dst !== branch) return why(`push to ${u.dst}`, branch);
    }
    return null;
  }
  // Another way to the same API.
  if ((prog === "curl" || prog === "wget" || prog === "http") && MERGE_API.test(w.join(" "))) return why("merge or approve through the API", branch);
  return null;
}

function line(command: string, branch: string, depth = 0): string | null {
  const parts = splitCommand(command);
  if (!parts) return /\b(gh|git)\b/.test(command) ? why("run a command line it cannot read here", branch) : null;
  for (const s of parts) {
    const r = part(s, branch, depth);
    if (r) return r;
  }
  // The whole line once more, for the API forms a part may hide in a quoted string or a here-document.
  if (/\bgh\b|api\.github\.com/.test(command) && MERGE_API.test(command)) return why("merge, auto-merge or approve through the API", branch);
  return null;
}

// A shell command line.
export const commandRefusal = (command: string, branch: string): string | null => line(command, branch);

// A tool of a connected server that merges or approves (the GitHub server's own tools: merge_pull_request ...).
const MERGE_TOOL = /(^|[_.\-/])(merge_pull_request|merge_pr|enable_auto_merge|auto_merge|approve_pull_request|approve_pr|approve)([_.\-/]|$)/i;
export const toolRefusal = (tool: string, branch: string): string | null => (MERGE_TOOL.test(tool) ? why(`use ${tool}: it merges or approves`, branch) : null);
