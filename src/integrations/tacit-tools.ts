// What Keel knows about a tool call before it asks the memory store's
// before-a-tool hook, so it asks, and holds a tool's result, only when that
// can bring something. Each rule follows what the store's hook does with a
// call, and none of them may cost a fact the store would have given:
//
// - The store answers an edit only with facts tied to the file's repository
//   (the first folder up its path that holds a .git entry). A file in no
//   checkout gets nothing, ever: not asked.
// - A shell command with no text gets nothing: not asked.
// - What the store answers depends on the call as it is sent (the session's
//   folder, the tool, the file or files, the whole command line, an MCP
//   tool's name), on what the session was already given (which only grows,
//   so it only takes answers away, until a summary or a clear) and on what
//   the store holds. So an empty answer stays empty for the same call of the
//   same session until the store may have changed: remembered that long.
// - The hook is also how the store records that the model opened one of its
//   facts, folders or searches (its own tools, or its command line run in a
//   shell). Those calls are always made, whatever is remembered.
// - The hook runs beside the tool and never stops it, so its answer reaches
//   the model with the next request either way. Holding the tool's result
//   for it only decides whether a rule is in that very request or one step
//   later: worth the wait when the call changes something, not for a read.
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isReadOnly, splitCommand } from "../safety/shell.ts";

export type StoreCall = { tool_name: string; tool_input: any };

// How long an empty answer is trusted. The store's own follower asks its
// server for changes at least this often when no event arrives, so the clone
// a hook reads may already be that far behind: a "nothing" is believed no longer.
export const NOTHING_FOR_MS = 60_000;

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

// Whether any folder up from a path holds a .git entry: the path is in a
// checkout, as the store finds one. Symlinks resolved, as the store does.
const checkouts = new Map<string, { at: number; yes: boolean }>();
export function inCheckout(path: string, now = Date.now()): boolean {
  let dir = dirname(path);
  // The nearest folder that exists (a new file's folders may not yet).
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  try { dir = realpathSync(dir); } catch { return true; } // cannot tell: ask
  const known = checkouts.get(dir);
  // A checkout can be made at any time: what was seen is trusted as long as an empty answer is.
  if (known && now - known.at < NOTHING_FOR_MS) return known.yes;
  let yes = false;
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) { yes = true; break; }
    if (dirname(d) === d) break;
  }
  if (checkouts.size > 2_000) checkouts.clear();
  checkouts.set(dir, { at: now, yes });
  return yes;
}

// A call the store's hook answers with nothing whatever it holds.
export function neverAnswered(cwd: string, call: StoreCall): boolean {
  if (namesStore(call)) return false;
  if (call.tool_name.startsWith("mcp__")) return false;
  const files = filesOf(call);
  if (files.length) return !files.some((f) => inCheckout(isAbsolute(f) ? f : resolve(cwd, f)));
  return !commandOf(call).trim();
}

// What the store's answer to a call depends on, besides the session and the
// store itself: two calls with the same key get the same answer.
export function callKey(cwd: string, call: StoreCall): string {
  const files = filesOf(call);
  const what = call.tool_name.startsWith("mcp__") ? "" : files.length ? [...files].sort().join("\n") : commandOf(call);
  return Bun.hash(`${cwd}\n${call.tool_name === "apply_patch" && files.length ? "patch" : call.tool_name}\n${what}`).toString(36);
}

// Whether a call changes something (a file, a process, another system), so a
// rule about it is worth holding its result for. A shell command is a read
// when every part of it is one (or only moves the shell); an MCP tool by
// what its server says of it; anything unsure counts as a change.
export function changesSomething(call: StoreCall, target?: { readOnly: boolean } | null): boolean {
  if (call.tool_name.startsWith("mcp__")) return !target?.readOnly;
  if (filesOf(call).length) return true;
  const parts = splitCommand(commandOf(call));
  if (!parts) return true;
  return !parts.every((p) => isReadOnly(p) || p.words[0] === "cd");
}

// The empty answers of one session: call keys with when each stops being believed.
export class Nothing {
  private until = new Map<string, number>();
  known(key: string, now = Date.now()): boolean {
    const t = this.until.get(key);
    if (t === undefined) return false;
    if (t > now) return true;
    this.until.delete(key);
    return false;
  }
  remember(key: string, now = Date.now()) {
    // Bounded: past it, the ones no longer believed go, then the oldest.
    if (this.until.size >= 1_000) {
      for (const [k, t] of this.until) if (t <= now) this.until.delete(k);
      while (this.until.size >= 1_000) this.until.delete(this.until.keys().next().value!);
    }
    this.until.delete(key);
    this.until.set(key, now + NOTHING_FOR_MS);
  }
  get size() {
    return this.until.size;
  }
}
