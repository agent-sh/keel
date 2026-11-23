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
// A command runs a check when the check is one of its simple commands, and
// the others are only of these kinds:
//   before it: `cd DIR`, assignments (`S=...`, `export S=...`), `mkdir -p`,
//              `set` of shell options, `true`, and the waits the repository names;
//   on it:     its output sent to files (`> log 2>&1`) or through `tail`/`head`;
//   after it:  commands that read (`tail`, `head`, `cat`, `grep`, `wc`, `ls`, `echo`, `printf`).
// joined by `&&` and `;`, in `( )` or `{ }` groups. Nothing that runs in the
// background (`&`), a fallback (`||`), a command substitution, a here-document,
// an input redirection (but from /dev/null) or a `$` left after the command's own assignments,
// `$PWD` and `$HOME` are put in: a check with a `$` of another kind left in
// its words is recorded but never answered.

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

type Word = { raw: string; text: string; quoted: boolean };
type Tok = { op: string } | { word: Word } | { redir: string; target?: Word };
// The tokens of a command line, or why it is not read (a substitution, a here-document).
export function tokens(line: string): Tok[] | undefined {
  const out: Tok[] = [];
  let i = 0;
  const n = line.length;
  const isSpace = (c: string) => c === " " || c === "\t";
  while (i < n) {
    const c = line[i]!;
    if (isSpace(c)) { i++; continue; }
    if (c === "\n") { out.push({ op: ";" }); i++; continue; }
    if (c === "#" ) break;
    const two = line.slice(i, i + 2);
    if (two === "&&" || two === "||") { out.push({ op: two }); i += 2; continue; }
    if (c === ";" || c === "|" || c === "(" || c === ")") { out.push({ op: c }); i++; continue; }
    if (two === "<<" || two === "<(" || two === ">(") return undefined;
    // (Input from /dev/null only: nothing is read.)
    if (c === "<") { const m = /^<\s*\/dev\/null(?=[\s;&|)]|$)/.exec(line.slice(i)); if (!m) return undefined; i += m[0].length; out.push({ redir: "</dev/null" }); continue; }
    if (c === "&" && line[i + 1] === ">") {
      const op = line[i + 2] === ">" ? "&>>" : "&>";
      i += op.length;
      const t = word();
      if (!t) return undefined;
      out.push({ redir: op, target: t });
      continue;
    }
    if (c === "&") { out.push({ op: "&" }); i++; continue; }
    if (c === ">") {
      const op = line[i + 1] === ">" ? ">>" : ">";
      i += op.length;
      if (line[i] === "&") { const m = /^&(\d+|-)/.exec(line.slice(i)); if (!m) return undefined; i += m[0].length; out.push({ redir: `${op}${m[0]}` }); continue; }
      if (line[i] === "|") i++;
      const t = word();
      if (!t) return undefined;
      out.push({ redir: op, target: t });
      continue;
    }
    const w = word();
    if (!w) return undefined;
    // `2>`: a number right before a redirection is its descriptor.
    if (/^\d+$/.test(w.raw) && (line[i] === ">")) {
      const op = line[i + 1] === ">" ? ">>" : ">";
      i += op.length;
      if (line[i] === "&") { const m = /^&(\d+|-)/.exec(line.slice(i)); if (!m) return undefined; i += m[0].length; out.push({ redir: `${w.raw}${op}${m[0]}` }); continue; }
      const t = word();
      if (!t) return undefined;
      out.push({ redir: `${w.raw}${op}`, target: t });
      continue;
    }
    out.push({ word: w });
  }
  return out;
  // One word from `i`: quotes taken off in `text`, kept in `raw`.
  function word(): Word | undefined {
    while (i < n && isSpace(line[i]!)) i++;
    const start = i;
    let text = "", quoted = false;
    while (i < n) {
      const c = line[i]!;
      if (isSpace(c) || c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")" || c === "<" || c === ">") break;
      if (c === "`") return undefined;
      if (c === "$" && line[i + 1] === "(") return undefined;
      if (c === "\\") { if (i + 1 >= n) return undefined; text += line[i + 1]; i += 2; quoted = true; continue; }
      if (c === "'") { const e = line.indexOf("'", i + 1); if (e < 0) return undefined; text += line.slice(i + 1, e); i = e + 1; quoted = true; continue; }
      if (c === '"') {
        let j = i + 1, t = "";
        while (j < n && line[j] !== '"') {
          if (line[j] === "\\" && j + 1 < n) { t += line[j + 1]; j += 2; continue; }
          if (line[j] === "`" || (line[j] === "$" && line[j + 1] === "(")) return undefined;
          t += line[j]; j++;
        }
        if (j >= n) return undefined;
        text += t; i = j + 1; quoted = true; continue;
      }
      text += c; i++;
    }
    return i > start ? { raw: line.slice(start, i), text, quoted } : undefined;
  }
}

// `depth`: how many `( )` groups it is in (a `cd` there does not outlast the group).
type Simple = { words: Word[]; redirs: { redir: string; target?: Word }[]; sep: string; depth: number };
// The simple commands of a line, each with the operator that follows it; the
// group marks `(` `)` `{` `}` are left out (where their output goes is not what runs).
function simples(toks: Tok[]): Simple[] | undefined {
  const out: Simple[] = [];
  let depth = 0;
  let cur: Simple = { words: [], redirs: [], sep: "", depth };
  const close = (sep: string) => { if (cur.words.length || cur.redirs.length) { cur.sep = sep; out.push(cur); } else if (out.length && sep) out.at(-1)!.sep = out.at(-1)!.sep === "|" ? "|" : sep; cur = { words: [], redirs: [], sep: "", depth }; };
  for (const t of toks) {
    if ("op" in t) {
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
const READERS = new Set(["tail", "head", "cat", "grep", "wc", "ls", "echo", "printf", "true", ":", "date"]);
const FILTERS = new Set(["tail", "head"]);

export type Where = {
  cwd: string;                                  // the folder the command starts in (absolute)
  home: string;
  rel: (abs: string) => string | undefined;     // a folder from the repository's top, or undefined outside it
};
export type Match = {
  check: Check;
  command: string;   // what the check run is known by: the check's command and the words added to it
  dir: string;       // the folder it ran in, from the top (absolute when it is outside the repository)
  exact: boolean;    // its words hold no `$` that is not known here: an earlier pass of it can answer it
  // A check of a commit: `rev` is its last argument when that may name one (it does not follow an
  // option), which the caller resolves; `named` is what the run is known by when it names none.
  tree: { kind: "work"; folder: string } | { kind: "folder"; folder: string } | { kind: "commit"; rev?: string; named?: string };
  shellCwd: string;  // where the command leaves the shell: its `cd`s outside a `( )` group, the check's own folder for an answer
  start: string;     // the check's simple command as the shell reports it (startText)
  filters: number;   // commands its output goes through after it in its pipe (its status is the pipe's first)
  alone: boolean;    // nothing runs before or after it: the command's own status is the check's (with no filter)
};

// The words of a simple command as the shell reports it running ($BASH_COMMAND):
// its assignments and redirections left out, one space between words.
export function startText(command: string): string | undefined {
  const t = tokens(command);
  if (!t) return undefined;
  const s = simples(t)?.[0];
  if (!s) return undefined;
  let k = 0;
  while (k < s.words.length && ASSIGN.test(s.words[k]!.raw)) k++;
  return s.words.slice(k).map((w) => w.raw).join(" ");
}

// Which check `command` runs, or nothing.
export function matchCommand(command: string, named: Pick<Named, "checks" | "wait" | "env">, where: Where): Match | undefined {
  if (!named.checks.length) return;
  const toks = tokens(command);
  if (!toks || toks.some((t) => "op" in t && (t.op === "||" || t.op === "&"))) return;
  const cmds = simples(toks);
  if (!cmds?.length) return;
  const vars = new Map<string, string | undefined>([["HOME", where.home], ["PWD", where.cwd]]);
  // What the command exports for what it runs: part of what the check run is known by (unless the repository
  // says the variable does not change a result). Undefined value: not known here.
  const exported = new Map<string, string | undefined>();
  let allExport = false;
  let cwd = where.cwd, kept = where.cwd;
  // `$NAME` and `${NAME}` put in where they are known; `~` at a word's start is the home folder.
  const expand = (w: Word): string => {
    if (w.raw.startsWith("'")) return w.text;
    let s = w.raw.startsWith("~/") || w.raw === "~" ? where.home + w.text.slice(1) : w.text;
    s = s.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, v: string) => (v === "PWD" ? cwd : vars.get(v) ?? m));
    return s;
  };
  // (As bash's cd reads it: `..` takes off the last part of the path as written.)
  const resolve = (p: string) => normalize(p.startsWith("/") ? p : `${cwd}/${p}`);
  const runWords = (c: Check) => c.run.split(" ").map((r) => (r === "~" || r.startsWith("~/") ? where.home + r.slice(1) : r.replace(/^\$HOME(?=\/|$)/, where.home)));
  const isWait = (words: string[]) => named.wait.some((p) => { const pw = p.split(" "); return pw.every((x, i) => words[i] === x); });
  for (let i = 0; i < cmds.length; i++) {
    const s = cmds[i]!;
    const sepBefore = i ? cmds[i - 1]!.sep : "";
    if (sepBefore === "|") return; // a pipe into something before the check
    const words = s.words.map(expand);
    // Is it the check?
    let k = 0;
    const lead: string[] = [];
    while (k < words.length && ASSIGN.test(s.words[k]!.raw)) { const name = s.words[k]!.raw.split("=")[0]!; if (!named.env.includes(name)) lead.push(words[k]!); k++; }
    const body = words.slice(k);
    const rel = where.rel(cwd);
    for (const check of named.checks) {
      const rw = runWords(check);
      if (!rw.every((x, j) => body[j] === x)) continue;
      if (body.length > rw.length && !check.args) continue;
      if (check.dir !== "*" && (rel === undefined || rel !== check.dir)) continue;
      if (s.redirs.some((r) => r.redir.includes("<") && r.redir !== "</dev/null")) return;
      // What follows: filters in its pipe, then commands that read.
      let filters = 0, j = i;
      while (cmds[j]!.sep === "|") { const f = cmds[j + 1]; if (!f || !FILTERS.has(f.words[0]?.text ?? "")) return; filters++; j++; }
      for (let r = j + 1; r < cmds.length; r++) {
        if (cmds[r - 1]!.sep === "|" ? !FILTERS.has(cmds[r]!.words[0]?.text ?? "") && !READERS.has(cmds[r]!.words[0]?.text ?? "") : !READERS.has(cmds[r]!.words[0]?.text ?? "")) return;
      }
      // Its arguments: the dropped options out, the tree's argument taken.
      let args = body.slice(rw.length);
      for (let a = 0; a < args.length; a++) {
        const d = check.drop.find((o) => args[a] === o || args[a]!.startsWith(`${o}=`));
        if (d) { args.splice(a, args[a] === d ? 2 : 1); a--; }
      }
      let tree: Match["tree"] = { kind: "work", folder: cwd };
      if (check.tree.kind === "folder") {
        const f = args[check.tree.arg - 1];
        if (!f || f.startsWith("-")) return;
        tree = { kind: "folder", folder: resolve(f) };
        args.splice(check.tree.arg - 1, 1);
      } else if (check.tree.kind === "commit") {
        const last = args.at(-1);
        const before = args.at(-2);
        // (The value of an option is not a commit: `--only unit`.)
        if (last && !last.startsWith("-") && !before?.startsWith("-")) { tree = { kind: "commit", rev: last }; args = args.slice(0, -1); }
        else tree = { kind: "commit" };
      }
      const env = [...exported].filter(([n]) => !named.env.includes(n)).sort(([a], [b]) => (a < b ? -1 : 1));
      const known = [...env.map(([n, v]) => `${n}=${v ?? "$?"}`), ...lead, ...rw, ...args].join(" ");
      if (tree.kind === "commit" && tree.rev) tree.named = [...env.map(([n, v]) => `${n}=${v ?? "$?"}`), ...lead, ...rw, ...args, tree.rev].join(" ");
      // (A check that runs anywhere is known by the folder it ran in.)
      const dir = rel ?? cwd;
      // Where the shell is left: an answer stands for the command, and the `cd`s before the check
      // outside a group hold after it (nothing after a check moves: only readers follow it).
      const shellCwd = s.depth === 0 ? cwd : kept;
      return {
        check, command: known, dir, exact: !/[$*?[]/.test(known) && env.every(([, v]) => v !== undefined),
        tree, start: s.words.slice(k).map((w) => w.raw).join(" "), filters, alone: i === 0 && j === cmds.length - 1, shellCwd,
      };
    }
    // Else it is a part allowed before a check, or nothing is a check.
    const head = words[0]!;
    if (head === "cd") {
      if (words.length !== 2) return;
      const to = words[1]!;
      if (to.includes("$")) return;
      cwd = resolve(to).replace(/(?<=.)\/$/, "");
      if (s.depth === 0) kept = cwd;
      continue;
    }
    const exporting = head === "export";
    if (exporting && words.slice(1).some((w) => w.startsWith("-"))) return;
    if (words.every((_, x) => ASSIGN.test(s.words[x]!.raw)) || (exporting && words.slice(1).every((w, x) => ASSIGN.test(s.words[x + 1]!.raw) || /^[A-Za-z_]\w*$/.test(w)))) {
      for (const [x, w] of words.entries()) {
        if (exporting && x === 0) continue;
        if (!ASSIGN.test(s.words[x]!.raw)) { exported.set(w, vars.has(w) ? vars.get(w) : undefined); continue; } // `export NAME`
        const at = w.indexOf("=");
        const name = w.slice(0, at), value = w.slice(at + 1);
        vars.set(name, value.includes("$") ? undefined : value);
        if (exporting || allExport || exported.has(name)) exported.set(name, vars.get(name));
      }
      continue;
    }
    // `set -a`: every assignment after it is exported.
    if (head === "set" && words.slice(1).some((w) => /^-[a-zA-Z]*a/.test(w) || w === "allexport")) allExport = true;
    if ((head === "mkdir" && words[1] === "-p") || head === "true" || head === ":" || (head === "set" && words.slice(1).every((w) => /^[-+][a-zA-Z]+$|^pipefail$/.test(w)))) continue;
    if (isWait(words)) continue;
    return;
  }
  return undefined;
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
export function checkStatus(lines: readonly TraceLine[], start: string, filters: number): { exit: number | null } | undefined {
  const norm = (c: string) => startText(c) ?? squash(c);
  const i = lines.findIndex((l) => "command" in l && norm(l.command) === start);
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
