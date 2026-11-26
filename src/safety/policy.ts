// The permission decision for one tool call, from the session's mode and the
// standing answers that apply. Pure: the gate supplies the facts.
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { accountFacts, foreign, foreignAll, namedOwners, namespaceOf, ownsOwner, say, whyForeign, writesFed, writesOf as writesPlain, type Env as AccountEnv, type Namespace, type Write } from "./accounts.ts";
import { neverAllowed, neverAllowedText } from "./autonomy.ts";
import { shellCredentialReads, type DiskLook } from "./credential-reads.ts";
import { credentialAt, homeOf, placesOf, type Credential } from "./credentials.ts";
import type { Looked } from "./looked.ts";
import { innerLines } from "./nested-shell.ts";
import { RULE_WORDS, codeGiven, laid, risksAt, type Laid } from "./risk.ts";
import type { PartRisk } from "./own-places.ts";
import type { AskedPart } from "./summary.ts";
import { outputsOf } from "./outputs.ts";
import { resolvedLine } from "./resolved-line.ts";
import { gitStoreOf, sharedMessage, sharedRefusal, type Shared } from "./shared-branches.ts";
import { LEAVES, PARTS_MAX, WORDS_MAX, asksReal, dirsOf, elseOf, name as baseName, namesCdpath, shellGiven, startsReal, untrailed, unwrap, valuesOf, type Run } from "./risk-words.ts";
import { unstartedAct, unstartedWhy } from "./unstarted.ts";
import { follow } from "./line-makes.ts";
import { isReadOnly, matchRule, packageRule, readForm, redirectTargets, resolveVariables, runsAnyPackage, shimmedRead, splitCommand, suggestRule, type Simple } from "./shell.ts";
import { atCwd, contains, homeDir } from "../core/paths.ts";
import { RESERVED } from "../mcp/config.ts";
import type { ToolKind } from "../tools/types.ts";
import type { WebUse } from "./addresses.ts";
import { extractShellApplyPatch, patchTargetPaths } from "../tools/v4a-parse.ts";

// Who decides what a mode lets run: the owner, a model, or nobody because
// nothing changes. A menu groups the modes by it, in this order.
export const MODE_GROUPS = [
  { id: "you", name: "You decide" },
  { id: "model", name: "A model decides" },
  { id: "none", name: "Nothing changes" },
] as const;
// `summary` is what runs and what asks in a few words, for a list read at a
// glance; `description` is the whole of it. A summary never promises more
// asking than the mode does: what runs without the owner is named in it
// (policy.test.ts holds each one against `decide`).
export const MODES = [
  { id: "ask", name: "Ask", group: "you", summary: "Reads run; changes ask unless granted", description: "Reads run. Edits, commands and other tools ask first unless a grant covers them." },
  { id: "auto-edits", name: "Auto edits", group: "you", summary: "Folder edits run; commands ask unless read-only or sandboxed", description: "Edits inside the folder run. Commands ask, except read-only ones and sandboxed ones." },
  { id: "auto", name: "Auto", group: "model", summary: "A judge reviews what no rule covers", description: "Reads, edits inside the folder, read-only or sandboxed commands, and standing grants run as usual. The judge reviews other calls and refuses them if it cannot approve. Actions requiring your consent still ask." },
  { id: "full-auto", name: "Full auto", group: "model", summary: "Runs everything; nothing is checked", description: "Every call runs without review, high-risk ones too; the activity list names what was flagged. Use Auto for a judge model. Tools that explicitly require your confirmation still ask." },
  { id: "read-only", name: "Read only", group: "none", summary: "Reads and read-only commands; the rest is refused", description: "Reads and read-only commands run, and so do the session's own records: its agents (they hold this mode), waits, todos and notes to you. A web fetch to an address the session has not seen that carries data asks you. Everything else is refused, a schedule that would run later included." },
  { id: "plan", name: "Plan", group: "none", summary: "Plans first; you approve the plan", description: "Reads and read-only commands run, and so do the session's own records: its agents (they hold this mode), waits, todos and notes to you; a web fetch to an address the session has not seen that carries data asks you. The model plans, and you approve the plan before anything changes." },
  { id: "reviewer", name: "Reviewer", group: "model", summary: "A reviewer model answers; high risk asks you", description: "A reviewer model decides what would ask. High-risk actions and anything it cannot judge still ask you." },
] as const;
export type Mode = (typeof MODES)[number]["id"];
export const isMode = (m: unknown): m is Mode => MODES.some((x) => x.id === m);

// How much a mode lets run without asking the owner, one ranking for every
// place that compares modes (a remote device loosening one, a child agent).
const LOOSENESS: Record<Mode, number> = { "read-only": 0, plan: 0, ask: 1, reviewer: 2, "auto-edits": 3, auto: 4, "full-auto": 5 };
export const asksLess = (mode: string, than: string) => (isMode(mode) ? LOOSENESS[mode] : 0) > (isMode(than) ? LOOSENESS[than] : 0);
// A child runs in the mode it wants unless that asks less than its parent's.
export const childMode = (parent: Mode, want?: string): Mode => (isMode(want) && !asksLess(want, parent) ? want : parent);
// Modes in which nothing is written (a child gets no worktree of its own).
export const writesNothing = (m: Mode) => m === "read-only" || m === "plan";

export type RuleKind = "shell" | "edit" | "tool";
// `bind`, on a tool rule, names the source it was granted for (an MCP server's
// binding): the same name on another source is not covered.
export type Rule = { id: string; kind: RuleKind; pattern: string; scope: string; lifetime: "always" | "session"; session_id?: string | null; created: number; bind?: string | null };
export type Suggest = { kind: RuleKind; pattern: string; bind?: string };

// Whether a tool rule covers a tool: it names the tool, or it is a glob of an
// MCP server's tools after the server's literal name (`github__*`, `github__get_*`,
// carried from Claude Code's whole-server rules). A server's name holds no `__`,
// so the first one ends it. A server Keel brings itself has no glob rule (its
// tools ask by Keel's own rules), and a tool whose name holds `*` is never
// offered a rule of its own, so a stored `*` is always a glob.
export function toolCovers(pattern: string, tool: string): boolean {
  if (pattern === tool) return true;
  const cut = pattern.indexOf("__");
  if (cut <= 0 || !pattern.includes("*", cut)) return false;
  const server = pattern.slice(0, cut + 2);
  if (server.includes("*") || !tool.startsWith(server) || RESERVED.has(server.slice(0, -2).toLowerCase())) return false;
  const glob = pattern.slice(server.length).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${glob}$`, "s").test(tool.slice(server.length));
}
const toolRule = (f: Facts, tool: string) => f.rules.some((r) => r.kind === "tool" && toolCovers(r.pattern, tool) && (!r.bind || r.bind === f.bind));
const toolSuggest = (f: Facts, tool: string): Suggest[] => (tool.includes("*") ? [] : [{ kind: "tool", pattern: tool, ...(f.bind ? { bind: f.bind } : {}) }]);

// What an MCP server says a tool of its does (its annotations), as far as the gate reads it.
// Untrusted (the server's word, 2025-11-25 server/tools): no hint lets a call run that would ask.
// `interaction`: the server marks the tool as one the owner answers on every call (tools/list
// _meta "anthropic/requiresUserInteraction" is exactly true). Unlike the others it is not a hint that
// raises care: it is a rule the gate holds the call to (see decide).
export type ToolHints = { destructive?: true; openWorld?: true; interaction?: true };

export type CallClass =
  // `paths`: the files and folders a read names (readPaths), for the one
  // thing a read is held to: in a sandboxed session it asks before it reads
  // where the owner's credentials or Keel's own files are kept.
  // `unnamed`: a reading tool known only by its flag (an MCP server's) whose input names no file.
  // `fetches`: the web addresses a page fetch goes to (its tool's `web`). The gate
  // judges a fetch to an address the session has not seen as the send it is.
  | { kind: "read"; paths?: string[]; unnamed?: true; fetches?: string[] }
  // `interpreter`: the program that runs the command when it is not bash. The
  // rules read a command as bash does, so none of it is then taken for a read.
  // `unconfined`: the command is typed into a terminal that runs with no sandbox around it (its launch was allowed
  // out of the sandbox, or the session has none): it runs unconfined whatever the session's sandbox is now.
  | { kind: "shell"; command: string; escalate?: boolean; unconfined?: true; cwd?: string; interpreter?: string }
  // input to, or the stop of, a process an allowed call started; `own`: an act on what Keel keeps for the
  // session (ToolKind "own"), which is no read: it changes things, only none the modes guard.
  | { kind: "control"; own?: true }
  // `names`: the edit writes words that name a program something runs later
  // (NAMES_PROGRAM, by id). It is the owner's call when one of its files,
  // where it lands, is a file those words mean that in.
  | { kind: "edit"; paths: string[]; names?: string[] }
  // `grant` names the standing answer that covers it when the tool's name is
  // too wide (keel__spawn_on_machine:<machine>: one machine, not all of them).
  // `paths`: the strings of its input that are a path by themselves (pathsNamed).
  // `hints`: what an MCP server says of its tool (2025-11-25 tool annotations), which only ever
  // makes the gate more careful: a destructive one is high risk, an open-world one says so on its card.
  // `account`: the tool writes with an account its MCP server holds (the server's name), src/safety/accounts.ts.
  // `input`: what the call was given, which the owners it names are read from.
  // `reads`: the owner marked the tool a read (only read-only mode needs to know, for a tool that asks every call).
  | { kind: "other"; grant?: string; paths?: string[]; hints?: ToolHints; reads?: true; account?: { server: string; name?: string; tool?: string; input?: unknown } }
  // A message, answer or model command into another session. `resource` names
  // the tool and the target (keel__session_message:claude:abc); `owner` says why
  // only the owner may allow it.
  | { kind: "drive"; target: string; resource: string; shown: string; owner?: string }
  // A web request that sends what it carries: a page fetch to addresses the
  // session has not seen that carry data (src/safety/addresses.ts), each in `to`,
  // with what it carries in `because` (a query string, a secret in its path...);
  // `carries`: a request with a body, headers or a method of its own, to any address.
  // `shown`: the addresses whole with their query parameters, for the card and the judge.
  | { kind: "send"; to: string[]; shown: string; because?: string; carries?: true }
  // A call its tool refused before it was judged (the reason is the result).
  | { kind: "refused"; why: string };

// `notice`: a line for the owner on the card (the form of the command that would not have asked).
// `rule`: the class of the rule that asks, in a few words (what a folded call is
// marked with in the transcript); `why` is the sentence the approval card shows.
// A high-risk command's class is one of five (risk.ts RULE_WORDS).
// `settles`: every reason it is high risk is one of git's own forms, which the full-auto rules can settle from
// the repository's state before a judge is asked.
// `risks`: each reason a high-risk command is high risk, with the part of the line it was found in (what Keel's
// facts can settle of one part, own-places.ts).
// `account`: a write with the owner's account beyond his namespaces (the namespace, or "" when it is not known): the owner's
// alone in every mode, Full auto included, where it opens a card and does not go to the judge.
// `interaction`: the tool's server requires the owner's answer on every call: his card opens in every mode, Full auto too.
export type Ask = { risk: "high" | "low"; why?: string; rule?: string; suggest: Suggest[]; ownerOnly?: true; account?: string; interaction?: true; mine?: string; readTool?: { server: string; tool: string }; notice?: string; settles?: true; risks?: PartRisk[]; part?: AskedPart };
export type Decision =
  | { allow: true; why?: string }
  | { deny: string }
  | { ask: Ask };

// The part of a line that asked: its text and which of the parts with that text it is, so the card can mark it.
const partAt = (parts: Simple[], i: number | null | undefined): AskedPart | undefined => {
  const p = i == null ? undefined : parts[i];
  if (!p || !p.text || !p.words.length) return undefined;
  let nth = 0;
  for (let k = 0; k < i!; k++) if (parts[k]!.text === p.text) nth++;
  return { text: p.text, nth };
};
// An ask that names the part of the line that asked (a line of one command names none: the whole is it).
const naming = (d: Decision, parts: Simple[], i: number | null | undefined): Decision => {
  const part = parts.length > 1 && "ask" in d ? partAt(parts, i) : undefined;
  return part && "ask" in d ? { ask: { ...d.ask, part } } : d;
};

const onlyOwner = (why: string, rule = "yours alone to allow"): Decision => ({ ask: { risk: "high", why, rule, suggest: [], ownerOnly: true } });

// What a call does. The tool's own definition says which kind of call it is
// (its read flag and its kind); the input only supplies the command or the
// paths of that kind, so no key a model puts in a call changes how it is judged.
export function classify(tool: { name: string; readOnly: boolean; kind?: ToolKind; input_schema?: any; built?: any; interpreter?(input: any): string; appliesPatch?: true; web?: WebUse }, input: any, cwd: string): CallClass {
  if (tool.readOnly) {
    const paths = readPaths(input, cwd);
    const fetches = tool.web && "fetches" in tool.web ? tool.web.fetches(input ?? {}) : undefined;
    return { kind: "read", ...(paths.length ? { paths } : {}), ...(fetches ? { fetches } : {}) };
  }
  switch (tool.kind) {
    case "control":
      return { kind: "control" };
    case "own":
      return { kind: "control", own: true };
    case "shell": {
      // The command is read from the key the tool itself reads (its schema
      // names it), and only as text. A tool runs the text of that one key: a
      // list or an object there is not the words it seems to hold, and a
      // second key the tool never reads says nothing about what runs.
      const props = (tool.built ?? tool.input_schema)?.properties;
      const key = props ? ("cmd" in props && !("command" in props) ? "cmd" : "command")
        : input?.command == null ? "cmd" : input?.cmd == null ? "command" : null;
      if (key === null) return { kind: "refused", why: `${tool.name} was given both command and cmd.` };
      const raw = input?.[key];
      if (raw != null && typeof raw !== "string") return { kind: "refused", why: `${tool.name} takes its ${key} as one string.` };
      const cmd = typeof raw === "string" ? raw : null;
      if (cmd === null) return { kind: "other" }; // a monitor of a socket: judged by the tool's name
      // A command the tool does not run but applies itself as a patch (no
      // shell, so no sandbox confines it) is the edit it is: its files.
      const wrapped = tool.appliesPatch ? extractShellApplyPatch(cmd) : null;
      if (wrapped) {
        const base = wrapped.cd ? atCwd(cwd, wrapped.cd) : cwd;
        const paths = patchTargetPaths(wrapped.patch);
        if (!paths.length) return { kind: "refused", why: `${tool.name} was given a patch that names no file to change.` };
        const names = wordsNaming(wrapped.patch);
        return { kind: "edit", paths: paths.map((p) => atCwd(base, p)), ...(names.length ? { names } : {}) };
      }
      // A tool that offers it (Codex's exec_command) can ask to run outside the sandbox.
      // Read from the running build's schema: a session may carry an older definition (Tool.built).
      // Each family in the words its own harness taught it: Codex's shell
      // takes sandbox_permissions, Claude Code's Bash dangerouslyDisableSandbox.
      const shape = (tool.built ?? tool.input_schema)?.properties;
      const escalate = (!!shape?.sandbox_permissions && input?.sandbox_permissions === "require_escalated") || (!!shape?.dangerouslyDisableSandbox && input?.dangerouslyDisableSandbox === true);
      const runs = tool.interpreter?.(input);
      return { kind: "shell", command: cmd, escalate: escalate || undefined, cwd, ...(runs !== undefined && !BASH.test(runs) ? { interpreter: runs } : {}) };
    }
    case "edit": {
      const paths: string[] = [];
      for (const k of ["file_path", "path", "notebook_path"]) if (typeof input?.[k] === "string") paths.push(input[k]);
      const patch = typeof input === "string" ? input : typeof input?.patch === "string" ? input.patch : typeof input?.input === "string" ? input.input : "";
      // The files of a patch are read by the tool's own parser: a header the
      // tool takes (no space after the colon, an indented one) is a file here too.
      if (patch) paths.push(...patchTargetPaths(patch));
      if (!paths.length) return { kind: "refused", why: `${tool.name} names no file to change.` };
      const parts = [input?.content, input?.new_string, input?.new_source, patch, ...(Array.isArray(input?.edits) ? input.edits.map((e: any) => e?.new_string) : [])].filter((x): x is string => typeof x === "string" && x.length > 0);
      // (As given: a `..` after a link is walked where the path is resolved, never cut from its text.)
      const full = paths.map((p) => atCwd(cwd, p));
      const names = parts.length ? wordsNaming(parts.join("\n")) : [];
      return { kind: "edit", paths: full, ...(names.length ? { names } : {}) };
    }
    default:
      return { kind: "other" };
  }
}

const BASH = /^(\/usr)?(\/bin\/)?bash$/;

// The command of a shell call as one bash line. An argument list is quoted
// word by word, so a word is never read as shell syntax; `bash -c SCRIPT` is
// the script. Another shell's script stays an argument: the rules read bash.
export function shellText(input: any): string | null {
  const c = input?.command ?? input?.cmd;
  if (typeof c === "string") return c;
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) {
    const w = c as string[];
    if (w.length === 3 && BASH.test(w[0]!) && /^-l?c$/.test(w[1]!)) return w[2]!;
    return w.map((w: string) => (/^[\w./=:@%+-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`)).join(" ");
  }
  return null;
}

// A repository's files that run, or configure what runs, later and outside
// any sandbox: git's hooks and config, direnv, the MCP and hook files of the
// harnesses, an editor's tasks, the folders commands and language servers are
// found in, and the workflow files a CI host runs with the repository's
// secrets at the next push (GitHub, GitLab, CircleCI, Azure, Bitbucket,
// Buildkite, Jenkins, Forgejo, Gitea, Woodpecker, Drone, Travis, Cirrus, Tekton, Cloud Build, CodeBuild and others),
// and the hook runners' own files (pre-commit, lefthook).
export const RUNS_LATER = /^(?:.*\/)?(?:\.git\/(?:hooks\/|config$)|\.envrc$|\.mcp\.json$|\.npmrc$|\.pypirc$|\.gitattributes$|\.gitmodules$|\.keel\/hooks\.json$|\.keel\/hooks\/|\.claude\/hooks\/|\.claude\/settings(?:\.local)?\.json$|\.codex\/config\.toml$|\.gemini\/settings\.json$|\.vscode\/(?:tasks|settings|launch)\.json$|\.husky\/|\.githooks\/|\.github\/(?:workflows|actions)\/|\.gitlab-ci\.ya?ml$|\.gitlab\/ci\/|\.circleci\/|\.buildkite\/|\.forgejo\/workflows\/|\.gitea\/workflows\/|\.woodpecker(?:\.ya?ml$|\/)|\.drone\.ya?ml$|\.travis\.yml$|azure-pipelines\.ya?ml$|\.azure-pipelines\/|bitbucket-pipelines\.yml$|Jenkinsfile(?:\.[\w.-]+)?$|\.pre-commit-config\.ya?ml$|lefthook(?:-local)?\.ya?ml$|\.lefthook\.ya?ml$|cloudbuild\.ya?ml$|buildspec\.ya?ml$|\.cirrus\.ya?ml$|\.tekton\/|appveyor\.yml$|\.semaphore\/|\.teamcity\/|node_modules\/(?:\.bin|@typescript|typescript|typescript-language-server|pyright|basedpyright)\/|\.venv\/bin\/)/;

// Files whose words can name a program a language server loads or runs
// (src/lsp/servers.ts): a plugin in a TypeScript project file, the
// interpreter in a Python one. An edit that writes such an entry is the
// owner's call like an edit of a hook; any other edit of the file is not.
// The words are looked for when the call is classified (the text it writes)
// and the file when it is decided, where the edit lands: a link to such a
// file under another name is that file. A key that ends its line counts (its
// colon can come with a later edit). The gate adds what only the file shows:
// an edit that changes an entry the file already holds (programEntries).
const NAMES_PROGRAM: { id: string; file: RegExp; words: RegExp; what: string }[] = [
  { id: "plugins", file: /(?:^|\/)(?:tsconfig(?:\.[\w.-]+)?|jsconfig)\.json$/, words: /["']?plugins["']?\s*(?::|$)/m, what: "a plugins entry, which names code a TypeScript language server loads" },
  { id: "interpreter", file: /(?:^|\/)(?:pyrightconfig\.json|pyproject\.toml)$/, words: /\b(?:pythonPath|venvPath|venv)\b["']?\s*(?:[:=]|$)/m, what: "the interpreter or environment a Python language server runs" },
];
export const wordsNaming = (writes: string): string[] => NAMES_PROGRAM.filter((n) => n.words.test(writes)).map((n) => n.id);
// The kinds of entry a file of this name can hold.
export const programRules = (path: string): string[] => NAMES_PROGRAM.filter((n) => n.file.test(path)).map((n) => n.id);
// The entries of one kind in a file's text, each from its key to the end of
// its value (a list or an object to its closing bracket, anything else to the
// end of its line), spaces folded: two texts with the same entries name the
// same programs.
export function programEntries(id: string, text: string): string[] {
  const n = NAMES_PROGRAM.find((x) => x.id === id);
  if (!n) return [];
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(n.words.source, "gm"))) {
    let at = m.index + m[0].length;
    while (at < text.length && /[\s:=]/.test(text[at]!)) at++;
    let end = at;
    if (text[at] === "[" || text[at] === "{") {
      let depth = 0, quote = "";
      for (; end < text.length && end - at < 65_536; end++) {
        const ch = text[end]!;
        if (quote) { if (ch === "\\") end++; else if (ch === quote) quote = ""; }
        else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === "[" || ch === "{") depth++;
        else if ((ch === "]" || ch === "}") && --depth === 0) { end++; break; }
      }
    } else { end = text.indexOf("\n", at); if (end < 0) end = text.length; }
    out.push(text.slice(m.index, end).replace(/\s+/g, " ").trim());
  }
  return out;
}
function namesProgram(paths: string[], names: string[]): { path: string; what: string } | null {
  for (const path of paths) { const hit = NAMES_PROGRAM.find((n) => names.includes(n.id) && n.file.test(path)); if (hit) return { path, what: hit.what }; }
  return null;
}

// Files of the home folder that run, or let someone in, later: the shells'
// start files, the remote-login folder, git's own configuration (it names
// programs git runs) and the folder of the owner's own commands. An edit of
// one is the owner's call like a repository's RUNS_LATER files, wherever the
// session's workspace is.
const HOME_RUNS_LATER = /^(?:\.(?:bashrc|bash_profile|bash_login|bash_logout|bash_aliases|profile|zshrc|zshenv|zprofile|zlogin|zlogout|inputrc|xprofile|xsessionrc|xinitrc|pam_environment|gitconfig)$|\.ssh(?:\/|$)|\.bashrc\.d\/|\.local\/bin\/|\.config\/(?:fish\/|git\/|environment\.d\/|systemd\/user\/|autostart\/))/;
// What such a file is, in a few words (the rule's class, as a mark says it).
function homeClass(rel: string): string {
  if (/^\.ssh(?:\/|$)/.test(rel)) return "remote login keys or settings";
  if (/^\.gitconfig$|^\.config\/git\//.test(rel)) return "git's own configuration";
  if (/^\.local\/bin\//.test(rel)) return "a folder of your own commands";
  if (/^\.config\/systemd\/user\//.test(rel)) return "a user service";
  if (/^\.config\/autostart\//.test(rel)) return "a program started at login";
  return "a login or shell start file";
}
type OwnerOnly = { why: string; rule: string };
// Why a change of this path is the owner's alone, or nothing. `config`: folders
// and files Keel itself runs things from (its config folder: hooks, MCP
// servers, skills, agents; the scripts the owner's hooks and a pinned
// repository's hooks run), which no sandbox confines.
const RUNS_LATER_RULE = "runs later, outside the sandbox";
function ownerOnlyEdit(p: string, f: Facts, does = "changes"): OwnerOnly | null {
  const rel = relative(f.workspace, p);
  // (Also in other letter case: on a disk that does not tell cases apart it is the same file.)
  if (RUNS_LATER.test(rel) || RUNS_LATER.test(rel.toLowerCase())) return { rule: RUNS_LATER_RULE, why: `it ${does} ${rel}, which runs or configures things outside the sandbox later` };
  const o = f.own?.();
  const own = (f.config ?? o?.config)?.find((c) => contains(c, p));
  if (own) return { rule: "Keel's own configuration", why: `it ${does} ${p}, which Keel runs or reads its configuration from (its hooks and their scripts, MCP servers, skills and agents), outside any sandbox` };
  const home = f.home ?? o?.home ?? homeDir();
  if (contains(home, p) && HOME_RUNS_LATER.test(relative(home, p))) return { rule: homeClass(relative(home, p)), why: `it ${does} ${p}, which runs at every login or shell start, or lets someone log in` };
  // A file of a folder commands are found in by name (an entry of the
  // session's PATH inside its workspace): its text runs at the next command,
  // or the next program Keel starts, of that name.
  const bins = f.bins ?? o?.bins;
  if (bins?.length) {
    const dir = dirname(p), inside = contains(f.workspace, p), at = inside ? relative(f.workspace, dir) : null;
    if (bins.some((b) => (isAbsolute(b) ? b === dir : at !== null && (at === b || at.endsWith(`/${b}`))))) return { rule: "a folder on the session's PATH", why: `it ${does} ${inside ? rel : p}, a file of a folder on this session's PATH, where commands are found by name` };
  }
  return null;
}
// The same for a path a command or a tool's input names: asked of the path as
// spelled and of where it lands (an edit's paths come to the gate landed already).
// `shell`: the path is written by a command of the session's shell, which a sandbox confines (see `sandboxHolds`),
// and the word surely names it (`sureWord` in decideShell).
function ownerOnlyNamed(w: string, cwd: string, f: Facts, does: string, shell = false): OwnerOnly | null {
  const p = spelled(w, cwd, f.home ?? homeDir());
  if (!p) return null;
  for (const q of f.own?.().land(p) ?? [p]) { const why = ownerOnlyEdit(q, f, does); if (why && !(shell && why.rule === RUNS_LATER_RULE && sandboxHolds(q, f))) return why; }
  return null;
}

// Whether the session's sandbox is what stops a command's write to this path. A confined command writes its
// session's folder, the temporary folders and the session's scratch, and nothing else: a project's file
// somewhere else that would run later (another repository's hooks, a workflow file next door) cannot be
// written, so nothing is asked for it. Not the user's own configuration: a file that runs later and is the home
// folder's own (~/.npmrc, ~/.claude/settings.json) stays the owner's, whatever would stop the write.
const HOME_OWN = new RegExp(RUNS_LATER.source.replace("^(?:.*\\/)?", "^"));
function sandboxHolds(p: string, f: Facts): boolean {
  if (!f.sandboxed || contains(f.workspace, p)) return false;
  // (The kernel's own trees lead back in: /proc/self/cwd is the session's folder.)
  if (/^\/(proc|dev|sys)(\/|$)/.test(p)) return false;
  if (["/tmp", "/var/tmp", "/dev/shm", tmpdir(), ...(f.scratch ?? [])].some((t) => contains(t, p))) return false;
  const home = f.home ?? homeDir();
  return !(contains(home, p) && HOME_OWN.test(relative(home, p)));
}

// A path as a command or a tool's input spells it: ~ and $HOME are the home
// folder, a relative one starts at `cwd`. Nothing for a word an expansion makes.
function spelled(w: string, cwd: string, home: string): string | null {
  w = w.replace(/^(["'])(.*)\1$/s, "$2").replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
  if (!w || /[$`*?\n]/.test(w)) return null;
  return atCwd(cwd, w);
}

// The files a command part writes by its plain shape: the target of a
// redirect, and what tee, cp, mv, rm, install, ln, sed -i and dd of= are given
// to write. Not every write a command can make (an interpreter, a program of
// the session's own): the forms that need no trick, so that a grant, the
// reviewer or the judge does not answer for a start file in passing.
const LAST_ARG = new Set(["cp", "install", "ln", "rsync", "scp"]);
const EACH_ARG = new Set(["tee", "mv", "rm", "truncate", "shred", "sponge", "yq", "patch"]);
// The programs looked for anywhere among the words, as they always were, and the ones read only where the program stands.
const WRITERS = /^(?:.*\/)?(?:cp|install|ln|rsync|scp|tee|mv|rm|truncate|shred|sed|dd)$/;
const WRITER_NAMES = new Set(["cp", "install", "ln", "rsync", "scp", "tee", "mv", "rm", "truncate", "shred", "sed", "dd"]);
const WRITERS_FIRST = /^(?:curl|wget|git|sort|yq|perl|sponge|patch|chmod|chown|chgrp|ed|ex|vi|vim|nvim)$/;
// `run`: the command the part runs, when the caller has worked it out already.
export function writesOf(p: Simple, run?: Run): string[] {
  const out: string[] = [];
  // (Read outside quotes: a > inside a quoted word is text, as in echo "x>=1" > file.)
  if (p.redirects) out.push(...redirectTargets(p.text));
  let i = p.words.findIndex((w) => WRITERS.test(w));
  if (i < 0) { run ??= unwrap(p.words); if (WRITERS_FIRST.test((run.words[0] ?? "").replace(/^.*\//, ""))) i = run.at; }
  if (i < 0) return out;
  const name = p.words[i]!.replace(/^.*\//, ""), rest = p.words.slice(i + 1), args = rest.filter((a) => !a.startsWith("-"));
  if (LAST_ARG.has(name)) out.push(...args.slice(-1));
  else if (name === "yq" || name === "perl") { if (rest.some((a) => /^-[a-zA-Z0-9]*i/.test(a) || a === "--inplace")) out.push(...args.slice(name === "perl" && !rest.some((a) => /^-[a-zA-Z0-9]*e/.test(a)) ? 0 : 1)); }
  else if (EACH_ARG.has(name)) out.push(...args);
  // What a change of modes or ownership names, past the mode or the owner.
  else if (name === "chmod" || name === "chown" || name === "chgrp") out.push(...args.slice(1));
  // An editor run from a command works from a script: the files it is given are what it writes.
  else if (/^(ed|ex|vi|vim|nvim)$/.test(name)) out.push(...rest.filter((a, k) => !a.startsWith("-") && !a.startsWith("+") && !/^(-c|--cmd|-S|-u|-i|-w|-W|-T|-t)$/.test(rest[k - 1] ?? "")));
  else if (name === "sed") { if (rest.some((a) => /^(?:-[a-zA-Z]*i|--in-place)/.test(a))) out.push(...args); }
  // The files a download is written to (curl -o FILE, wget -O FILE, also attached, in a cluster or as --output=FILE) and the others it writes.
  else if (name === "curl" || name === "wget" || name === "sort") out.push(...outputsOf(p.words.slice(i)).map((o) => o.to));
  else if (name === "git") {
    // The files its output options name (log, diff, show, format-patch ... --output=FILE, format-patch -o DIR), as a redirect's.
    out.push(...outputsOf(p.words.slice(i)).map((o) => o.to));
    // The paths git writes from a commit: checkout and restore of pathspecs, and a rename's new name.
    const sub = args[0], dd = rest.indexOf("--");
    const named = rest.slice(rest.indexOf(sub!) + 1).filter((a, k, all) => !a.startsWith("-") && !/^(-s|--source|-b|-B)$/.test(all[k - 1] ?? ""));
    if (sub === "checkout") out.push(...(dd >= 0 ? rest.slice(dd + 1) : named.length >= 2 ? named.slice(1) : []));
    else if (sub === "restore") out.push(...named);
    else if (sub === "mv") out.push(...named.slice(-1));
  } else for (const a of rest) if (a.startsWith("of=")) out.push(a.slice(3));
  return out;
}
// The folders a command part puts files into under names of their own: where a copy, a move or a sync lands, and
// where an archive is unpacked.
function writesInto(run: string[]): string[] {
  const name = (run[0] ?? "").replace(/^.*\//, "");
  if (!/^(cp|install|mv|rsync|scp|ln|tar|bsdtar|unzip)$/.test(name)) return [];
  const rest = run.slice(1), args = rest.filter((a) => !a.startsWith("-"));
  if (name === "tar" || name === "bsdtar") { const k = rest.findIndex((a) => a === "-C" || a === "--directory"); return k >= 0 && rest[k + 1] ? [rest[k + 1]!] : rest.filter((a) => a.startsWith("--directory=")).map((a) => a.slice(12)); }
  if (name === "unzip") { const k = rest.indexOf("-d"); return k >= 0 && rest[k + 1] ? [rest[k + 1]!] : []; }
  return args.length >= 2 ? args.slice(-1) : [];
}
// A patch a command part applies, or an archive it unpacks, with the folder its files land in (relative to where
// the part runs). `file` is not given when it reads the patch or the archive from another command.
function applied(p: Simple, run: string[]): { kind: "patch" | "archive"; file?: string; into: string } | null {
  const name = (run[0] ?? "").replace(/^.*\//, "");
  if (!/^(git|patch|tar|bsdtar|unzip)$/.test(name)) return null;
  const rest = run.slice(1), args = rest.filter((a) => !a.startsWith("-"));
  if (name === "git") {
    if (args[0] !== "apply" && args[0] !== "am") return null;
    if (rest.some((a) => /^--(stat|numstat|summary|check)$/.test(a)) && !rest.includes("--apply")) return null;
    return { kind: "patch", file: args[1], into: "." };
  }
  if (name === "patch") { const k = rest.findIndex((a) => a === "-i" || a === "--input"); const d = rest.findIndex((a) => a === "-d" || a === "--directory"); return { kind: "patch", file: k >= 0 ? rest[k + 1] : p.inputs?.[0], into: d >= 0 ? rest[d + 1] ?? "." : "." }; }
  if (name === "unzip") { if (rest.some((a) => /^-[a-zA-Z]*[lZtvp]/.test(a))) return null; const k = rest.indexOf("-d"); return { kind: "archive", file: args[0], into: k >= 0 ? rest[k + 1] ?? "." : "." }; }
  // tar: x, in its first word of letters or as an option; the archive after f.
  if (!(/^-?[a-zA-Z]*x/.test(rest[0] ?? "") || rest.some((a) => a === "--extract" || a === "--get" || /^-[a-zA-Z]*x/.test(a)))) return null;
  const f = rest.findIndex((a, k) => (k === 0 && /^[a-zA-Z]*f$/.test(a)) || /^-[a-zA-Z]*f$/.test(a) || a === "--file");
  const c = rest.findIndex((a) => a === "-C" || a === "--directory");
  const file = f >= 0 ? rest[f + 1] : rest.find((a) => a.startsWith("--file="))?.slice(7);
  return { kind: "archive", file: file === "-" ? undefined : file, into: c >= 0 ? rest[c + 1] ?? "." : rest.find((a) => a.startsWith("--directory="))?.slice(12) ?? "." };
}
// Whether a command can put into a file what the line does not hold: a fetcher or a remote copy, a copy or a move from outside
// the session's folder, a program the rules do not know. A program that makes an archive from files it is given, a pack or a
// compress, brings only what the session's folder holds.
const LOCAL_MAKERS = new Set(["tar", "bsdtar", "zip", "gzip", "gunzip", "bzip2", "bunzip2", "xz", "unxz", "zstd", "unzstd", "7z", "7za", "7zr", "lz4", "cpio", "ar", "touch", "mkdir", "rm", "echo", "printf", "ls", "cat", "true", "test", "sha256sum", "md5sum", "stat", "file", "chmod"]);
function bringsContent(run: string[], at: string, workspace: string, home: string): boolean {
  const name = (run[0] ?? "").replace(/^.*\//, "");
  if (LOCAL_MAKERS.has(name)) return false;
  if (/^(cp|mv|install|ln)$/.test(name)) {
    const words = run.slice(1).filter((w) => !w.startsWith("-"));
    return words.slice(0, -1).some((w) => { const p = /[$`*?]/.test(w) ? null : spelled(w, at, home); return p === null || !contains(workspace, p); });
  }
  return true;
}
const LANDS = new Set(["cp", "install", "mv", "rsync", "scp", "ln", "tar", "bsdtar", "unzip", "git", "patch", "node", "nodejs", "bun", "deno", "perl", "ruby", "php"]);
// A folder that holds folders of files that run later: something moved or copied under its name brings them.
const HOLDS_RUNS_LATER = /(^|\/)\.(github|gitlab|circleci|buildkite|forgejo|gitea|woodpecker|tekton|husky|githooks|keel|claude|codex|gemini|vscode|azure-pipelines|semaphore|teamcity|git)$/;

// The files and folders a reading tool's input names: its path keys, a
// relative one from the call's folder, and any other string that is an
// absolute path (a pattern that starts at one).
const PATH_KEY = /^(file_?path|path|paths|dir_?path|directory|absolute_path|notebook_path|file|files|filename|folder|root|target|source|src|dest|destination)$/i;
// A key that holds a pattern of names: read from the tool's folder key when it has one (Glob's `path`), else as a
// path when it starts at one. A pattern that reaches a store by a wildcard-free start is that store's.
const PATTERN_KEY = /^(pattern|patterns|glob|include|includes)$/i;
const MANY_KEY = /^(paths|files)$/i;
export function readPaths(input: unknown, cwd: string): string[] {
  const out = new Set<string>();
  const whole = (v: string) => (v === "~" ? homeDir() : v.startsWith("~/") ? join(homeDir(), v.slice(2)) : v);
  // `pattern`: the value came from a pattern key: it is read up to its first wildcard (the folder the pattern looks
  // in). A path key's value is a path whole, whatever characters its names hold (a link can be named `l[x`).
  const add = (v: unknown, base = cwd, pattern = false) => {
    if (typeof v !== "string" || !v || v.length > 4096) return;
    let t = whole(fileUrl(v) ?? v);
    if (pattern) { const wild = t.search(/[*?[{]/); if (wild >= 0) t = dirname(`${t.slice(0, wild)}x`); }
    // (With its `..` kept: where it leads is the walk's to say, realOf.)
    out.add(atCwd(base, t));
  };
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const entries = Object.entries(input);
    const each = (v: unknown, f: (x: unknown) => void) => { if (Array.isArray(v)) for (const x of v.slice(0, 32)) f(x); else f(v); };
    const bases: string[] = [];
    for (const [k, v] of entries) if (PATH_KEY.test(k)) each(v, (x) => {
      add(x);
      // (A list of paths takes patterns too, AskReaders' and read_many_files' among them: such an entry is read as
      // the name it is and as the folder its pattern looks in.)
      if (MANY_KEY.test(k) && typeof x === "string" && /[*?[{]/.test(x)) add(x, cwd, true);
      if (typeof x === "string" && x) bases.push(atCwd(cwd, whole(x)));
    });
    for (const [k, v] of entries) if (PATTERN_KEY.test(k)) each(v, (x) => {
      if (typeof x !== "string" || !x) return;
      // The part before the first wildcard names where the pattern looks.
      const lead = x.slice(0, x.search(/[*?[{]|$/));
      if (isAbsolute(whole(x))) add(x, cwd, true);
      else if (lead.includes("/") || lead.startsWith(".")) for (const b of bases.length ? bases : [cwd]) add(x, b, true);
    });
  }
  return [...out].slice(0, 32);
}

// The path a file: URL names, or nothing for any other string.
export function fileUrl(v: string): string | undefined {
  if (!/^file:/i.test(v)) return undefined;
  try { const u = new URL(v); return u.protocol === "file:" && (u.hostname === "" || u.hostname === "localhost") ? decodeURIComponent(u.pathname) : undefined; } catch { return undefined; }
}

// The strings of a tool's input that are a path by themselves (an MCP file
// server's `path`, at any depth) or a file: URL, for a tool whose input the
// gate cannot read otherwise.
export function pathsNamed(input: unknown): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (v: unknown, depth: number) => {
    if (++seen > 200 || depth > 4 || out.length >= 32) return;
    if (typeof v === "string") {
      if (v.length >= 4096) return;
      // A path by itself, or a file: URL (an MCP server's `uri`).
      const file = fileUrl(v);
      if (file) out.push(file);
      else if (/^(?:~|\/)[^\s]*$/.test(v)) out.push(v);
    }
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(input, 0);
  return out;
}

// Whether an edit stays inside what the session may already touch: its
// workspace (the repository's own metadata aside) or a scratch folder of its own.
const protectedPath = (workspace: string, p: string) => /(^|\/)\.git(\/|$)/.test(relative(workspace, p));
export const ownPath = (p: string, f: Pick<Facts, "workspace" | "scratch">) => (contains(f.workspace, p) && !protectedPath(f.workspace, p)) || !!f.scratch?.some((d) => contains(d, p));

// `scratch`: folders of the harness's own the session writes in like its workspace (its artifacts folder).
// `config`: Keel's own config folder and files (ownerOnlyEdit). `bins`: the
// folders of the session's PATH inside its workspace (workspaceBins). `own`: the
// home folder, that config and where a path lands, read from the disk only
// when a call names a file to change (a read never asks for them).
export type Facts = {
  mode: Mode; workspace: string; sandboxed: boolean; rules: Rule[]; tool: string; bind?: string; scratch?: string[]; home?: string; config?: string[]; bins?: string[];
  own?: () => { home: string; config: string[]; bins?: string[]; land: (p: string) => string[] };
  // What this machine's disk says, asked by the gate before it decides (looked.ts): what git cannot bring back
  // under a path, whether a path is there, the files a patch or an archive writes. Without it a delete inside the
  // folder is judged by names, and a patch or an archive is not read.
  looked?: Looked;
  // The owner's namespaces (Settings > Permissions). Without it no write with an account is looked at. `agent`: a session an
  // agent works in, which is refused such a write where the owner would be asked.
  accounts?: { names: Namespace[]; agent?: true };
  // Whether a program's name on this machine is the program itself and not a version manager's shim (shims.ts):
  // looked up by the gate before it decides, so this only reads the answer. Without it the reading forms of such
  // programs (node --version) are not reads.
  real?: (program: string) => boolean;
  // Whether the session's sandbox shows a path to its commands (sandbox-view.ts, shownTo): a file tool of a
  // sandboxed session reads what they read. `store`: a credential store or one of Keel's own folders.
  shown?: (path: string) => { shown: true } | { shown: false; store: boolean; why: string };
  // The same for a command that runs in the sandbox (given only then, not for one that leaves it): what the
  // sandbox hides the command cannot read, so naming it asks nobody; what it shows is judged as below.
  confinedShown?: (path: string) => { shown: boolean };
  // The credential a path is or is in (credentials.ts), as named and where it lands: the gate's, with Keel's own
  // folders. Without it the path as named is read against the home's stores and the names alone.
  credential?: (path: string) => Credential | null;
  // What the disk adds to a command's words about credentials: the files named like them in a folder it searches,
  // the files a wildcard of it matches (credential-reads.ts).
  look?: DiskLook;
  // The session is an agent another session started: it reads no credential, in any mode.
  agent?: true;
  // Why a file (where it lands) is in Keel's own state folder, which no session's tool writes in any mode; nothing
  // for any other file, the session's own artifacts and a worktree Keel made for it.
  keel?: (path: string) => string | null;
  // Why a file is in Keel's own config folder (skills, hooks, MCP servers, settings): the owner's own card in the
  // asking modes. Full auto checks nothing, so there it runs; a sandbox there keeps the session's file tools out
  // of it, as it keeps its commands out.
  keelConfig?: (path: string) => string | null;
  // Whether a file has another name somewhere (a hard link): a write to it lands there too.
  linked?: (path: string) => boolean;
  // For an agent in a worktree Keel made for it: the checkouts it shares its branches with. A command that moves
  // one of their branches is refused in every mode (shared-branches.ts). The owner's own sessions have none.
  shared?: Shared;
  // Whether the owner's own words are in the turn that runs the call (a loop run, a wake, a monitor's batch, a watch
  // or an agent's report started it when they are not): asked only when a command could merge, approve or force-push.
  // Without it nothing is limited.
  byOwner?: () => boolean;
};

// The class of a command that asks to run outside the sandbox.
export const ESCALATES = "asks to leave the sandbox";

export function decide(c: CallClass, f: Facts): Decision {
  // A web request that sends (a page fetch to an unseen address that carries data, or a request with a body):
  // high risk in every mode, never refused for it. The asking modes show the owner the
  // card (Reviewer too: its reviewer answers low risk only), Auto's judge reviews it, and Full auto, which checks
  // nothing, runs it and names it in the activity list. Read only and Plan ask too: a fetch changes nothing here.
  if (c.kind === "send") {
    // (The addresses themselves are the card's text, `shown`.)
    const why = c.carries
      ? "it sends a request with a body, headers or a method of its own"
      : `it fetches ${c.to.length === 1 ? "an address" : "addresses"} this session has not seen (not in your messages, a search result or a page fetched before) with ${c.because ?? "data"}`;
    return { ask: { risk: "high", why, rule: c.carries ? "sends a request of its own" : "an address the session has not seen, with data", suggest: [] } };
  }
  if (c.kind === "read") {
    // A sandboxed session's file tools run outside the sandbox: they read
    // what its commands read (the sandbox's view) and nothing else without
    // the owner, in every mode. Full auto checks nothing, and asks nobody:
    // there such a read is refused, as the sandbox refuses a command's. That
    // is the sandbox the owner turned on holding, not a review of the call.
    // A reading tool that runs outside the sandbox and names no file reads where it chooses: nothing here can say
    // what. The owner is asked once (the answer stands for the tool, as for any tool known by its name). In Full
    // auto it runs, as every tool that is not a file tool does there: no sandbox holds such a tool.
    if (f.sandboxed && c.unnamed && f.mode !== "read-only" && f.mode !== "plan" && f.mode !== "full-auto") {
      if (toolRule(f, f.tool)) return { allow: true };
      return { ask: { risk: "low", why: `${f.tool} is a reading tool that names no file: it runs outside this session's sandbox and reads where it chooses`, rule: "reads where it chooses", suggest: toolSuggest(f, f.tool) } };
    }
    // Where credentials are kept (credentials.ts, the list a command's reads are held to too): an agent's read is
    // refused; the owner's sessions ask the owner, one read at a time (Full auto flags it and runs it). What such a
    // read returns is kept from every model by the secrets vault (the gate gives it the file's values first).
    const cred = credentialIn(c.paths ?? [], f);
    if (cred && f.agent) return credentialRead(cred.what, f, "it reads", cred.api);
    if (f.sandboxed && f.shown) for (const p of c.paths ?? []) {
      const v = f.shown(p);
      if (v.shown) continue;
      if (f.mode === "full-auto") return { deny: `Refused: ${v.why.replace(/\.$/, "")}. ${CONFINED} They read only what its commands can read. Say what you wanted it for and go on with the rest.` };
      return onlyOwner(v.why, v.store ? "a credential store or one of Keel's own files" : "outside what the sandbox shows");
    }
    if (cred) return credentialRead(cred.what, f, "it reads", cred.api);
    return { allow: true };
  }
  if (c.kind === "control") return { allow: true };
  // Plan mode holds like read-only, and says how to go on.
  if (f.mode === "plan") {
    const d = decide(c, { ...f, mode: "read-only" });
    return "deny" in d ? { deny: `${d.deny.replace("This session is read-only", "This session is in plan mode")} Present your plan with the plan tool (ExitPlanMode or present_plan); the owner approves it before anything changes.` } : d;
  }
  if (c.kind === "shell") {
    // Escalation is one-call consent in Auto, even if the sandbox is off.
    // Other modes keep their existing handling of escalation requests.
    if (c.escalate && (f.sandboxed || f.mode === "auto")) {
      if (f.mode === "read-only") return { deny: "This session is read-only: commands cannot leave the sandbox." };
      const inner = decideShell(c.command, f, c.cwd, c.interpreter);
      if ("deny" in inner) return inner;
      const why = ["the command asks to run outside the sandbox", "ask" in inner ? inner.ask.why : undefined].filter(Boolean).join("; and ");
      // What else the command is asked for, when that is a rule of its own.
      const rule = [ESCALATES, "ask" in inner && inner.ask.risk === "high" ? inner.ask.rule : undefined].filter(Boolean).join("; ");
      return f.mode === "auto" ? onlyOwner(why, rule) : { ask: { risk: "high", why, rule, suggest: [] } };
    }
    return decideShell(c.command, f, c.cwd, c.interpreter);
  }
  if (c.kind === "refused") return { deny: c.why };
  if (c.kind === "drive") return decideDrive(c, f);
  if (c.kind === "edit") {
    // Keel's own state is never a session's tool's to write, in any mode, Full auto included: not a check of the
    // work, but what keeps a session from corrupting the store of the daemon it runs in.
    for (const p of c.paths) { const why = f.keel?.(p); if (why) return { deny: keelRefusal(why) }; }
    // An agent in a worktree Keel made writes no git data its worktree shares, in any mode (shared-branches.ts).
    if (f.shared) for (const p of c.paths) { const what = gitStoreOf(p, f.shared); if (what) return { deny: sharedMessage(`would change ${what}`, f.shared, "the edit") }; }
    if (f.mode === "read-only") return { deny: "This session is read-only: files cannot be changed. Say what you would change instead." };
    if (f.mode === "full-auto") {
      // Full auto checks nothing. A sandbox the owner turned on still holds, and it holds the session's file tools
      // as it holds its commands: they write where its commands can and nowhere else. That is its folder (the
      // repository's own metadata and a config file of Keel's kept there aside, which the sandbox keeps read-only)
      // and its scratch, by where the file really is, and not through a file that has another name elsewhere.
      if (f.sandboxed) for (const p of c.paths) {
        const why = f.linked?.(p) ? hardLinked(p) : f.keelConfig?.(p) ?? (ownPath(p, f) ? null : `it changes ${p}, outside this session's folder, where its sandbox lets nothing write`);
        if (why) return { deny: `Refused: ${why}. ${CONFINED} They write only where its commands can. Say what you wanted it for and go on with the rest.` };
      }
      // Everything else runs. An edit of a file that runs later (a hook, a CI workflow, a shell's start file, Keel's
      // own configuration) is flagged high risk, which in Full auto names it in the activity list and stops nothing.
      for (const p of c.paths) { const o = ownerOnlyEdit(p, f); if (o) return { ask: { risk: "high", why: o.why, rule: o.rule, suggest: [] } }; }
      return { allow: true };
    }
    // Keel's own config (also under another name, a hard link): the owner's call, one at a time.
    for (const p of c.paths) { const why = f.keelConfig?.(p); if (why) return onlyOwner(why, "Keel's own configuration"); }
    // A file with another name elsewhere: what is written through it lands outside the sandbox's folders too.
    if (f.sandboxed) for (const p of c.paths) if (f.linked?.(p)) return onlyOwner(hardLinked(p), "a file with another name outside the sandbox");
    // A file something runs or reads its configuration from later (git hooks,
    // direnv, the project's hook and MCP files, Keel's own config, a shell's
    // start file, the login keys): the owner's call, one at a time. No grant,
    // reviewer or hook answers it.
    for (const p of c.paths) { const o = ownerOnlyEdit(p, f); if (o) return onlyOwner(o.why, o.rule); }
    const program = c.names?.length ? namesProgram(c.paths, c.names) : null;
    if (program) return onlyOwner(`it writes ${program.what}, into ${relative(f.workspace, program.path)}`, "names code a language server runs");
    const editRules = f.rules.filter((r) => r.kind === "edit");
    const covered = (p: string) => editRules.some((r) => contains(r.pattern, p));
    // The repository's own metadata is not an in-scope edit.
    const open = c.paths.filter((p) => !covered(p) && !((f.mode === "auto-edits" || f.mode === "auto") && ownPath(p, f)));
    if (!open.length) return { allow: true };
    const dirs = [...new Set(open.map((p) => (contains(f.workspace, p) && !protectedPath(f.workspace, p) ? f.workspace : dirname(p))))];
    return { ask: { risk: "low", suggest: dirs.map((d) => ({ kind: "edit", pattern: d })) } };
  }
  // A tool that can change things, given one of Keel's own files (an MCP file server's write): its state never, in
  // any mode (its config is the owner's card in the asking modes, below, and runs in Full auto).
  if (c.kind === "other") for (const w of c.paths ?? []) {
    const why = keelNamed(w, f.workspace, f, "names", f.keel);
    if (why) return { deny: keelRefusal(why) };
  }
  // A tool whose server requires the owner's answer on every call (requiresUserInteraction): his card in every mode,
  // Full auto included, for this call only (no Always allow). No rule, grant, hook or mode settles it: it is decided
  // before they are read. An agent has nobody to ask and is refused.
  if (c.kind === "other" && c.hints?.interaction) {
    const why = `${f.tool}'s server requires your answer on every call (requiresUserInteraction)`;
    if (f.agent) return { deny: `Refused: ${why}. An agent has nobody to ask, and nothing else allows it. Report to your parent what you wanted it to do and go on with the rest: the session that started you can call it and ask the owner.` };
    if (f.mode === "read-only" && !c.reads) return { deny: `This session is read-only: ${f.tool} can change things, so it does not run here.` };
    return { ask: { risk: "high", why, rule: "its server requires the owner's answer on every call", suggest: [], ownerOnly: true, interaction: true } };
  }
  // A tool that writes with an account its server holds (Slack, mail, a forge): the owner's in every mode, unless its input
  // names an owner who is among his namespaces. An agent is refused.
  if (c.kind === "other" && c.account && f.accounts && f.mode !== "read-only") {
    const owners = namedOwners(c.account.input);
    if (!(owners.length && owners.every((o) => ownsOwner(f.accounts!.names, o)))) {
      const names = f.accounts.names;
      const yours = names.length ? names.map(say).join(", ") : "none named yet (Settings > Permissions)";
      const named = owners.length ? ` for ${owners.join(", ")}, not among your namespaces` : `, and nothing in the call names whose it is`;
      const why = `${f.tool} writes with the account the MCP server ${c.account.server} holds${named} (your namespaces: ${yours})`;
      if (f.accounts.agent) return { deny: `Refused: ${why}. ${AGENT_SAYS}` };
      return { ask: { risk: "high", why, rule: "writes beyond your accounts", suggest: [], ownerOnly: true, account: owners.join(", ") || c.account.server, ...(c.account.name && c.account.tool ? { readTool: { server: c.account.name, tool: c.account.tool } } : {}) } };
    }
  }
  if (f.mode === "full-auto") return { allow: true };
  if (f.mode === "read-only") return { deny: `This session is read-only: ${f.tool} can change things, so it does not run here.` };
  // A tool that can change things, given a file that is the owner's alone to change (an MCP file server's write).
  if (c.kind === "other") for (const w of c.paths ?? []) {
    const o = ownerOnlyNamed(w, f.workspace, f, "names");
    if (o) return onlyOwner(o.why, o.rule);
  }
  const grant = (c.kind === "other" && c.grant) || f.tool;
  if (toolRule(f, grant)) return { allow: true };
  const hints = c.kind === "other" ? c.hints : undefined;
  const world = hints?.openWorld ? "its server says it reaches services outside this machine (openWorldHint)" : undefined;
  // A tool its server calls destructive: high risk, so its card is answered once (no standing answer), the
  // reviewer hands it to the owner and Auto's judge reviews it as high risk. (Full auto checks nothing, above.)
  if (hints?.destructive) return { ask: { risk: "high", why: ["its server says it may delete or overwrite data (destructiveHint)", world].filter(Boolean).join("; and "), rule: "its server says it may destroy data", suggest: [] } };
  return { ask: { risk: "low", ...(world ? { why: world } : {}), suggest: toolSuggest(f, grant) } };
}

// (Said in every mode, Full auto too: it is not a review of the work.)
const keelRefusal = (why: string) => `Refused: ${why}. No session's tool writes there in any mode, Full auto included: this is not a check of your work, it keeps a session from corrupting the store of the daemon it runs in. Say what you wanted it for and go on with the rest.`;
// What a sandboxed session's file tool is told in Full auto, where nothing is checked and the sandbox still holds.
const CONFINED = "This session has a sandbox, and a sandbox confines the session's file tools as it confines its commands, in Full auto too.";
const hardLinked = (p: string) => `it changes ${p}, a file that has another name elsewhere (a hard link): what is written lands there too, outside what this session's sandbox lets it write`;
// Why a path a command or a tool's input names is one of Keel's own files, where it lands.
function keelNamed(w: string, cwd: string, f: Facts, does: string, of: Facts["keel"]): string | null {
  if (!of) return null;
  const p = spelled(w, cwd, f.home ?? homeDir());
  if (!p) return null;
  for (const q of f.own?.().land(p) ?? [p]) { const why = of(q); if (why) return why.replace(/^it changes/, `it ${does}`); }
  return null;
}

// Never allowed on its own: in Auto and Reviewer it is refused, whatever a
// judge would say; in Full auto, which checks nothing, it runs (flagged as
// high risk, so the activity list says so); elsewhere it is the owner's call.
// The class of a read of where credentials are kept, in a few words.
export const CREDENTIAL_RULE = "reads credentials";
const credentialOf = (p: string, f: Facts) => (f.credential ? f.credential(p) : credentialAt(p, placesOf(f.home ?? homeOf())));
const credentialIn = (paths: string[], f: Facts) => { for (const p of paths) { const c = credentialOf(p, f); if (c) return c; } return null; };
// A read of a credential, by a file tool or a command: an agent's is refused, with what it can do instead; the
// owner's sessions ask the owner (no grant answers it); Full auto, which asks nobody, flags it and runs it.
function credentialRead(what: string, f: Facts, by = "it reads", api?: string): Decision {
  if (f.agent) return { deny: `Refused: ${by} ${what}. An agent does not read the owner's credentials, in any mode. ${api ? `Keel's API gives what the file holds with the values masked: ${api}. If the task needs a value it leaves out` : "If the task needs what it holds"}, say so in your report: the session that started you can ask the owner. Go on with the rest.` };
  if (f.mode === "full-auto") return { ask: { risk: "high", why: `${by} ${what}`, rule: CREDENTIAL_RULE, suggest: [] } };
  return onlyOwner(`${by} ${what}`, CREDENTIAL_RULE);
}

export { shellCredentialReads };

const never = (why: string, f: Facts): Decision =>
  f.mode === "full-auto" ? { ask: { risk: "high", why: `the command ${why}`, rule: why, suggest: [] } }
  : f.mode === "auto" || f.mode === "reviewer"
    ? { deny: `Refused: the command ${why}, which never runs without the owner. Do not try another form of it; say what you wanted it for and go on with the rest.` }
    : onlyOwner(`the command ${why}`, why);

// Why a line's writes by a remote's name, or by default, cannot be placed: the line itself changes where remotes point
// (git config remote.*.url, -c url.*.insteadOf, GIT_CONFIG_*, GIT_DIR, git remote set-url, gh repo set-default), which
// remote a push by default goes to (remote.pushDefault, branch.*.remote and .pushRemote, a fetch or pull --set-upstream),
// renames or removes a section of the settings (git config --rename-section), has git read another config
// file or take a key from the environment (include.path, includeIf.*.path, --config-env, a HOME or XDG_CONFIG_HOME of the
// line's own), which can say any of those, or names a template, whose config a repository the line makes starts with
// (init.templateDir, GIT_TEMPLATE_DIR).
const REBOUND = /^(remote\.[^=\s]*\.(url|pushurl|gh-resolved)|url\..*\.(push)?insteadof|init\.templatedir)(=|$)/i;
const REBOUND_DEFAULT = /^(remote\.pushdefault|branch\..*\.(remote|pushremote))(=|$)/i;
const REBOUND_FILE = /^(include\.path|includeif\..*\.path)(=|$)/i;
const REBOUND_ENV = /^(GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL|SYSTEM)|GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_TEMPLATE_DIR)=/;
// An option as git takes it shortened: any start of its name that is long enough to be no other's (`--rename-sec`,
// `--set-upst`), with or without a value joined to it.
const shortFor = (x: string, full: string, least: number) => { const o = x.split("=")[0]!; return o.length >= least && full.startsWith(o); };
// (git reads the owner's own settings from $HOME/.gitconfig and $XDG_CONFIG_HOME/git/config: another folder there is another
// set of url rewrites.)
const REBOUND_HOME = /^(HOME|XDG_CONFIG_HOME)=/;
export function reboundBy(parts: Simple[]): string | undefined {
  for (const part of parts) {
    if (part.heredoc) continue;
    const w = part.words;
    for (let i = 0; i < w.length; i++) {
      const x = w[i]!;
      if (REBOUND.test(x)) return "the same line sets where a remote points";
      if (REBOUND_DEFAULT.test(x)) return "the same line sets which remote a push goes to";
      if (REBOUND_FILE.test(x)) return "the same line has git read another config file, which can say where a remote points";
      if (/^--config-env(=|$)/.test(x)) return "the same line gives git a setting from the environment, which can say where a remote points";
      if (REBOUND_ENV.test(x)) return "the same line sets git's configuration or its folder through the environment";
      if (REBOUND_HOME.test(x)) return "the same line sets HOME or XDG_CONFIG_HOME, where git reads your own settings from, which can say where a remote points";
      if (x === "remote" && /^(rename|remove|rm|set-head)$/.test(w[i + 1] ?? "") && w.slice(0, i).some((y) => baseName(y) === "git")) return "the same line changes a remote";
      if (x === "set-default" && w[i - 1] === "repo" && baseName(w[i - 2]) === "gh") return "the same line changes the repository gh acts on";
      // (A section of git's config renamed or removed is a remote or a branch's settings under another name; a fetch or
      // a pull with --set-upstream makes what it names the branch's remote, an address included.)
      const git = () => w.slice(0, i).some((y) => baseName(y) === "git");
      // (Also as git config's own subcommands: git config rename-section, remove-section.)
      const section = shortFor(x, "--rename-section", 5) || shortFor(x, "--remove-section", 5) || ((x === "rename-section" || x === "remove-section") && w.slice(0, i).includes("config"));
      if (section && git()) return "the same line renames or removes a section of git's settings, which can be a remote's or a branch's";
      if (shortFor(x, "--set-upstream", 5) && w.slice(0, i).some((y) => y === "fetch" || y === "pull") && git()) return "the same line sets which remote a push goes to";
    }
  }
  return undefined;
}

// What a line has set so far for the commands after it: the variables it gave a value, and the ones it exported.
// `moved`: the script starts in a folder the line went to. `unsure`: or in another one, which the rules cannot name.
// `homeKept`: whether HOME still names the owner's home for the script (asked only when a `cd` of it reads HOME). `real`,
// `cdpath`: what started the script's shell asked it for real folders, or the line names CDPATH (risk-words.ts Else).
// `makes`: a command before the script makes a repository (line-makes.ts).
type Scope = { vars: Map<string, string>; exported: Set<string>; rebinds?: string; added: Map<string, string>; moved?: boolean; unsure?: boolean; homeKept?: () => boolean; real?: boolean; cdpath?: boolean; makes?: (dir: string) => boolean; evaled?: boolean };
const ELSE_WHY = "a cd before it may not land where it says (it can fail, the line names CDPATH, or it is not one the rules follow), so the folder it runs in is not known to the rules";

// `git -C ~/folder`: a `~/` that begins the word, unquoted, is the home folder by the time git reads it (the shell writes
// it out before git starts), as it is for a `cd`: the word is read as that folder. Not when the word is quoted or escaped
// (git is then given the `~` itself, a folder of that name where it runs), names anything else the shell makes (a
// variable, a glob, `~user`), or stands in a line that may give HOME another value: one that names HOME other than to
// read it, an eval or a sourced file. A script another shell is given (`bash -c`, behind `sudo -u`) is not read so: whose
// home that shell has is not in the line's words. Such a word stays one the rules do not place.
// The same holds for a `cd` with no folder, to `~` or under it: in a line that may give HOME another value the folder it
// leaves the shell in is not known (in a script another shell is given too, where the line and the script both keep HOME
// and no other account starts that shell).
// What a shell that is given a script reads before it, or finds as a function, when it starts: BASH_ENV, an exported function.
const STARTS_WITH = /(^|[^A-Za-z0-9_])(BASH_ENV|BASH_FUNC_[A-Za-z0-9_]*)(%%)?(=|$)/;
const MADE_COMPUTES = /\$\{(?![A-Za-z_][A-Za-z0-9_]*\})|\$\(\(|\$\[/;
const HOME_READ = /\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g;
// (git's own options that take the next word, as the account rules read them: accounts.ts gitWrites.)
const GIT_VALUED = new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
type Runs = { runs: Run[]; dirs: (string | null)[] };
// Whether no part of a line can give HOME another value.
function keepsHome(parts: Simple[], runs: Run[]): boolean {
  return !parts.some((s, i) => {
    const first = baseName(runs[i]?.words[0]);
    if (s.heredoc) return false;
    const run = runs[i]!;
    // A part the parser does not read (a for or select name, a descriptor variable, arithmetic), code it is handed.
    if (s.unknown || first === "eval" || first === "source" || first === ".") return true;
    if (/\bHOME\b/.test(s.text.replace(HOME_READ, "")) || s.words.some((w) => /\bHOME\b/.test(w.replace(HOME_READ, "")))) return true;
    // A name that stands for another, or one whose value is computed.
    if (/^(declare|typeset|local)$/.test(first) && s.words.some((w) => /^-[a-zA-Z]*[ni]/.test(w))) return true;
    if (!s.dyn?.length) return false;
    // A word an expansion makes: one that can compute (${x:n}, ${a[n]}, ${!x}, $((..)), $[..]), an array subscript,
    // or any in a command that can give a name a value (export ${x}ME=, read $n, printf -v "$n", let, trap).
    if (s.dyn.some((n) => MADE_COMPUTES.test(s.words[n] ?? ""))) return true;
    if (!run.words.length) return s.words.some((w) => /^[A-Za-z_][A-Za-z0-9_]*\[/.test(w));
    return first !== "git" && first !== "cd" && !isReadOnly(s);
  });
}
// A `cd` or `pushd` whose folder is read from HOME: none given, `~`, or under it.
const readsHome = (r: Run) => {
  if (r.words[0] !== "cd" && r.words[0] !== "pushd") return false;
  const arg = r.words.slice(1).find((a) => !a.startsWith("-") || a === "-");
  return arg === undefined ? r.words[0] === "cd" : arg === "~" || arg.startsWith("~/");
};
function homeWritten<P extends Runs>(parts: Simple[], pre: P, home: string, homeKept: () => boolean): P {
  let runs: Run[] | undefined;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!, run = pre.runs[i]!;
    if (part.heredoc || baseName(run.words[0]) !== "git") continue;
    for (let k = 1; k < run.words.length && run.words[k]!.startsWith("-"); k++) {
      const o = run.words[k]!;
      if (GIT_VALUED.has(o)) { k++; continue; }
      if (o !== "-C") continue;
      const w = run.words[++k];
      if (w === undefined || !(w === "~" || w.startsWith("~/")) || /[$`*?[\]{}]/.test(w)) continue;
      // (The word as the line wrote it: the same word, with no quote or escape in it.)
      const at = run.at + k;
      if (part.words[at] !== w || part.quotes?.includes(at) || part.dyn?.includes(at) || !homeKept()) continue;
      runs ??= pre.runs.slice();
      const words = (runs[i] === run ? (runs[i] = { ...run, words: run.words.slice() }) : runs[i]!).words;
      words[k] = home + w.slice(1);
    }
  }
  const dirs = pre.runs.some(readsHome) && !homeKept() ? dirsOf(parts, pre.runs, pre.dirs[0] ?? null, null) : undefined;
  return runs || dirs ? { ...pre, ...(runs ? { runs } : {}), ...(dirs ? { dirs } : {}) } : pre;
}

// Every write with an account the parts of a line make, found through what wraps them and in the folder each runs in.
// A script a shell is given with -c (or eval) is read as a line of its own. Exports before a command count for it.
// `sandboxed`: whether the session's commands are confined (false only where that is known): a confined shell does not
// see every folder the daemon does, so a cd is taken as landing by the disk's word only outside a sandbox.
export function accountWrites(parts: Simple[], pre: Runs, f: Pick<Facts, "looked" | "home"> & { sandboxed?: boolean }, depth = 0, from?: Scope): Write[] {
  const out: Write[] = [];
  const home = f.home ?? homeDir();
  let kept: boolean | undefined;
  const homeKept = from?.homeKept ?? (() => (kept ??= keepsHome(parts, pre.runs)));
  if (depth === 0) pre = homeWritten(parts, pre, home, homeKept);
  const scope: Scope = { vars: new Map(from?.vars), exported: new Set(from?.exported), rebinds: from?.rebinds ?? reboundBy(parts), added: new Map(from?.added) };
  const cdpath = !!from?.cdpath || namesCdpath(parts), real = !!from?.real || asksReal(parts, pre.runs);
  // The folder the line starts in, and for each part the other folders it may run in (a cd before it that failed).
  // (The line's first command, a cd to a folder the disk says is there, leaves the shell nowhere else.)
  const lands = depth === 0 && f.sandboxed === false && f.looked?.enters ? (p: string) => f.looked!.enters!(p) === "yes" : undefined;
  const start = pre.dirs[0] ?? null, or = elseOf(parts, pre.runs, pre.dirs, { cdpath, real, ...(lands ? { lands } : {}), ...(from?.evaled ? { evaled: true } : {}) });
  const key = (w: Write) => `${w.does}\0${w.account ? say(w.account) : ""}`;
  // The folders the line's own git makes as it goes (line-makes.ts).
  // (A folder git is given with a `..` in it is read through the disk, which walks it: not read while it has not answered.)
  const onDisk = f.looked?.real ? (p: string) => { const r = f.looked!.real!(p); return r === "late" ? null : r; } : undefined;
  const made = follow(from?.makes, onDisk);
  parts.forEach((part, i) => {
    if (part.heredoc) return;
    // (env takes any name: a function handed to a shell, BASH_FUNC_name%%=..., is set for the command, not its first word.)
    const raw = pre.runs[i]!, fn = raw.words.findIndex((x) => !/^BASH_FUNC_[^=\s]*=/.test(x));
    const run = fn > 0 ? { ...raw, words: raw.words.slice(fn), at: raw.at + fn, set: [...raw.set, ...raw.words.slice(0, fn)] } : raw;
    const kept = [...scope.exported].filter((k) => scope.vars.has(k)).map((k) => `${k}=${scope.vars.get(k)}`);
    // (find -execdir runs its command in the folder of each file it found, not where the line is.)
    // (Nor does one `env -C FOLDER` starts: it runs in the folder env is given.)
    const elsewhere = (run.fed === "find" && part.words.some((x) => x === "-execdir" || x === "-okdir")) || (run.at > 0 && part.words.slice(0, run.at).some((x, k, all) => /^(-[a-zA-Z]*C|--chdir(=.*)?)$/.test(x) && all.slice(0, k).some((y) => baseName(y) === "env")));
    const dir = elsewhere ? null : pre.dirs[i] ?? null;
    // A command xargs or parallel hands its last words to is not placed by the words the line spells.
    const writesToAccounts = (words: string[], e: AccountEnv) => (run.fed === "xargs" ? writesFed(words, e) : writesPlain(words, e));
    const others = from?.unsure && !or[i]!.includes(null) ? [...or[i]!, null] : or[i]!;
    const base = { set: [...kept, ...run.set], ...(scope.rebinds ? { rebinds: scope.rebinds } : {}), ...(scope.added.size ? { added: scope.added } : {}), makes: made.mayHold, remade: made.mayReplace,
      ...(f.looked?.remotes ? { remotes: (d: string) => f.looked!.remotes!(d) } : {}), ...(f.looked?.manifest ? { manifest: (d: string) => f.looked!.manifest!(d) } : {}),
      ...(f.looked?.hostname ? { hostname: (h: string) => f.looked!.hostname!(h) } : {}) };
    const at = (d: string | null) => ({ ...base, dir: d, ...(from?.moved || d !== start ? { moved: true as const } : {}) });
    const env = at(dir);
    const found = writesToAccounts(run.words, env);
    out.push(...found);
    // The same command where the shell may be instead: what it writes there counts too.
    if (others.length) {
      const seen = new Set(found.map(key));
      for (const o of others) {
        if (o === dir) continue;
        for (const w of writesToAccounts(run.words, at(o))) {
          if (seen.has(key(w))) continue;
          seen.add(key(w));
          out.push(w.account ? { ...w, does: `${w.does} (in ${o}, where the line is if a cd before it fails)` } : o === null ? { ...w, why: ELSE_WHY } : w);
        }
      }
    }
    const first = baseName(run.words[0]);
    // sh -c 'git push ...', bash -lc "...", eval '...'
    let script: string | undefined, shell = -1;
    if (/^(sh|bash|zsh|dash|ksh)$/.test(first)) { const given = shellGiven(run.words.slice(1)); if (given.script !== undefined) { shell = given.at; script = given.script; } }
    else if (first === "eval") script = run.words.slice(1).join(" ");
    if (script !== undefined) {
      // (A script of more commands than a whole line may hold is not read, as a line of that many is not.)
      const split = depth < 2 ? splitCommand(script) : null;
      const inner = split && split.length <= PARTS_MAX ? split : null;
      if (inner) {
        const runs = inner.map((x) => unwrap(x.words));
        // The script's own HOME: the line's, unless the script or the line can change it, or another account starts its shell.
        let keeps: boolean | undefined;
        const innerKept = () => (keeps ??= homeKept() && !part.words.slice(0, run.at).some((x) => LEAVES.test(baseName(x))) && keepsHome(inner, runs));
        // (A shell started with BASH_ENV or a function in its environment may not have the `cd` its script names: no folder is followed.)
        const preset = STARTS_WITH.test(part.text) || [...scope.exported].some((k) => STARTS_WITH.test(k));
        const dirs = preset && runs.some((r) => /^(cd|pushd|popd)$/.test(r.words[0] ?? "")) ? new Array<string | null>(inner.length).fill(null) : dirsOf(inner, runs, dir, runs.some(readsHome) && !innerKept() ? null : home);
        out.push(...accountWrites(inner, { runs, dirs }, f, depth + 1, { vars: new Map([...scope.vars, ...run.set.map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] as [string, string])]), exported: new Set([...scope.exported, ...run.set.map((a) => a.slice(0, a.indexOf("=")))]), rebinds: scope.rebinds, added: scope.added, moved: !!env.moved, unsure: others.length > 0,
          homeKept: innerKept, cdpath, real: real || (shell > 0 && startsReal(run.words, shell)), makes: made.mayHold, evaled: first === "eval" || !!from?.evaled }));
      } else if (/\b(push|publish|upload)\b|\b(gh|glab) /.test(script)) out.push({ does: first, account: null, why: split ? `the script it runs holds ${split.length} commands, more than the rules read through (${PARTS_MAX})` : "the script it runs is nested deeper than the rules read, or not one they can read" });
    }
    // What this part gives the parts after it.
    made.step(part, run, dir);
    const w0 = baseName(run.words[0]);
    // git remote add NAME URL, git remote set-url [--push] NAME URL: the commands after it push where it says.
    if (w0 === "git") {
      const k = run.words.findIndex((x, n) => x === "remote" && /^(add|set-url)$/.test(run.words[n + 1] ?? ""));
      if (k > 0) {
        const rest: string[] = [];
        for (let n = k + 2; n < run.words.length; n++) { const x = run.words[n]!; if (x === "-t" || x === "-m") n++; else if (!x.startsWith("-")) rest.push(x); }
        if (rest.length >= 2) scope.added.set(rest[0]!, rest[1]!);
      }
    }
    if (!run.words.length) for (const a of run.set) scope.vars.set(a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1));
    else if (w0 === "export" || ((w0 === "declare" || w0 === "typeset") && run.words.some((x) => /^-[a-zA-Z]*x/.test(x)))) {
      for (const x of run.words.slice(1)) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:=([\s\S]*))?$/.exec(x);
        if (!m) continue;
        if (m[2] !== undefined) scope.vars.set(m[1]!, m[2]);
        scope.exported.add(m[1]!);
      }
    } else if (w0 === "unset") for (const x of run.words.slice(1)) { scope.vars.delete(x); scope.exported.delete(x); }
  });
  return out;
}

// What the judge is told of a line's writes with the owner's accounts, and whose namespaces they are in; "" when it makes none.
export function accountContext(command: string, cwd: string, looked: Looked | undefined, names: Namespace[], home: string = homeDir(), sandboxed?: boolean): string {
  const parts = splitCommand(command);
  if (!parts) return "";
  return accountFacts(accountWrites(parts, laid(parts, cwd, home), { looked, home, ...(sandboxed === undefined ? {} : { sandboxed }) }), names);
}

const AGENT_SAYS = "That write is the owner's to make, in every mode: an agent is never allowed it unless the place is one of his namespaces (Settings > Permissions > Your accounts, where he names them). Do not try another form of it. Report to your parent what you wanted to do (the command, and the repository or package) and go on with the rest.";
// What a write with an account beyond the owner's namespaces asks: the owner's card in every mode; an agent is refused.
function accountDecision(hit: { write: Write; account: ReturnType<typeof foreign> extends infer T ? (T extends { account: infer A } ? A : never) : never }, f: Facts, what = "the command", own = false): Decision {
  const why = whyForeign(hit as Parameters<typeof whyForeign>[0], f.accounts!.names);
  // An agent's write to a remote of the repository it works in waits for the owner, who can say "Mine" to it; one the command
  // itself names outside the repository's remotes is refused.
  const agent = f.accounts!.agent;
  if (agent && !own) return { deny: `Refused: ${what} ${why}. ${AGENT_SAYS}` };
  return { ask: { risk: "high", why: `${agent ? `An agent's write, to a remote of the repository it works in: ${what}` : what} ${why}`, rule: "writes beyond your accounts", suggest: [], ownerOnly: true, account: hit.account ? say(hit.account) : "", ...(hit.account ? { mine: namespaceOf(hit.account) } : {}) } };
}

// The decision on a line with variables it gave a written-out value is the stricter of two: the
// line written out, which every rule judges exactly as if the owner had typed it (resolved-line.ts), and the line as
// it is. An agent in a worktree of its own has no card to ask on, and its lines were refused for the word the rules
// cannot read: there the written line's verdict stands in its place (the line as it is counts only when it refuses or
// asks as high risk; its low risk is the program word it cannot name). The owner's own sessions keep the high risk
// of a program hidden in a variable, which the card shows him, and gain the written line's findings besides.
const SEVERITY = (d: Decision) => ("deny" in d ? 3 : "ask" in d ? (d.ask.risk === "high" ? 2 : 1) : 0);
function decideShell(command: string, f: Facts, cwd = f.workspace, interpreter?: string): Decision {
  const written = interpreter === undefined || /(^|\/)(sh|bash|zsh|dash|ksh)$/.test(interpreter) ? resolvedLine(command, f.home ?? homeOf()) : null;
  if (written === null) return decideLine(command, f, cwd, interpreter);
  const beside = !!f.shared;
  const a = decideLine(command, f, cwd, interpreter, beside), b = decideLine(written, f, cwd, interpreter);
  return beside ? (SEVERITY(a) >= 2 && SEVERITY(a) > SEVERITY(b) ? a : b) : SEVERITY(a) >= SEVERITY(b) ? a : b;
}

function decideLine(command: string, f: Facts, cwd = f.workspace, interpreter?: string, resolved = false): Decision {
  const parts = splitCommand(command);
  const home = f.home ?? homeOf();
  // An agent in a worktree Keel made for it changes its own branch only, in every mode, Full auto included.
  // (A program of another language is not read as a shell line: the hook holds what git it starts, ref-guard.ts.)
  if (f.shared && (interpreter === undefined || /(^|\/)(sh|bash|zsh|dash|ksh)$/.test(interpreter))) { const why = sharedRefusal(command, cwd, home, f.shared, 0, resolved); if (why) return { deny: sharedMessage(why, f.shared) }; }
  // A turn nobody started merges, approves and force-pushes nothing, in any mode (unstarted.ts).
  if (f.byOwner && parts && (interpreter === undefined || /(^|\/)(sh|bash|zsh|dash|ksh)$/.test(interpreter))) {
    const act = unstartedAct(parts);
    if (act && !f.byOwner()) return { deny: unstartedWhy(act) };
  }
  const worst = f.mode === "read-only" ? null : parts ? neverAllowed(parts, cwd, home) : neverAllowedText(command, home);
  // A standing rule is the owner's word for commands that change things: a mode that writes nothing runs none of it (a stored
  // `rm *` does not let `rm -rf build` run in Read only, nor `pnpm dlx *` any package).
  const shellRules = writesNothing(f.mode) ? [] : f.rules.filter((r) => r.kind === "shell");
  // A standing rule of the owner's that names this command and does not cover it: the card says so.
  // `why`: the reason, as "deletes ..." or, for another machine, "on HOST, deletes ...".
  const uncovered = (d: Decision, why: string): Decision => {
    if (!("ask" in d) || !parts || !shellRules.length) return d;
    const stands = shellRules.find((r) => parts.some((p) => !p.heredoc && p.words.length && matchRule(r.pattern, p)));
    if (!stands) return d;
    const away = /^on ([^,]{1,80}), (.*)$/s.exec(why);
    const said = /^it /.test(why) ? why : away ? `on ${away[1]}, it ${away[2]}` : `it ${why}`;
    return { ask: { ...d.ask, notice: `Your rule "${stands.pattern}" does not cover this one: ${said}.` } };
  };
  if (worst) return uncovered(never(worst, f), worst);
  if (!parts) {
    if (f.mode === "full-auto") return { allow: true };
    if (f.mode === "read-only") return { deny: "This session is read-only and the command could not be parsed to check it." };
    return { ask: { risk: "high", why: "the command could not be parsed, so no rule can cover it", rule: "could not be parsed", suggest: [] } };
  }
  // A line of more commands than the rules read through is not read at all: high risk, said at once.
  if (parts.length > PARTS_MAX) {
    let n = 0;
    for (const p of parts) if (!p.heredoc) n++;
    if (n > PARTS_MAX) {
      const why = `holds ${n} commands, more than the rules read through (${PARTS_MAX})`;
      return f.mode === "read-only" ? { deny: `This session is read-only, and the command ${why}.` } : { ask: { risk: "high", why: `the command ${why}`, rule: RULE_WORDS.hidden, suggest: [] } };
    }
  }
  // A command whose plain shape writes a file that is the owner's alone to
  // change (`echo x >> ~/.bashrc`, a cp into Keel's config, a write into a CI
  // workflow folder): the owner's call, before any grant, the sandbox's
  // allowance, the reviewer or the judge. In Full auto, where nothing waits
  // for the owner, it is high risk and goes to the judge. (Read only refuses
  // it below.) Each part is read in the folder a `cd` before it leaves it in.
  // (Each part's command and folder, worked out once for this and for the risk classes.)
  const pre = laid(parts, cwd, home);
  if (f.mode !== "read-only" && f.accounts && (interpreter === undefined || /(^|\/)(sh|bash|zsh|dash|ksh)$/.test(interpreter))) {
    const writes = accountWrites(parts, pre, f);
    const hit = foreign(f.accounts.names, writes);
    // (An agent's line waits for the owner only when every write of it that is beyond his namespaces goes to a remote of the repository.)
    if (hit) return uncovered(accountDecision(hit, f, "the command", hit.account !== null && foreignAll(f.accounts.names, writes).every((w) => w.own && w.account)), whyForeign(hit, f.accounts.names));
  }
  // The scripts the line hands a shell it starts (`bash -c '...'`, a here-document into sh, eval), each read as a line
  // of its own where its shell starts (nested-shell.ts): what is never allowed, a write of a file that is the owner's
  // alone to change and a read of a credential are judged in a script as they are in a plain line.
  const scripts = f.mode === "read-only" ? [] : innerLines(parts, pre, home);
  for (const s of scripts) {
    const inner = neverAllowed(s.parts, pre.dirs[s.at] ?? cwd, home);
    if (inner) return uncovered(never(inner, f), inner);
  }
  // (`top`: for a script, the part of the line that starts its shell: the one the card names.)
  const whole = parts;
  const ownerWrites = (parts: Simple[], pre: Laid, cwd: string | null, top?: number): Decision | null => {
    let askAt: number | undefined; // the part the loop below is reading
    const owners = (o: OwnerOnly): Decision => naming(uncovered(f.mode === "full-auto" ? { ask: { risk: "high", why: `the command: ${o.why}`, rule: o.rule, suggest: [] } } : onlyOwner(`the command: ${o.why}`, o.rule), o.why), whole, top ?? askAt);
    // The variables the line gives one value, and the links it makes: a write through either lands where they lead.
    let vals: ReturnType<typeof valuesOf> | undefined;
    const links = new Map<string, string>();
    const unread = (what: string): Decision => ({ ask: { risk: "high", why: `the command ${what}: it can put files where they run later`, rule: RULE_WORDS.hidden, suggest: [] } });
    const asked = new Map<string, OwnerOnly | null>();
    // A line that gives HOME or PWD a value of its own names paths the rules do not follow.
    const renamed = parts.some((p) => !p.heredoc && p.words.some((a) => /^(HOME|PWD|OLDPWD|CDPATH)=/.test(a)));
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (part.heredoc) continue;
      askAt = i;
      const run = pre.runs[i]!;
      // (Most parts redirect nothing and are none of the programs read here: they are passed before anything is asked of them.)
      const first = baseName(run.words[0]), lands = LANDS.has(first) || first.startsWith("python");
      if (!lands && !part.redirects && !WRITERS_FIRST.test(first) && !part.words.some((w) => WRITER_NAMES.has(baseName(w)))) continue;
      if (interpreter === undefined && isReadOnly(part)) continue;
      // A folder the rules cannot follow: only what is written out from the root or the home is read.
      const at = pre.dirs[i] ?? null;
      // (A path the line names again in the same folder is asked about once.)
      // Whether a word names the path the kernel will reach: written out from the root or the home with no step
      // back up (a link there leads elsewhere), or from the folder the part runs in when that folder is certain
      // (after a `cd` that may have failed the shell is in the folder before it).
      const sureWord = (w: string) => {
        if (renamed) return false;
        const up = /(^|\/)\.\.(\/|$)/.test(w);
        return /^["']?(\/|~(\/|$)|\$HOME(\/|$)|\$\{HOME\}(\/|$))/.test(w) ? !up : pre.firm[i] === true && (!up || at === cwd);
      };
      const here = (w0: string) => {
        // (D=.github/workflows; echo x > $D/x.yml: the name is read as the one value the line gave it.)
        const w = w0.includes("$") && !/\$(HOME|\{HOME\})/.test(w0)
          ? w0.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (all, v: string) => { const k = (vals ??= valuesOf(parts, pre.runs)).get(v); return k && k.text !== undefined && k.at < i ? k.text : all; }) : w0;
        const sure = sureWord(w);
        const key = `${at}\0${sure}\0${w}`;
        let o = asked.get(key);
        if (o !== undefined) return o;
        o = at !== null || /^(["']?)(\/|~|\$HOME|\$\{HOME\})/.test(w) ? ownerOnlyNamed(w, at ?? "/", f, "writes", sure) : null;
        // (ln -s .github/workflows w && echo x > w/x.yml: a path under a link the line made is the path under what it links to.)
        if (!o && links.size) {
          const p = spelled(w, at ?? "/", home);
          if (p) for (const [link, to] of links) if (p === link || p.startsWith(`${link}/`)) { o = ownerOnlyNamed(to + p.slice(link.length), "/", f, "writes"); if (o) break; }
        }
        asked.set(key, o);
        return o;
      };
      if (first === "ln" && at !== null && run.words.some((a) => /^-[a-zA-Z]*s/.test(a) || a === "--symbolic")) {
        const named = run.words.slice(1).filter((a) => !a.startsWith("-"));
        const to = named.length === 2 ? spelled(named[0]!, at, home) : null, link = named.length === 2 ? spelled(named[1]!, at, home) : null;
        if (to && link && links.size < 16) links.set(link, to);
      }
      const written = writesOf(part, run);
      // (A command that writes more files than the rules read is not read: any of them could be one that runs later.)
      if (written.length > WORDS_MAX) return { ask: { risk: "high", why: `the command names ${written.length} files to write or delete, more than the rules read for one command (${WORDS_MAX})`, rule: RULE_WORDS.hidden, suggest: [] } };
      // A file of Keel's own state is never written, in any mode, Full auto included (one of its config is the
      // owner's card in the asking modes and flagged high risk in Full auto, below).
      const keels = (w: string): Decision | null => {
        if (at === null && !/^(["']?)(\/|~|\$HOME|\$\{HOME\})/.test(w)) return null;
        const keel = keelNamed(w, at ?? "/", f, "writes", f.keel);
        return keel ? { deny: keelRefusal(`the command: ${keel}`) } : null;
      };
      for (const w of written) { const k = keels(w); if (k) return k; const o = here(w); if (o) return owners(o); }
      // (The rest reads only the programs that copy into a folder, apply a patch, unpack an archive or are handed code.)
      if (!lands) continue;
      // (A folder elsewhere that the sandbox keeps the command from writing; not one of the home folder's own.)
      const heldFolder = (d: string, cwd: string) => { const p = spelled(join(d, "_"), cwd, home); return !!p && sureWord(d) && sandboxHolds(p, f) && dirname(dirname(p)) !== home; };
      for (const d of writesInto(run.words)) {
        const k = keels(join(d, "_"));
        if (k) return k;
        const o = here(join(d, "_")) ?? (HOLDS_RUNS_LATER.test(untrailed(d)) && at !== null && !heldFolder(untrailed(d), at) ? { rule: "runs later, outside the sandbox", why: `it writes into ${d}, where files that run or configure things later are kept` } : null);
        if (o) return owners(o);
      }
      // A patch or an archive: the files it writes are read from it, off the loop, before the decision.
      const a = applied(part, run.words);
      // (Only where its files can land in the session's folder or the home: elsewhere nothing of theirs runs later.)
      const into = a && at !== null ? spelled(a.into, at, home) : null;
      // (Under a sandbox that is the session's folder: a write anywhere else fails by itself.)
      if (a && f.looked && into && (contains(f.workspace, into) || (contains(home, into) && !(sureWord(a.into) && sandboxHolds(join(into, "_"), f))))) {
        const what = a.kind === "patch" ? "applies a patch" : "unpacks an archive";
        const file = a.file === undefined || /[$`*?]/.test(a.file) ? null : isAbsolute(a.file) ? a.file : resolve(at!, a.file);
        // One that is not there unpacks nothing; one that is there and cannot be read is not known.
        // (A file an earlier command of the line names may be fetched or copied there: what is on the disk now is not what it
        // holds then. A command that only makes it from the session's own files, a tar create or a zip, brings nothing the line cannot know.
        // Unpacked inside the session's folder the archive keeps the verdict it has with no earlier command: the row held what lands in the home.)
        const later = a.file !== undefined && !contains(f.workspace, into) && parts.slice(0, i).some((q, j) => !q.heredoc && q.words.some((w) => w === a.file || baseName(w) === baseName(a.file!)) && !isReadOnly(q) && bringsContent(pre.runs[j]?.words ?? q.words, pre.dirs[j] ?? at!, f.workspace, home));
        const files = file === null || later ? null : f.looked.exists(file) === "none" ? [] : f.looked.targets(a.kind, file);
        if (!files) return unread(`${what} the rules could not read${a.file ? ` (${a.file})` : ""}`);
        for (const t of files) { const o = ownerOnlyNamed(join(a.into, t), at!, f, "writes", sureWord(a.into)); if (o) return owners(o); }
      }
      // Code given to an interpreter that names such a file in its text.
      const code = codeGiven(run);
      // (Each quoted string as it stands: a short one is passed, not skipped half-way into the next.)
      if (code) for (const m of code.matchAll(/"([^"]*)"|'([^']*)'/g)) { const t = m[1] ?? m[2]!; const o = t.length >= 3 && t.length <= 300 && !/\s/.test(t) && /[\/.]/.test(t) ? here(t) : null; if (o) return owners(o); }
    }
    return null;
  };
  if (f.mode !== "read-only") {
    const d = ownerWrites(parts, pre, cwd);
    if (d) return d;
    for (const s of scripts) { const inner = ownerWrites(s.parts, s.pre, pre.dirs[s.at] ?? null, s.at); if (inner) return inner; }
  }
  const risks = risksAt(parts, { cwd, home, workspace: f.workspace, scratch: f.scratch, looked: f.looked, sandboxed: f.sandboxed, land: f.own && ((p) => f.own!().land(p)), ...(resolved ? { beside: true as const } : {}) }, pre);
  if (risks.length) {
    if (f.mode === "read-only") return { deny: `This session is read-only, and the command ${risks[0]!.why}.` };
    // (The rule is the first reason in a few words: its own when it is that short, else its class's. A line of
    // several says how many more.)
    const classes = [...new Set(risks.map((r) => (r.said ? r.why : RULE_WORDS[r.rule])))];
    return naming(uncovered({ ask: { risk: "high", why: `the command ${risks.map((r) => r.why).join(" and ")}`, rule: classes.length > 1 ? `${classes[0]}, and ${classes.length - 1} more` : classes[0], suggest: [],
      ...(risks.every((r) => r.git) ? { settles: true as const } : {}), risks: risks.map((r) => ({ at: r.at, rule: r.rule, why: r.why })) } }, risks[0]!.why), parts, risks.find((r) => r.at !== null)?.at);
  }
  // A credential file a reading command names, or a folder holding the home's stores that a searcher walks: the
  // same class as a file tool's read of it.
  // (In Read only a line that starts a shell is refused below as no read: its script adds no card to that.)
  const cred = shellCredentialReads(parts, cwd, f.home ?? homeOf(), (p) => credentialOf(p, f), pre, f.look, f.mode !== "read-only");
  if (cred) {
    // In the sandbox the command reads what the sandbox shows and nothing else: a credential it hides is not read,
    // so it asks nobody. One it shows (the session's own folder's `.env`, a folder the owner opened) runs without a
    // card: what it prints is given to the secrets vault first (the gate does, with the paths), so it reaches no
    // model. An agent's command that shows one outside its own folder is refused.
    // (A folder the look did not finish is not known to hold none: it asks, in the sandbox too.)
    const unread = cred.hits.find((h) => h.unread);
    if (unread) return credentialRead(unread.what, f, unread.by, unread.api);
    const shown = f.confinedShown ? cred.hits.filter((h) => f.confinedShown!(h.path).shown) : null;
    // (A link to one of the owner's files is not the folder's own, whatever it is called or where it stands.)
    const outside = shown?.find((h) => h.foreign || !contains(f.workspace, h.path));
    if (!shown) return credentialRead(cred.what, f, cred.by, cred.api);
    if (outside && f.agent) return credentialRead(outside.what, f, outside.by, outside.api);
  }
  if (f.mode === "full-auto") return { allow: true };
  // A variable the line's first words give a value is read as that value.
  const reads = (p: Simple) => { if (isReadOnly(p)) return true; const program = f.real && shimmedRead(p); return !!program && f.real!(program); };
  // A rule that stops at a launcher (`pnpm dlx *`) covers no package where a model decides: the line goes to it.
  const judged = f.mode === "auto" || f.mode === "reviewer";
  const anyPackage: { rule: string; part: Simple }[] = [];
  const openAt: number[] = []; // where each open part stands in the line
  const open = resolveVariables(parts).filter((p, at) => {
    const keep = (() => {
      if (interpreter === undefined && reads(p)) return false;
      const hit = shellRules.filter((r) => matchRule(r.pattern, p));
      if (!hit.length) return true;
      if (!judged) return false;
      const covering = hit.find((r) => !runsAnyPackage(r.pattern, p));
      if (covering) return false;
      anyPackage.push({ rule: hit[0]!.pattern, part: p });
      return true;
    })();
    if (keep) openAt.push(at);
    return keep;
  });
  if (!open.length) return { allow: true };
  // The form that would be read as a read, when an expansion among the arguments is all that keeps it from being one.
  const form = interpreter === undefined ? readForm(open[0]!) : null;
  if (f.mode === "read-only") {
    const p = open[0]!;
    // Say what would make it a read, when that is all it lacks.
    const why = reads(p) ? ` It runs in ${interpreter}, and only a command bash runs is read as a read: run it with bash.`
      : form ? ` One of its arguments comes from an expansion ($(...), a variable, {a,b}, a glob), which could add an option that writes: ${form}.`
      : p.unknown && isReadOnly({ ...p, unknown: undefined }) ? " The rules cannot follow what the shell evaluates in it (arithmetic, a subscript, a sliced or indirect variable, a case inside a substitution): write it plainly."
      : "";
    return { deny: `This session is read-only: only read-only commands run, and \`${p.text}\` is not one.${why}` };
  }
  if ((f.mode === "auto-edits" || f.mode === "auto") && f.sandboxed) return { allow: true, why: "sandboxed" };
  // A part with no command word (a redirect after a group, a loop or nothing) has no rule to suggest.
  // (The first five different ones: a line of thousands of parts is not read past them.)
  const patterns = new Set<string>();
  for (const p of open) { if (p.words.length) patterns.add(suggestRule(p)); if (patterns.size >= 5) break; }
  const suggest = [...patterns].map((pattern) => ({ kind: "shell" as const, pattern }));
  // One command asks, and only for its expansion: the card says the form that runs without asking.
  const readNotice = form && open.length === 1 ? `It reads, but one of its arguments comes from an expansion, which could add an option that writes. To run without asking: ${form}.` : undefined;
  const any = anyPackage[0];
  const named = any && packageRule(any.part);
  const notice = any ? `Your rule "${any.rule}" runs any package, so it does not cover this one${named ? `: allow ${named.slice(0, -2)} only with "${named}"` : ""}.` : readNotice;
  return naming({ ask: { risk: "low", suggest, ...(notice ? { notice } : {}) } }, parts, openAt[0]);
}

// Driving another session. An allow rule for a tool does not cover another
// session: only a standing answer for driving does (drive:<id>, drive:*). A
// text its harness would act on, a text for an ended session and an allow on
// another session's prompt are the owner's: no mode covers them, only a rule
// naming the tool and the target (keel__session_message:<id>, or :*).
function decideDrive(c: Extract<CallClass, { kind: "drive" }>, f: Facts): Decision {
  if (f.mode === "read-only") return { deny: "This session is read-only: it does not drive other sessions." };
  const tools = f.rules.filter((r) => r.kind === "tool").map((r) => r.pattern);
  if (c.owner) {
    const tool = c.resource.slice(0, c.resource.indexOf(":"));
    if (tools.includes(c.resource) || tools.includes(`${tool}:*`)) return { allow: true };
    return onlyOwner(`only the owner allows this: ${c.owner}`, "acts in another session");
  }
  if (f.mode === "full-auto") return { allow: true };
  if (tools.includes(`drive:${c.target}`) || tools.includes("drive:*")) return { allow: true };
  return { ask: { risk: "low", suggest: [{ kind: "tool", pattern: `drive:${c.target}` }] } };
}

// How a shell tool asks to run a command outside the sandbox, as a sentence
// for a result that says the sandbox stopped it: by the parameter its family
// has. Each such call is approved first: by the owner on a card, and in
// full auto by what settles a high-risk call there.
export function escapeOf(tool: { built?: any; input_schema?: any }): string {
  const props = (tool.built ?? tool.input_schema)?.properties;
  if (props?.sandbox_permissions) return 'If the command is needed, run it again with sandbox_permissions: "require_escalated" and a justification: it runs outside the sandbox only once that is approved.';
  if (props?.dangerouslyDisableSandbox) return "If the command is needed, run it again with dangerouslyDisableSandbox: true: it runs outside the sandbox only once that is approved.";
  return "If the command is needed, ask the owner to run it outside the sandbox.";
}
