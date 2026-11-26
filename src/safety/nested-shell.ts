// The scripts a command line hands to a shell it starts, each as a line of its own, for the rules that read a
// line's words: what is never allowed, the files that are the owner's alone to change and Keel's own files
// (policy.ts), and the reads of credentials (credential-reads.ts). `bash -c 'cat ~/.ssh/id_ed25519'` is judged
// as `cat ~/.ssh/id_ed25519` is, in the folder its shell starts in. (The risk classes, the account writes and the
// guards of branches read a nested script themselves; they find it with the same shellGiven.)
//
// How a script is found:
// - a shell with -c: sh, bash, zsh, dash, ksh, fish or ash by its name, whatever folder it is called from, behind
//   what the rules read through (variables set in front, env, sudo, timeout, nice, xargs, find -exec). The script
//   is the word shellGiven names (risk-words.ts): -c in any cluster (-lc, -xec), other options before or after it.
//   It is the word as the line's own shell hands it over: its quotes taken off, its escapes read (in
//   `sh -c "cat \"$HOME/.npmrc\""` the script is `cat "$HOME/.npmrc"`). What that shell would expand in it stays as
//   written: `~` and `$HOME` are read as the home, any other variable is a path the rules do not know.
// - a shell that reads its input: the word of a here-string (`bash <<< 'script'`), the text of a here-document
//   that feeds it (a quoted delimiter or not), and the words a plain echo or printf pipes into it.
// - eval: its words joined.
// - a script inside a script, to DEPTH.
// Not read: a script file the line names (`bash run.sh` runs a file, as `./run.sh` does), the words after a script
// (its $0 and $1 are not written into it: `sh -c 'cat "$1"' _ FILE`), a script longer than
// SCRIPT_MAX, of more commands than PARTS_MAX, nested deeper than DEPTH or that does not split into commands
// (risk.ts says each of those as a risk of its own), and a script for another machine or a container.
import { resolvedLine } from "./resolved-line.ts";
import { laid, type Laid } from "./risk.ts";
import { DEPTH, PARTS_MAX, SCRIPT_MAX, SHELLS, name, shellGiven } from "./risk-words.ts";
import { splitCommand, type Simple } from "./shell.ts";

// One script: its commands, where each runs, and the part of the outer line that starts its shell.
export type Inner = { parts: Simple[]; pre: Laid; at: number };

const AWAY = /^(ssh|kubectl|oc|docker|podman)$/;

export function innerLines(parts: Simple[], pre: Laid, home: string, depth = 0): Inner[] {
  const out: Inner[] = [];
  if (depth >= DEPTH) return out;
  const read = (text: string, i: number) => {
    const inner = splitCommand(text);
    if (!inner || inner.length > PARTS_MAX) return;
    const l = laid(inner, pre.dirs[i] ?? null, home, pre.firm[i] === true);
    out.push({ parts: inner, pre: l, at: i });
    for (const deeper of innerLines(inner, l, home, depth + 1)) out.push({ ...deeper, at: i });
  };
  // (A script is read as it stands and, as a plain line is, with the variables it gave a written-out value written
  // out: `f=~/.npmrc; cat $f`.)
  const add = (text: string | undefined, i: number) => {
    if (text === undefined || text.length > SCRIPT_MAX || !/\S/.test(text)) return;
    read(text, i);
    const written = resolvedLine(text, home);
    if (written !== null && written !== text && written.length <= SCRIPT_MAX) read(written, i);
  };
  let since = 0;
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i]!;
    if (s.heredoc) {
      // A run of here-document lines feeds the first command since the run before it that takes a script on its
      // input: a shell here, or a program that runs it somewhere else (then it is no script of this machine).
      let end = i;
      while (end < parts.length && parts[end]!.heredoc) end++;
      let feeder = -1;
      for (let k = since; k < i; k++) {
        const w = pre.runs[k]!.words, p = name(w[0]);
        if (AWAY.test(p)) break;
        if (SHELLS.test(p) && shellGiven(w.slice(1)).input) { feeder = k; break; }
      }
      if (feeder >= 0) for (let k = i; k < end; k++) add(parts[k]!.doc, feeder);
      i = end - 1;
      since = end;
      continue;
    }
    const run = pre.runs[i]!;
    const p = name(run.words[0]);
    if (p === "eval") { add(run.words.slice(1).join(" "), i); continue; }
    if (!SHELLS.test(p) || run.deep) continue;
    const given = shellGiven(run.words.slice(1));
    if (given.script !== undefined) { add(given.script, i); continue; }
    if (!given.input) continue;
    add(s.here, i);
    const before = i > 0 ? parts[i - 1]! : undefined;
    if (before && !before.heredoc && !before.dyn?.length && (before.sep === "|" || before.sep === "|&") && /^(echo|printf)$/.test(name(pre.runs[i - 1]!.words[0])))
      add(pre.runs[i - 1]!.words.slice(1).filter((w) => !/^-[neE]+$/.test(w)).join(" ").replace(/\\n/g, "\n"), i);
  }
  return out;
}
