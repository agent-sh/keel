// The permission decision for one tool call, from the session's mode and the
// standing answers that apply. Pure: the gate supplies the facts.
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { highRisk, isReadOnly, matchRule, splitCommand, suggestRule } from "./shell.ts";

export const MODES = [
  { id: "ask", name: "Ask", description: "Reads run. Edits, commands and other tools ask first unless a grant covers them." },
  { id: "auto-edits", name: "Auto edits", description: "Edits inside the workspace run. Commands ask, except read-only ones and sandboxed ones." },
  { id: "full-auto", name: "Full auto", description: "Everything runs. Only high-risk commands still ask." },
  { id: "read-only", name: "Read only", description: "Reads and read-only commands run. Everything else is refused." },
  { id: "reviewer", name: "Reviewer", description: "A reviewer model decides what would ask. High-risk actions and anything it cannot judge still ask you." },
] as const;
export type Mode = (typeof MODES)[number]["id"];
export const isMode = (m: unknown): m is Mode => MODES.some((x) => x.id === m);

export type RuleKind = "shell" | "edit" | "tool";
export type Rule = { id: string; kind: RuleKind; pattern: string; scope: string; lifetime: "always" | "session"; session_id?: string | null; created: number };
export type Suggest = { kind: RuleKind; pattern: string };

export type CallClass =
  | { kind: "read" }
  | { kind: "shell"; command: string; escalate?: boolean }
  | { kind: "control" } // input to, or the stop of, a process an allowed call started
  | { kind: "edit"; paths: string[] }
  | { kind: "other" }
  // A message, answer or model command into another session. `resource` names
  // the tool and the target (keel__session_send:claude:abc); `owner` says why
  // only the owner may allow it.
  | { kind: "drive"; target: string; resource: string; shown: string; owner?: string }
  // A call its tool refused before it was judged (the reason is the result).
  | { kind: "refused"; why: string };

export type Decision =
  | { allow: true; why?: string }
  | { deny: string }
  | { ask: { risk: "high" | "low"; why?: string; suggest: Suggest[] } };

// What a call does, from its tool's flag and its input's shape, so tools of
// every family (Bash, shell, exec_command, apply_patch, MCP) classify alike.
export function classify(tool: { name: string; readOnly: boolean }, input: any, cwd: string): CallClass {
  if (tool.readOnly) return { kind: "read" };
  const cmd = shellText(input);
  // Codex's exec_command can ask to run outside the sandbox.
  if (cmd !== null) return { kind: "shell", command: cmd, escalate: input?.sandbox_permissions === "require_escalated" || undefined };
  const keys = Object.keys(input ?? {});
  if (keys.some((k) => /^(session_id|task_id|shell_id|bash_id)$/.test(k)) && !keys.some((k) => /path|command|cmd|patch|url/.test(k))) return { kind: "control" };
  const paths: string[] = [];
  for (const k of ["file_path", "path", "notebook_path"]) if (typeof input?.[k] === "string") paths.push(input[k]);
  const patch = typeof input?.patch === "string" ? input.patch : typeof input?.input === "string" ? input.input : "";
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) paths.push((m[1] ?? m[2])!.trim());
  if (paths.length) return { kind: "edit", paths: paths.map((p) => (isAbsolute(p) ? p : resolve(cwd, p))) };
  return { kind: "other" };
}

function shellText(input: any): string | null {
  const c = input?.command ?? input?.cmd;
  if (typeof c === "string") return c;
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) {
    const w = c as string[];
    if (w.length === 3 && /(^|\/)(ba|z)?sh$/.test(w[0]!) && /^-l?c$/.test(w[1]!)) return w[2]!;
    return w.map((w: string) => (/^[\w./=:@%+-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`)).join(" ");
  }
  return null;
}

export const inside = (p: string, dir: string) => {
  const r = relative(dir, p);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

export const RUNS_LATER = /^(?:.*\/)?(?:\.git\/(?:hooks\/|config$)|\.envrc$|\.mcp\.json$|\.npmrc$|\.pypirc$|\.gitattributes$|\.gitmodules$|\.keel\/hooks\.json$|\.claude\/settings(?:\.local)?\.json$|\.codex\/config\.toml$|\.gemini\/settings\.json$|\.vscode\/(?:tasks|settings|launch)\.json$|\.husky\/|\.githooks\/)/;

export type Facts = { mode: Mode; workspace: string; sandboxed: boolean; rules: Rule[]; tool: string };

export function decide(c: CallClass, f: Facts): Decision {
  if (c.kind === "read" || c.kind === "control") return { allow: true };
  if (c.kind === "shell") {
    // Leaving the owner's sandbox is the owner's call in every mode, one call at a time.
    if (c.escalate && f.sandboxed) {
      if (f.mode === "read-only") return { deny: "This session is read-only: commands cannot leave the sandbox." };
      const inner = decideShell(c.command, f);
      const why = ["the command asks to run outside the sandbox", "ask" in inner ? inner.ask.why : undefined].filter(Boolean).join("; and ");
      return { ask: { risk: "high", why, suggest: [] } };
    }
    return decideShell(c.command, f);
  }
  if (c.kind === "refused") return { deny: c.why };
  if (c.kind === "drive") return decideDrive(c, f);
  if (c.kind === "edit") {
    if (f.mode === "full-auto") return { allow: true };
    if (f.mode === "read-only") return { deny: "This session is read-only: files cannot be changed. Say what you would change instead." };
    // A file the repository runs or reads its configuration from later (git
    // hooks, direnv, the project's hook and MCP files): the owner's call, one at a time.
    const runs = c.paths.find((p) => RUNS_LATER.test(relative(f.workspace, p)));
    if (runs) return { ask: { risk: "high", why: `it changes ${relative(f.workspace, runs)}, which runs or configures things outside the sandbox later`, suggest: [] } };
    const editRules = f.rules.filter((r) => r.kind === "edit");
    const covered = (p: string) => editRules.some((r) => inside(p, r.pattern));
    // The repository's own metadata never edits itself in auto-edits mode.
    const protectedPath = (p: string) => /(^|\/)\.git(\/|$)/.test(relative(f.workspace, p));
    const open = c.paths.filter((p) => !covered(p) && !(f.mode === "auto-edits" && inside(p, f.workspace) && !protectedPath(p)));
    if (!open.length) return { allow: true };
    const dirs = [...new Set(open.map((p) => (inside(p, f.workspace) && !protectedPath(p) ? f.workspace : dirname(p))))];
    return { ask: { risk: "low", suggest: dirs.map((d) => ({ kind: "edit", pattern: d })) } };
  }
  if (f.mode === "full-auto") return { allow: true };
  if (f.mode === "read-only") return { deny: `This session is read-only: ${f.tool} can change things, so it does not run here.` };
  if (f.rules.some((r) => r.kind === "tool" && r.pattern === f.tool)) return { allow: true };
  return { ask: { risk: "low", suggest: [{ kind: "tool", pattern: f.tool }] } };
}

function decideShell(command: string, f: Facts): Decision {
  const parts = splitCommand(command);
  if (!parts) {
    if (f.mode === "full-auto") return { allow: true };
    if (f.mode === "read-only") return { deny: "This session is read-only and the command could not be parsed to check it." };
    return { ask: { risk: "high", why: "the command could not be parsed, so no rule can cover it", suggest: [] } };
  }
  const risks = parts.map(highRisk).filter((r): r is string => !!r);
  if (risks.length) {
    if (f.mode === "read-only") return { deny: `This session is read-only, and the command ${risks[0]}.` };
    return { ask: { risk: "high", why: `the command ${[...new Set(risks)].join(" and ")}`, suggest: [] } };
  }
  if (f.mode === "full-auto") return { allow: true };
  const shellRules = f.rules.filter((r) => r.kind === "shell");
  const open = parts.filter((p) => !isReadOnly(p) && !shellRules.some((r) => matchRule(r.pattern, p)));
  if (!open.length) return { allow: true };
  if (f.mode === "read-only") return { deny: `This session is read-only: only read-only commands run, and \`${open[0]!.text}\` is not one.` };
  if (f.mode === "auto-edits" && f.sandboxed) return { allow: true, why: "sandboxed" };
  return { ask: { risk: "low", suggest: [...new Set(open.map(suggestRule))].slice(0, 5).map((pattern) => ({ kind: "shell" as const, pattern })) } };
}

// Driving another session. An allow rule for a tool does not cover another
// session: only a standing answer for driving does (drive:<id>, drive:*). A
// text its harness would act on, a text for an ended session and an allow on
// another session's prompt are the owner's: no mode covers them, only a rule
// naming the tool and the target (keel__session_send:<id>, or :*).
function decideDrive(c: Extract<CallClass, { kind: "drive" }>, f: Facts): Decision {
  if (f.mode === "read-only") return { deny: "This session is read-only: it does not drive other sessions." };
  const tools = f.rules.filter((r) => r.kind === "tool").map((r) => r.pattern);
  if (c.owner) {
    const tool = c.resource.slice(0, c.resource.indexOf(":"));
    if (tools.includes(c.resource) || tools.includes(`${tool}:*`)) return { allow: true };
    return { ask: { risk: "high", why: `only the owner sends this: ${c.owner}`, suggest: [] } };
  }
  if (f.mode === "full-auto") return { allow: true };
  if (tools.includes(`drive:${c.target}`) || tools.includes("drive:*")) return { allow: true };
  return { ask: { risk: "low", suggest: [{ kind: "tool", pattern: `drive:${c.target}` }] } };
}
