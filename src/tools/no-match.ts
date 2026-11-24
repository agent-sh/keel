// Exit 1 of grep, rg, diff, cmp and test (and `git diff`, `git grep`) says "nothing found" or "differs",
// not that the command failed. Only the program that sets the call's status counts.
import { lastCommand } from "../checks/named.ts";

const PROGRAMS = new Set(["grep", "egrep", "fgrep", "rg", "diff", "cmp", "test", "["]);

export function noMatch(command: string, exitCode: number | null): boolean {
  if (exitCode !== 1) return false;
  const w = lastCommand(command);
  if (!w) return false;
  const name = w[0]!.replace(/^.*\//, "");
  if (PROGRAMS.has(name)) return true;
  return name === "git" && (w.find((x, i) => i > 0 && !x.startsWith("-")) === "diff" || w.find((x, i) => i > 0 && !x.startsWith("-")) === "grep");
}
