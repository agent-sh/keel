// A line whose variables the line gave a written-out value (`W=/abs/dir; $W/run.sh x`, `G=rm; $G -rf d`, `V=push; git $V
// --force`): the line with those variables written out, which the gate judges beside the line itself. The shell runs the
// written form, so the verdict on it is the verdict the owner would get for the line typed out. Only a line that can be
// rewritten by text alone is rewritten; any other keeps being judged as it is, and a program word it cannot read stays
// refused (shared-branches.ts).
import { KNOWN_PATH } from "./shared-branches.ts";
import { laid } from "./risk.ts";
import { valuesOf } from "./risk-words.ts";
import { splitCommand } from "./shell.ts";

// A variable in a word: `${NAME...` or `$NAME`, with the name whole; and the plain forms, `${NAME}` and `$NAME`.
const ANY = /\$(?:\{[#!]?([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g;
const PLAIN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const NAMED = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;

// The line with each variable the line sets to a written-out value written out, or null when there is none to write
// or the line is not one to rewrite. A variable is written out when
// - it is set once, to a written-out value (no `$`, glob, space, `~`, `=`; not empty; a leading `~` or `$HOME` is the
//   session's home, `~user` is not read) in the shell that runs the words
//   that use it: not in a pipeline's stage, a subshell, a substitution, the background or after `||` (`valuesOf` reads
//   exactly that), and every use is in a word of its own after the assignment (not single-quoted, escaped, in a
//   here-document, `${W:-x}`) and is the whole of what the text shows.
// A variable that is not so is left as it is, unless it is in a program word: then the line is not rewritten, and the
// program word it cannot read stays refused. Nothing is rewritten in a line with a loop, a conditional or a group (a name
// may be rebound where the parts do not show it), `IFS` (a value would split into words), an alias or a function (a name
// may mean another program), or a positional parameter (`set -- branch -D x; $W "$@"`).
// `home`: the folder a leading `~`, `~/` or `$HOME/` in a value stands for, as bash writes it out; without it they stay unread.
export function resolvedLine(command: string, home?: string): string | null {
  if (!command.includes("$") || /\bIFS\b|\balias\b|\bfunction\b|\(\s*\)|\$[@*0-9]|\$\{[@*0-9]/.test(command)) return null;
  const parts = splitCommand(command);
  if (!parts || parts.some((p) => p.flow || p.unknown)) return null;
  const { runs } = laid(parts, null, "");
  const vals = valuesOf(parts, runs, home);
  // The uses the parts show: how many of each name, and the first part that has one. The text's own, once, besides.
  const shown = new Map<string, { n: number; first: number }>();
  const see = (name: string, j: number) => {
    const s = shown.get(name);
    if (s) s.n++; else shown.set(name, { n: 1, first: j });
  };
  // (A redirect's target is a use too, shown in the part's `targets`: `$S/run.sh > $S/run.log`.)
  for (let j = 0; j < parts.length; j++) {
    for (const m of parts[j]!.how ?? []) for (const v of m.vars) see(v.name, j);
    for (const v of parts[j]!.targets ?? []) see(v.name, j);
  }
  const text = new Map<string, number>(), plain = new Map<string, number>();
  for (const m of command.matchAll(ANY)) { const n = m[1] ?? m[2]!; text.set(n, (text.get(n) ?? 0) + 1); }
  for (const m of command.matchAll(PLAIN)) { const n = m[1] ?? m[2]!; plain.set(n, (plain.get(n) ?? 0) + 1); }
  // The part outside a substitution before each part: an assignment ran in a shell that goes on when it does not end in a pipe.
  const outer: number[] = [];
  let last = -1;
  for (let j = 0; j < parts.length; j++) { outer.push(last); if (!parts[j]!.nested) last = j; }
  const writable = (n: string): string | null => {
    const k = vals.get(n), s = shown.get(n);
    if (!k || !k.text || /[=~]/.test(k.text) || !s || s.first <= k.at) return null;
    const before = outer[k.at]!;
    if (before >= 0 && (parts[before]!.sep === "|" || parts[before]!.sep === "|&")) return null;
    return s.n === text.get(n) && s.n === plain.get(n) ? k.text : null;
  };
  // A program word that holds a variable the line cannot write out is not rewritten at all.
  const out = new Map<string, string>();
  for (let i = 0; i < parts.length; i++) {
    const w = runs[i]!.words[0];
    if (parts[i]!.heredoc || w === undefined || !/[$`]/.test(w) || KNOWN_PATH.test(w)) continue;
    if (/[$`]/.test(w.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, ""))) return null;
    for (const m of w.matchAll(NAMED)) if (!out.has(m[1]!)) { const v = writable(m[1]!); if (v === null) return null; out.set(m[1]!, v); }
  }
  for (const n of shown.keys()) if (!out.has(n)) { const v = writable(n); if (v !== null) out.set(n, v); }
  if (!out.size) return null;
  return command.replace(PLAIN, (m, a, b) => out.get(a ?? b) ?? m);
}
