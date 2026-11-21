// Shell command analysis for the permission gate: split a command line into
// the simple commands it runs, decide which are read-only, which are high
// risk, and whether a stored rule covers each one. Pure functions.
import { ENDS, KEPT, READERS, anyArguments, denied, long, xargsCommand } from "./shell-reads.ts";

// One simple command: its words with quotes removed, and whether it writes
// through a redirection. `nested`: it runs inside a substitution or a
// subshell, so a `cd` in it does not say where the commands after it run.
// `unknown`: the parser could not account for it, so it is never a read.
// `heredoc`: a line of a here-document read as a script, for the risk rules
// alone: it runs only if the command it feeds runs it, and that one is judged.
// A redirect is kept wherever it stands: one after a group, a loop or a
// conditional, or with no command at all, is a part with no words.
// `dyn`: the words (by index) an expansion makes ($x, $(...), {a,b}), so what
// they hold, and with `splits` how many words they are, is not known from the
// text; `how` says, for each of them in the same order, what is known of it.
// `inputs`: the files it reads through a redirect. `sep`: the operator that
// ends it when that is not `;` or a newline. `flow`: a loop, a conditional, a
// group or an assigning expansion stands before it in the line, so a variable
// may not hold what the line's first words gave it.
export type Simple = { words: string[]; text: string; redirects: boolean; nested?: true; unknown?: true; heredoc?: true; dyn?: number[]; splits?: true; how?: Made[]; inputs?: string[]; sep?: string; flow?: true };

// What is known of a word an expansion makes. `one`: it stays one word (every
// expansion in it is inside double quotes, and no glob or brace is). `lead`:
// its literal text before the first expansion. `subs`: the commands of each
// $(...) and `...` in it. `vars`: each plain $name and ${name}, with where it
// stands in the word. `rest`: something else makes it too (a glob, braces,
// ${x:-y}, $'..', $"..", arithmetic, a positional or special parameter).
export type Made = { one: boolean; lead: string; subs: Simple[][]; vars: { name: string; at: number; len: number }[]; rest: boolean };

const OPS = ["&&", "||", "|&", ";;", ";", "|", "&", "\n"];
// Leading words that are syntax, not commands.
const CONTROL = /^(if|then|else|elif|fi|do|done|while|until|esac|\{|\}|!|time)$/;
// What a redirect may write to without changing anything.
const SINK = /^\/dev\/null$/;
type Redirect = ">" | ">&" | "<" | "<&" | "<<<" | "<<" | "<<-";

// Split on shell operators outside quotes. Command and process substitutions
// ($(...), `...`, <(...), >(...)) are analysed as commands of their own. Null:
// not a command line a shell would run (an open quote or substitution, a
// redirect with no target). A line with text and no part comes back as one
// unknown part, never as nothing.
export function splitCommand(cmd: string): Simple[] | null {
  // A line continuation right after $ < > & ( is read by bash before it reads the operator: not followed here.
  if (/[$<>&(]\\\n/.test(cmd)) return null;
  const r = scan(cmd, 0, false);
  if (!r) return null;
  if (!r.parts.length && cmd.trim()) return [{ words: [], text: cmd.trim(), redirects: false, unknown: true }];
  return r.parts;
}

// The commands from `start`: to the end of the text, or (`inner`) to the `)`
// that closes the substitution they are in.
// Nesting deeper than this is not followed: the cost of reading it grows with the square of its depth.
let level = 0;
function scan(cmd: string, start: number, inner: boolean, flow = false): { parts: Simple[]; end: number } | null {
  if (level >= 64) return null;
  level++;
  try { return scanIn(cmd, start, inner, flow); } finally { level--; }
}
function scanIn(cmd: string, start: number, inner: boolean, flow: boolean): { parts: Simple[]; end: number } | null {
  const out: Simple[] = [];
  let words: string[] = [];
  let dyn: number[] = [];
  let how: Made[] = [];
  let splits = false;
  // The word being read, when an expansion makes it: see Made. `lead` is how much of it was literal before the first one.
  const fresh = () => ({ lead: 0, open: false, rest: false, subs: [] as Simple[][], vars: [] as Made["vars"] });
  let cur = fresh();
  // An expansion makes the word from `at` on. `open`: its result is split into words, or is several.
  const expands = (at: number, open: boolean) => {
    if (!made) cur.lead = at;
    made = true;
    if (open) splits = cur.open = true;
  };
  let word = "";
  let inWord = false;
  let quoted = false; // the word has a quoted or escaped character
  let made = false; // an expansion makes the word, or part of it
  let text = "";
  let redirects = false;
  let unknown = false;
  let depth = 0;
  let inputs: string[] = [];
  let param = 0; // ${ ... } still open: what stands in it is its text, whatever it looks like
  let want: Redirect | null = null; // a redirect operator waiting for its target word
  let bad = false;
  let docs: { delim: string; tabs: boolean; quoted: boolean }[] = [];

  const target = (kind: Redirect, w: string) => {
    if (kind === ">") redirects ||= made || !SINK.test(w); // >, >>, >|, &>, &>> and <> (opened for writing too)
    else if (kind === ">&") redirects ||= made || (!/^(\d+-?|-)$/.test(w) && !SINK.test(w)); // >&2 copies a descriptor; >&file writes it
    else if (kind === "<") { inputs.push(w); redirects ||= made || /^\/dev\/(tcp|udp)\//.test(w); } // /dev/tcp opens a connection
    else if (kind === "<<" || kind === "<<-") { if (made) bad = true; docs.push({ delim: w, tabs: kind === "<<-", quoted }); } // bash takes the delimiter as written: $(..) in it is text
  };
  const flushWord = () => {
    if (!inWord) return;
    if (want) { target(want, word); want = null; }
    else {
      // A `case` pattern ends in a `)` that closes nothing: inside a substitution, where that one ends is then not known.
      if (inner && !quoted && word === "case" && (!words.length || CONTROL.test(words[0]!) || /^(coproc|function)$/.test(words[0]!))) unknown = true;
      if (made) { dyn.push(words.length); how.push({ one: !cur.open, lead: word.slice(0, cur.lead), subs: cur.subs, vars: cur.vars, rest: cur.rest }); }
      words.push(word);
    }
    word = "";
    inWord = false;
    quoted = false;
    made = false;
    cur = fresh();
  };
  const flushCmd = (sep?: string) => {
    flushWord();
    if (want) { bad = true; want = null; }
    // `for x in ...`, `select x in ...` and `case ... in` headers run nothing themselves.
    if (/^(for|select|case)$/.test(words[0] ?? "")) { words = []; flow = true; }
    let lead = 0;
    while (lead < words.length && CONTROL.test(words[lead]!)) lead++;
    if (lead) flow = true;
    words = words.slice(lead);
    const kept = dyn.map((n, k) => ({ n: n - lead, m: how[k]! })).filter((d) => d.n >= 0 && d.n < words.length);
    dyn = kept.map((d) => d.n);
    how = kept.map((d) => d.m);
    if (words.length || redirects || unknown || inputs.length)
      out.push({
        words, text: text.trim(), redirects,
        ...(depth > 0 ? { nested: true as const } : {}), ...(unknown ? { unknown: true as const } : {}),
        ...(dyn.length ? { dyn, how } : {}), ...(dyn.length && splits ? { splits: true as const } : {}), ...(inputs.length ? { inputs } : {}),
        ...(sep && sep !== ";" && sep !== "\n" ? { sep } : {}), ...(flow ? { flow: true as const } : {}),
      });
    words = [];
    dyn = [];
    how = [];
    inputs = [];
    splits = false;
    text = "";
    redirects = false;
    unknown = false;
  };
  // $( at j: the commands inside, and where its ) is. $(( is arithmetic: it
  // evaluates the names in it, and a name's value can hold a substitution.
  // Arithmetic on numbers alone names nothing: its result is a number.
  const substitution = (j: number): number | null => {
    if (cmd[j] === "$") {
      const sum = /^\$\(\([0-9+\-*\/% \t]*\)\)/.exec(cmd.slice(j, j + 200));
      if (sum) { cur.rest = true; return j + sum[0].length - 1; }
    }
    const r = scan(cmd, j + 2, true, flow);
    if (!r) return null;
    out.push(...nestedIn(r.parts));
    if (cmd[j] === "$") cur.subs.push(r.parts);
    if (cmd[j] === "$" && cmd[j + 2] === "(") unknown = true;
    return r.end;
  };
  // $ at j outside single quotes: the word it is in is made by an expansion
  // from `at` on. ${name}, ${#name}, the forms that default, trim or replace,
  // an element or a slice named by a number (${a[0]}, ${a[@]}, ${x:0:5}) are
  // followed; the rest index, slice or evaluate (${a[i]}, ${x:i}, ${!x},
  // ${x@P}, $[...]) and can run what a value holds.
  const dollar = (j: number, inDouble: boolean, at: number) => {
    const n = cmd[j + 1] ?? "";
    if (n === '"' && !inDouble) { expands(at, false); cur.rest = true; } // $"..." is the string with the $ dropped: the word is not what it reads
    else if (n === "[") unknown = true;
    else if (n === "{") {
      const here = cmd.slice(j, j + 200);
      const plain = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(here);
      // "${a[@]}" is one word for each element, quoted or not.
      expands(at, !inDouble || /^\$\{[A-Za-z_][A-Za-z0-9_]*\[[@*]\]/.test(here));
      if (plain) cur.vars.push({ name: plain[1]!, at, len: plain[0].length });
      else cur.rest = true;
      if (!inDouble) param++;
      if (!/^\$\{#?[A-Za-z_][A-Za-z0-9_]*(\}|:?[-=?+]|[#%\/^,]|\[(\d+|[@*])\]\}|:\d+(:\d+)?\})/.test(here)) unknown = true;
      // ${x:=y} and ${x=y} assign: from here on a variable may not hold what it was given.
      if (/^\$\{[A-Za-z_][A-Za-z0-9_]*:?=/.test(here)) flow = true;
    } else if (/[A-Za-z0-9_@*!=~^+-]/.test(n)) { // $=x, $~x, $^x and $+x are zsh's
      const name = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(cmd.slice(j, j + 200));
      expands(at, !inDouble || n === "@" || n === "*");
      if (name) cur.vars.push({ name: name[1]!, at, len: name[0].length });
      else cur.rest = true;
    }
  };
  // ` at j: the command between the backquotes, its own escapes removed.
  const backquoted = (j: number, inDouble: boolean): number | null => {
    let k = j + 1;
    let code = "";
    for (; k < cmd.length && cmd[k] !== "`"; k++) {
      if (cmd[k] === "\\" && k + 1 < cmd.length && (/[`\\$]/.test(cmd[k + 1]!) || (inDouble && cmd[k + 1] === '"'))) k++;
      code += cmd[k];
    }
    if (k >= cmd.length) return null;
    const r = scan(code, 0, false, flow);
    if (!r) return null;
    out.push(...nestedIn(r.parts));
    cur.subs.push(r.parts);
    return k;
  };
  // The here-documents opened on the line that ended before `from`: where the text after them starts.
  const bodies = (from: number): number | null => {
    let p = from;
    for (const d of docs) {
      const first = p;
      let last = cmd.length;
      for (;;) {
        const nl = cmd.indexOf("\n", p);
        const line = cmd.slice(p, nl < 0 ? cmd.length : nl);
        const done = (d.tabs ? line.replace(/^\t+/, "") : line) === d.delim;
        if (done) last = p;
        p = nl < 0 ? cmd.length : nl + 1;
        if (done || nl < 0) break;
      }
      // An unquoted delimiter: the shell runs the substitutions in the text.
      if (!d.quoted) {
        if (cmd.slice(first, last).includes("\\\n")) return null; // bash joins the lines before it compares one to the delimiter
        const word = [made, splits];
        const mine = cur;
        cur = fresh();
        for (let k = first; k < last; k++) {
          if (cmd[k] === "\\") { k++; continue; }
          if (cmd[k] === "$" && cmd[k + 1] !== "(") dollar(k, true, 0);
          const end = cmd[k] === "$" && cmd[k + 1] === "(" ? substitution(k) : cmd[k] === "`" ? backquoted(k, false) : k;
          if (end === null) return null;
          k = Math.min(end, last);
        }
        [made, splits] = word as [boolean, boolean];
        cur = mine;
      }
      const script = splitCommand(cmd.slice(first, last));
      if (script) out.push(...script.map((s) => ({ ...s, nested: true as const, heredoc: true as const })));
    }
    docs = [];
    return p;
  };

  for (let i = start; i < cmd.length; i++) {
    const c = cmd[i]!;
    // Inside ${ ... } the shell reads these as text; here they would be read as syntax.
    if (param && /[<>(){;|&\n]/.test(c)) unknown = true;
    if (c === "\\" && i + 1 < cmd.length) {
      if (cmd[i + 1] === "\n") { i++; continue; }
      word += cmd[i + 1]; inWord = true; quoted = true; text += c + cmd[i + 1]; i++;
      continue;
    }
    if (c === "'" || (c === "$" && cmd[i + 1] === "'")) {
      // '...' holds no escapes; $'...' does.
      const ansi = c === "$";
      let j = i + (ansi ? 2 : 1);
      let lit = "";
      for (; j < cmd.length && cmd[j] !== "'"; j++) {
        // An escape there can spell any character (\x2d is a dash): the word is not known.
        if (ansi && cmd[j] === "\\" && j + 1 < cmd.length) { j++; expands(word.length + lit.length, false); cur.rest = true; }
        lit += cmd[j];
      }
      if (j >= cmd.length) return null;
      word += lit; inWord = true; quoted = true; text += cmd.slice(i, j + 1); i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let lit = "";
      let braces = 0;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === "\\" && j + 1 < cmd.length) {
          // Inside double quotes a backslash escapes only these.
          if (cmd[j + 1] === "\n") j++;
          else if (/[$`"\\]/.test(cmd[j + 1]!)) lit += cmd[++j];
          else lit += cmd[j];
          continue;
        }
        if ((cmd[j] === "$" && cmd[j + 1] === "(") || cmd[j] === "`") {
          expands(word.length + lit.length, false);
          const end = cmd[j] === "$" ? substitution(j) : backquoted(j, true);
          if (end === null) return null;
          lit += cmd[j] === "$" ? "$(...)" : "`...`";
          j = end;
          continue;
        }
        if (cmd[j] === "$") { dollar(j, true, word.length + lit.length); if (cmd[j + 1] === "{") braces++; }
        else if (cmd[j] === "}" && braces) braces--;
        lit += cmd[j];
      }
      if (j >= cmd.length) return null;
      // A quote inside "${...}" opens a string of its own there: where this one ends is not known.
      if (braces) unknown = true;
      word += lit; inWord = true; quoted = true; text += cmd.slice(i, j + 1); i = j;
      continue;
    }
    if ((c === "$" || c === "<" || c === ">") && cmd[i + 1] === "(") {
      // <(...) and >(...) become a file name; $(...) becomes whatever the command prints.
      if (c === "$") expands(word.length, true);
      const end = substitution(i);
      if (end === null) return null;
      word += "$(...)"; inWord = true; text += cmd.slice(i, end + 1); i = end;
      continue;
    }
    if (c === "`") {
      expands(word.length, true);
      const end = backquoted(i, false);
      if (end === null) return null;
      word += "`...`"; inWord = true; text += cmd.slice(i, end + 1); i = end;
      continue;
    }
    if (c === "$") {
      dollar(i, false, word.length);
      if (cmd[i + 1] === "{") { word += "${"; inWord = true; text += "${"; i++; continue; }
    }
    if (c === "#" && !inWord && !param) {
      const nl = cmd.indexOf("\n", i);
      i = nl < 0 ? cmd.length : nl - 1;
      continue;
    }
    if (c === ">" || c === "<" || (c === "&" && cmd[i + 1] === ">")) {
      // A redirection: [n]>file, >>, >|, &>, &>>, >&n, >&file, <file, <&n, <>file, <<<word, <<[-]WORD.
      // Digits right before it name the descriptor and are no word.
      if (c !== "&" && inWord && !quoted && /^\d+$/.test(word)) { word = ""; inWord = false; }
      else flushWord();
      if (want) return null;
      let j = i + 1;
      if (c === "&") { j++; if (cmd[j] === ">") j++; want = ">"; }
      else if (c === ">") {
        if (cmd[j] === "&") { j++; want = ">&"; }
        else { if (cmd[j] === ">" || cmd[j] === "|") j++; want = ">"; }
      } else if (cmd[j] === "<" && cmd[j + 1] === "<") { j += 2; want = "<<<"; }
      else if (cmd[j] === "<") { j++; if (cmd[j] === "-") { j++; want = "<<-"; } else want = "<<"; }
      else if (cmd[j] === ">") { j++; want = ">"; }
      else if (cmd[j] === "&") { j++; want = "<&"; }
      else want = "<";
      text += cmd.slice(i, j); i = j - 1;
      continue;
    }
    const op = OPS.find((o) => cmd.startsWith(o, i));
    if (op) {
      flushCmd(op);
      i += op.length - 1;
      if (op === "\n" && docs.length) {
        const next = bodies(i + 1);
        if (next === null) return null;
        i = next - 1;
      }
      continue;
    }
    // Parentheses always end a word: a subshell, a function's (), a case pattern's ).
    if (c === "(" || c === ")") {
      flushCmd();
      if (c === ")" && inner && depth === 0) return bad ? null : { parts: out, end: i };
      depth = Math.max(0, depth + (c === "(" ? 1 : -1));
      if (c === "(" && cmd[i + 1] === "(") unknown = true; // (( ... )): arithmetic, as $(( is
      continue;
    }
    if (c === " " || c === "\t") {
      flushWord();
      text += c;
      continue;
    }
    // {a,b} and {1..3} become several words.
    if (c === "{" && cmd[i - 1] !== "$" && braceExpands(cmd, i)) { expands(word.length, true); cur.rest = true; }
    if (c === "}" && param) param--;
    // A glob that opens a word can expand to an option (a file named -o): not known from the text.
    if ((c === "*" || c === "?" || c === "[") && !want && !words.every((w) => CONTROL.test(w)) && (word === "" || word.startsWith("-"))) { expands(word.length, true); cur.rest = true; }
    word += c; inWord = true; text += c;
  }
  flushCmd();
  return bad || inner ? null : { parts: out, end: cmd.length };
}

const nestedIn = (sub: Simple[]): Simple[] => sub.map((s) => ({ ...s, nested: true as const }));

// Whether the { at i opens a brace expansion: its } in the same word, with a
// comma or a `..` between, or with an expansion between (not known: taken as one).
function braceExpands(cmd: string, i: number): boolean {
  let depth = 0;
  let list = false;
  // A word of more than 512 characters is not followed to its end (that is quadratic over many braces): taken as an expansion.
  for (let j = i; j < cmd.length; j++) {
    if (j - i > 512) return true;
    const c = cmd[j]!;
    if (c === "\\") { j++; continue; }
    if (c === "'") { j = cmd.indexOf("'", j + 1); if (j < 0) return true; continue; }
    if (c === '"') {
      for (j++; j < cmd.length && cmd[j] !== '"'; j++) if (cmd[j] === "\\") j++;
      continue;
    }
    if (c === "$" || c === "`" || ((c === "<" || c === ">") && cmd[j + 1] === "(")) return true;
    if (/[ \t\n;&|<>()]/.test(c)) return false;
    if (c === "{") depth++;
    else if (c === "}") { if (--depth === 0) return list; }
    else if (c === "," || (c === "." && cmd[j + 1] === ".")) list = true;
  }
  return false;
}

// Words after leading VAR=value assignments.
const body = (w: string[]) => {
  let i = 0;
  while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]!)) i++;
  return { env: i > 0, words: w.slice(i) };
};

// Programs that only read, whatever their arguments are.
const READ_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "pwd", "echo", "which", "type",
  "stat", "du", "df", "cut", "tr", "diff", "cmp", "jq", "basename", "dirname", "realpath",
  "readlink", "whoami", "id", "uname", "true", "false", "cd", "nl", "column",
  "sha256sum", "md5sum", "free", "uptime", "nproc", "ps", "printenv",
]);
const GIT_READ = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "grep", "describe", "shortlog",
  "cat-file", "merge-base", "rev-list", "reflog", "whatchanged", "name-rev", "for-each-ref", "check-ignore",
  "show-ref", "show-branch", "diff-index", "diff-tree", "diff-files", "count-objects", "var", "version", "cherry", "check-attr",
]);

// uniq [OPTION]... [INPUT [OUTPUT]]: its operands, past the options that take a value.
function uniqOperands(args: string[]): number {
  let n = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return n + args.length - i - 1;
    if (/^-[fsw]$/.test(a)) { i++; continue; }
    if (a.startsWith("-") && a !== "-") continue;
    n++;
  }
  return n;
}

// date [OPTION]... [+FORMAT]: -s and --set set the clock, and so does an operand that is not a format.
function dateSets(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) { if (a.length > 2 && "set".startsWith(a.slice(2).split("=")[0]!)) return true; continue; }
    if (!a.startsWith("-") || a === "-") { if (!a.startsWith("+")) return true; continue; }
    for (let k = 1; k < a.length; k++) {
      if (a[k] === "s") return true;
      if (a[k] === "I") break; // the rest is its format
      if ("dfr".includes(a[k]!)) { if (k === a.length - 1) i++; break; } // takes a value: the rest, or the next argument
    }
  }
  return false;
}

// Whether a sed script only prints. Its `w` and `W` commands and the `w` flag
// of `s` write a file, the `e` command and flag run a program; a command this
// does not know is not a read. Labels end as early as any sed ends them, so
// what follows one is read as commands.
function sedReads(script: string): boolean {
  const n = script.length;
  let i = 0;
  const at = (set: string) => i < n && set.includes(script[i]!);
  const blanks = () => { while (at(" \t")) i++; };
  // To the closing delimiter. A bracket expression that holds the delimiter
  // or a backslash is read differently from one sed to the next: not known.
  const delimited = (d: string): boolean => {
    for (; i < n; i++) {
      const c = script[i]!;
      if (c === d) { i++; return true; }
      if (c === "\n") return false;
      if (c === "\\") { i++; continue; }
      if (c !== "[") continue;
      i++;
      if (at("^")) i++;
      if (at("]")) i++;
      for (; i < n && script[i] !== "]"; i++) {
        if (script[i] === d || script[i] === "\\" || script[i] === "\n") return false;
        if (script[i] === "[" && ":.=".includes(script[i + 1] ?? " ")) {
          const close = script.indexOf(script[i + 1] + "]", i + 2);
          if (close < 0) return false;
          i = close + 1;
        }
      }
      if (i >= n) return false;
    }
    return false;
  };
  const address = (): boolean => {
    if (at("0123456789")) {
      while (at("0123456789")) i++;
      if (at("~")) { i++; while (at("0123456789")) i++; }
    } else if (at("$")) i++;
    else if (at("/")) { i++; if (!delimited("/")) return false; while (at("IM")) i++; }
    else if (at("\\")) return false; // \cREGEXc: a delimiter of its own
    return true;
  };
  while (i < n) {
    while (at(" \t\n;")) i++;
    if (i >= n) break;
    if (!address()) return false;
    blanks();
    if (at(",")) { i++; blanks(); if (at("+~")) i++; if (!address()) return false; blanks(); }
    while (at("!")) { i++; blanks(); }
    const c = script[i++];
    if (c === undefined) return false;
    if ("pdDgGhHnNPxzF={}".includes(c)) continue;
    if ("qQl".includes(c)) { blanks(); while (at("0123456789")) i++; continue; }
    if (c === "s" || c === "y") {
      const d = script[i++];
      if (d === undefined || "\\\n[".includes(d) || !delimited(d) || !delimited(d)) return false;
      if (c === "s") while (at("gpiImM0123456789")) i++; // not w (a file) nor e (runs the result)
      blanks();
      if (i < n && !at(";\n}")) return false;
      continue;
    }
    if (":btT".includes(c)) { blanks(); while (i < n && /[\w.-]/.test(script[i]!)) i++; continue; }
    // Text to add (a backslash carries it onto the next line), a file to read, a comment: to the end of the line.
    if ("aic".includes(c)) { for (; i < n && script[i] !== "\n"; i++) if (script[i] === "\\") i++; continue; }
    if ("rR#".includes(c)) { while (i < n && script[i] !== "\n") i++; continue; }
    return false;
  }
  return true;
}

// sed [OPTION]... {script} [file]...: no -i and no -f, and every script only prints.
// A word an expansion makes (`made`, by argument) is read only as a file: after the script, never as the script or an option's value.
function sedReadOnly(args: string[], made?: Map<number, Kind>): boolean {
  const scripts: string[] = [];
  let script = -1; // the first operand, which is the script when no -e gave one
  const operand = (i: number) => { if (script < 0) script = i; };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (made?.has(i)) {
      if (made.get(i) !== "operand" && made.get(i) !== "hashes") return false;
      operand(i);
      continue;
    }
    if (a === "--") { if (i + 1 < args.length) operand(i + 1); break; }
    if (a.startsWith("--")) {
      if (a.startsWith("--expression=")) scripts.push(a.slice(13));
      else if (a === "--expression" && i + 1 < args.length && !made?.has(i + 1)) scripts.push(args[++i]!);
      else if (!/^--(quiet|silent|regexp-extended|separate|unbuffered|null-data|posix|debug|sandbox|line-length=\d+)$/.test(a)) return false; // --in-place, --file, a cut-short form
    } else if (a.startsWith("-") && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        if ("nErsuz".includes(a[k]!)) continue;
        if (a[k] !== "e" && a[k] !== "l") return false; // -i, -f, and what is not known
        const value = a.slice(k + 1) || (made?.has(i + 1) ? undefined : args[++i]);
        if (value === undefined) return false;
        if (a[k] === "e") scripts.push(value);
        break;
      }
    } else operand(i);
  }
  if (!scripts.length && script >= 0 && !made?.has(script)) scripts.push(args[script]!);
  return scripts.length > 0 && scripts.every(sedReads);
}

// awk [-F fs] [-v var=value]... 'program' [file]...: a program that neither
// runs anything (system, a pipe, an extension) nor prints into a file. A `>`
// redirects only inside a print statement, so one before the first print
// compares. Judged on the program's text as written, strings included.
function awkReadOnly(args: string[]): boolean {
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") { i++; break; }
    if (!a.startsWith("-") || a === "-") break;
    if (a === "-F" || a === "-v") i++; // its value is the next word
    else if (!/^-[Fv]./.test(a)) return false; // -f, -i, -e, --source, and what is not known
  }
  const program = args[i];
  if (program === undefined || args.slice(i + 1).some((a) => a.startsWith("-") && a !== "-")) return false;
  const print = program.indexOf("print");
  return !/[|@`]|system/.test(program) && (print < 0 || !program.slice(print).includes(">"));
}

// test and [: `-v` and `-R` make bash evaluate a subscript, which runs the
// substitutions written in it. With a word an expansion makes, only the forms
// whose operator is written out: one operand, a unary test, a binary test.
function testReadOnly(prog: string, args: string[], dyn: number[], splits: boolean): boolean {
  let a = args.map((w, k) => ({ w, made: dyn.includes(k + 1) }));
  if (prog === "[" && a.at(-1)?.w === "]") a = a.slice(0, -1);
  if (a.some((x) => !x.made && (x.w === "-v" || x.w === "-R"))) return false;
  if (!a.some((x) => x.made)) return true;
  if (splits) return false;
  while (a[0] && !a[0].made && a[0].w === "!") a = a.slice(1);
  if (a.length === 2) return !a[0]!.made;
  if (a.length === 3) return !a[1]!.made && /^(=|==|!=|-eq|-ne|-lt|-le|-gt|-ge|-nt|-ot|-ef)$/.test(a[1]!.w);
  return a.length < 2;
}

const GIT_VALUE = /^(-C|--git-dir|--work-tree|--namespace|--super-prefix|--attr-source)$/; // their value is the next word
const GIT_FLAG = /^(-P|--no-pager|--no-replace-objects|--no-lazy-fetch|--no-optional-locks|--no-advice|--bare|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--(git-dir|work-tree|namespace|attr-source)=.*)$/;
// Listing options of git tag and git branch. The ones in GIT_LISTS turn the command into a listing, so a name after them is a pattern, not a tag or branch to make.
const GIT_LISTS = /^(--list|--(contains|no-contains|merged|no-merged|points-at)(=.+)?)$/;
const GIT_TAG_LIST = /^(-l|--list|-n\d*|-i|--ignore-case|--sort=.+|--format=.+|--color(=.+)?|--no-color|--column(=.+)?|--no-column|--(contains|no-contains|merged|no-merged|points-at)(=.+)?)$/;
const GIT_BRANCH_LIST = /^(-a|-r|-v|-vv|-i|--all|--remotes|--verbose|--list|--show-current|--ignore-case|--omit-empty|--no-color|--no-column|--no-abbrev|--(color|column|abbrev|format|sort|contains|no-contains|merged|no-merged|points-at)(=.+)?)$/;
// git config: the options that only choose where to read and how to print. --file, --blob, -e, --add, --unset, --replace-all and the section commands are not among them.
const GIT_CONFIG_FLAG = /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--global|--local|--system|--worktree|--show-origin|--show-scope|--name-only|-z|--null|--bool|--int|--bool-or-int|--path|--expiry-date|--includes|--no-includes|--type=\w+|--default=.*)$/;

// git config reads when it lists, gets by an option, or is given one name (a name has a dot; a second operand is the value to set).
function gitConfigReads(rest: string[]): boolean {
  if (!rest.every((a) => !a.startsWith("-") || GIT_CONFIG_FLAG.test(a))) return false;
  const names = rest.filter((a) => !a.startsWith("-"));
  if (rest.some((a) => a === "--list" || a === "-l")) return names.length === 0;
  if (rest.includes("--get-urlmatch")) return names.length === 2;
  if (rest.some((a) => /^--get(-all|-regexp)?$/.test(a))) return names.length === 1 || names.length === 2;
  if (names[0] === "list") return names.length === 1;
  if (names[0] === "get") return names.length === 2;
  return names.length === 1 && names[0]!.includes(".");
}

// Options of the reading subcommands that take no value: a `--` right after one of them ends the options, and is not a value.
const GIT_PLAIN = /^(-\d+|-[pqswbrtzc]+|--[a-z-]+=.*|--(oneline|stat|shortstat|numstat|name-only|name-status|cached|staged|patch|no-patch|graph|all|no-merges|merges|first-parent|follow|reverse|quiet|abbrev-commit|no-color|color|decorate|summary|raw|full-history|word-diff|cc|porcelain|short|long|tags|branches|remotes|ignore-all-space|ignore-space-change|check|exit-code|verify|heads|left-right|cherry-pick|no-index|text|minimal|patience|histogram|full-index|no-renames|find-renames|others|modified|deleted|stage|unmerged|ignored|exclude-standard|line-number|files-with-matches|ignore-case|word-regexp|fixed-strings|extended-regexp|perl-regexp|untracked))$/;

// `made`: the arguments an expansion makes, with what is known of each.
function gitReadOnly(args: string[], made?: Map<number, Kind>): boolean {
  // git --version, and the usage text of git --help and git help with no topic (a topic opens its manual page in a pager).
  if (/^(--version|-v)$/.test(args[0] ?? "")) return !made && args.slice(1).every((a) => a === "--build-options");
  if (args.length === 1 && /^(--help|-h|help)$/.test(args[0]!)) return !made;
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-") && !made?.has(i)) {
    // The folder of -C may come from an expansion when it stays one word.
    if (GIT_VALUE.test(args[i]!)) { if (made?.has(i + 1) && (args[i] !== "-C" || made.get(i + 1) === null || made.get(i + 1) === "hashes")) return false; i += 2; }
    else if (GIT_FLAG.test(args[i]!)) i++;
    else return false; // -c, --exec-path and --config-env run or set things; the rest is not known
  }
  if (made?.has(i)) return false; // the subcommand itself
  const sub = args[i];
  const rest = args.slice(i + 1);
  // --help after a subcommand opens its manual page (in a pager, or with -w in a browser). -h prints the usage.
  if (rest.some((a) => a.startsWith("--help"))) return false;
  const loose = made ? [...made.keys()].filter((k) => k > i).map((k) => k - i - 1) : [];
  if (loose.length) {
    // Among a reading subcommand's arguments an expansion is a revision, a pattern or a path: after --, or when it cannot be an option.
    // Not after --end-of-options: blame and shortlog read the options behind it all the same (git 2.53), and git before 2.24 does not know it.
    if (!sub || !GIT_READ.has(sub) || sub === "reflog") return false;
    const end = optionsEnd(rest, (k) => made!.has(k + i + 1), GIT_PLAIN);
    if (loose.some((k) => !(end >= 0 && k > end) && !/^(operand|hashes|option)$/.test(made!.get(k + i + 1) ?? ""))) return false;
  }
  if (rest.some((a) => a.startsWith("--output") || a === "--ext-diff")) return false;
  // git grep -O / --open-files-in-pager runs the pager it names on the hits.
  if (sub === "grep" && rest.some((a) => /^-[a-zA-Z0-9]*O/.test(a) || long(a, "open-files-in-pager") || a.startsWith("--open-files-in-pager"))) return false;
  if (sub === "branch") return rest.every((a) => (a.startsWith("-") ? GIT_BRANCH_LIST.test(a) : rest.some((x) => GIT_LISTS.test(x))));
  // remote show, update and prune ask the remote; add, remove, rename and set-url change the configuration.
  if (sub === "remote") return rest.every((a) => /^(-v|-vv|--verbose)$/.test(a)) || rest[0] === "get-url";
  if (sub === "tag") return rest.every((a) => (a.startsWith("-") ? GIT_TAG_LIST.test(a) : rest.some((x) => x === "-l" || GIT_LISTS.test(x))));
  if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
  if (sub === "config") return gitConfigReads(rest);
  // reflog expire, delete, drop and write change it; a bare ref name shows it, and is not told from a later subcommand.
  if (sub === "reflog") return rest[0] === undefined || rest[0].startsWith("-") || /^(show|list|exists)$/.test(rest[0]);
  // symbolic-ref NAME prints it; a second operand, -d and -m change it.
  if (sub === "symbolic-ref") return rest.filter((a) => !a.startsWith("-")).length === 1 && rest.every((a) => !a.startsWith("-") || /^(--short|-q|--quiet|--no-recurse)$/.test(a));
  // worktree add, remove, move, prune, lock and repair change things; submodule update, init, add and sync too; notes add, edit, remove and merge too.
  if (sub === "worktree") return rest[0] === "list" && rest.slice(1).every((a) => /^(--porcelain|-v|--verbose|-z)$/.test(a));
  if (sub === "submodule") return rest.length === 0 || rest[0] === "status";
  if (sub === "notes") return rest.length === 0 || rest[0] === "list" || rest[0] === "show";
  return !!sub && GIT_READ.has(sub);
}

// What is known of a word an expansion makes: "operand": one word that cannot
// be an option (it starts with literal text that is not a dash, or with the
// home or working directory, or holds only what prints a path or commit
// hashes); "hashes": commit hashes, one word or several, none an option;
// "option": one word that starts with a written-out --name=; "word": one word
// of unknown text; null: nothing is known.
export type Kind = "operand" | "hashes" | "option" | "word" | null;

// A revision as it is written: no leading dash, nothing the shell or git reads as more than a name.
const REV = /^[A-Za-z0-9_.\/@^~{}][A-Za-z0-9_.\/@^~{}-]*$/;

// What the one command of a substitution prints, when the rules know its shape: commit hashes (or a
// revision as written, when git cannot resolve it), or an absolute path. null: anything.
function prints(parts: Simple[]): "hashes" | "path" | null {
  const p = parts[0];
  if (parts.length !== 1 || !p || p.unknown || p.redirects || p.dyn || p.inputs || p.heredoc) return null;
  // Its errors are not its output: 2>/dev/null is the one redirect let through (2>&1 would put them in the word).
  if (/[<>]/.test(p.text.replace(/2>\s*\/dev\/null/g, ""))) return null;
  const w = p.words;
  if (w[0] === "pwd") return w.length === 1 || (w.length === 2 && /^-[LP]$/.test(w[1]!)) ? "path" : null;
  if (w[0] !== "git") return null;
  const [sub, ...rest] = w.slice(1);
  if (sub === "rev-parse" && rest.length === 1 && /^--(show-toplevel|absolute-git-dir)$/.test(rest[0]!)) return "path";
  const flags = rest.filter((a) => a.startsWith("-"));
  const all = (re: RegExp) => flags.every((f) => re.test(f));
  if (!rest.every((a) => a.startsWith("-") || REV.test(a))) return null;
  if (sub === "merge-base") return all(/^(--fork-point|--octopus|-a|--all|--independent|--is-ancestor)$/) ? "hashes" : null;
  if (sub === "rev-parse") return rest.length > flags.length && all(/^(--verify|-q|--quiet|--short|--short=\d+)$/) ? "hashes" : null;
  if (sub === "rev-list") return all(/^(-\d+|-n|-n\d+|--max-count=\d+|--first-parent|--no-merges|--merges|--reverse|--all|--branches|--tags|--remotes)$/) ? "hashes" : null;
  return null; // git log --format=%H is not here: with log.showSignature set it prints the signature check too
}

function wordKind(m: Made, word: string, flow: boolean): Kind {
  // A dash right after an expansion would open the word when the expansion is empty.
  const dash = m.lead.startsWith("-") || /(\)|`|\}|\$[A-Za-z0-9_]+)-/.test(word);
  if (!m.rest && !m.vars.length && m.subs.length && !dash) {
    const out = m.subs.map(prints);
    if (out.every((o) => o === "hashes")) return m.one ? "operand" : "hashes";
    if (m.one && out.every((o) => o)) return "operand";
  }
  if (!m.one) return null;
  if (m.lead && !m.lead.startsWith("-")) return "operand";
  // "$HOME/x" and "$PWD/x": the home and the working directory are absolute paths, unless the line gave them another value.
  const v = m.vars[0];
  if (v && v.at === 0 && !flow && (v.name === "HOME" || v.name === "PWD") && (word.length === v.len || word[v.len] === "/")) return "operand";
  if (/^--[a-z][a-z0-9-]*=/.test(m.lead)) return "option";
  return "word";
}

// Where the options end among `args`: the first written-out `--` that stands first, after an operand or after an
// option that takes no value (`plain`). After any other option it may be that option's value: -1, as when there is none.
function optionsEnd(args: string[], made: (i: number) => boolean, plain: RegExp): number {
  const i = args.findIndex((a, k) => a === "--" && !made(k));
  if (i <= 0) return i;
  const before = args[i - 1]!;
  return !made(i - 1) && (!before.startsWith("-") || plain.test(before)) ? i : -1;
}

// Programs that are files on disk and read whatever their arguments are: what xargs and find -exec may run.
const runsAsReader = (prog: string | undefined) => !!prog && ((READ_PROGRAMS.has(prog) && prog !== "cd" && prog !== "type") || anyArguments(prog));

// find: -delete removes, -fprint, -fprint0, -fprintf and -fls write a file, -ok and -okdir ask on the terminal and then run.
// -exec and -execdir run a program on what was found: a read only when that program reads whatever its arguments are.
function findReadOnly(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (/^-(ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a)) return false;
    if (a !== "-exec" && a !== "-execdir") continue;
    if (!runsAsReader(args[i + 1])) return false;
    // The command ends at `;`, or at a `+` right after `{}`.
    let end = i + 2;
    while (end < args.length && args[end] !== ";" && !(args[end] === "+" && args[end - 1] === "{}")) end++;
    if (end >= args.length) return false;
    i = end;
  }
  return true;
}

// [[ ... ]]: no word is split and no expansion is read as an operator there, so its operands may be anything.
// -v and -R evaluate a subscript, and the arithmetic comparisons evaluate both sides: either runs a substitution a value holds.
function condReadOnly(args: string[], dyn: number[]): boolean {
  if (args.at(-1) !== "]]" || dyn.includes(args.length)) return false;
  return !args.some((w, k) => !dyn.includes(k + 1) && /^-(v|R|eq|ne|lt|le|gt|ge)$/.test(w));
}

// A command that cannot change anything (files, processes, the network state).
export function isReadOnly(s: Simple): boolean {
  if (s.heredoc) return true;
  if (s.unknown || s.redirects) return false;
  const { env, words } = body(s.words);
  // `name=value` alone gives a shell variable a value. A name in capitals may be one the shell or a program reads (PATH, IFS, GIT_DIR).
  if (!words.length) return s.words.every((w) => /^[a-z_][a-z0-9_]*=/.test(w) && !KEPT.test(w.slice(0, w.indexOf("="))));
  const [prog, ...args] = words;
  const lead = s.words.length - words.length;
  // An assignment before a command changes what that command runs with. `IFS= read` only says how read splits its line.
  if (env && !(prog === "read" && s.words.slice(0, lead).every((w) => w.startsWith("IFS=")))) return false;
  const dyn = (s.dyn ?? []).filter((n) => n >= lead).map((n) => n - lead);
  if (dyn.includes(0)) return false; // the program's name is made by an expansion
  const reader = READERS.get(prog!);
  if (READ_PROGRAMS.has(prog!) || reader === true) return true;
  // Builtins that evaluate one of their words.
  if (prog === "test" || prog === "[") return testReadOnly(prog, args, dyn, !!s.splits);
  if (prog === "[[") return condReadOnly(args, dyn);
  // printf -v NAME (or -vNAME) assigns, and a subscript in the name is evaluated. Its first word is an option or the format.
  if (prog === "printf") return !dyn.includes(1) && (!args[0]?.startsWith("-") || args[0] === "--");
  // command -v and -V say what a name is; without them command runs it. Nothing after takes that back.
  if (prog === "command") return !dyn.includes(1) && /^-[pvV]*[vV][pvV]*$/.test(args[0] ?? "");
  if (!dyn.length) return byArguments(prog!, args);
  // The rest read or write by their arguments, and one an expansion makes ($(echo -delete), {-delete,x}) is not known from the text.
  // It is let through where it cannot be an option that writes: see wordKind.
  const made = new Map<number, Kind>();
  (s.dyn ?? []).forEach((n, k) => { if (n > lead) made.set(n - lead - 1, s.how?.[k] ? wordKind(s.how[k]!, s.words[n]!, !!s.flow) : null); });
  if (prog === "git") return gitReadOnly(args, made);
  if (prog === "sed") return sedReadOnly(args, made);
  // Programs whose operands are only read. The ones in ENDS take `--` as the end of their options.
  const plain = ENDS.get(prog!);
  if (!plain && prog !== "find" && prog !== "tree" && typeof reader !== "object") return false;
  const end = plain ? optionsEnd(args, (i) => made.has(i), plain) : -1;
  for (const [i, kind] of made) if (!(end >= 0 && i > end) && kind !== "operand" && kind !== "hashes" && (kind !== "option" || prog === "find")) return false;
  // What find -exec runs ends at a `;` or a `+`, which an expansion could be.
  if (prog === "find" && args.some((a) => a === "-exec" || a === "-execdir")) return false;
  return byArguments(prog!, args);
}

// A program that reads or writes by its arguments, all of them as written.
function byArguments(prog: string, args: string[]): boolean {
  const reader = READERS.get(prog);
  if (reader) return typeof reader === "function" ? reader(args) : !denied(reader as { short?: string; long?: string[] }, args);
  if (prog === "env" || prog === "hostname") return args.length === 0; // `env CMD` runs CMD; `hostname X` sets it
  if (prog === "date") return !dateSets(args);
  if (prog === "find") return findReadOnly(args);
  // xargs runs a program on words it reads: a read when that program reads whatever its arguments are (echo when none is named).
  if (prog === "xargs") { const run = xargsCommand(args); return !!run && (run.length === 0 || runsAsReader(run[0])); }
  // Flags that write a file or run another program.
  if (prog === "sort") return !args.some((a) => /^-[a-zA-Z0-9]*o/.test(a) || long(a, "output", "compress-program"));
  if (prog === "rg") return !args.some((a) => /^--(pre|hostname-bin)(=|$)/.test(a));
  if (prog === "fd") return !args.some((a) => /^-[a-zA-Z0-9]*[xX]/.test(a) || /^--exec(-batch)?(=|$)/.test(a));
  if (prog === "tree") return !args.some((a) => /^-[a-zA-Z0-9]*[oR]/.test(a) || a.startsWith("--output")); // -R writes 00Tree.html in each folder
  if (prog === "uniq") return uniqOperands(args) <= 1 && !args.some((a) => /[*?[]/.test(a)); // a second operand is the file it writes
  if (prog === "file") return !args.some((a) => /^-[a-zA-Z0-9]*[Cp]/.test(a) || long(a, "compile", "preserve-date")); // -p sets the file's times back after reading it
  if (prog === "sed") return sedReadOnly(args);
  if (prog === "awk" || prog === "gawk" || prog === "mawk" || prog === "nawk") return awkReadOnly(args);
  if (prog === "git") return gitReadOnly(args);
  return false;
}

// What the line's first commands give its variables, used where a later word reads them. A line that opens with
// `name=value` assignments (ended by `;`, a newline or `&&`) runs them before anything else, so `$name` after them
// is that value: a written-out one is put in its place, and the output of a substitution stands where the variable
// does. Not when a loop, a conditional or a group stands before the use, nor when anything else on the line could
// give the name another value.
const ASSIGNS = /^(read|declare|typeset|local|export|readonly|unset|printf|mapfile|readarray|getopts|let|wait|coproc|builtin|command|eval|source|\.)$/;
const WRITTEN = /^[A-Za-z0-9_.\/@:+,=%^-]+$/; // no blank, quote, glob or tilde: the same word quoted or not
// A line that opens with more assignments than this is left as it is (its variables then ask): the work stays in step with the line's length.
const MOST = 64;
export function resolveVariables(parts: Simple[]): Simple[] {
  // `at`: where the assignment stands among the parts. Only what runs after it reads its value.
  const known = new Map<string, { text?: string; sub?: Simple[]; at: number }>();
  const dead = new Set<string>();
  let seen = 0;
  for (let at = 0; at < parts.length; at++) {
    const p = parts[at]!;
    if (p.nested) continue; // the commands of a substitution in a value
    if (p.flow || p.unknown || p.redirects || p.heredoc || !p.words.length || !p.words.every((w) => /^[a-z_][a-z0-9_]*=/.test(w))) break;
    if (p.sep && p.sep !== "&&" && p.sep !== "||") break; // in a pipeline or the background it runs in a shell of its own
    if ((seen += p.words.length) > MOST) return parts;
    let certain = true; // a substitution's failure is the assignment's: what follows `&&` may not run
    p.words.forEach((w, k) => {
      const name = w.slice(0, w.indexOf("="));
      const value = w.slice(name.length + 1);
      const m = p.how?.[p.dyn?.indexOf(k) ?? -1];
      if (known.has(name) || dead.has(name)) { known.delete(name); dead.add(name); }
      else if (!m) { if (WRITTEN.test(value)) known.set(name, { text: value, at }); else dead.add(name); }
      else {
        certain = false;
        if ((value === "$(...)" || value === "`...`") && m.subs.length === 1 && !m.rest && !m.vars.length && prints(m.subs[0]!) === "hashes") known.set(name, { sub: m.subs[0]!, at });
        else dead.add(name);
      }
    });
    if (p.sep === "||" || (p.sep === "&&" && !certain)) break;
  }
  // Anything else on the line that could give a name a value takes the knowledge away: one pass over its words.
  for (let at = 0; at < parts.length && known.size; at++) {
    const p = parts[at]!;
    const prog = body(p.words).words[0] ?? "";
    const names = ASSIGNS.test(prog);
    if (names && (p.dyn || /^(eval|source|\.)$/.test(prog))) { known.clear(); break; }
    for (const w of p.words) {
      const given = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=|\[)/.exec(w)?.[1];
      if (given !== undefined && known.get(given)?.at !== at) known.delete(given);
      if (names) known.delete(w);
    }
  }
  if (!known.size) return parts;
  return parts.map((p, at) => {
    if (!p.dyn || !p.how || p.flow) return p;
    const words = [...p.words];
    const dyn: number[] = [];
    const how: Made[] = [];
    // A substitution in the assignment's own value runs before the assignment.
    const value = (name: string) => { const k = known.get(name); return k && k.at < at ? k : undefined; };
    p.dyn.forEach((n, k) => {
      const m = p.how![k]!;
      const mine = m.vars.map((v) => value(v.name));
      if (m.vars.length && !m.rest && !m.subs.length && mine.every((v) => v?.text !== undefined)) {
        // Every expansion in the word is a variable with a written-out value: the word is that text.
        let w = words[n]!;
        for (let v = m.vars.length - 1; v >= 0; v--) w = w.slice(0, m.vars[v]!.at) + mine[v]!.text + w.slice(m.vars[v]!.at + m.vars[v]!.len);
        words[n] = w;
        return;
      }
      // A variable that holds a substitution's output is that substitution, where it stands.
      const subs = mine.flatMap((v) => (v?.sub ? [v.sub] : []));
      dyn.push(n);
      how.push(subs.length ? { ...m, subs: [...m.subs, ...subs], vars: m.vars.filter((_, v) => !mine[v]?.sub) } : m);
    });
    const { dyn: _d, how: _h, splits, ...rest } = p;
    return { ...rest, words, ...(dyn.length ? { dyn, how, ...(splits ? { splits } : {}) } : {}) };
  });
}

// The form of a command that would be read as a read, when an expansion among its arguments is all that keeps it from being one.
export function readForm(s: Simple): string | null {
  if (!s.dyn || isReadOnly(s) || !isReadOnly({ ...s, dyn: undefined, how: undefined, splits: undefined })) return null;
  const prog = body(s.words).words[0] ?? "";
  if (prog === "git") return "put -- before it when it names files, write the value out, or quote it after written-out text (\"refs/tags/$tag\")";
  if (ENDS.has(prog) || prog === "sed") return "put -- before it, or write the value out";
  return "write the value out, or quote it after written-out text (\"./$x\")";
}

// Whether a whole command line only reads. Not one the parser cannot split, and not an empty one.
export function readOnlyCommand(command: string): boolean {
  const parts = splitCommand(command);
  return !!parts && parts.length > 0 && resolveVariables(parts).every(isReadOnly);
}

// Why a command is dangerous enough that no standing answer may cover it,
// in every mode. null when it is not.
export function highRisk(s: Simple): string | null {
  const { words } = body(s.words);
  const [prog, ...args] = words;
  if (!prog) return null;
  if (prog === "sudo" || prog === "doas" || prog === "pkexec") return "runs as root";
  if (prog === "rm") {
    const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive");
    const targets = args.filter((a) => !a.startsWith("-"));
    const wide = targets.find((t) => /^(\/|~|~\/|\$HOME\/?|\.\.?\/?|\*|\/\*|~\/\*|\$HOME\/\*)$/.test(t) || /^\/(home|etc|usr|var|bin|lib|boot|opt|root)\/?$/.test(t));
    if (recursive && wide) return `deletes ${wide} recursively`;
    if (args.includes("--no-preserve-root")) return "deletes the root directory";
  }
  if (prog === "git") {
    const sub = args.find((a) => !a.startsWith("-"));
    if (sub === "push" && args.some((a) => a === "--force" || a === "-f" || a.startsWith("--force") || a === "--mirror" || /^\+/.test(a) || a === "--delete" || a === "-d" || /^:./.test(a)))
      return "rewrites or deletes history on a remote";
    if (sub === "reset" && args.includes("--hard")) return "discards uncommitted work";
    if (sub === "clean" && args.some((a) => /^-[a-zA-Z]*f/.test(a))) return "deletes untracked files";
    if (sub === "checkout" && args.includes("--") && args.includes(".")) return "discards uncommitted work";
    if (sub === "restore" && args.includes(".") && !args.includes("--staged")) return "discards uncommitted work";
  }
  if (/^mkfs/.test(prog) || prog === "wipefs" || prog === "fdisk" || prog === "parted") return "formats or repartitions a disk";
  if (prog === "dd" && args.some((a) => /^of=\/dev\/(?!(null|stdout|stderr)$)/.test(a))) return "writes a raw device";
  if ((prog === "chmod" || prog === "chown") && args.some((a) => /^-[a-zA-Z]*R/.test(a)) && args.some((a) => /^(\/|~|\$HOME)\/?$/.test(a))) return "changes ownership or modes of a whole tree";
  if (prog === "shutdown" || prog === "reboot" || prog === "poweroff" || prog === "halt") return "stops the machine";
  return null;
}

const FETCHERS = new Set(["curl", "wget", "aria2c", "http", "xh"]);
const RUNNERS = /^(sh|bash|zsh|dash|ksh|fish|python3?|perl|ruby|node|bun|deno)$/;

// What makes the whole line high risk beyond its parts: a script fetched from
// the network and run by a shell or interpreter that reads it from a pipe or
// a substitution (curl URL | sh, bash <(curl URL), sh -c "$(curl URL)").
export function lineRisk(parts: Simple[]): string | null {
  const fetches = parts.some((p) => FETCHERS.has(body(p.words).words[0] ?? ""));
  if (!fetches) return null;
  const runs = parts.some((p) => {
    const [prog, ...args] = body(p.words).words;
    if (!prog || !RUNNERS.test(prog)) return false;
    const operands = args.filter((a) => !a.startsWith("-") || a === "-");
    return !operands.length || operands.includes("-") || args.includes("-s") || args.some((a) => a.includes("$(...)") || a.includes("`...`"));
  });
  return runs ? "runs a downloaded script" : null;
}

// Every reason the line is high risk: each part's, and the line's own.
export const risksOf = (parts: Simple[]): string[] => [...new Set([...parts.map(highRisk), lineRisk(parts)].filter((r): r is string => !!r))];

// A rule pattern in Claude Code's form: `git log *` matches `git log` and
// anything after it; a pattern without `*` matches exactly. `*` elsewhere
// stands for any text.
export function matchRule(pattern: string, s: Simple): boolean {
  const { words } = body(s.words);
  const cmd = words.join(" ");
  const p = pattern.trim().replace(/:\*$/, " *");
  if (!p.includes("*")) return cmd === p;
  if (p.endsWith(" *") && p.indexOf("*") === p.length - 1) {
    const pre = p.slice(0, -2);
    return cmd === pre || cmd.startsWith(pre + " ");
  }
  const re = new RegExp("^" + p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(cmd);
}

const MULTI = new Set(["git", "npm", "pnpm", "yarn", "bun", "bunx", "npx", "cargo", "go", "docker", "podman", "kubectl", "gh", "uv", "pip", "python", "python3", "make", "systemctl", "brew", "apt", "deno", "rustup", "terraform", "aws"]);

// The rule "allow always" suggests for a command: the program and its
// subcommand, then `*`.
export function suggestRule(s: Simple): string {
  const { words } = body(s.words);
  const [prog, second] = words;
  if (!prog) return s.text;
  if (second && MULTI.has(prog) && /^[a-z][\w:.-]*$/i.test(second) && !second.includes("/")) return `${prog} ${second} *`;
  return `${prog} *`;
}
