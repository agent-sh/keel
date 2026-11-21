// The permission decision for one tool call, from the session's mode and the
// standing answers that apply. Pure: the gate supplies the facts.
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { neverAllowed, neverAllowedText } from "./autonomy.ts";
import { isReadOnly, matchRule, risksOf, splitCommand, suggestRule } from "./shell.ts";
import { contains } from "../core/paths.ts";
import type { ToolKind } from "../tools/types.ts";

export const MODES = [
  { id: "ask", name: "Ask", description: "Reads run. Edits, commands and other tools ask first unless a grant covers them." },
  { id: "auto-edits", name: "Auto edits", description: "Edits inside the workspace run. Commands ask, except read-only ones and sandboxed ones." },
  { id: "auto", name: "Auto", description: "Reads, workspace edits, read-only or sandboxed commands, and standing grants run as usual. The judge reviews other calls and refuses them if it cannot approve. Actions requiring your consent still ask." },
  { id: "full-auto", name: "Full auto", description: "Ordinary calls run without review. Flagged calls go to the safety rules and judge model. Refusals are listed for you to let one retry through. Tools that explicitly require your confirmation still ask." },
  { id: "read-only", name: "Read only", description: "Reads and read-only commands run. Everything else is refused." },
  { id: "plan", name: "Plan", description: "Reads and read-only commands run. The model plans, and you approve the plan before anything changes." },
  { id: "reviewer", name: "Reviewer", description: "A reviewer model decides what would ask. High-risk actions and anything it cannot judge still ask you." },
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
  | { kind: "other"; grant?: string }
  // A message, answer or model command into another session. `resource` names
  // the tool and the target (keel__session_message:claude:abc); `owner` says why
  // only the owner may allow it.
  | { kind: "drive"; target: string; resource: string; shown: string; owner?: string }
  // A call its tool refused before it was judged (the reason is the result).
  | { kind: "refused"; why: string };

export type Ask = { risk: "high" | "low"; why?: string; suggest: Suggest[]; ownerOnly?: true };
export type Decision =
  | { allow: true; why?: string }
  | { deny: string }
  | { ask: Ask };

const onlyOwner = (why: string): Decision => ({ ask: { risk: "high", why, suggest: [], ownerOnly: true } });

// What a call does. The tool's own definition says which kind of call it is
// (its read flag and its kind); the input only supplies the command or the
// paths of that kind, so no key a model puts in a call changes how it is judged.
export function classify(tool: { name: string; readOnly: boolean; kind?: ToolKind; input_schema?: any; built?: any; interpreter?(input: any): string }, input: any, cwd: string): CallClass {
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
      // A tool that offers it (Codex's exec_command) can ask to run outside the sandbox.
      // Read from the running build's schema: a session may carry an older definition (Tool.built).
      const escalate = !!(tool.built ?? tool.input_schema)?.properties?.sandbox_permissions && input?.sandbox_permissions === "require_escalated";
      const runs = tool.interpreter?.(input);
      return { kind: "shell", command: cmd, escalate: escalate || undefined, cwd, ...(runs !== undefined && !BASH.test(runs) ? { interpreter: runs } : {}) };
    }
    case "edit": {
      const paths: string[] = [];
      for (const k of ["file_path", "path", "notebook_path"]) if (typeof input?.[k] === "string") paths.push(input[k]);
      const patch = typeof input === "string" ? input : typeof input?.patch === "string" ? input.patch : typeof input?.input === "string" ? input.input : "";
      for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) paths.push((m[1] ?? m[2])!.trim());
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

export const RUNS_LATER = /^(?:.*\/)?(?:\.git\/(?:hooks\/|config$)|\.envrc$|\.mcp\.json$|\.npmrc$|\.pypirc$|\.gitattributes$|\.gitmodules$|\.keel\/hooks\.json$|\.claude\/settings(?:\.local)?\.json$|\.codex\/config\.toml$|\.gemini\/settings\.json$|\.vscode\/(?:tasks|settings|launch)\.json$|\.husky\/|\.githooks\/)/;

// `scratch`: folders of the harness's own the session writes in like its workspace (its artifacts folder).
export type Facts = { mode: Mode; workspace: string; sandboxed: boolean; rules: Rule[]; tool: string; bind?: string; scratch?: string[]; home?: string };

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
    // A file the repository runs or reads its configuration from later (git
    // hooks, direnv, the project's hook and MCP files): the owner's call, one at a time.
    const runs = c.paths.find((p) => RUNS_LATER.test(relative(f.workspace, p)));
    if (runs) return onlyOwner(`it changes ${relative(f.workspace, runs)}, which runs or configures things outside the sandbox later`);
    const editRules = f.rules.filter((r) => r.kind === "edit");
    const covered = (p: string) => editRules.some((r) => contains(r.pattern, p));
    // The repository's own metadata is not an in-scope edit.
    const protectedPath = (p: string) => /(^|\/)\.git(\/|$)/.test(relative(f.workspace, p));
    const mine = (p: string) => (contains(f.workspace, p) && !protectedPath(p)) || !!f.scratch?.some((d) => contains(d, p));
    const open = c.paths.filter((p) => !covered(p) && !((f.mode === "auto-edits" || f.mode === "auto") && mine(p)));
    if (!open.length) return { allow: true };
    const dirs = [...new Set(open.map((p) => (contains(f.workspace, p) && !protectedPath(p) ? f.workspace : dirname(p))))];
    return { ask: { risk: "low", suggest: dirs.map((d) => ({ kind: "edit", pattern: d })) } };
  }
  if (f.mode === "full-auto") return { allow: true };
  if (f.mode === "read-only") return { deny: `This session is read-only: ${f.tool} can change things, so it does not run here.` };
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
  const risks = risksOf(parts);
  if (risks.length) {
    if (f.mode === "read-only") return { deny: `This session is read-only, and the command ${risks[0]}.` };
    return { ask: { risk: "high", why: `the command ${risks.join(" and ")}`, suggest: [] } };
  }
  if (f.mode === "full-auto") return { allow: true };
  const shellRules = f.rules.filter((r) => r.kind === "shell");
  const open = parts.filter((p) => (interpreter !== undefined || !isReadOnly(p)) && !shellRules.some((r) => matchRule(r.pattern, p)));
  if (!open.length) return { allow: true };
  if (f.mode === "read-only") {
    const p = open[0]!;
    // Say what would make it a read, when that is all it lacks.
    const why = isReadOnly(p) ? ` It runs in ${interpreter}, and only a command bash runs is read as a read: run it with bash.`
      : p.dyn && isReadOnly({ ...p, dyn: undefined, splits: undefined }) ? " One of its arguments comes from an expansion ($(...), a variable, {a,b}), which could add an option that writes: write the value out."
      : p.unknown && isReadOnly({ ...p, unknown: undefined }) ? " The rules cannot follow what the shell evaluates in it (arithmetic, a subscript, a sliced or indirect variable, a case inside a substitution): write it plainly."
      : "";
    return { deny: `This session is read-only: only read-only commands run, and \`${p.text}\` is not one.${why}` };
  }
  if ((f.mode === "auto-edits" || f.mode === "auto") && f.sandboxed) return { allow: true, why: "sandboxed" };
  // A part with no command word (a redirect after a group, a loop or nothing) has no rule to suggest.
  return { ask: { risk: "low", suggest: [...new Set(open.filter((p) => p.words.length).map(suggestRule))].slice(0, 5).map((pattern) => ({ kind: "shell" as const, pattern })) } };
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
