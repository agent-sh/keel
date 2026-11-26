// What a turn nobody started may not do. A loop run, a wake, a monitor's batch, a watch and an agent's report to an
// idle parent start turns with no word of the owner's in them. Such a turn does not merge a pull request, approve a
// review, turn on auto-merge or force-push, in any mode: those acts are the owner's, and nobody was there to ask. It
// reads the owner's message again when one reaches the session (Engine.byOwner decides which turns those are).
//
// What this is: a guard against an unattended turn doing these acts by their usual commands (gh, glab, git, and a
// request to a forge's merge or approve route from any program). It is not a sandbox: a program that talks to the
// forge by a route this file does not know, a script on disk, or an alias made before the turn is beyond it. It is
// deliberately broad on git: --force-with-lease, and the delete of a remote branch or tag, are refused here even on
// an agent's own branch, because nobody who started the turn is there to answer for a rewritten or removed ref.
// Pure: the policy gives it the line's parts.
import { docsRun, splitCommand, type Simple } from "./shell.ts";
import { DEPTH, SHELLS, evalGiven, name, scriptsOf, shellGiven, unwrap } from "./risk-words.ts";

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
  let method = "", fields = false, path: string | undefined, file = false;
  const text: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-X" || a === "--method") { method = (args[++i] ?? "").toUpperCase(); continue; }
    if (a.startsWith("--method=")) { method = a.slice(9).toUpperCase(); continue; }
    if (/^-X./.test(a)) { method = a.slice(2).toUpperCase(); continue; }
    // A request read from a file (--input, -F key=@file) is not seen: the route decides.
    if (a === "-f" || a === "-F" || a === "--field" || a === "--raw-field" || a === "--input") { fields = true; const v = args[++i] ?? ""; text.push(v); if (a === "--input" || ((a === "-F" || a === "--field") && /=@/.test(v))) file = true; continue; }
    if (/^(-f|-F).+/.test(a) || /^--(field|raw-field|input)=/.test(a)) { fields = true; text.push(a); if (/^--input=/.test(a) || (/^(-F|--field=)/.test(a) && /=@/.test(a))) file = true; continue; }
    if (a.startsWith("-")) { if (!a.includes("=") && /^(-H|--header|-q|--jq|-t|--template|--cache|-p|--preview|--hostname)$/.test(a)) i++; continue; }
    if (path === undefined) path = a;
  }
  if (path === undefined) return null;
  const all = text.join("\n");
  if (path === "graphql") {
    if (file) return "sends a GraphQL request it reads from a file (gh api graphql), which may merge or approve";
    if (MERGE_QUERY.test(all)) return "merges a pull request or turns on auto-merge (gh api graphql)";
    if (APPROVE_QUERY.test(all)) return "approves a pull request (gh api graphql)";
    return null;
  }
  const writes = method ? !/^(GET|HEAD)$/.test(method) : fields;
  if (!writes) return null;
  const route = path.replace(API_HOST, "").replace(/^\/+/, "").split("?")[0]!;
  if (/(^|\/)pulls\/[^/]+\/merge$/.test(route) || /(^|\/)merges$/.test(route)) return `merges (gh api ${route})`;
  if (/(^|\/)(pulls\/[^/]+\/reviews|reviews\/[^/]+\/events)$/.test(route) && file) return `sends a review it reads from a file (gh api ${route}), which may approve`;
  if (/(^|\/)(pulls\/[^/]+\/reviews|reviews\/[^/]+\/events)$/.test(route) && /\bAPPROVE\b/i.test(all)) return `approves a pull request (gh api ${route})`;
  if (/(^|\/)git\/refs\//.test(route) && file) return `moves a ref with a request it reads from a file (gh api ${route}), which may force it`;
  if (/(^|\/)git\/refs\//.test(route) && /\bforce\b\s*=\s*true/i.test(all)) return `moves a ref by force (gh api ${route})`;
  return null;
}

// gh pr merge, gh pr review --approve, gh api.
function gh(words: string[]): string | null {
  const { pos, flags } = operands(words.slice(1), GH_VALUED);
  if (pos[0] === "alias" && (pos[1] === "set" || pos[1] === "import")) return "makes a gh alias (gh alias set), which can run any gh command under another name";
  if (pos[0] === "api") return ghApi(words.slice(1 + words.indexOf("api", 1)));
  if (pos[0] !== "pr") return null;
  if (pos[1] === "merge") return flags.some((f) => f === "--auto" || f === "--admin") ? "merges a pull request or turns on auto-merge (gh pr merge)" : "merges a pull request (gh pr merge)";
  if (pos[1] === "review" && flags.some((f) => /^--approve(=true)?$/.test(f) || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(f))) return "approves a pull request (gh pr review --approve)";
  return null;
}

// A request to a forge's merge or approve route, or a GraphQL mutation that does, by whatever program makes the request
// (curl, wget, glab api, a client of its own). gh is read by its own forms above, where a GET is no act. A program that only
// shows text (grep, cat, echo) is no request.
const TEXT_TOOLS = /^(grep|egrep|fgrep|rg|ag|cat|echo|printf|head|tail|less|more|ls|find|sed|awk|wc|diff|cmp|man|test|\[|stat|file|tee|sort|uniq|cut|tr|xargs|time|nice|nohup|env|command|builtin|exec|sudo|doas|timeout|git|gh)$/;
const MERGE_ROUTE = /(^|\/)repos\/[^/\s]+\/[^/\s]+\/(pulls\/[^/\s]+\/merge|merges)(?![\w/.-])|(^|\/)merge_requests\/[^/\s]+\/(merge|approve)(?![\w/.-])/;
const REVIEW_ROUTE = /(^|\/)repos\/[^/\s]+\/[^/\s]+\/(pulls\/[^/\s]+\/reviews|reviews\/[^/\s]+\/events)(?![\w/.-])/;
function request(words: string[]): string | null {
  const prog = name(words[0]);
  if (!prog || TEXT_TOOLS.test(prog)) return null;
  const rest = words.slice(1);
  const route = rest.find((w) => MERGE_ROUTE.test(w));
  if (route) return `merges or approves by a request to the forge (${prog} ${route.replace(/^https?:\/\/[^/]+\//, "").slice(0, 80)})`;
  const all = rest.join("\n");
  if (rest.some((w) => REVIEW_ROUTE.test(w)) && /\bAPPROVE\b/.test(all)) return `approves a pull request by a request to the forge (${prog})`;
  if (MERGE_QUERY.test(all)) return `merges a pull request or turns on auto-merge by a request to the forge (${prog})`;
  if (APPROVE_QUERY.test(all)) return `approves a pull request by a request to the forge (${prog})`;
  return null;
}

// glab mr merge, glab mr approve.
function glab(words: string[]): string | null {
  const { pos } = operands(words.slice(1), /^(-R|--repo|-m|--message|-t|--title|-d|--description|-l|--label|-a|--assignee)$/);
  if (pos[0] === "mr" && (pos[1] === "merge" || pos[1] === "approve")) return `${pos[1] === "merge" ? "merges" : "approves"} a merge request (glab mr ${pos[1]})`;
  return null;
}

// git push --force, -f, --force-with-lease, a refspec that starts with +, --mirror; a push that deletes (--delete, -d, a
// :ref refspec, --prune); an alias made for the line (git -c alias.x=..., git config alias.x ...), which can run a push by another name.
function git(words: string[]): string | null {
  let i = 1;
  while (i < words.length && words[i]!.startsWith("-")) {
    const w = words[i]!;
    const given = w === "-c" || w === "--config-env" ? words[i + 1] : /^--config-env=/.test(w) ? w.slice(13) : undefined;
    if (given !== undefined && /^alias\./i.test(given)) return "makes a git alias for the command (git -c alias...), which can run a push by another name";
    i += GIT_VALUED.test(w) ? 2 : 1;
  }
  if (words[i] === "config") {
    const { pos } = operands(words.slice(i + 1), /^(--file|-f|--blob|--type|--default|--comment)$/);
    if (pos[0] && /^alias\./i.test(pos[0]) && pos.length >= 2) return "makes a git alias (git config alias...), which can run a push by another name";
    return null;
  }
  if (words[i] !== "push") return null;
  const { pos, flags } = operands(words.slice(i + 1), PUSH_VALUED);
  if (flags.some((f) => /^--(delete|prune)$/.test(f) || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(f)) || pos.slice(1).some((p) => p.startsWith(":") && p.length > 1)) return "deletes a branch or tag on the remote (git push --delete)";
  if (flags.some((f) => /^--(force|force-with-lease|force-if-includes|mirror)(=.*)?$/.test(f) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f))) return "force-pushes (git push --force)";
  if (pos.some((p) => p.startsWith("+"))) return "force-pushes (git push, a refspec that starts with +)";
  return null;
}

// What one command's words do that a turn nobody started may not, or null.
function formOf(words: string[]): string | null {
  const prog = name(words[0]);
  if (prog === "gh") return gh(words);
  if (prog === "glab") return glab(words) ?? request(words);
  if (prog === "git") return git(words);
  return request(words);
}

export const UNPARSED = Symbol("unparsed shell line");
export const TOO_DEEP = Symbol("shell script nesting limit");

// The first act no turn nobody started may do. An unreadable part does not hide a known act elsewhere.
export function unstartedAct(parts: Simple[] | null, depth = 0): string | typeof UNPARSED | typeof TOO_DEEP | null {
  if (!parts) return UNPARSED;
  let unreadable = false;
  let tooDeep = false;
  const docs = docsRun(parts);
  for (const part of parts) {
    if (part.heredoc && !docs) continue;
    if (part.heredoc && part.docUnread) unreadable = true;
    const run = unwrap(part.words);
    const found = formOf(run.words);
    if (found) return found;
    // A shell given the program (bash -c '...', eval '...'): its text is a line of its own.
    const prog = name(run.words[0]);
    const codes = prog === "eval" ? [evalGiven(run.words.slice(1))] : SHELLS.test(prog) ? scriptsOf(shellGiven(run.words.slice(1))).map((g) => g.script) : [];
    for (const code of codes) {
      if (!code) continue;
      // The risk reader can describe a long script without reading it. The unattended guard
      // must still look for the acts that no Full auto risk label would stop.
      if (depth >= DEPTH) { tooDeep = true; continue; }
      const inner = unstartedAct(splitCommand(code), depth + 1);
      if (inner === UNPARSED) unreadable = true;
      else if (inner === TOO_DEEP) tooDeep = true;
      else if (inner) return inner;
    }
  }
  return unreadable ? UNPARSED : tooDeep ? TOO_DEEP : null;
}

// What the model reads when the line is refused.
export const unstartedWhy = (act: string) =>
  `Refused: the command ${act}, and no message of the owner's is in this turn (a loop run, a wake, a monitor's batch, a watch or an agent's report started it). Merging, approving, turning on auto-merge, force-pushing and deleting a remote branch or tag are the owner's to start. Do not try another form of it. Say in your reply what you wanted to do (the command, and the pull request or branch) and go on with the rest; the limit lifts when the owner sends a message to this session.`;
