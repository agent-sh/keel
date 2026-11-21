// The permission decision for one tool call, from the session's mode and the
// standing answers that apply. Pure: the gate supplies the facts.
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { neverAllowed, neverAllowedText } from "./autonomy.ts";
import { isReadOnly, matchRule, readForm, resolveVariables, risksOf, splitCommand, suggestRule, type Simple } from "./shell.ts";
import { contains } from "../core/paths.ts";
import type { ToolKind } from "../tools/types.ts";
import { extractShellApplyPatch, patchTargetPaths } from "../tools/v4a.ts";

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
  { id: "full-auto", name: "Full auto", group: "model", summary: "Runs; only flagged calls are judged", description: "Ordinary calls run without review. Flagged calls go to the safety rules and judge model. Refusals are listed for you to let one retry through. Tools that explicitly require your confirmation still ask." },
  { id: "read-only", name: "Read only", group: "none", summary: "Reads and read-only commands; the rest is refused", description: "Reads and read-only commands run. Everything else is refused." },
  { id: "plan", name: "Plan", group: "none", summary: "Plans first; you approve the plan", description: "Reads and read-only commands run. The model plans, and you approve the plan before anything changes." },
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

export type CallClass =
  | { kind: "read" }
  // `interpreter`: the program that runs the command when it is not bash. The
  // rules read a command as bash does, so none of it is then taken for a read.
  | { kind: "shell"; command: string; escalate?: boolean; cwd?: string; interpreter?: string }
  | { kind: "control" } // input to, or the stop of, a process an allowed call started
  | { kind: "edit"; paths: string[] }
  // `grant` names the standing answer that covers it when the tool's name is
  // too wide (keel__spawn_on_machine:<machine>: one machine, not all of them).
  // `paths`: the strings of its input that are a path by themselves (pathsNamed).
  | { kind: "other"; grant?: string; paths?: string[] }
  // A message, answer or model command into another session. `resource` names
  // the tool and the target (keel__session_message:claude:abc); `owner` says why
  // only the owner may allow it.
  | { kind: "drive"; target: string; resource: string; shown: string; owner?: string }
  // A call its tool refused before it was judged (the reason is the result).
  | { kind: "refused"; why: string };

// `notice`: a line for the owner on the card (the form of the command that would not have asked).
export type Ask = { risk: "high" | "low"; why?: string; suggest: Suggest[]; ownerOnly?: true; notice?: string };
export type Decision =
  | { allow: true; why?: string }
  | { deny: string }
  | { ask: Ask };

const onlyOwner = (why: string): Decision => ({ ask: { risk: "high", why, suggest: [], ownerOnly: true } });

// What a call does. The tool's own definition says which kind of call it is
// (its read flag and its kind); the input only supplies the command or the
// paths of that kind, so no key a model puts in a call changes how it is judged.
export function classify(tool: { name: string; readOnly: boolean; kind?: ToolKind; input_schema?: any; built?: any; interpreter?(input: any): string; appliesPatch?: true }, input: any, cwd: string): CallClass {
  if (tool.readOnly) return { kind: "read" };
  switch (tool.kind) {
    case "control":
      return { kind: "control" };
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
        const base = wrapped.cd ? resolve(cwd, wrapped.cd) : cwd;
        const paths = patchTargetPaths(wrapped.patch);
        if (!paths.length) return { kind: "refused", why: `${tool.name} was given a patch that names no file to change.` };
        return { kind: "edit", paths: paths.map((p) => (isAbsolute(p) ? p : resolve(base, p))) };
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
      return { kind: "edit", paths: paths.map((p) => (isAbsolute(p) ? p : resolve(cwd, p))) };
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

export const RUNS_LATER = /^(?:.*\/)?(?:\.git\/(?:hooks\/|config$)|\.envrc$|\.mcp\.json$|\.npmrc$|\.pypirc$|\.gitattributes$|\.gitmodules$|\.keel\/hooks\.json$|\.keel\/hooks\/|\.claude\/hooks\/|\.claude\/settings(?:\.local)?\.json$|\.codex\/config\.toml$|\.gemini\/settings\.json$|\.vscode\/(?:tasks|settings|launch)\.json$|\.husky\/|\.githooks\/)/;

// Files of the home folder that run, or let someone in, later: the shells'
// start files, the remote-login folder, git's own configuration (it names
// programs git runs) and the folder of the owner's own commands. An edit of
// one is the owner's call like a repository's RUNS_LATER files, wherever the
// session's workspace is.
const HOME_RUNS_LATER = /^(?:\.(?:bashrc|bash_profile|bash_login|bash_logout|bash_aliases|profile|zshrc|zshenv|zprofile|zlogin|zlogout|inputrc|xprofile|xsessionrc|xinitrc|pam_environment|gitconfig)$|\.ssh(?:\/|$)|\.bashrc\.d\/|\.local\/bin\/|\.config\/(?:fish\/|git\/|environment\.d\/|systemd\/user\/|autostart\/))/;
// Why a change of this path is the owner's alone, or nothing. `config`: folders
// and files Keel itself runs things from (its config folder: hooks, MCP
// servers, skills, agents; the scripts the owner's hooks and a pinned
// repository's hooks run), which no sandbox confines.
function ownerOnlyEdit(p: string, f: Facts, does = "changes"): string | null {
  const rel = relative(f.workspace, p);
  if (RUNS_LATER.test(rel)) return `it ${does} ${rel}, which runs or configures things outside the sandbox later`;
  const o = f.own?.();
  const own = (f.config ?? o?.config)?.find((c) => contains(c, p));
  if (own) return `it ${does} ${p}, which Keel runs or reads its configuration from (its hooks and their scripts, MCP servers, skills and agents), outside any sandbox`;
  const home = f.home ?? o?.home ?? homedir();
  if (contains(home, p) && HOME_RUNS_LATER.test(relative(home, p))) return `it ${does} ${p}, which runs at every login or shell start, or lets someone log in`;
  return null;
}
// The same for a path a command or a tool's input names: asked of the path as
// spelled and of where it lands (an edit's paths come to the gate landed already).
function ownerOnlyNamed(w: string, cwd: string, f: Facts, does: string): string | null {
  const p = spelled(w, cwd, f.home ?? homedir());
  if (!p) return null;
  for (const q of f.own?.().land(p) ?? [p]) { const why = ownerOnlyEdit(q, f, does); if (why) return why; }
  return null;
}

// A path as a command or a tool's input spells it: ~ and $HOME are the home
// folder, a relative one starts at `cwd`. Nothing for a word an expansion makes.
function spelled(w: string, cwd: string, home: string): string | null {
  w = w.replace(/^(["'])(.*)\1$/s, "$2").replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
  if (!w || /[$`*?\n]/.test(w)) return null;
  return isAbsolute(w) ? w : resolve(cwd, w);
}

// The files a command part writes by its plain shape: the target of a
// redirect, and what tee, cp, mv, rm, install, ln, sed -i and dd of= are given
// to write. Not every write a command can make (an interpreter, a program of
// the session's own): the forms that need no trick, so that a grant, the
// reviewer or the judge does not answer for a start file in passing.
const LAST_ARG = new Set(["cp", "install", "ln", "rsync", "scp"]);
const EACH_ARG = new Set(["tee", "mv", "rm", "truncate", "shred"]);
function writesOf(p: Simple): string[] {
  const out: string[] = [];
  if (p.redirects) for (const m of p.text.matchAll(/(?:&>>?|>>|>\||>)\s*("[^"]*"|'[^']*'|[^\s;|&<>()]+)/g)) out.push(m[1]!);
  const i = p.words.findIndex((w) => /^(?:.*\/)?(?:cp|install|ln|rsync|scp|tee|mv|rm|truncate|shred|sed|dd)$/.test(w));
  if (i < 0) return out;
  const name = p.words[i]!.replace(/^.*\//, ""), rest = p.words.slice(i + 1), args = rest.filter((a) => !a.startsWith("-"));
  if (LAST_ARG.has(name)) out.push(...args.slice(-1));
  else if (EACH_ARG.has(name)) out.push(...args);
  else if (name === "sed") { if (rest.some((a) => /^(?:-[a-zA-Z]*i|--in-place)/.test(a))) out.push(...args); }
  else for (const a of rest) if (a.startsWith("of=")) out.push(a.slice(3));
  return out;
}

// The strings of a tool's input that are a path by themselves (an MCP file
// server's `path`), for a tool whose input the gate cannot read otherwise.
export function pathsNamed(input: unknown): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (v: unknown, depth: number) => {
    if (++seen > 200 || depth > 4 || out.length >= 32) return;
    if (typeof v === "string") { if (v.length < 4096 && /^(?:~|\/)[^\s]*$/.test(v)) out.push(v); }
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
// `config`: Keel's own config folder and files (ownerOnlyEdit). `own`: the
// home folder, that config and where a path lands, read from the disk only
// when a call names a file to change (a read never asks for them).
export type Facts = {
  mode: Mode; workspace: string; sandboxed: boolean; rules: Rule[]; tool: string; bind?: string; scratch?: string[]; home?: string; config?: string[];
  own?: () => { home: string; config: string[]; land: (p: string) => string[] };
};

export function decide(c: CallClass, f: Facts): Decision {
  if (c.kind === "read" || c.kind === "control") return { allow: true };
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
      return f.mode === "auto" ? onlyOwner(why) : { ask: { risk: "high", why, suggest: [] } };
    }
    return decideShell(c.command, f, c.cwd, c.interpreter);
  }
  if (c.kind === "refused") return { deny: c.why };
  if (c.kind === "drive") return decideDrive(c, f);
  if (c.kind === "edit") {
    if (f.mode === "full-auto") return { allow: true };
    if (f.mode === "read-only") return { deny: "This session is read-only: files cannot be changed. Say what you would change instead." };
    // A file something runs or reads its configuration from later (git hooks,
    // direnv, the project's hook and MCP files, Keel's own config, a shell's
    // start file, the login keys): the owner's call, one at a time. No grant,
    // reviewer or hook answers it.
    for (const p of c.paths) { const why = ownerOnlyEdit(p, f); if (why) return onlyOwner(why); }
    const editRules = f.rules.filter((r) => r.kind === "edit");
    const covered = (p: string) => editRules.some((r) => contains(r.pattern, p));
    // The repository's own metadata is not an in-scope edit.
    const open = c.paths.filter((p) => !covered(p) && !((f.mode === "auto-edits" || f.mode === "auto") && ownPath(p, f)));
    if (!open.length) return { allow: true };
    const dirs = [...new Set(open.map((p) => (contains(f.workspace, p) && !protectedPath(f.workspace, p) ? f.workspace : dirname(p))))];
    return { ask: { risk: "low", suggest: dirs.map((d) => ({ kind: "edit", pattern: d })) } };
  }
  if (f.mode === "full-auto") return { allow: true };
  if (f.mode === "read-only") return { deny: `This session is read-only: ${f.tool} can change things, so it does not run here.` };
  // A tool that can change things, given a file that is the owner's alone to change (an MCP file server's write).
  if (c.kind === "other") for (const w of c.paths ?? []) {
    const why = ownerOnlyNamed(w, f.workspace, f, "names");
    if (why) return onlyOwner(why);
  }
  const grant = (c.kind === "other" && c.grant) || f.tool;
  if (f.rules.some((r) => r.kind === "tool" && r.pattern === grant && (!r.bind || r.bind === f.bind))) return { allow: true };
  return { ask: { risk: "low", suggest: [{ kind: "tool", pattern: grant, ...(f.bind ? { bind: f.bind } : {}) }] } };
}

// Never allowed on its own: in modes with a judge it is refused, whatever a
// judge would say; elsewhere it is the owner's call, one at a time.
const never = (why: string, f: Facts): Decision =>
  f.mode === "auto" || f.mode === "full-auto" || f.mode === "reviewer"
    ? { deny: `Refused: the command ${why}, which never runs without the owner. Do not try another form of it; say what you wanted it for and go on with the rest.` }
    : onlyOwner(`the command ${why}`);

function decideShell(command: string, f: Facts, cwd = f.workspace, interpreter?: string): Decision {
  const parts = splitCommand(command);
  const home = f.home ?? homedir();
  const worst = f.mode === "read-only" ? null : parts ? neverAllowed(parts, cwd, home) : neverAllowedText(command, home);
  if (worst) return never(worst, f);
  if (!parts) {
    if (f.mode === "full-auto") return { allow: true };
    if (f.mode === "read-only") return { deny: "This session is read-only and the command could not be parsed to check it." };
    return { ask: { risk: "high", why: "the command could not be parsed, so no rule can cover it", suggest: [] } };
  }
  // A command whose plain shape writes a file that is the owner's alone to
  // change (`echo x >> ~/.bashrc`, a cp into Keel's config): the owner's call,
  // before any grant, the sandbox's allowance, the reviewer or the judge.
  // (Full auto runs it as it runs such an edit; Read only refuses it below.)
  if (f.mode !== "read-only" && f.mode !== "full-auto") for (const part of parts) if (interpreter !== undefined || !isReadOnly(part)) for (const w of writesOf(part)) {
    const why = ownerOnlyNamed(w, cwd, f, "writes");
    if (why) return onlyOwner(`the command: ${why}`);
  }
  const risks = risksOf(parts);
  if (risks.length) {
    if (f.mode === "read-only") return { deny: `This session is read-only, and the command ${risks[0]}.` };
    return { ask: { risk: "high", why: `the command ${risks.join(" and ")}`, suggest: [] } };
  }
  if (f.mode === "full-auto") return { allow: true };
  const shellRules = f.rules.filter((r) => r.kind === "shell");
  // A variable the line's first words give a value is read as that value.
  const open = resolveVariables(parts).filter((p) => (interpreter !== undefined || !isReadOnly(p)) && !shellRules.some((r) => matchRule(r.pattern, p)));
  if (!open.length) return { allow: true };
  // The form that would be read as a read, when an expansion among the arguments is all that keeps it from being one.
  const form = interpreter === undefined ? readForm(open[0]!) : null;
  if (f.mode === "read-only") {
    const p = open[0]!;
    // Say what would make it a read, when that is all it lacks.
    const why = isReadOnly(p) ? ` It runs in ${interpreter}, and only a command bash runs is read as a read: run it with bash.`
      : form ? ` One of its arguments comes from an expansion ($(...), a variable, {a,b}, a glob), which could add an option that writes: ${form}.`
      : p.unknown && isReadOnly({ ...p, unknown: undefined }) ? " The rules cannot follow what the shell evaluates in it (arithmetic, a subscript, a sliced or indirect variable, a case inside a substitution): write it plainly."
      : "";
    return { deny: `This session is read-only: only read-only commands run, and \`${p.text}\` is not one.${why}` };
  }
  if ((f.mode === "auto-edits" || f.mode === "auto") && f.sandboxed) return { allow: true, why: "sandboxed" };
  // A part with no command word (a redirect after a group, a loop or nothing) has no rule to suggest.
  const suggest = [...new Set(open.filter((p) => p.words.length).map(suggestRule))].slice(0, 5).map((pattern) => ({ kind: "shell" as const, pattern }));
  // One command asks, and only for its expansion: the card says the form that runs without asking.
  const notice = form && open.length === 1 ? `It reads, but one of its arguments comes from an expansion, which could add an option that writes. To run without asking: ${form}.` : undefined;
  return { ask: { risk: "low", suggest, ...(notice ? { notice } : {}) } };
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
    return onlyOwner(`only the owner allows this: ${c.owner}`);
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
