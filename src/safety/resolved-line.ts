// A line whose program words are variables it gave a written-out value (`W=/abs/dir; $W/run.sh x`, `G=rm; $G -rf d`):
// the line with those variables written out, which the gate judges beside the line itself. The shell runs the written
// form, so the verdict on it is the verdict the owner would get for the line typed out. Only a line that can be
// rewritten by text alone is rewritten; any other keeps being judged as it is, and its program word it cannot read
// stays refused (shared-branches.ts).
import { KNOWN_PATH } from "./shared-branches.ts";
import { laid } from "./risk.ts";
import { valuesOf } from "./risk-words.ts";
import { splitCommand } from "./shell.ts";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The line with each variable of its program words replaced by its value, or null when the line is not one of those:
// - a program word that is not only variables the line sets, each once, to a written-out value (no `$`, glob, space,
//   `~`, `=`; not empty) in the shell that runs it: not in a pipeline's stage, a subshell, a substitution, the
//   background or after `||` (`valuesOf` reads exactly that);
// - a line with a loop, a conditional or a group (a name may be rebound where the parts do not show it), `IFS`
//   (a value would split into words), an alias or a function (a name may mean another program), or a use of a
//   variable that is not in a word of its own (single-quoted, escaped, in a here-document, `${W:-x}`) or before its
//   assignment.
export function resolvedLine(command: string): string | null {
  if (!command.includes("$") || /\bIFS\b|\balias\b|\bfunction\b|\(\s*\)/.test(command)) return null;
  const parts = splitCommand(command);
  if (!parts || parts.some((p) => p.flow || p.unknown)) return null;
  const { runs } = laid(parts, null, "");
  const vals = valuesOf(parts, runs);
  const names = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const w = runs[i]!.words[0];
    if (p.heredoc || w === undefined || !/[$`]/.test(w) || KNOWN_PATH.test(w)) continue;
    if (/[$`]/.test(w.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, ""))) return null;
    for (const m of w.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) names.add(m[1]!);
  }
  if (!names.size) return null;
  let out = command;
  for (const n of names) {
    const k = vals.get(n);
    if (!k || !k.text || /[=~]/.test(k.text)) return null;
    // The assignment ran in a shell that goes on: the part before it does not end in a pipe.
    const before = parts.findLastIndex((q, j) => j < k.at && !q.nested);
    if (before >= 0 && (parts[before]!.sep === "|" || parts[before]!.sep === "|&")) return null;
    // Every use is in a word of its own, after the assignment, and is the whole of what the text shows.
    let used = 0;
    for (let j = 0; j < parts.length; j++) for (const m of parts[j]!.how ?? []) for (const v of m.vars) if (v.name === n) { if (j <= k.at) return null; used++; }
    const all = new RegExp(`\\$\\{[#!]?${esc(n)}(?![A-Za-z0-9_])|\\$${esc(n)}(?![A-Za-z0-9_])`, "g");
    const plain = new RegExp(`\\$\\{${esc(n)}\\}|\\$${esc(n)}(?![A-Za-z0-9_])`, "g");
    const seen = command.match(all)?.length ?? 0;
    if (!used || seen !== used || (command.match(plain)?.length ?? 0) !== used) return null;
    out = out.replace(plain, () => k.text!);
  }
  return out;
}
