// A line whose variables the line gave a written-out value (`W=/abs/dir; $W/run.sh x`, `G=rm; $G -rf d`, `V=push; git $V
// --force`): the line with those variables written out, which the gate judges beside the line itself. The shell runs the
// written form, so the verdict on it is the verdict the owner would get for the line typed out. Only a line that can be
// rewritten by text alone is rewritten; any other keeps being judged as it is, and a program word it cannot read stays
// refused (shared-branches.ts).
import { KNOWN_PATH } from "./shared-branches.ts";
import { laid } from "./risk.ts";
import { valuesOf, type SetEvent } from "./risk-words.ts";
import { splitCommand } from "./shell.ts";

// A variable in a word: `${NAME...` or `$NAME`, with the name whole; and the plain forms, `${NAME}` and `$NAME`.
const ANY = /\$(?:\{[#!]?([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g;
const PLAIN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const NAMED = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;

// The line with each variable the line sets to a written-out value written out, or null when there is none to write
// or the line is not one to rewrite. A use is written out when
// - the last place the line sets the name before it gives a written-out value (no `$`, glob, space, `~`, `=`; not empty;
//   a leading `~` or `$HOME` is the session's home, `~user` is not read) in the shell that runs the words that use it:
//   not in a pipeline's stage, a subshell, a substitution, the background or after `||` (`valuesOf` reads exactly that).
//   A name set twice is read by the last literal before each use; any other kind of setting between them (`+=`, a
//   substitution, an `export`) leaves it unread. In a line with a substitution or a here-document a name is set once.
// - every use of the name is in a word of its own (not single-quoted, escaped, in a here-document, `${W:-x}`) and is the
//   whole of what the text shows.
// A line that sets HOME to such a value has the `~` and `$HOME` after it written out as that value, as bash expands them.
// A use that is not so is left as it is, unless it is in a program word: then the line is not rewritten, and the
// program word it cannot read stays refused. Nothing is rewritten in a line with a loop, a conditional or a group (a name
// may be rebound where the parts do not show it), `IFS` (a value would split into words), an alias or a function (a name
// may mean another program), or a positional parameter (`set -- branch -D x; $W "$@"`).
// `home`: the folder a leading `~`, `~/` or `$HOME/` in a value stands for, as bash writes it out; without it they stay unread.
export function resolvedLine(command: string, home?: string): string | null {
  if (!/[$~]/.test(command) || /\bIFS\b|\balias\b|\bfunction\b|\(\s*\)|\$[@*0-9]|\$\{[@*0-9]/.test(command)) return null;
  const parts = splitCommand(command);
  if (!parts || parts.some((p) => p.flow || p.unknown)) return null;
  const { runs } = laid(parts, null, "");
  const hist = new Map<string, SetEvent[]>();
  valuesOf(parts, runs, home, hist);
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
  // Where each part stands in the text, when the parts follow one another there (no substitution, no here-document).
  const spans: { from: number; to: number }[] | null = parts.some((p) => p.nested || p.heredoc) ? null : spansOf(command, parts);
  const given = (e: SetEvent): string | null => {
    if (e.text === null || !e.text || /[=~]/.test(e.text)) return null;
    const before = outer[e.at]!;
    return before >= 0 && (parts[before]!.sep === "|" || parts[before]!.sep === "|&") ? null : e.text;
  };
  // The value a name has at part `j`: the last place before it that sets it, when that gives a written-out value.
  const at = (n: string, j: number): string | null => {
    const evs = (hist.get(n) ?? []).filter((e) => e.at < j);
    return evs.length ? given(evs[evs.length - 1]!) : null;
  };
  // A name set once is the same for all its uses, and each of them must come after it. Where the text of the parts is
  // known, a name is read use by use.
  const writable = (n: string, j: number): string | null => {
    const s = shown.get(n), evs = hist.get(n);
    if (!evs || !s || s.n !== text.get(n) || s.n !== plain.get(n)) return null;
    if (spans) return at(n, j);
    return evs.length === 1 && s.first > evs[0]!.at ? given(evs[0]!) : null;
  };
  // A program word that holds a variable the line cannot write out is not rewritten at all.
  const partAt = (pos: number): number => { for (let j = 0; j < spans!.length; j++) if (pos >= spans![j]!.from && pos < spans![j]!.to) return j; return -1; };
  const edits: { from: number; to: number; with: string }[] = [];
  const done = new Set<number>();
  for (let i = 0; i < parts.length; i++) {
    const w = runs[i]!.words[0];
    if (parts[i]!.heredoc || w === undefined || !/[$`]/.test(w) || KNOWN_PATH.test(w)) continue;
    if (/[$`]/.test(w.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, ""))) return null;
    for (const m of w.matchAll(NAMED)) if (writable(m[1]!, i) === null) return null;
  }
  for (const m of command.matchAll(PLAIN)) {
    const n = m[1] ?? m[2]!;
    const j = spans ? partAt(m.index!) : shown.get(n)?.first ?? 0;
    const v = spans && j < 0 ? null : writable(n, j);
    if (v !== null) { edits.push({ from: m.index!, to: m.index! + m[0].length, with: v }); done.add(m.index!); }
  }
  // `~` where HOME was set to a written-out value earlier on the line.
  if (spans && hist.has("HOME") && !/\$['"]/.test(command)) {
    for (let j = 0; j < spans.length; j++) {
      const h = at("HOME", j);
      if (h === null) continue;
      for (const t of tildesIn(command.slice(spans[j]!.from, spans[j]!.to))) edits.push({ from: spans[j]!.from + t, to: spans[j]!.from + t + 1, with: h });
    }
  }
  if (!edits.length) return null;
  edits.sort((a, b) => a.from - b.from);
  let out = "", pos = 0;
  for (const e of edits) { out += command.slice(pos, e.from) + e.with; pos = e.to; }
  return out + command.slice(pos);
}

// The place of each part in the text: the parts stand in it in order, each as it is written. Null when one is not found.
function spansOf(command: string, parts: { text: string }[]): { from: number; to: number }[] | null {
  const out: { from: number; to: number }[] = [];
  let at = 0;
  for (const p of parts) {
    const from = p.text ? command.indexOf(p.text, at) : -1;
    if (from < 0) return null;
    out.push({ from, to: from + p.text.length });
    at = from + p.text.length;
  }
  return out;
}

// The places of the `~` in a part's text that bash expands: unquoted, unescaped, at the start of a word (or of the value
// in `NAME=~/x`), and whole: `~` alone or before a `/`. (`~user`, `~+` and `~-` are not read.)
function tildesIn(text: string): number[] {
  const out: number[] = [];
  let q: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = null; continue; }
    if (c === "\\") { i++; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c !== "~" || !/^(\/|$|[\s;&|)<>])/.test(text.slice(i + 1, i + 2))) continue;
    const word = text.slice(0, i).match(/(?:^|[\s;&|(<>])([A-Za-z_][A-Za-z0-9_]*=)?$/);
    if (word) out.push(i);
  }
  return out;
}
