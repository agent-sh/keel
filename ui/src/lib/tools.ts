// How the UI reads tool calls of every family: one kind per tool name, and
// the few shapes (plans, questions, shell results) normalized.
import type { ToolResultBlock } from "../../../src/core/types.ts";

export type ToolKind = "shell" | "stdin" | "read" | "edit" | "write" | "patch" | "notebook" | "search" | "glob" | "list"
  | "web" | "fetch" | "plan" | "ask" | "skill" | "mcp" | "stop" | "other";

const KINDS: Record<string, ToolKind> = {
  Bash: "shell", exec_command: "shell", run_shell_command: "shell", write_stdin: "stdin", TaskStop: "stop",
  Read: "read", read_file: "read", Edit: "edit", replace: "edit", Write: "write", write_file: "write",
  apply_patch: "patch", NotebookEdit: "notebook", Grep: "search", grep_search: "search", Glob: "glob", glob: "glob",
  list_directory: "list", WebSearch: "web", google_web_search: "web", WebFetch: "fetch", web_fetch: "fetch",
  TodoWrite: "plan", update_plan: "plan", write_todos: "plan", AskUserQuestion: "ask", request_user_input: "ask", ask_user: "ask",
  Skill: "skill", skill: "skill", activate_skill: "skill", search_tools: "mcp", mcp_call: "mcp",
};
export const toolKind = (name: string): ToolKind => KINDS[name] ?? (name.includes("__") ? "mcp" : "other");

export type PlanItem = { text: string; status: "pending" | "in_progress" | "completed" | "cancelled"; active?: string };

export function planItems(name: string, input: any): PlanItem[] {
  if (name === "update_plan") return (input?.plan ?? []).map((p: any) => ({ text: p.step, status: p.status }));
  if (name === "write_todos") return (input?.todos ?? []).map((t: any) => ({ text: t.description, status: t.status }));
  return (input?.todos ?? []).map((t: any) => ({ text: t.content, status: t.status, active: t.activeForm }));
}

export type UiQuestion = { id: string; header?: string; question: string; options: { label: string; description?: string }[]; multi: boolean };

export function questions(name: string, input: any): UiQuestion[] {
  return (input?.questions ?? []).map((q: any, i: number) => ({
    id: name === "request_user_input" ? String(q.id ?? i) : String(i),
    header: q.header, question: q.question ?? "",
    options: q.type === "yesno" ? [{ label: "Yes" }, { label: "No" }] : q.options ?? [],
    multi: !!q.multiSelect,
  }));
}

export function resultText(r?: ToolResultBlock): string {
  if (!r) return "";
  if (typeof r.content === "string") return r.content;
  return r.content.map((c) => (c.type === "text" ? c.text : "")).filter(Boolean).join("\n");
}

export const resultImages = (r?: ToolResultBlock) =>
  !r || typeof r.content === "string" ? [] : r.content.filter((c): c is { type: "image"; media_type: string; data: string } => c.type === "image");

// What the shell said about the run, read from each family's result wording.
export function shellStatus(text: string): { exit?: number; background?: string; session?: string } {
  const exit = /^(?:Exit code|Exit Code:|Process exited with code) ?(-?\d+)/m.exec(text);
  const bg = /(?:in background|moved to the background) with ID: (\w+)/.exec(text) ?? /Background PIDs: (\d+)/.exec(text);
  const session = /Process running with session ID (\d+)/.exec(text);
  return { exit: exit ? Number(exit[1]) : undefined, background: bg?.[1], session: session?.[1] };
}

// Shell output without the result's own framing lines.
export function shellBody(name: string, text: string): string {
  if (name === "exec_command" || name === "write_stdin") return text.replace(/^[\s\S]*?\nOutput:\n?/, "");
  if (name === "run_shell_command") return (/^Output: ([\s\S]*?)\nExit Code:/m.exec(text)?.[1] ?? text);
  return text.replace(/^Exit code \d+\n?/, "");
}

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, "");

export function patchFiles(patch: string): { path: string; op: "add" | "delete" | "update"; lines: string[]; moveTo?: string }[] {
  const out: { path: string; op: "add" | "delete" | "update"; lines: string[]; moveTo?: string }[] = [];
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    const m = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line);
    if (m) { out.push({ path: m[2]!.trim(), op: m[1]!.toLowerCase() as any, lines: [] }); continue; }
    const mv = /^\*\*\* Move to: (.+)$/.exec(line);
    if (mv && out.length) { out[out.length - 1]!.moveTo = mv[1]!.trim(); continue; }
    if (/^\*\*\* (Begin|End) Patch|^\*\*\* End of File/.test(line) || !out.length) continue;
    out[out.length - 1]!.lines.push(line);
  }
  return out;
}

export const shortPath = (p: string, cwd?: string) => (cwd && p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p.replace(/^\/home\/[^/]+/, "~"));
