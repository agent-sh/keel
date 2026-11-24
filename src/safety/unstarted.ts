// What a turn nobody started may not do. A loop run, a wake, a monitor's batch, a watch and an agent's report to an
// idle parent start turns with no word of the owner's in them. Such a turn does not merge a pull request, approve a
// review, turn on auto-merge or force-push, in any mode: those acts are the owner's, and nobody was there to ask. It
// reads the owner's message again when one reaches the session (Engine.byOwner decides which turns those are).
// Pure: the policy gives it the line's parts.
import { docsRun, splitCommand, type Simple } from "./shell.ts";
import { SHELLS, name, unwrap } from "./risk-words.ts";

const DEPTH = 4;

// Options of gh (and of git before its subcommand) that take their value in the next word.
const GH_VALUED = /^(-R|--repo|-t|--title|-b|--body|-F|--body-file|-B|--base|-H|--head|-a|--assignee|-l|--label|-m|--milestone|-p|--project|-r|--reviewer|--hostname|--header|--match-head-commit|--subject|--author-email|--body-env)$/;
const GIT_VALUED = /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env|--super-prefix)$/;
const PUSH_VALUED = /^(--repo|-o|--push-option|--receive-pack|--exec)$/;

// The operands of a command and its options, with the options that take a value skipping it.
function operands(args: string[], valued: RegExp): { pos: string[]; flags: string[] } {
  const pos: string[] = [];
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") { pos.push(...args.slice(i + 1)); break; }
    if (a.startsWith("-") && a !== "-") { flags.push(a); if (!a.includes("=") && valued.test(a)) i++; continue; }
    pos.push(a);
  }
  return { pos, flags };
}

const API_HOST = /^https?:\/\/[^/]+\//i;
const MERGE_QUERY = /\b(mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch)\b/;
const APPROVE_QUERY = /\b(addPullRequestReview|submitPullRequestReview)\b[\s\S]*\bAPPROVE\b|\bAPPROVE\b[\s\S]*\b(addPullRequestReview|submitPullRequestReview)\b/;

// gh api: a request that merges, turns on auto-merge, approves, or moves a ref by force.
function ghApi(args: string[]): string | null {
  let method = "", fields = false, path: string | undefined;
  const text: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-X" || a === "--method") { method = (args[++i] ?? "").toUpperCase(); continue; }
    if (a.startsWith("--method=")) { method = a.slice(9).toUpperCase(); continue; }
    if (/^-X./.test(a)) { method = a.slice(2).toUpperCase(); continue; }
    if (a === "-f" || a === "-F" || a === "--field" || a === "--raw-field" || a === "--input") { fields = true; text.push(args[++i] ?? ""); continue; }
    if (/^(-f|-F).+/.test(a) || /^--(field|raw-field|input)=/.test(a)) { fields = true; text.push(a); continue; }
    if (a.startsWith("-")) { if (!a.includes("=") && /^(-H|--header|-q|--jq|-t|--template|--cache|-p|--preview|--hostname)$/.test(a)) i++; continue; }
    if (path === undefined) path = a;
  }
  if (path === undefined) return null;
  const all = text.join("\n");
  if (path === "graphql") {
    if (MERGE_QUERY.test(all)) return "merges a pull request or turns on auto-merge (gh api graphql)";
    if (APPROVE_QUERY.test(all)) return "approves a pull request (gh api graphql)";
    return null;
  }
  const writes = method ? !/^(GET|HEAD)$/.test(method) : fields;
  if (!writes) return null;
  const route = path.replace(API_HOST, "").replace(/^\/+/, "").split("?")[0]!;
  if (/(^|\/)pulls\/[^/]+\/merge$/.test(route) || /(^|\/)merges$/.test(route)) return `merges (gh api ${route})`;
  if (/(^|\/)(pulls\/[^/]+\/reviews|reviews\/[^/]+\/events)$/.test(route) && /\bAPPROVE\b/i.test(all)) return `approves a pull request (gh api ${route})`;
  if (/(^|\/)git\/refs\//.test(route) && /\bforce\b\s*=\s*true/i.test(all)) return `moves a ref by force (gh api ${route})`;
  return null;
}

// gh pr merge, gh pr review --approve, gh api.
function gh(words: string[]): string | null {
  const { pos, flags } = operands(words.slice(1), GH_VALUED);
  if (pos[0] === "api") return ghApi(words.slice(1 + words.indexOf("api", 1)));
  if (pos[0] !== "pr") return null;
  if (pos[1] === "merge") return flags.some((f) => f === "--auto" || f === "--admin") ? "merges a pull request or turns on auto-merge (gh pr merge)" : "merges a pull request (gh pr merge)";
  if (pos[1] === "review" && flags.some((f) => /^--approve(=true)?$/.test(f) || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(f))) return "approves a pull request (gh pr review --approve)";
  return null;
}

// glab mr merge, glab mr approve.
function glab(words: string[]): string | null {
  const { pos } = operands(words.slice(1), /^(-R|--repo|-m|--message|-t|--title|-d|--description|-l|--label|-a|--assignee)$/);
  if (pos[0] === "mr" && (pos[1] === "merge" || pos[1] === "approve")) return `${pos[1] === "merge" ? "merges" : "approves"} a merge request (glab mr ${pos[1]})`;
  return null;
}

// git push --force, -f, --force-with-lease, a refspec that starts with +, --mirror.
function git(words: string[]): string | null {
  let i = 1;
  while (i < words.length && words[i]!.startsWith("-")) i += GIT_VALUED.test(words[i]!) ? 2 : 1;
  if (words[i] !== "push") return null;
  const { pos, flags } = operands(words.slice(i + 1), PUSH_VALUED);
  if (flags.some((f) => /^--(force|force-with-lease|force-if-includes|mirror)(=.*)?$/.test(f) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f))) return "force-pushes (git push --force)";
  if (pos.some((p) => p.startsWith("+"))) return "force-pushes (git push, a refspec that starts with +)";
  return null;
}

// What one command's words do that a turn nobody started may not, or null.
function formOf(words: string[]): string | null {
  const prog = name(words[0]);
  if (prog === "gh") return gh(words);
  if (prog === "glab") return glab(words);
  if (prog === "git") return git(words);
  return null;
}

// The first act on the line that no turn nobody started may do, or null.
export function unstartedAct(parts: Simple[] | null, depth = 0): string | null {
  if (!parts || depth > DEPTH) return null;
  const docs = docsRun(parts);
  for (const part of parts) {
    if (part.heredoc && !docs) continue;
    const run = unwrap(part.words);
    const found = formOf(run.words);
    if (found) return found;
    // A shell given the program (bash -c '...', eval '...'): its text is a line of its own.
    const prog = name(run.words[0]);
    const c = SHELLS.test(prog) ? run.words.findIndex((a, k) => k > 0 && /^-[a-zA-Z]*c$/.test(a)) : -1;
    const code = prog === "eval" ? run.words.slice(1).join(" ") : c > 0 ? run.words[c + 1] : undefined;
    if (code) {
      const inner = unstartedAct(splitCommand(code), depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

// What the model reads when the line is refused.
export const unstartedWhy = (act: string) =>
  `Refused: the command ${act}, and no message of the owner's is in this turn (a loop run, a wake, a monitor's batch, a watch or an agent's report started it). Merging, approving, turning on auto-merge and force-pushing are the owner's to start. Do not try another form of it. Say in your reply what you wanted to do (the command, and the pull request or branch) and go on with the rest; the limit lifts when the owner sends a message to this session.`;
