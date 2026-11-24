// Exit 1 of grep, rg, diff, cmp and test (and `git diff`, `git grep`, `git merge-base --is-ancestor`) says
// "nothing found", "differs" or "no", not that the command failed. Only the program that sets the call's status
// counts: `A && echo yes` is A's status, since the echo ran only if A passed.
import { lastCommand } from "../checks/named.ts";

const PROGRAMS = new Set(["grep", "egrep", "fgrep", "rg", "diff", "cmp", "test", "["]);

// The subcommand of a `git` line (the first word that is not an option).
const subOf = (w: string[]) => {
  for (let i = 1; i < w.length; i++) {
    if (w[i] === "-C" || w[i] === "-c" || w[i] === "--git-dir" || w[i] === "--work-tree") { i++; continue; }
    if (!w[i]!.startsWith("-")) return w[i];
  }
  return undefined;
};

// `git merge-base --is-ancestor A B`: exit 0 yes, exit 1 no (anything else is an error).
const isAncestor = (w: string[]) => subOf(w) === "merge-base" && w.includes("--is-ancestor");

export function noMatch(command: string, exitCode: number | null): boolean {
  if (exitCode !== 1) return false;
  const w = lastCommand(command);
  if (!w) return false;
  const name = w[0]!.replace(/^.*\//, "");
  if (PROGRAMS.has(name)) return true;
  return name === "git" && (subOf(w) === "diff" || subOf(w) === "grep" || isAncestor(w));
}

// Whether the program that sets the status of a command that ended with exit 1 prints nothing when it says so:
// what the call printed came from commands before it, not from the one that failed.
export function silentExit(command: string, exitCode: number | null): boolean {
  if (exitCode !== 1) return false;
  const w = lastCommand(command);
  if (!w) return false;
  const name = w[0]!.replace(/^.*\//, "");
  if (name === "test" || name === "[" || name === "false") return true;
  return name === "git" && (isAncestor(w) || (subOf(w) === "diff" && w.includes("--quiet")));
}
