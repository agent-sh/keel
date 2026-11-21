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
  Skill: "skill", skill: "skill", activate_skill: "skill", search_tools: "mcp", ToolSearch: "mcp", mcp_call: "mcp", keel__run_on: "shell", keel__session_send: "other", keel__sessions_list: "other", keel__machines_list: "other", keel__send_files: "other",
};
export const toolKind = (name: string): ToolKind => KINDS[name] ?? (name.includes("__") ? "mcp" : "other");
export const PLAN_TOOLS = Object.keys(KINDS).filter((n) => KINDS[n] === "plan");

export type PlanItem = { text: string; status: "pending" | "in_progress" | "completed" | "cancelled"; active?: string };

// A call the model got wrong (not a list) is an empty plan, not a crash.
export function planItems(name: string, input: any): PlanItem[] {
  const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
  if (name === "update_plan") return list(input?.plan).map((p: any) => ({ text: String(p?.step ?? ""), status: p?.status }));
  if (name === "write_todos") return list(input?.todos).map((t: any) => ({ text: String(t?.description ?? ""), status: t?.status }));
  return list(input?.todos).map((t: any) => ({ text: String(t?.content ?? ""), status: t?.status, active: t?.activeForm }));
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
  // A tool search's result names the tools it loaded (tool_reference blocks).
  const loaded = r.content.filter((c: any) => c.type === "tool_reference").map((c: any) => c.tool_name as string);
  const text = r.content.map((c) => (c.type === "text" ? c.text : "")).filter(Boolean).join("\n");
  return loaded.length ? [text, `Loaded ${loaded.join(", ")}`].filter(Boolean).join("\n") : text;
}

// Instruction files the daemon appended to a call's result when the work
// reached their folder (src/engine/nested.ts): taken out of the output and
// shown as what they are.
export function splitNested(text: string): { text: string; nested: { path: string; body: string }[] } {
  const nested: { path: string; body: string }[] = [];
  const rest = text.replace(/\n*<nested-instructions path="([^"]+)">\n([\s\S]*?)\n<\/nested-instructions>/g, (_m, path: string, body: string) => {
    nested.push({ path, body });
    return "";
  });
  return { text: nested.length ? rest.trimEnd() : text, nested };
}

// A memory block an integration appended to a tool's result (tacit's
// pre-tool hook): shown apart as the note it is, labelled with its source. The
// model's input keeps it as it was.
export type ResultMemory = { source: string; hook: string; body: string };
export function splitMemory(text: string): { text: string; memory: ResultMemory[] } {
  const memory: ResultMemory[] = [];
  const rest = text.replace(/\n*<memory source="([^"]+)" hook="([^"]+)">\n([\s\S]*?)\n<\/memory>/g, (_m, source: string, hook: string, body: string) => {
    memory.push({ source, hook, body: body.replace(/^From the owner's memory store.*\n/, "").trim() });
    return "";
  });
  return { text: memory.length ? rest.trimEnd() : text, memory };
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

export { stripAnsi } from "../../../src/core/text.ts";

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

// A tool call as one line of what it does: "Running bun test", "Editing src/a.ts".
const VERB: Partial<Record<ToolKind, string>> = {
  shell: "Running", stdin: "Typing into", read: "Reading", edit: "Editing", write: "Writing", patch: "Patching",
  search: "Searching", glob: "Finding", list: "Listing", web: "Searching the web for", fetch: "Fetching", plan: "Planning",
  ask: "Asking you", skill: "Using skill", mcp: "Calling",
};

export function toolLine(name: string, input: any, cwd?: string): string {
  const k = toolKind(name);
  const arg =
    k === "shell" ? input.cmd ?? input.command
    : k === "read" || k === "edit" || k === "write" ? shortPath(input.file_path ?? "", cwd)
    : k === "search" || k === "glob" ? input.pattern
    : k === "list" ? shortPath(input.dir_path ?? input.path ?? "", cwd)
    : k === "web" ? input.query
    : k === "fetch" ? input.url
    : k === "ask" ? "" : name;
  // A command the model described reads by its description: what it is for, not how it is spelled.
  if (k === "shell" && typeof input.description === "string" && input.description.trim()) return input.description.trim();
  return [VERB[k] ?? "Using", arg].filter(Boolean).join(" ");
}
