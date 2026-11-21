// What Keel knows about a tool call before it asks the memory store's
// before-a-tool hook, so it asks, and holds a tool's result, only when that
// can bring something. Each rule follows what the store's hook does with a
// call. Two things bind every one of them: none may cost a fact the store
// would have given, and a rule about an action must reach the model before
// that action runs when the store answers in time.
//
// - The store answers an edit only with facts tied to the file's repository
//   (the first folder up its real path that holds a .git entry). A file in
//   no checkout gets nothing, ever: not asked.
// - A shell command with no text gets nothing: not asked.
// - A call that changes something is always asked: the store may have gained
//   a rule for it a moment ago.
// - A read's answer depends on the call as it is sent (the session's folder,
//   the tool, the whole command line, an MCP tool's name), on what the
//   session was already given (which only grows, so it only takes answers
//   away, until a summary or a clear) and on what the store holds. So an
//   empty answer to a read stays empty for the same read of the same session
//   until the store may have changed: remembered that long, and only when
//   the answer came from a search (see Searches).
// - The hook is also how the store records that the model opened one of its
//   facts, folders or searches (its own tools, or its command line run in a
//   shell). Those calls are always made, whatever is remembered.
// - The store gives a rule at a read too (reading a script brings the rule
//   about running it) and marks it given there. A read's result is not held
//   for the answer, but the session's next request waits for it, so the rule
//   is in the request the model answers by acting (tacit.ts). A change's
//   result is held, so its rule is in that result.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isReadOnly, splitCommand } from "../safety/shell.ts";

export type StoreCall = { tool_name: string; tool_input: any };

// How long a read's empty answer is believed. The store's follower merges a
// change into the clone a hook reads between 1 s (its debounce) and 5 s (the
// longest it lets changes gather) after the server announces it, so what a
// hook reads is by design up to 5 s behind: a "nothing" is believed no
// longer than that. (Its 60 s poll is only for when no announcement comes.)
export const NOTHING_FOR_MS = 5_000;

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

// What the store's answer to a call depends on, besides the session and the
// store itself: two calls with the same key get the same answer.
export function callKey(cwd: string, call: StoreCall): string {
  const files = filesOf(call);
  const what = call.tool_name.startsWith("mcp__") ? "" : files.length ? [...files].sort().join("\n") : commandOf(call);
  return Bun.hash(`${cwd}\n${call.tool_name === "apply_patch" && files.length ? "patch" : call.tool_name}\n${what}`).toString(36);
}

// Whether a call changes something (a file, a process, another system): it
// is then always asked about, and its result held for the answer. A shell
// command is a read when every part of it is one (or only moves the shell),
// as the permission gate reads commands; an MCP tool by what its server says
// of it. Anything unsure counts as a change: a command the parser makes no
// parts of, and any command with an output redirect in its text (a redirect
// after a group or a loop is not a part of its own).
export function changesSomething(call: StoreCall, target?: { readOnly: boolean } | null): boolean {
  if (call.tool_name.startsWith("mcp__")) return !target?.readOnly;
  if (filesOf(call).length) return true;
  const command = commandOf(call);
  if (!command.trim()) return false;
  if (command.includes(">")) return true;
  const parts = splitCommand(command);
  if (!parts?.length) return true;
  return !parts.every((p) => isReadOnly(p) || p.words[0] === "cd");
}

// How long the store's before-a-tool calls take, lately. An index that is
// stale or still being built makes the hook answer with nothing at once,
// far faster than a search, and nothing in its output says so. So an empty
// answer counts as the store's "nothing" only when it took at least half as
// long as its calls usually do (their median over the last 50), and none
// does before 20 calls were seen.
export class Searches {
  private ms: number[] = [];
  add(ms: number) {
    this.ms.push(ms);
    if (this.ms.length > 50) this.ms.shift();
  }
  // Whether an answer that took `ms` came from a search.
  searched(ms: number): boolean {
    if (this.ms.length < 20) return false;
    const sorted = [...this.ms].sort((a, b) => a - b);
    return ms >= sorted[Math.floor(sorted.length / 2)]! / 2;
  }
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
