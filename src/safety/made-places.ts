// Folders a session made itself, read from its own stored calls: a worktree its own `git worktree add` created.
// Git refuses to add a worktree where something already lives, so a call that succeeded made the folder, and what
// is in it is the session's own work. This is a fact of the session's records, not of what the agent says of a
// folder: the call must have run and ended without a failure, and the gate checks the folder is a linked worktree
// now. Pure here: the gate reads the events and the disk.
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitCall, located } from "./autonomy.ts";
import { splitCommand } from "./shell.ts";

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
// Options of `git worktree add` that take a value of their own.
const WITH_VALUE = new Set(["-b", "-B", "--reason"]);

// A word with the home and the variables the line set to a literal replaced; null when anything else stands in it.
function spelled(word: string, env: Map<string, string>, home: string): string | null {
  let w = word === "~" ? home : word.startsWith("~/") ? home + word.slice(1) : word;
  let unknown = false;
  w = w.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, a, b) => {
    const name = (a ?? b) as string;
    const v = name === "HOME" ? home : env.get(name);
    if (v === undefined) { unknown = true; return ""; }
    return v;
  });
  return unknown || /[$`*?[\]{}]/.test(w) ? null : w;
}

// The folders a command line adds as git worktrees, as paths (a relative one from where the line has `cd`ed to).
// Only a path the line spells out: a variable it sets to a literal counts, anything built at run time does not.
export function worktreesAdded(command: string, cwd: string, home: string): string[] {
  if (!/\bworktree\s+add\b/.test(command)) return [];
  const parts = splitCommand(command);
  if (!parts) return [];
  const env = new Map<string, string>();
  const out: string[] = [];
  for (const { s, dir } of located(parts, cwd, home)) {
    const set = s.words.length === 1 ? ASSIGN.exec(s.words[0]!) : null;
    if (set && !s.nested) {
      const v = spelled(set[2]!, env, home);
      if (v !== null) env.set(set[1]!, v); else env.delete(set[1]!);
      continue;
    }
    const g = gitCall(s.words, dir, home);
    if (!g || g.sub !== "worktree" || g.args[0] !== "add" || g.dir === null || s.nested) continue;
    const rest = g.args.slice(1);
    let path: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (WITH_VALUE.has(a)) { i++; continue; }
      if (a.startsWith("-")) continue;
      path = a;
      break;
    }
    const word = path === undefined ? null : spelled(path, env, home);
    if (word === null) continue;
    out.push(resolve(g.dir, word));
  }
  return out;
}

// Whether a stored result shows the call ended without a failure: a command that exits with a status says so
// first (Claude's and Gemini's shells mark it an error; the gpt family's says "Process exited with code N"), and git
// says why it refused. A result of a command still running (moved to the background, a session to read on) shows
// nothing of what it did. One failure anywhere drops the call: a line that adds several worktrees and fails
// somewhere is not known to have made any.
export function endedWell(output: string, isError?: boolean): boolean {
  if (isError || /^Exit code \d+/.test(output) || /\bfatal:/.test(output)) return false;
  if (/^Process exited with code (?!0\b)/m.test(output) || /^Process running with session ID/m.test(output)) return false;
  return !/^Command (did not complete within|running in background|moved to the background)/.test(output);
}

// Exit status 0 does not show a call made anything: `true || git worktree add P`, a `grep -q x f && ...`, a
// `... 2>/dev/null || true` on a folder that was there before all end well. What shows it made the worktree is
// that the folder's own `.git` file was born while the call ran: from when the call was stored to when its result
// was, a few milliseconds either way for the clocks. A worktree removed and made again later by someone else is
// born after the result, so it is not the call's. A file system with no birth time says nothing, so nothing counts.
// (Before: the kernel stamps files with a clock a few milliseconds behind the call's own. After: the stored time is
// cut to the millisecond.)
const BORN_BEFORE_MS = 50, BORN_AFTER_MS = 5;
export function bornDuring(dir: string, from: number, to: number): boolean {
  try {
    const b = statSync(join(dir, ".git")).birthtimeMs;
    return b > 0 && b >= from - BORN_BEFORE_MS && b <= to + BORN_AFTER_MS;
  } catch { return false; }
}
