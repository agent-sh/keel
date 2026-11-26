// The scripts a command line hands to a shell it starts, each as a line of its own, for the rules that read a
// line's words: what is never allowed, the files that are the owner's alone to change and Keel's own files
// (policy.ts), and the reads of credentials (credential-reads.ts). `bash -c 'cat ~/.ssh/id_ed25519'` is judged
// as `cat ~/.ssh/id_ed25519` is, in the folder its shell starts in. (The risk classes, the account writes and the
// guards of branches read a nested script themselves; they find it with the same shellGiven.)
//
// How a script is found:
// - a shell with -c: sh, bash, zsh, dash, ksh, fish and the others of SHELLS by its name, whatever folder it is
//   called from, behind what the rules read through (variables set in front, env, sudo, timeout, nice, xargs, find
//   -exec). The script is the word shellGiven names (risk-words.ts): -c in any cluster (-lc, -xec, +c), other
//   options before or after it, and behind options that cannot be read (`bash $OPTS -c`) the word after the first
//   cluster with c, with every other word that may be the script instead (`scriptsOf`: `bash -oc $X errexit
//   'script'`, `X='-c $1'; bash $X -oc 'script'`). It is the word as the line's own shell hands it over: its
//   quotes taken off, its escapes read (in `sh -c "cat \"$HOME/.npmrc\""` the script is `cat "$HOME/.npmrc"`, in
//   `bash -c $'a\nb'` two lines). What
//   that shell would expand in it stays as written: `~` and `$HOME` are read as the home, any other variable is a
//   path the rules do not know.
// - a shell that reads its input (no script, -s, or /dev/stdin named as the script): the word of a here-string
//   (`bash <<< 'script'`), the text of a here-document it opens (a quoted delimiter or not; also one opened by a
//   shell whose own -c script starts the shell that reads it, `bash -c 'sh -s' <<EOF`, or by a cat piped into
//   it), and the words a plain echo or printf pipes into it or hands it as a file (`bash <(echo 'script')`).
// - eval: its words joined. A wrapper handed the command as one word (`env -S 'bash -c ...'`, `watch 'cmd'`,
//   flock's `-c 'cmd'`: lineHanded), and the option of a program that runs its value as a line here (script -c,
//   nix-shell --run, waitfor --until): that word. (The risk classes read the first three and not a wait's
//   --until: its word is most often a script in a variable, `"$S/check.sh"`, which they would ask about.)
// - a script inside a script, to DEPTH.
// - the words after a script that names them plainly ($0, $1, "$@") are written into it when they are plain paths:
//   `sh -c 'cat "$1"' _ FILE` is also read as `cat "FILE"`.
// Not read: a script file the line names (`bash run.sh` runs a file, as `./run.sh` does), the words xargs or find
// hands a script (`xargs -I{} sh -c 'cat {}'`), a script longer than SCRIPT_MAX, of more
// commands than PARTS_MAX, nested deeper than DEPTH or that does not split into commands (risk.ts says each of
// those as a risk of its own), and a script for another machine or a container. A here-document of the line
// itself is read whatever its length (it is the line's own text, read once); one inside a script that is longer
// than SCRIPT_MAX is not read, and is said (`unread`).
import { resolvedLine } from "./resolved-line.ts";
import { laid, type Laid } from "./risk.ts";
import { DEPTH, PARTS_MAX, PRINTS, SCRIPT_MAX, SHELLS, evalGiven, lineHanded, name, printed, scriptsOf, shellGiven, substituted, unwrap } from "./risk-words.ts";
import { docOf, splitCommand, splitDocument, type Simple } from "./shell.ts";

// One script: its commands, where each runs, and the part of the outer line that starts its shell.
export type Inner = { parts: Simple[]; pre: Laid; at: number };
// A script that was not read, by the part of the outer line that starts its shell.
export type Unread = { at: number; why: string; unparsed?: true };

// Programs that hand their input to a shell somewhere else: a here-document they open is no script of this machine.
const AWAY = /^(ssh|kubectl|oc|docker|podman)$/;
// Programs that run an option's value as a shell line on this machine, in the account the line runs in.
const RUNS_TEXT: Record<string, RegExp> = Object.assign(Object.create(null), { script: /^(-[a-zA-Z]*c|--command)$/, "nix-shell": /^(--run|--command)$/, waitfor: /^--until$/ });
// A script with the words after it written in where it names them plainly ($0, $1, "$@"): `sh -c 'cat "$1"' _ FILE`
// as `cat "FILE"`. Only words that are plain paths are written in (a leading ~ as the home, which the line's own
// shell has written out by then); undefined when the script names none or a word is anything else.
function positional(script: string, rest: string[], home: string): string | undefined {
  if (!rest.length || !/\$\{?[@*0-9]/.test(script)) return undefined;
  const plain = rest.map((w) => (w === "~" ? home : w.startsWith("~/") ? home + w.slice(1) : w));
  if (!plain.every((w) => /^[A-Za-z0-9_.\/@%+,:=-]*$/.test(w))) return undefined;
  const all = plain.slice(1).join(" ");
  return script.replace(/"\$(?:[@*]|\{[@*]\})"/g, all).replace(/\$(?:\{([@*0-9])\}|([@*0-9]))/g, (_, a: string | undefined, b: string | undefined) => { const k = a ?? b!; return k === "@" || k === "*" ? all : plain[Number(k)] ?? ""; });
}

// What one line's reading has read so far: each script once in a folder (a script and its written-out form hold
// the same scripts inside them, which are read once, not once for each), and no more nested text in all than
// NESTED_MAX, whatever the line's length (the line's own here-documents are not counted: each is read once as it
// stands and, up to NESTED_MAX characters, once written out; a longer one asks as a script too long does, risk.ts).
// A line that hands shells more than that asks, as one nested too deep does.
type Read = { seen: Set<string>; left: number };
// (A script at the bound with one as long inside it, each as it stands and written out.)
export const NESTED_MAX = 4 * SCRIPT_MAX;

// `written`: the parts are those of a script's written-out form. A script inside one is read in its own
// written-out form only (the one text with the variables of every level above it and its own written out), and as
// it stands when it has none: a script inside a script as it stands is read both ways. So a script nested n deep is
// read in n + 1 forms at most, not in one for every choice of the levels above it.
export function innerLines(parts: Simple[], pre: Laid, home: string, depth = 0, unread?: Unread[], state?: Read, written = false): Inner[] {
  const out: Inner[] = [];
  if (depth >= DEPTH) return out;
  const st = state ?? { seen: new Set<string>(), left: NESTED_MAX };
  // The same text read as a document may yield a runnable prefix that no whole-script parse returned.
  const keyOf = (text: string, i: number, document: boolean) => `${document ? "doc" : "cmd"}\0${pre.dirs[i] ?? ""}\0${pre.firm[i] === true}\0${text}`;
  const read = (text: string, i: number, free: boolean, from: boolean, document: boolean) => {
    const key = keyOf(text, i, document);
    if (st.seen.has(key)) return;
    st.seen.add(key);
    if (!free) {
      if (st.left < text.length) { if (st.left >= 0) unread?.push({ at: i, why: "nests more script text than the rules read through: put it in a file" }); st.left = -1; return; }
      st.left -= text.length;
    }
    const doc = document ? splitDocument(text) : undefined;
    const inner = doc ? doc.parts : splitCommand(text);
    if (doc?.unread) unread?.push({ at: i, why: "feeds a shell a here-document it could not parse", unparsed: true });
    if (!inner?.length || inner.length > PARTS_MAX) return;
    const l = laid(inner, pre.dirs[i] ?? null, home, pre.firm[i] === true);
    out.push({ parts: inner, pre: l, at: i });
    const deeper: Unread[] = [];
    for (const d of innerLines(inner, l, home, depth + 1, deeper, st, from)) out.push({ ...d, at: i });
    for (const u of deeper) unread?.push({ ...u, at: i });
  };
  // (A script is read as it stands and, as a plain line is, with the variables it gave a written-out value written
  // out: `f=~/.npmrc; cat $f`. `whole`: a here-document of the line itself, read whatever its length.)
  const add = (text: string | undefined, i: number, whole = false, document = false) => {
    if (text === undefined || !/\S/.test(text) || (text.length > SCRIPT_MAX && !whole)) return;
    const key = `${written ? "w" : ""}${keyOf(text, i, document)}`;
    if (st.left < 0 || st.seen.has(key)) return;
    if (written) st.seen.add(key);
    const out = text.length > NESTED_MAX ? null : resolvedLine(text, home);
    const use = out !== null && out !== text && (out.length <= SCRIPT_MAX || whole) ? out : null;
    if (!written || use === null) read(text, i, whole, written, document);
    if (use !== null) read(use, i, whole, true, document);
  };
  // Whether the command of a part reads a script from its input: a shell with no script of its own, or one whose
  // -c script starts such a shell (its input is the outer shell's).
  const takes = (words: string[], deep = 0): boolean => {
    if (!SHELLS.test(name(words[0]))) return false;
    const given = shellGiven(words.slice(1));
    if (given.input) return true;
    if (deep >= 2) return false;
    return scriptsOf(given).some(({ script }) => {
      const inner = script.length > SCRIPT_MAX ? null : splitCommand(script);
      return !!inner && inner.length <= 64 && inner.some((q) => !q.heredoc && takes(unwrap(q.words).words, deep + 1));
    });
  };
  let since = 0, handled = -1;
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i]!;
    if (s.heredoc) {
      if (i <= handled) continue;
      // The here-documents of one line: their lines, up to the next command of the line's own (the substitutions
      // of an unquoted one stand between them). Each is the input of the command that opened it (docOf): a script
      // when that command reads one from its input, or is a cat piped into one that does. Otherwise, and where
      // the commands that open one and the documents do not pair off (two on one command), it goes to the first
      // command since the documents before that reads a script from its input: one read too many, never too few.
      let end = i;
      while (end < parts.length && (parts[end]!.heredoc || parts[end]!.nested)) end++;
      // (A document's own lines are parts too, and a here-document among them carries its text as well: that one
      // is a script of the document's, found when the document is read, not one of this line's. The parts a
      // document's lines make are as many as its text splits into.)
      const docs: string[] = [];
      const several = parts.slice(i, end).filter((q) => q.heredoc && q.doc !== undefined).length > 1;
      for (let k = i; k < end; k++) {
        const doc = parts[k]!.heredoc ? parts[k]!.doc : undefined;
        if (doc === undefined) continue;
        docs.push(doc);
        if (several) k += (parts[k]!.docSpan ?? Math.max(1, splitCommand(doc)?.length ?? 1)) - 1;
      }
      const owners: number[] = [];
      for (let k = since; k < i; k++) if (!parts[k]!.nested && docOf(parts[k]!) !== "none") owners.push(k);
      const feeds = (k: number): number => {
        const w = pre.runs[k]!.words;
        if (takes(w)) return k;
        const next = parts[k]!.sep === "|" || parts[k]!.sep === "|&" ? k + 1 : -1;
        return name(w[0]) === "cat" && !w.slice(1).some((a) => !a.startsWith("-")) && next > 0 && next < i && takes(pre.runs[next]!.words) ? next : -1;
      };
      const paired = owners.length === docs.length;
      let first = -1;
      for (let k = since; k < i && first < 0; k++) if (takes(pre.runs[k]!.words)) first = k;
      docs.forEach((text, n) => {
        // (An owner that is no reader of scripts may hand its input on, a group `(bash) <<EOF` or a longer pipe:
        // then too the first command that reads one. Not from a program that runs it somewhere else.)
        const own = paired ? feeds(owners[n]!) : -1;
        const feeder = own >= 0 || (paired && AWAY.test(name(pre.runs[owners[n]!]!.words[0]))) ? own : first;
        if (feeder < 0) return;
        // (An unquoted delimiter: the line's shell takes the backslash off \$, \` and \\ before the text is handed on.)
        const doc = paired && docOf(parts[owners[n]!]!) === "unquoted" ? text.replace(/\\([$`\\])/g, "$1") : text;
        if (depth > 0 && doc.length > SCRIPT_MAX) unread?.push({ at: feeder, why: `feeds ${name(pre.runs[feeder]!.words[0])} a here-document of ${doc.length} characters inside a script, longer than the rules read through: put it in a file` });
        else add(doc, feeder, depth === 0, true);
      });
      handled = end - 1;
      since = end;
      continue;
    }
    const run = pre.runs[i]!;
    if (run.deep) continue;
    const p = name(run.words[0]);
    if (p === "eval") { add(evalGiven(run.words.slice(1)), i); continue; }
    // (A wrapper handed its command as one word: watch 'cmd', env -S 'cmd', flock LOCK -c 'cmd'.)
    const handed = run.wrapped ? lineHanded(s.words, run) : undefined;
    if (handed !== undefined) { add(handed, i); continue; }
    if (RUNS_TEXT[p]) { run.words.forEach((w, k) => { if (k > 0 && RUNS_TEXT[p]!.test(w)) add(run.words[k + 1], i); }); continue; }
    if (!SHELLS.test(p)) continue;
    const given = shellGiven(run.words.slice(1));
    if (given.script !== undefined) {
      // (Behind options the rules could not read, the words that may be the script instead.)
      for (const other of given.also ?? []) add(other.script, i);
      add(given.script, i);
      const placed = positional(given.script, given.rest, home);
      if (placed !== undefined) add(placed, i);
      continue;
    }
    // (What a substitution prints, handed to the shell as its script file or its input: `bash <(echo 'script')`.)
    add(substituted(parts, pre.runs, i, given), i);
    if (!given.input) continue;
    add(s.here, i);
    const before = i > 0 ? parts[i - 1]! : undefined;
    if (before && !before.heredoc && !before.dyn?.length && (before.sep === "|" || before.sep === "|&") && PRINTS.test(name(pre.runs[i - 1]!.words[0]))) add(printed(pre.runs[i - 1]!.words), i);
  }
  return out;
}

// The script of a line that is one shell started with -c and nothing more (`/bin/bash -lc 'script'`), as another
// harness sends what it runs; undefined for any other line. Such a script is the whole of what runs: it is judged
// as the plain line it is, whatever its length (the gate's harnessRisk).
export function onlyScript(command: string): string | undefined {
  const parts = splitCommand(command);
  const p = parts?.length === 1 ? parts[0]! : undefined;
  if (!p || p.redirects || p.dyn?.length || p.nested || p.heredoc || p.here !== undefined || p.inputs?.length) return undefined;
  const [sh, ...rest] = p.words;
  if (!sh || !SHELLS.test(name(sh))) return undefined;
  const given = shellGiven(rest);
  return given.script !== undefined && !given.also && given.at === rest.length - 1 ? given.script : undefined;
}
