// A tool call as one line of what it does, as the transcript renders it: one kind per tool name of
// every family, and the verb a line starts with. The page (ui/src/lib/tools.ts) and the daemon's
// "now" line of an agent (src/automation/now.ts) say a call in the same words.

export type ToolKind = "shell" | "stdin" | "read" | "edit" | "write" | "patch" | "notebook" | "search" | "glob" | "list"
  | "web" | "fetch" | "plan" | "ask" | "skill" | "mcp" | "stop" | "other";

export const KINDS: Record<string, ToolKind> = {
  Bash: "shell", exec_command: "shell", run_shell_command: "shell", write_stdin: "stdin", TaskStop: "stop",
  Read: "read", read_file: "read", Edit: "edit", replace: "edit", Write: "write", write_file: "write",
  apply_patch: "patch", NotebookEdit: "notebook", Grep: "search", grep_search: "search", Glob: "glob", glob: "glob",
  list_directory: "list", WebSearch: "web", google_web_search: "web", WebFetch: "fetch", web_fetch: "fetch",
  TodoWrite: "plan", update_plan: "plan", write_todos: "plan", AskUserQuestion: "ask", request_user_input: "ask", ask_user: "ask",
  Skill: "skill", skill: "skill", activate_skill: "skill", search_tools: "mcp", ToolSearch: "mcp", mcp_call: "mcp", keel__run_on: "shell", keel__session_send: "other", keel__sessions_list: "other", keel__machines_list: "other", keel__send_files: "other",
};
export const toolKind = (name: string): ToolKind => KINDS[name] ?? (name.includes("__") ? "mcp" : "other");
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
