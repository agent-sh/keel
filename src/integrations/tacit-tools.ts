// What Keel knows about a tool call before it asks the memory store's
// before-a-tool hook. Each rule follows what the store's hook does with a
// call, and two things bind every one of them: none may cost a fact the
// store would have given, and a rule about an action must reach the model
// before that action runs when the store answers in time.
//
// - The store answers an edit only with facts tied to the file's repository
//   (the first folder up its real path that holds a .git entry). A file in
//   no checkout gets nothing, ever: not asked.
// - A shell command with no text gets nothing: not asked.
// - Every other call is asked, every time. What the store answers depends on
//   what it holds at that moment, and nothing in its answer says when that
//   last changed, so an empty answer is never remembered.
// - The hook is also how the store records that the model opened one of its
//   facts, folders or searches (its own tools, or its command line run in a
//   shell). Those calls are always made.
// - The store gives a rule at a read too (reading a script brings the rule
//   about running it) and marks it given there. A read's result is not held
//   for the answer, but the session's next request waits for it, so the rule
//   is in the request the model answers by acting (tacit.ts). A change's
//   result is held, so its rule is in that result.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readOnlyCommand } from "../safety/shell.ts";

export type StoreCall = { tool_name: string; tool_input: any };

// The files a patch writes, as the store reads them from its text.
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
const patchFiles = (text: string) => [...text.matchAll(PATCH_FILE)].map((m) => m[1]!.trim());

// The files a call writes (an edit, a write, a patch), or none for a command or an MCP tool.
export function filesOf(call: StoreCall): string[] {
  if (call.tool_name === "Edit" || call.tool_name === "Write") return typeof call.tool_input?.file_path === "string" ? [call.tool_input.file_path] : [];
  if (call.tool_name === "apply_patch") return patchFiles(String(call.tool_input?.command ?? ""));
  return [];
}
const commandOf = (call: StoreCall): string => (call.tool_name === "Bash" || (call.tool_name === "apply_patch" && !filesOf(call).length) ? String(call.tool_input?.command ?? "") : "");

// The call is one the store records as a step in itself: one of its own
// tools, or its command line in a shell command.
export function namesStore(call: StoreCall): boolean {
  if (call.tool_name.startsWith("mcp__")) return /tacit/i.test(call.tool_name);
  return /(^|[^\w.-])tacit(\.exe)?([^\w-]|$)/.test(commandOf(call));
}

// A path as the store reads it: made absolute and cleaned (a ".." through a
// folder that does not exist is plain text there), then its symlinks
// resolved: of the file itself when it exists, else of the nearest folder that does.
export function realOf(cwd: string, path: string): string | null {
  const p = resolve(cwd, path);
  try { return realpathSync(p); } catch {}
  const rest = [basename(p)];
  let dir = dirname(p);
  while (!existsSync(dir) && dirname(dir) !== dir) { rest.unshift(basename(dir)); dir = dirname(dir); }
  try { return join(realpathSync(dir), ...rest); } catch { return null; }
}

// Whether any folder up from a file's real path holds a .git entry: the file
// is in a checkout, as the store finds one. Looked up each time (a few
// stats): a checkout can be made at any moment (git init, a clone).
export function inCheckout(cwd: string, path: string): boolean {
  const real = realOf(cwd, path);
  if (!real) return true; // cannot tell: ask
  for (let d = dirname(real); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return true;
    if (dirname(d) === d) return false;
  }
}

// A call the store's hook answers with nothing whatever it holds.
export function neverAnswered(cwd: string, call: StoreCall): boolean {
  if (namesStore(call)) return false;
  if (call.tool_name.startsWith("mcp__")) return false;
  const files = filesOf(call);
  if (files.length) return !files.some((f) => inCheckout(cwd, f));
  return !commandOf(call).trim();
}

// Whether a call changes something (a file, a process, another system): its
// result is then held for the store's answer. A shell command by the
// permission gate's own reading of commands, which reads as a change
// whatever it cannot tell is a read; an MCP tool by what its server says of it.
export function changesSomething(call: StoreCall, target?: { readOnly: boolean } | null): boolean {
  if (call.tool_name.startsWith("mcp__")) return !target?.readOnly;
  if (filesOf(call).length) return true;
  const command = commandOf(call);
  if (!command.trim()) return false;
  return !readOnlyCommand(command);
}
