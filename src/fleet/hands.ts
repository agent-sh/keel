// Peer hands: a session's workspace tools run on another machine through that
// machine's daemon, over the paired link. The serving daemon runs the same tool
// (same family, same name) fenced to the directory granted to the caller; the
// calling daemon's permission gate has already judged the call.
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { confine, sandboxStatus } from "../safety/sandbox.ts";
import { inside } from "../safety/policy.ts";
import { toolsFor } from "../tools/registry.ts";
import type { ToolContext, ToolOutput } from "../tools/types.ts";

// The tools that touch the workspace: they run where the session's files are.
// Everything else (questions to the owner, plans, web, MCP, skills, the fleet's
// own tools) stays with the session's daemon.
export const WORKSPACE_TOOLS = new Set([
  "Bash", "TaskStop", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep",
  "exec_command", "write_stdin", "apply_patch",
  "run_shell_command", "read_file", "write_file", "replace", "glob", "grep_search", "list_directory",
]);

const PATH_KEYS = ["file_path", "absolute_path", "path", "notebook_path", "dir_path", "cwd", "workdir", "directory"];

export type HandsRequest = {
  session: string;
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
    if (inside(full, r)) return;
    if (readOnly && inside(full, real(spillDir))) return; // "Full output: <path>" written by this connection
    bad.push(p);
  };
  if (!inside(real(cwd), r)) bad.push(cwd);
  if (input && typeof input === "object") {
    for (const k of PATH_KEYS) if (typeof input[k] === "string" && input[k]) check(input[k], true);
    const patch = typeof input.patch === "string" ? input.patch : typeof input.input === "string" ? input.input : "";
    const base = typeof input.workdir === "string" ? resolve(cwd, input.workdir) : cwd;
    for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
      const p = (m[1] ?? m[2])!.trim();
      const full = real(isAbsolute(p) ? p : resolve(base, p));
      if (!inside(full, r)) bad.push(p);
    }
  }
  return bad;
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
  const ctx: ToolContext = {
    sessionId: q.session, cwd: q.cwd, signal, seen, spillDir,
    wrapSpawn: q.sandbox ? (argv) => confine(argv, { sandbox: "workspace-write", network: false }, q.root) : undefined,
  };
  return tool.run(q.input, ctx);
}
