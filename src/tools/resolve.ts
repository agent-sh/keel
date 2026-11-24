// What a call to a tool the request did not offer is answered with. Models
// carry names from other harnesses ("bash" for Bash, "shell" for exec_command):
// a call whose name matches exactly one offered tool, by case or as a known
// alias of the same job, runs as that tool and the result says so once. Any
// other name is answered with the offered names closest to it.
import { similar } from "./missing.ts";

// Names one job goes by across the harnesses' tool sets, lower case.
const ALIASES: readonly (readonly string[])[] = [
  ["bash", "shell", "sh", "exec", "exec_command", "run_shell_command", "run_command", "execute_command", "execute_bash", "terminal"],
  ["read", "read_file", "view_file", "cat"],
  ["write", "write_file", "create_file"],
  ["edit", "edit_file", "str_replace", "replace"],
  ["glob", "find_files"],
  ["grep", "grep_search", "search_files"],
  ["list_directory", "ls", "list_dir"],
  ["webfetch", "web_fetch", "fetch"],
  ["websearch", "web_search", "google_web_search"],
];

type Offered = { name: string; input_schema?: any };
export type Resolved = { as: Offered; how: "case" | "alias" } | { near: string[] };

// Whether the input has every property the tool requires: a call that names the
// right job with another tool's inputs (cmd for command) is the model's to redo.
const fits = (t: Offered, input: unknown) => {
  const need: unknown = t.input_schema?.required;
  if (!Array.isArray(need)) return true;
  const have = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return need.every((k) => typeof k === "string" && k in have);
};

export function resolveToolName(asked: string, offered: readonly Offered[], input?: unknown): Resolved {
  const lower = asked.toLowerCase();
  const one = (hits: Offered[], how: "case" | "alias"): Resolved | undefined => hits.length === 1 && fits(hits[0]!, input) ? { as: hits[0]!, how } : undefined;
  const byCase = offered.filter((t) => t.name.toLowerCase() === lower);
  const found = one(byCase, "case");
  if (found) return found;
  if (!byCase.length) {
    const group = ALIASES.find((g) => g.includes(lower));
    if (group) {
      const hit = one(offered.filter((t) => group.includes(t.name.toLowerCase())), "alias");
      if (hit) return hit;
    }
  }
  const names = offered.map((t) => t.name);
  const group = ALIASES.find((g) => g.includes(lower));
  const kin = group ? offered.filter((t) => group.includes(t.name.toLowerCase())).map((t) => t.name) : [];
  return { near: [...new Set([...byCase.map((t) => t.name), ...kin, ...similar(names, asked)])].slice(0, 3) };
}

// What the result of a resolved call says, once.
export const resolvedNote = (asked: string, as: string) => `(There is no tool named ${asked}; ran as ${as}, the name of the tool here. Call it ${as}.)`;
export const closestNote = (near: string[]) => (near.length ? ` The nearest tools offered: ${near.join(", ")}.` : "");
