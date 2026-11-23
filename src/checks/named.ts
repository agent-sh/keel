// The checks a repository names, and which command runs one of them. Pure.
//
// A repository names its checks in `.keel/checks.json`, read from the work
// tree being checked (so a branch that changes a check is checked by its own
// definition). The owner's Keel setting for the repository (`checks.repos`,
// by the repository's main checkout) is laid over it: a check of the same
// name replaces the file's (null removes it), and its `wait` and `env` lists
// add to the file's. A repository with neither has no checks: nothing is
// recorded or answered there.
//
//   {
//     "checks": {
//       "typecheck": "bunx tsc --noEmit -p .",
//       "unit": { "run": "bun test", "args": true },
//       "e2e": { "run": "bunx playwright test", "args": true, "cache": false },
//       "web": { "run": "npm test", "dir": "web" },
//       "remote": { "run": "scripts/remote-verify.sh", "args": true, "tree": { "commit": "last" }, "drop": ["--wait", "--out"] },
//       "specs": { "run": "~/bin/validate.sh", "args": true, "dir": "*", "tree": { "folder": 1 } }
//     },
//     "wait": ["waitfor --capacity"],
//     "env": ["VERIFY_MAX_RUNS"]
//   }
//
// A check is a name and the command that runs it: a string, or an object with
//   run    the command (`~` and `$HOME` are the home folder);
//   args   more words after it are allowed; each set of words is a check run of its own;
//   dir    the folder it runs in, from the repository's top ("." by default; "*": any);
//   cache  false: every run is recorded, none is answered from an earlier one
//          (a check that reads more than the files: a server, the network);
//   tree   what it checks: the work tree of the folder it runs in (the default),
//          `{ "folder": N }` the work tree of the folder its Nth argument names,
//          or `{ "commit": "last" }` the commit its last argument names (a
//          commit id or HEAD~n; else HEAD). That argument is not part of what
//          the run is known by: the tree is;
//   drop   options of it that take a value and do not change what it finds
//          (`--out DIR`): left out of what the run is known by.
// `wait`: commands that only wait for room before what follows them runs
// (each named by its first words). `env`: variables whose setting on the
// check's command does not change what it finds.
//
// A command runs a check when the check is one of its simple commands: its
// words, after assignments of its own (`S=x check`) and the wrappers that only
// start it (`timeout N`, `nice`, `ionice`), are the check's command and, when it
// takes them, more words. Its output may go to files (`> log 2>&1`) and through
// filters in its pipe (`tail`, `head`, `grep`, `tee`, `sed` without -i, `cut`,
// `wc`, `sort`, `uniq`, `cat`, `tr`); the shell reports the check's own status
// (the pipe's first) whatever follows it. A here-document's body is input, not
// commands, and `cd`s are followed, also into another repository's work tree.
//
// The tree it ran on must be known, so the other parts are read for whether
// they change a file a check reads:
//   still:  `cd`, assignments and `export`, `set`, `mkdir -p`, `true`, waits
//           (any `waitfor`, `sleep`), other checks, and commands that only read
//           (`ls`, `cat`, `grep`, `git log`/`status`/`diff`, `sed -n`, ...) with
//           their output sent outside the repository;
//   moves:  anything else (an edit, `git rebase`, `ln -s`, a script).
// The tree is taken before the command runs when everything before the check
// is still; else when the command ended, when everything from the check to the
// end is still, the reading reached the end, and nothing before it ran in the
// background (`&`); else the run is not counted. The reading stops at what
// changes the shell in ways it does not follow (`source`, `eval`, `read`,
// `declare`, control flow such as `if` and `for`) and at a quote or a
// substitution left open.
//
// Never counted, since what ran is not known: a check whose own words, or a
// variable it is given, hold a `$` the command does not set (`$1`, `$?`,
// `${X:-y}`, a variable from outside), a command or process substitution, or
// an exported value of that kind; a check whose input is a pipe, a file or a
// here-document; one whose output goes into a command that is not a filter;
// one run in the background. `$PWD`, `$HOME` and `~` are put in.
//
// An answer from the ledger stands for the whole command, so only a command of
// the narrow form is answered: before the check only `cd`, assignments,
// `mkdir -p`, `set`, `true` and the waits the repository names; after it only
// commands that read (`tail`, `head`, `cat`, `grep`, `wc`, `ls`, `echo`,
// `printf`), joined by `&&` and `;` in `( )` or `{ }` groups, all of it read,
// with no `&` and no `||`; and a check whose words hold a pattern (`*`, `?`,
// `[`) is recorded but never answered.

import { normalize } from "node:path";

export const FILE = ".keel/checks.json";
export const NAMES_MAX = 64;
const NAME = /^[A-Za-z0-9][\w.:-]{0,39}$/;
const RUN_MAX = 400;

export type TreeSpec = { kind: "work" } | { kind: "folder"; arg: number } | { kind: "commit" };
export type Check = { name: string; run: string; args: boolean; dir: string; cache: boolean; tree: TreeSpec; drop: string[]; inputs: string[] };
export type Named = { checks: Check[]; wait: string[]; env: string[]; problems: string[] };

const squash = (s: string) => s.trim().replace(/\s+/g, " ");
// A folder from the top, as one form: "." or "a/b" ("*": any folder).
export function normDir(d: string): string {
  if (d === "*") return "*";
  const parts: string[] = [];
  for (const p of d.split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") { if (!parts.length) return ".."; parts.pop(); continue; }
    parts.push(p);
  }
  return parts.join("/") || ".";
}

const strings = (v: unknown, max: number) => Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim() && x.length <= max) ? (v as string[]).map(squash) : undefined;

function oneCheck(name: string, v: unknown, problems: string[]): Check | undefined {
  if (!NAME.test(name)) { problems.push(`"${name.slice(0, 40)}" is not a check name (letters, digits, . _ : -, up to 40)`); return; }
  const o = typeof v === "string" ? { run: v } : v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  const run = typeof o?.run === "string" ? squash(o.run) : "";
  if (!run || run.length > RUN_MAX) { problems.push(`${name}: "run" is a command of 1 to ${RUN_MAX} characters`); return; }
  if (o!.args !== undefined && typeof o!.args !== "boolean") { problems.push(`${name}: "args" is true or false`); return; }
  if (o!.cache !== undefined && typeof o!.cache !== "boolean") { problems.push(`${name}: "cache" is true or false`); return; }
  if (o!.dir !== undefined && typeof o!.dir !== "string") { problems.push(`${name}: "dir" is a folder from the repository's top, or "*"`); return; }
  const dir = normDir(String(o!.dir ?? "."));
  if (dir === ".." || String(o!.dir ?? "").startsWith("/")) { problems.push(`${name}: "dir" is a folder inside the repository`); return; }
  let tree: TreeSpec = { kind: "work" };
  const t = o!.tree as any;
  if (t !== undefined) {
    if (t && typeof t === "object" && Number.isInteger(t.folder) && t.folder >= 1 && t.folder <= 20 && Object.keys(t).length === 1) tree = { kind: "folder", arg: t.folder };
    else if (t && typeof t === "object" && t.commit === "last" && Object.keys(t).length === 1) tree = { kind: "commit" };
    else { problems.push(`${name}: "tree" is { "folder": N } or { "commit": "last" }`); return; }
    if (!o!.args) { problems.push(`${name}: a "tree" from an argument needs "args": true`); return; }
  }
  const drop = o!.drop === undefined ? [] : strings(o!.drop, 40);
  if (!drop || drop.some((d) => !/^--?[\w-]+$/.test(d))) { problems.push(`${name}: "drop" is a list of options (--out)`); return; }
  const inputs = o!.inputs === undefined ? [] : strings(o!.inputs, 200);
  if (!inputs || inputs.length > 16 || inputs.some((x) => x.startsWith("/") || x.includes("\0"))) { problems.push(`${name}: "inputs" is a list of up to 16 paths from the repository's top`); return; }
  return { name, run, args: o!.args === true, dir, cache: o!.cache !== false, tree, drop, inputs };
}

// The checks of a parsed file or setting, with what was wrong in it.
// `removed`: the names a setting sets to null (it takes them out of the file's).
export function readChecks(value: unknown): Named & { removed: string[] } {
  const problems: string[] = [];
  const checks: Check[] = [];
  const removed: string[] = [];
  const o = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  const list = o?.checks;
  if (!list || typeof list !== "object" || Array.isArray(list)) return { checks, wait: [], env: [], removed, problems: ["it has no \"checks\" object"] };
  for (const [name, v] of Object.entries(list)) {
    if (checks.length >= NAMES_MAX) { problems.push(`more than ${NAMES_MAX} checks: the rest are left out`); break; }
    if (v === null) { removed.push(name); continue; }
    const c = oneCheck(name, v, problems);
    if (c) checks.push(c);
  }
  const wait = o!.wait === undefined ? [] : strings(o!.wait, 120);
  if (!wait) problems.push('"wait" is a list of commands, each by its first words');
  const env = o!.env === undefined ? [] : strings(o!.env, 64);
  if (!env || env.some((e) => !/^[A-Za-z_]\w*$/.test(e))) problems.push('"env" is a list of variable names');
  return { checks, wait: wait ?? [], env: env?.filter((e) => /^[A-Za-z_]\w*$/.test(e)) ?? [], removed, problems };
}

export function parseChecks(text: string): Named {
  let v: unknown;
  try { v = JSON.parse(text); } catch (e) { return { checks: [], wait: [], env: [], problems: [`it is not JSON: ${(e as Error).message.slice(0, 120)}`] }; }
  const { removed: _, ...rest } = readChecks(v);
  return rest;
}

// The owner's setting laid over the repository's file.
export function overlay(file: Named | undefined, setting: ReturnType<typeof readChecks> | undefined): Named | undefined {
  if (!setting) return file;
  const base = file ?? { checks: [], wait: [], env: [], problems: [] };
  const over = new Map(setting.checks.map((c) => [c.name, c]));
  const checks = [...base.checks.filter((c) => !over.has(c.name) && !setting.removed.includes(c.name)), ...setting.checks];
  return { checks, wait: [...new Set([...base.wait, ...setting.wait])], env: [...new Set([...base.env, ...setting.env])], problems: [...base.problems, ...setting.problems] };
}

// ---- reading a command

// `subst`: it holds a command or process substitution (what it becomes is not known here).
type Word = { raw: string; text: string; quoted: boolean; subst?: true };
// `{ op: "?" }`: the line is not read past this point (a quote or a substitution left open, a
// here-document with no end).
type Tok = { op: string } | { word: Word } | { redir: string; target?: Word };
export function tokens(line: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = line.length;
  const isSpace = (c: string) => c === " " || c === "\t";
  const cut = () => { out.push({ op: "?" }); return out; };
  // Here-documents whose bodies start after this line: their end words, and whether tabs are taken off.
  let docs: { end: string; tabs: boolean }[] = [];
  while (i < n) {
    const c = line[i]!;
    if (isSpace(c)) { i++; continue; }
    if (c === "\n") {
      i++;
      // A here-document's body is its command's input, not commands: it ends at a line that is its end word.
      for (const d of docs) {
        for (;;) {
          if (i >= n) return cut();
          const e = line.indexOf("\n", i);
          const l = line.slice(i, e < 0 ? n : e);
          i = e < 0 ? n : e + 1;
          if ((d.tabs ? l.replace(/^\t+/, "") : l) === d.end) break;
        }
      }
      docs = [];
      out.push({ op: ";" });
      continue;
    }
    if (c === "#") {
      // (A comment runs to the end of its line.)
      const e = line.indexOf("\n", i);
      if (e < 0) break;
      i = e;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === "|&") { out.push({ op: "|" }); i += 2; continue; }
    if (two === "&&" || two === "||") { out.push({ op: two }); i += 2; continue; }
    if (c === ";" || c === "|" || c === "(" || c === ")") { out.push({ op: c }); i++; continue; }
    if (line.startsWith("<<<", i)) { i += 3; const t = word(); if (!t) return cut(); out.push({ redir: "<<<", target: t }); continue; }
    if (two === "<<") {
      const tabs = line[i + 2] === "-";
      i += tabs ? 3 : 2;
      const t = word();
      if (!t || t.subst) return cut();
      docs.push({ end: t.text, tabs });
      out.push({ redir: "<<", target: t });
      continue;
    }
    if (two === "<&" || two === "<>") return cut();
    if (c === "<" && line[i + 1] !== "(") {
      i++;
      const t = word();
      if (!t) return cut();
      out.push({ redir: t.text === "/dev/null" ? "</dev/null" : "<", target: t });
      continue;
    }
    if (c === "&" && line[i + 1] === ">") {
      const op = line[i + 2] === ">" ? "&>>" : "&>";
      i += op.length;
      const t = word();
      if (!t) return cut();
      out.push({ redir: op, target: t });
      continue;
    }
    if (c === "&") { out.push({ op: "&" }); i++; continue; }
    if (c === ">" && line[i + 1] !== "(") {
      const op = line[i + 1] === ">" ? ">>" : ">";
      i += op.length;
      if (line[i] === "&") { const m = /^&(\d+|-)/.exec(line.slice(i)); if (!m) return cut(); i += m[0].length; out.push({ redir: `${op}${m[0]}` }); continue; }
      if (line[i] === "|") i++;
      const t = word();
      if (!t) return cut();
      out.push({ redir: op, target: t });
      continue;
    }
    const w = word();
    if (!w) return cut();
    // `2>`: a number right before a redirection is its descriptor.
    if (/^\d+$/.test(w.raw) && (line[i] === ">")) {
      const op = line[i + 1] === ">" ? ">>" : ">";
      i += op.length;
      if (line[i] === "&") { const m = /^&(\d+|-)/.exec(line.slice(i)); if (!m) return cut(); i += m[0].length; out.push({ redir: `${w.raw}${op}${m[0]}` }); continue; }
      const t = word();
      if (!t) return cut();
      out.push({ redir: `${w.raw}${op}`, target: t });
      continue;
    }
    out.push({ word: w });
  }
  return docs.length ? cut() : out;
  // The end of a substitution whose `(` is at `j`, past its `)`; -1 when it does not end.
  function closeParen(j: number): number {
    let depth = 0;
    while (j < n) {
      const c = line[j]!;
      if (c === "\\") { j += 2; continue; }
      if (c === "'") { const e = line.indexOf("'", j + 1); if (e < 0) return -1; j = e + 1; continue; }
      if (c === '"') { j++; while (j < n && line[j] !== '"') j += line[j] === "\\" ? 2 : 1; if (j >= n) return -1; j++; continue; }
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return j + 1;
      j++;
    }
    return -1;
  }
  function backtick(j: number): number {
    for (j++; j < n; j++) { if (line[j] === "\\") { j++; continue; } if (line[j] === "`") return j + 1; }
    return -1;
  }
  // One word from `i`: quotes taken off in `text`, kept in `raw`.
  function word(): Word | undefined {
    while (i < n && isSpace(line[i]!)) i++;
    const start = i;
    let text = "", quoted = false, subst = false;
    while (i < n) {
      const c = line[i]!;
      if ((c === "<" || c === ">") && line[i + 1] === "(" && i === start) {
        const e = closeParen(i + 1);
        if (e < 0) return undefined;
        text += line.slice(i, e); i = e; subst = true; continue;
      }
      if (isSpace(c) || c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")" || c === "<" || c === ">") break;
      if (c === "`") { const e = backtick(i); if (e < 0) return undefined; text += line.slice(i, e); i = e; subst = true; continue; }
      if (c === "$" && line[i + 1] === "(") { const e = closeParen(i + 1); if (e < 0) return undefined; text += line.slice(i, e); i = e; subst = true; continue; }
      if (c === "\\") { if (i + 1 >= n) return undefined; text += line[i + 1]; i += 2; quoted = true; continue; }
      if (c === "'") { const e = line.indexOf("'", i + 1); if (e < 0) return undefined; text += line.slice(i + 1, e); i = e + 1; quoted = true; continue; }
      if (c === '"') {
        let j = i + 1, t = "";
        while (j < n && line[j] !== '"') {
          if (line[j] === "\\" && j + 1 < n) { t += line[j + 1]; j += 2; continue; }
          if (line[j] === "`") { const e = backtick(j); if (e < 0) return undefined; t += line.slice(j, e); j = e; subst = true; continue; }
          if (line[j] === "$" && line[j + 1] === "(") { const e = closeParen(j + 1); if (e < 0) return undefined; t += line.slice(j, e); j = e; subst = true; continue; }
          t += line[j]; j++;
        }
        if (j >= n) return undefined;
        text += t; i = j + 1; quoted = true; continue;
      }
      text += c; i++;
    }
    return i > start ? { raw: line.slice(start, i), text, quoted, ...(subst ? { subst: true as const } : {}) } : undefined;
  }
}

// `depth`: how many `( )` groups it is in (a `cd` there does not outlast the group).
// `cut`: the line was not read past this command's start, so what it is is not known.
type Simple = { words: Word[]; redirs: { redir: string; target?: Word }[]; sep: string; depth: number; cut?: true };
// The simple commands of a line, each with the operator that follows it; the
// group marks `(` `)` `{` `}` are left out (where their output goes is not what runs).
function simples(toks: Tok[]): Simple[] {
  const out: Simple[] = [];
  let depth = 0;
  let cur: Simple = { words: [], redirs: [], sep: "", depth };
  const close = (sep: string) => { if (cur.words.length || cur.redirs.length) { cur.sep = sep; out.push(cur); } else if (out.length && sep) out.at(-1)!.sep = out.at(-1)!.sep === "|" ? "|" : sep; cur = { words: [], redirs: [], sep: "", depth }; };
  for (const t of toks) {
    if ("op" in t) {
      if (t.op === "?") { cur.cut = true; out.push(cur); return out.filter((s) => s.words.length || s.cut); }
      if (t.op === "(") { close(""); depth++; cur.depth = depth; continue; }
      if (t.op === ")") { close(""); depth = Math.max(0, depth - 1); cur.depth = depth; continue; }
      close(t.op);
      continue;
    }
    if ("redir" in t) { cur.redirs.push(t); continue; }
    if (!t.word.quoted && (t.word.raw === "{" || t.word.raw === "}")) { if (t.word.raw === "}") close(""); continue; }
    cur.words.push(t.word);
  }
  close("");
  // A group's output redirection stands alone: it goes.
  return out.filter((s) => s.words.length);
}

const ASSIGN = /^[A-Za-z_]\w*=/;
// After a check an answer stands for: commands that read what it left.
const READERS = new Set(["tail", "head", "cat", "grep", "wc", "ls", "echo", "printf", "true", ":", "date"]);
// What its output may go through in its pipe: commands that read their input and write nothing of the
// tree (its status is still the pipe's first). `sed` only without `-i`.
const FILTERS = new Set(["tail", "head", "grep", "egrep", "fgrep", "tee", "cut", "wc", "sort", "uniq", "cat", "tr", "sed"]);
// Commands that read and change no file (their output sent outside the repository), and waits of any
// kind. A check after them is recorded, never answered (an answer would not show what they print).
const LOOKS = new Set(["tail", "head", "cat", "grep", "egrep", "fgrep", "rg", "wc", "ls", "echo", "printf", "true", ":", "date", "pwd", "test", "[", "which", "type", "stat", "file", "du", "df", "uptime", "nproc", "free", "sleep", "waitfor", "jq", "diff", "cmp", "sha256sum", "md5sum", "basename", "dirname", "realpath", "readlink", "cut", "sort", "uniq", "tr", "column", "nl"]);
const GIT_LOOKS = new Set(["log", "status", "show", "diff", "rev-parse", "describe", "ls-files", "blame", "cat-file", "branch", "rev-list", "merge-base", "shortlog", "grep"]);
// What the reading stops at: commands that change the shell itself in ways not followed here (its
// folder, its variables), and the shell's own words for control flow (a loop runs its body again).
const STOPS = new Set(["source", ".", "eval", "exec", "pushd", "popd", "read", "mapfile", "readarray", "declare", "typeset", "local", "readonly", "alias", "unset", "shopt", "trap", "if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "!", "[[", "((", "coproc", "time"]);
// `sed -n` and the like: `-i` writes the file it reads.
const inPlace = (words: string[]) => words.slice(1).some((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith("--in-place"));
function looks(words: string[]): boolean {
  const head = words[0] ?? "";
  if (head === "sed") return !inPlace(words);
  if (head === "find") return !words.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(w));
  if (head === "git") {
    let k = 1;
    while (k < words.length && words[k]!.startsWith("-")) k += words[k] === "-C" || words[k] === "-c" ? 2 : 1;
    const sub = words[k];
    if (!sub || !GIT_LOOKS.has(sub)) return false;
    // (`git branch NAME` makes one, `git diff --output=F` writes one: only their reading forms.)
    if (sub === "branch" && words.slice(k + 1).some((w) => !w.startsWith("-") || /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description)/.test(w))) return false;
    return !words.some((w) => w.startsWith("--output"));
  }
  return LOOKS.has(head);
}

// Wrappers that start the check and do not change what it finds: `timeout`, `nice`, `ionice`.
// The words one takes from `k`, or undefined when none starts there. `timeout`'s own statuses say
// the check was stopped (src/checks/runs.ts).
function wrapper(words: string[], k: number): { take: number; timeout: boolean } | undefined {
  const w = words[k];
  let j = k + 1;
  if (w === "timeout") {
    while (j < words.length && words[j]!.startsWith("-")) {
      const o = words[j]!;
      if (o === "-s" || o === "-k" || o === "--signal" || o === "--kill-after") j += 2;
      else if (/^(--signal=|--kill-after=|--foreground$|--preserve-status$|-v$|--verbose$|-s\w|-k\d)/.test(o)) j++;
      else return undefined;
    }
    if (!/^\d+(\.\d+)?[smhd]?$/.test(words[j] ?? "")) return undefined;
    return { take: j + 1 - k, timeout: true };
  }
  if (w === "nice") {
    if (words[j] === "-n") j += 2;
    else if (/^(-n-?\d+|-\d+|--adjustment=-?\d+)$/.test(words[j] ?? "")) j++;
    return { take: j - k, timeout: false };
  }
  if (w === "ionice") {
    while (/^-[cnpPu]$/.test(words[j] ?? "") || /^-[cn]\d+$|^-t$/.test(words[j] ?? "")) j += /^-[cnpPu]$/.test(words[j]!) ? 2 : 1;
    return { take: j - k, timeout: false };
  }
  return undefined;
}

export type Where = {
  cwd: string;                                  // the folder the command starts in (absolute)
  home: string;
  rel: (abs: string) => string | undefined;     // a folder from the repository's top, or undefined outside it
};
export type Match = {
  check: Check;
  command: string;   // what the check run is known by: the check's command and the words added to it
  dir: string;       // the folder it ran in, from the top (absolute when it is outside the repository)
  exact: boolean;    // its words hold no pattern (`*`, `?`, `[`) the shell expands: an earlier pass of it can answer it
  answers: boolean;  // the command stands for the check as a whole (see the head of this file): an answer may replace it
  // When the tree it ran on is taken: before the command runs (nothing before the check changes a file),
  // or when it ended (something before it may have, and nothing from the check on does).
  treeAt: "start" | "end";
  // A check of a commit: `rev` is its last argument when that may name one (it does not follow an
  // option), which the caller resolves; `named` is what the run is known by when it names none.
  tree: { kind: "work"; folder: string } | { kind: "folder"; folder: string } | { kind: "commit"; rev?: string; named?: string };
  shellCwd: string;  // where the command leaves the shell: its `cd`s outside a `( )` group, the check's own folder for an answer
  start: string;     // the check's simple command as the shell reports it (startText)
  filters: number;   // commands its output goes through after it in its pipe (its status is the pipe's first)
  alone: boolean;    // nothing runs before or after it: the command's own status is the check's (with no filter)
  timeout?: true;    // started by `timeout`: its statuses for a time limit say the check was stopped
  nth?: number;      // how many simple commands before it read as the same words (the shell reports each)
};

// The words of a simple command as the shell reports it running ($BASH_COMMAND):
// its assignments and redirections left out, one space between words.
export function startText(command: string): string | undefined {
  const s = simples(tokens(command))[0];
  if (!s || s.cut) return undefined;
  return s.words.slice(countAssign(s)).map((w) => w.raw).join(" ");
}
const rawStart = (s: Simple) => s.words.slice(countAssign(s)).map((w) => w.raw).join(" ");
const nthOf = (cmds: Simple[], i: number) => cmds.slice(0, i).filter((c) => rawStart(c) === rawStart(cmds[i]!)).length;
const countAssign = (s: Simple) => { let k = 0; while (k < s.words.length && ASSIGN.test(s.words[k]!.raw)) k++; return k; };

// The first check `command` runs, or nothing.
export function matchCommand(command: string, named: Pick<Named, "checks" | "wait" | "env">, where: Where): Match | undefined {
  return matchAll(command, named, where)[0];
}

// Every check `command` runs, in order (see the head of this file).
export function matchAll(command: string, named: Pick<Named, "checks" | "wait" | "env">, where: Where): Match[] {
  if (!named.checks.length) return [];
  const toks = tokens(command);
  // An answer stands for the whole command: nothing in the background, no fallback, all of it read.
  const plain = !toks.some((t) => "op" in t && (t.op === "||" || t.op === "&" || t.op === "?"));
  const cmds = simples(toks);
  const vars = new Map<string, string | undefined>([["HOME", where.home], ["PWD", where.cwd]]);
  // What the command exports for what it runs: part of what the check run is known by (unless the repository
  // says the variable does not change a result). Undefined value: not known here.
  const exported = new Map<string, string | undefined>();
  let allExport = false;
  let cwd = where.cwd;
  // The folder at each group depth: a `cd` inside `( )` does not outlast it.
  const at: string[] = [where.cwd];
  let depth = 0;
  // `$NAME` and `${NAME}` put in where they are known; `~` at a word's start (and after an assignment's
  // `=`) is the home folder. `known`: nothing of the shell's is left in it that is not known here.
  const expand = (w: Word): { text: string; known: boolean } => {
    if (w.subst) return { text: w.text, known: false };
    if (/^'[^']*'$/.test(w.raw)) return { text: w.text, known: true };
    let s = w.raw.startsWith("~/") || w.raw === "~" ? where.home + w.text.slice(1) : w.text;
    if (ASSIGN.test(w.raw)) s = s.replace(/^([A-Za-z_]\w*=)~(?=\/|$)/, `$1${where.home}`);
    let known = true;
    s = s.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a?: string, b?: string) => {
      const v = (a ?? b)!;
      const val = v === "PWD" ? cwd : vars.get(v);
      if (val === undefined) { known = false; return m; }
      return val;
    });
    // (`$?`, `$1`, `${X:-y}` and the like: the shell's, not known here. A `$` at a word's end is a `$`.)
    if (/\$(?:[A-Za-z_{(0-9?#@*!$-])/.test(s)) known = false;
    return { text: s, known };
  };
  // (As bash's cd reads it: `..` takes off the last part of the path as written.)
  const resolve = (p: string) => normalize(p.startsWith("/") ? p : `${cwd}/${p}`);
  const ofRepo = (file: string) => { const f = resolve(file); return where.rel(f.slice(0, f.lastIndexOf("/")) || "/") !== undefined; };
  const runWords = (c: Check) => c.run.split(" ").map((r) => (r === "~" || r.startsWith("~/") ? where.home + r.slice(1) : r.replace(/^\$HOME(?=\/|$)/, where.home)));
  const isWait = (words: string[]) => named.wait.some((p) => { const pw = p.split(" "); return pw.every((x, i) => words[i] === x); });
  const head0 = (s: Simple | undefined) => s?.words[0]?.text ?? "";
  // Output sent to a file of the repository, or to one not known here: a check may read it.
  const writesInside = (s: Simple) => s.redirs.some((r) => {
    if (!r.target || r.redir.startsWith("<")) return false;
    const t = expand(r.target);
    if (!t.known) return true;
    if (t.text === "/dev/null" || t.text === "/dev/stdout" || t.text === "/dev/stderr") return false;
    return ofRepo(t.text);
  }) || (head0(s) === "tee" && s.words.slice(1).some((w) => { const t = expand(w); return !t.text.startsWith("-") && (!t.known || ofRepo(t.text)); }));
  // What each part is: a check run (`match`), and whether it changes nothing a check reads (`still`).
  // `bgBefore`: a part before it ran in the background (it may still be at work). `quiet`: every part
  // before it is of the kinds an answer stands for (a cd, an assignment, a named wait).
  type Part = { i: number; end: number; still: boolean; match?: Omit<Match, "treeAt" | "answers">; post?: boolean; bgBefore: boolean; quiet: boolean };
  const parts: Part[] = [];
  let bg = false;
  let quiet = true;
  let i = 0;
  for (; i < cmds.length; i++) {
    const s = cmds[i]!;
    if (s.cut) break; // nothing is read past here
    // Back out of a group: the folder it was entered from.
    if (s.depth < depth) cwd = at[s.depth] ?? cwd;
    for (let d = depth + 1; d <= s.depth; d++) at[d] = cwd;
    depth = s.depth;
    const sepBefore = i ? cmds[i - 1]!.sep : "";
    const ex = s.words.map(expand);
    const words = ex.map((e) => e.text);
    const part = (still: boolean, end = i, extra: Partial<Part> = {}) => { parts.push({ i, end, still, bgBefore: bg, quiet, ...extra }); if (cmds[end]!.sep === "&") bg = true; };
    // Is it a check? Its own assignments, then the wrappers that only start it.
    let k = 0;
    const lead: string[] = [];
    let leadKnown = true;
    while (k < words.length && ASSIGN.test(s.words[k]!.raw)) {
      const name = s.words[k]!.raw.split("=")[0]!;
      if (!named.env.includes(name)) { lead.push(words[k]!); leadKnown &&= ex[k]!.known; }
      k++;
    }
    let timeout = false;
    for (let w = wrapper(words, k); w; w = wrapper(words, k)) { k += w.take; timeout ||= w.timeout; }
    const body = words.slice(k);
    const rel = where.rel(cwd);
    const check = named.checks.find((c) => {
      const rw = runWords(c);
      return rw.every((x, j) => body[j] === x) && (body.length === rw.length || c.args) && (c.dir === "*" || (rel !== undefined && rel === c.dir));
    });
    if (check) {
      // Its pipe: the filters its output goes through.
      let filters = 0, j = i, piped = true;
      while (cmds[j]!.sep === "|") {
        const f = cmds[j + 1];
        if (!f || f.cut || !FILTERS.has(head0(f)) || (head0(f) === "sed" && inPlace(f.words.map((x) => x.text)))) { piped = false; break; }
        filters++; j++;
      }
      const still = !cmds.slice(i, j + 1).some(writesInside);
      // Not a run of the check as named (it still only reads): its input from another command or a
      // file, its output read by a command that is not a filter, a word the ledger cannot know (a `$`
      // the command does not set, a substitution), or the check in the background.
      const counted = sepBefore !== "|" && !s.redirs.some((r) => r.redir === "<" || r.redir === "<<" || r.redir === "<<<")
        && leadKnown && ex.slice(k).every((e) => e.known) && ![...exported].some(([n, v]) => v === undefined && !named.env.includes(n))
        && piped && cmds[j]!.sep !== "&";
      // Its arguments: the dropped options out, the tree's argument taken.
      const rw = runWords(check);
      let args = body.slice(rw.length);
      for (let a = 0; a < args.length; a++) {
        const d = check.drop.find((o) => args[a] === o || args[a]!.startsWith(`${o}=`));
        if (d) { args.splice(a, args[a] === d ? 2 : 1); a--; }
      }
      let tree: Match["tree"] | undefined = { kind: "work", folder: cwd };
      if (check.tree.kind === "folder") {
        const f = args[check.tree.arg - 1];
        if (!f || f.startsWith("-")) tree = undefined;
        else { tree = { kind: "folder", folder: resolve(f) }; args.splice(check.tree.arg - 1, 1); }
      } else if (check.tree.kind === "commit") {
        const last = args.at(-1);
        const before = args.at(-2);
        // (The value of an option is not a commit: `--only unit`.)
        if (last && !last.startsWith("-") && !before?.startsWith("-")) { tree = { kind: "commit", rev: last }; args = args.slice(0, -1); }
        else tree = { kind: "commit" };
      }
      if (!counted || !tree) { part(still, piped ? j : i); quiet = false; i = piped ? j : i; continue; }
      // What an answer would stand for: commands that read after it, nothing else.
      let post = true;
      for (let r = j + 1; r < cmds.length; r++) {
        const c = cmds[r]!;
        if (c.cut || !(cmds[r - 1]!.sep === "|" ? FILTERS.has(head0(c)) || READERS.has(head0(c)) : READERS.has(head0(c)))) { post = false; break; }
      }
      const env = [...exported].filter(([n]) => !named.env.includes(n)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, v]) => `${n}=${v}`);
      const known = [...env, ...lead, ...rw, ...args].join(" ");
      if (tree.kind === "commit" && tree.rev) tree.named = [...env, ...lead, ...rw, ...args, tree.rev].join(" ");
      part(still, j, {
        post,
        match: {
          check, command: known, dir: rel ?? cwd, exact: !/[*?[]/.test(known), tree, start: s.words.slice(countAssign(s)).map((w) => w.raw).join(" "),
          // Where the shell is left: an answer stands for the command, and the `cd`s before the check
          // outside a group hold after it (nothing after a check an answer stands for moves: only readers follow it).
          filters, alone: i === 0 && j === cmds.length - 1, shellCwd: s.depth === 0 ? cwd : at[0]!, ...(timeout ? { timeout: true as const } : {}),
          ...(nthOf(cmds, i) ? { nth: nthOf(cmds, i) } : {}),
        },
      });
      // (A check reads the tree: one after it reads the same tree, and is not answered.)
      quiet = false;
      i = j;
      continue;
    }
    // Else a part that changes nothing a check reads, one that may, or one the reading cannot follow.
    if (sepBefore === "|") quiet = false;
    const head = words[0] ?? "";
    if (!head || STOPS.has(head)) break;
    if (head === "cd") {
      if (words.length !== 2 || !ex[1]!.known || s.sep === "|" || sepBefore === "|") break;
      cwd = resolve(words[1]!).replace(/(?<=.)\/$/, "");
      at[s.depth] = cwd;
      part(true);
      continue;
    }
    const exporting = head === "export";
    if (exporting && words.slice(1).some((w) => w.startsWith("-"))) break;
    if (words.every((_, x) => ASSIGN.test(s.words[x]!.raw)) || (exporting && words.slice(1).every((w, x) => ASSIGN.test(s.words[x + 1]!.raw) || /^[A-Za-z_]\w*$/.test(w)))) {
      for (const [x, w] of words.entries()) {
        if (exporting && x === 0) continue;
        if (!ASSIGN.test(s.words[x]!.raw)) { exported.set(w, vars.has(w) ? vars.get(w) : undefined); continue; } // `export NAME`
        const eq = w.indexOf("=");
        const name = w.slice(0, eq), value = w.slice(eq + 1);
        vars.set(name, ex[x]!.known ? value : undefined);
        if (exporting || allExport || exported.has(name)) exported.set(name, vars.get(name));
      }
      part(!s.words.some((w) => w.subst));
      continue;
    }
    // `set -a`: every assignment after it is exported.
    if (head === "set" && words.slice(1).some((w) => /^-[a-zA-Z]*a/.test(w) || w === "allexport")) allExport = true;
    if ((head === "mkdir" && words[1] === "-p") || head === "true" || head === ":" || (head === "set" && words.slice(1).every((w) => /^[-+][a-zA-Z]+$|^pipefail$/.test(w))) || isWait(words)) {
      part(!writesInside(s) && !s.words.some((w) => w.subst));
      continue;
    }
    quiet = false;
    // A command whose words run another (a substitution) may change anything.
    part(looks(words) && !writesInside(s) && !s.words.some((w) => w.subst));
  }
  // The reading followed the command to its end.
  const whole = i >= cmds.length;
  // Each check run: on the tree as the command started when everything before it changes nothing, else
  // on the tree as it ended when nothing from it on changes anything (and nothing before it is still at
  // work in the background); else what it ran on is not known, and it is not counted.
  const out: Match[] = [];
  const first = parts.findIndex((q) => q.match);
  for (const [x, p] of parts.entries()) {
    if (!p.match) continue;
    const before = parts.slice(0, x).every((q) => q.still);
    const after = whole && !p.bgBefore && parts.slice(x).every((q) => q.still);
    if (!before && !after) continue;
    out.push({ ...p.match, treeAt: before ? "start" : "end", answers: plain && before && p.quiet && !!p.post && x === first });
  }
  return out;
}

// The folder a command's leading `cd`s take it to (the repository its checks are of), or `cwd`.
export function firstFolder(command: string, cwd: string, home: string): string {
  let at = cwd;
  for (const s of simples(tokens(command))) {
    if (s.cut || s.depth || s.words[0]?.text !== "cd" || s.words.length !== 2 || s.redirs.length) break;
    const w = s.words[1]!;
    if (w.subst) break;
    const to = (w.raw.startsWith("~/") || w.raw === "~" ? home + w.text.slice(1) : w.text).replace(/^\$HOME(?=\/|$)/, home);
    if (to.includes("$")) break;
    at = normalize(to.startsWith("/") ? to : `${at}/${to}`).replace(/(?<=.)\/$/, "");
    if (s.sep !== "&&" && s.sep !== ";") break;
  }
  return at;
}

// --- what the shell reports of a check's run (see the trace in src/tools/shell.ts)

// One line a simple command: the shell's process and level, the statuses of the pipe before it, its words.
export type TraceLine = { pid: string; level: number; status: string; command: string } | { exit: string };
export function parseTrace(text: string): TraceLine[] {
  const out: TraceLine[] = [];
  for (const l of text.split("\n")) {
    const f = l.split("\t");
    if (f[0] === "D" && f.length >= 5) out.push({ pid: f[1]!, level: Number(f[2]), status: f[3]!, command: f.slice(4).join("\t") });
    else if (f[0] === "E" && f.length >= 2) out.push({ exit: f[1]! });
  }
  return out;
}

// Whether the check started, and its own status: the first status of the pipe
// it led, as the shell saw it at the next command of the same shell (or at the
// end of a group it ended, or of the whole command). Undefined: it never
// started (a wait before it gave up). `exit` null: it started and no status
// was seen (it was stopped).
export function checkStatus(lines: readonly TraceLine[], start: string, filters: number, nth = 0): { exit: number | null } | undefined {
  const norm = (c: string) => startText(c) ?? squash(c);
  let seen = 0;
  const i = lines.findIndex((l) => "command" in l && norm(l.command) === start && seen++ === nth);
  if (i < 0) return undefined;
  const at = lines[i] as Extract<TraceLine, { pid: string }>;
  let skip = filters;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if ("exit" in l) return { exit: first(l.exit) };
    if (l.pid === at.pid) { if (skip > 0) { skip--; continue; } return { exit: first(l.status) }; }
    // The group it ran in ended: its status is the group's.
    if (l.level < at.level) return { exit: first(l.status) };
  }
  return { exit: null };
}
const first = (s: string) => { const n = Number(s.trim().split(/\s+/)[0]); return Number.isInteger(n) ? n : null; };

// What `timeout` leaves when it stopped the check (124, or 128 + the signal with --preserve-status or
// after -k) or could not start it (125): the check found nothing.
export const stoppedByTimeout = (exit: number | null) => exit === 124 || exit === 125 || (exit !== null && exit >= 128);
