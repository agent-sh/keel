// An instruction file edited while a session lives reaches it at its next
// request, without a daemon restart. Claude Code reads its CLAUDE.md files
// again at a compaction and OpenCode sends the change as a message; Keel
// tells it at the tail of the history while the cache is warm and folds it
// into the prompt at the next cold moment (src/engine/prompt-note.ts,
// src/engine/build-pin.ts). What was missing is noticing the edit.
//
// A render of the prompt notes each file it read or looked for (the owner's
// file, the AGENTS.md and CLAUDE.md of every folder of the chain, the files
// they import) with its mark on disk: size, change time and inode, taken
// before the file is read, so an edit made while it is read is seen at the
// next check. Before each request of a turn the marks are taken again: a
// stat per path, no read, no watcher. A mark that differs (an edit, a new
// file, a deleted one, a link pointed elsewhere) has the prompt rendered and
// compared again; the comparison decides what the model is told.
import { statSync } from "node:fs";
import { diffLines, splitLines } from "../tools/diff.ts";

export type InstructionScope = "owner" | "parent" | "folder" | "nested";
export type InstructionEdit = { path: string; scope: InstructionScope; lines: string };

// Only line numbers are stored with the result, not another copy of the file.
export function changedInstructionLines(before: string, after: string): string {
  if (before === after) return "";
  const old = splitLines(before), now = splitLines(after);
  let first = 0, rest = 0;
  while (first < old.length && first < now.length && old[first] === now[first]) first++;
  while (rest < old.length - first && rest < now.length - first && old[old.length - 1 - rest] === now[now.length - 1 - rest]) rest++;
  const span = (a: number, b: number) => a === b ? `line ${a}` : `lines ${a}–${b}`;
  const end = Math.max(old.length, now.length) - rest;
  if (first === end) return `line ${Math.max(1, end)} (line ending)`;
  // Do not run a quadratic diff of a whole-file rewrite on the daemon's loop.
  if (old.length + now.length - 2 * (first + rest) > 512) return `${span(first + 1, end)} (changed span)`;
  const runs: string[] = [];
  const ops = diffLines(old.slice(first, old.length - rest), now.slice(first, now.length - rest));
  for (const kind of ["-", "+"] as const) {
    let line = first, from = 0;
    for (const { t } of ops) {
      if (t === (kind === "+" ? "-" : "+")) continue;
      if (t === kind) { from ||= line + 1; line++; continue; }
      if (from) { runs.push(`${span(from, line)} ${kind === "+" ? "added" : "removed"}`); from = 0; }
      line++;
    }
    if (from) runs.push(`${span(from, line)} ${kind === "+" ? "added" : "removed"}`);
  }
  return runs.length > 6 ? `${span(first + 1, end)} (changed span)` : runs.join("; ");
}

// Each path's mark as the render saw it.
export type Marks = Map<string, string>;

// A path's mark: what changes when the file is written, replaced or removed.
// A link is followed: an edit of the file it points at is an edit.
// (A path that is not there is the common case, most folders have no file:
// asked without an exception, which costs more than the stat.)
export function markOf(path: string): string {
  try {
    const s = statSync(path, { throwIfNoEntry: false });
    return s ? `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}` : "-";
  } catch {
    return "?";
  }
}

// Notes a path the render is about to read or looked for (the first look stands).
export function noteMark(marks: Marks | undefined, path: string) {
  if (marks && !marks.has(path)) marks.set(path, markOf(path));
}

// The first path whose mark is not the one the render saw, if any.
export function editedPath(marks: Marks): string | undefined {
  for (const [path, mark] of marks) if (markOf(path) !== mark) return path;
  return undefined;
}
