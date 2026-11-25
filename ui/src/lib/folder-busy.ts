// Sessions that work in a folder already, for the start box: a second session started in the same checkout edits the
// same files as the first, and a worktree is one press away. Only sessions of this machine whose workspace is the
// folder itself and whose state is working, or waiting on the owner in the middle of its work, count (a session in a
// worktree has its own folder). A request that waits does not end the session's hold on the folder, and counting it
// keeps the line steady while the owner answers a run of them: it would otherwise come in as the first answered
// session starts, and move the rows the next press is on.
import type { Session } from "../../../src/core/types.ts";

const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

export function workingIn(folder: string, sessions: readonly Session[], watchOf: (s: Session) => string | undefined): Session[] {
  const here = bare(folder);
  if (!here) return [];
  return sessions.filter((s) => !s.archived && !s.machine && bare(s.workspace) === here && (watchOf(s) === "work" || watchOf(s) === "need"))
    .sort((a, b) => b.updated - a.updated);
}

const NUMBERS = ["No", "One", "Two", "Three", "Four", "Five"];
// "Two sessions work in this folder (Fix the build, Add search)", the names as many as read well on a line.
export function busyWords(titles: readonly string[]): string {
  const n = titles.length;
  const head = n === 1 ? "A session works" : `${NUMBERS[n] ?? n} sessions work`;
  const names = titles.slice(0, 2).map((t) => t.trim() || "New session");
  const rest = n - names.length;
  return `${head} in this folder (${names.join(", ")}${rest > 0 ? ` and ${rest} more` : ""})`;
}
