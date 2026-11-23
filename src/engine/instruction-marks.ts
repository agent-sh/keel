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
