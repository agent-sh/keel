// The root folder of the repository a folder is in: a worktree's is its
// repository's (the folder that holds the common git directory), so the agents
// of one repository share it wherever their worktrees are. Null outside a
// repository Keel opens. Read from the files (src/core/git.ts locate).
import { dirname } from "node:path";
import { locate } from "./git.ts";

export function repoRoot(dir: string): string | null {
  try {
    const at = locate(dir);
    if (!at?.top) return null;
    return at.common.endsWith("/.git") ? dirname(at.common) : at.top;
  } catch { return null; }
}
