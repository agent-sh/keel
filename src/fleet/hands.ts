// Peer hands: a session's workspace tools run on another machine through that
// machine's daemon, over the paired link. The serving daemon runs the same tool
// (same family, same name) fenced to the directory granted to the caller; the
// calling daemon's permission gate has already judged the call.
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { confine, sandboxStatus } from "../safety/sandbox.ts";
import { contains } from "../core/paths.ts";
import { toolsFor } from "../tools/registry.ts";
import type { ToolContext, ToolOutput } from "../tools/types.ts";
import { dropCallEnv, setCallEnv } from "../tools/jobs.ts";
import { SHELL_FIELDS, vault } from "../safety/secrets.ts";
import { readOptsFor } from "../safety/sandbox-config.ts";
import { sandboxScope } from "../safety/sandbox-view.ts";

// A secret named in a call another daemon sent (it sends names, never values):
// one this daemon holds under that name, or a refusal that names it.
export function namedSecrets<T extends Record<string, unknown>>(input: T, shell: ReadonlySet<string>): { value: T; env: Record<string, string> } | { error: string } {
  const r = vault.resolveNamed(input, shell);
  if ("value" in r) return r;
  const list = (ns: string[]) => ns.map((n) => "$" + n).join(", ");
  const parts = [
    r.missing.length ? `${list(r.missing)} ${r.missing.length > 1 ? "are" : "is"} not a secret on this machine: give it here under that name` : "",
    r.ambiguous.length ? `${list(r.ambiguous)} names two secrets on this machine: keep one` : "",
  ].filter(Boolean);
  return { error: `Error [SECRET_NOT_HERE]: nothing ran: ${parts.join("; ")}.` };
}

// The tools that touch the workspace: they run where the session's files are.
// Everything else (questions to the owner, plans, web, MCP, skills, the fleet's
// own tools) stays with the session's daemon.
export const WORKSPACE_TOOLS = new Set([
  "Bash", "TaskStop", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep",
  "exec_command", "write_stdin", "apply_patch", "view_image",
  "run_shell_command", "read_file", "write_file", "replace", "glob", "grep_search", "list_directory",
]);

const PATH_KEYS = ["file_path", "absolute_path", "path", "notebook_path", "dir_path", "cwd", "workdir", "directory"];

export type HandsRequest = {
  session: string;
  call?: string;
  tool: string;
  input: any;
  cwd: string;
  root: string;
  sandbox?: boolean;
};

// Resolve through links where the path exists (its nearest existing ancestor
// otherwise), so a link inside the root that points out of it is caught.
function real(p: string): string {
  let cur = p;
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return p;
    rest.unshift(cur.slice(up.length + 1));
    cur = up;
  }
  try { return join(realpathSync(cur), ...rest); } catch { return p; }
}

// Paths a call names that lie outside the root, in every spelling it carries.
export function outsideRoot(input: any, cwd: string, root: string, spillDir: string): string[] {
  const r = real(root);
  const bad: string[] = [];
  const check = (p: string, readOnly: boolean) => {
    const full = real(isAbsolute(p) ? p : resolve(cwd, p));
    if (contains(r, full)) return;
    if (readOnly && contains(real(spillDir), full)) return; // "Full output: <path>" written by this connection
    bad.push(p);
  };
  if (!contains(r, real(cwd))) bad.push(cwd);
  if (input && typeof input === "object") {
    for (const k of PATH_KEYS) if (typeof input[k] === "string" && input[k]) check(input[k], true);
    const patch = typeof input.patch === "string" ? input.patch : typeof input.input === "string" ? input.input : "";
    const base = typeof input.workdir === "string" ? resolve(cwd, input.workdir) : cwd;
    for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
      const p = (m[1] ?? m[2])!.trim();
      const full = real(isAbsolute(p) ? p : resolve(base, p));
      if (!contains(r, full)) bad.push(p);
    }
  }
  return bad;
}

// The argv of a script /api/fleet/hands/exec runs: confined in the granted
// directory as the caller asked (its session's sandbox), or refused when this
// machine cannot confine it. A daemon's own git steps ask for nothing.
export function execArgv(script: string, root: string, confined?: { sandbox?: unknown; network?: unknown }): string[] | { error: string } {
  const argv = ["bash", "-c", script];
  if (!confined) return argv;
  const sandbox = confined.sandbox === "read-only" ? "read-only" : "workspace-write";
  if (!sandboxStatus().available) return { error: `The session is sandboxed and this machine cannot sandbox commands (${sandboxStatus().reason}): nothing ran.` };
  // (What this machine's owner lets the folder's commands read: its own settings.)
  return confine(argv, { sandbox, network: confined.network === true }, root, undefined, readOptsFor(sandboxScope(root)));
}

const seenBySession = new Map<string, Map<string, number>>();

export async function runHands(q: HandsRequest, spillRoot: string, signal: AbortSignal): Promise<ToolOutput> {
  if (!WORKSPACE_TOOLS.has(q.tool)) return { content: `${q.tool} does not run on another machine.`, is_error: true };
  // Tool names are distinct across families, so the name alone finds it.
  const tool = (["claude", "gpt", "gemini"] as const).flatMap((f) => toolsFor(f)).find((t) => t.name === q.tool);
  if (!tool) return { content: `This machine has no tool ${q.tool}.`, is_error: true };
  if (q.sandbox && !sandboxStatus().available) return { content: `The session is sandboxed and this machine cannot sandbox commands (${sandboxStatus().reason}): nothing ran.`, is_error: true };
  if (!q.root || !existsSync(q.root)) return { content: `The granted directory ${q.root} does not exist on this machine.`, is_error: true };
  const spillDir = join(spillRoot, q.session);
  const out = outsideRoot(q.input, q.cwd, q.root, spillDir);
  if (out.length) return { content: `Error [OUTSIDE_WORKSPACE]: ${out.join(", ")} is outside the directory granted on this machine (${q.root}).`, is_error: true };
  const seen = seenBySession.get(q.session) ?? new Map();
  seenBySession.set(q.session, seen);
  const callId = typeof q.call === "string" && q.call ? q.call : crypto.randomUUID();
  const ctx: ToolContext = {
    sessionId: q.session, cwd: q.cwd, signal, seen, spillDir, callId,
    wrapSpawn: q.sandbox ? (argv) => confine(argv, { sandbox: "workspace-write", network: false }, q.root, undefined, readOptsFor(sandboxScope(q.root))) : undefined,
  };
  let input = q.input;
  if (tool.kind === "shell" && input && typeof input === "object") {
    const r = namedSecrets(input, SHELL_FIELDS);
    if ("error" in r) return { content: r.error, is_error: true };
    input = r.value;
    if (Object.keys(r.env).length) setCallEnv(callId, r.env);
  }
  try {
    // Output with a value this daemon knows goes back with its placeholder.
    return vault.mask(await tool.run(input, ctx));
  } finally {
    dropCallEnv(callId);
  }
}
