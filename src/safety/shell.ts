// Shell command analysis for the permission gate: split a command line into
// the simple commands it runs, decide which are read-only, which are high
// risk, and whether a stored rule covers each one. Pure functions.

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
// text. `inputs`: the files it reads through a redirect.
export type Simple = { words: string[]; text: string; redirects: boolean; nested?: true; unknown?: true; heredoc?: true; dyn?: number[]; splits?: true; inputs?: string[] };

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
function scan(cmd: string, start: number, inner: boolean): { parts: Simple[]; end: number } | null {
  if (level >= 64) return null;
  level++;
  try { return scanIn(cmd, start, inner); } finally { level--; }
}
function scanIn(cmd: string, start: number, inner: boolean): { parts: Simple[]; end: number } | null {
  const out: Simple[] = [];
  let words: string[] = [];
  let dyn: number[] = [];
  let splits = false;
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
      if (made) dyn.push(words.length);
      words.push(word);
    }
    word = "";
    inWord = false;
    quoted = false;
    made = false;
  };
  const flushCmd = () => {
    flushWord();
    if (want) { bad = true; want = null; }
    // `for x in ...`, `select x in ...` and `case ... in` headers run nothing themselves.
    if (/^(for|select|case)$/.test(words[0] ?? "")) words = [];
    let lead = 0;
    while (lead < words.length && CONTROL.test(words[lead]!)) lead++;
    words = words.slice(lead);
    dyn = dyn.map((n) => n - lead).filter((n) => n >= 0 && n < words.length);
    if (words.length || redirects || unknown || inputs.length)
      out.push({
        words, text: text.trim(), redirects,
        ...(depth > 0 ? { nested: true as const } : {}), ...(unknown ? { unknown: true as const } : {}),
        ...(dyn.length ? { dyn } : {}), ...(dyn.length && splits ? { splits: true as const } : {}), ...(inputs.length ? { inputs } : {}),
      });
    words = [];
    dyn = [];
    inputs = [];
    splits = false;
    text = "";
    redirects = false;
    unknown = false;
  };
  // $( at j: the commands inside, and where its ) is. $(( is arithmetic: it
  // evaluates the names in it, and a name's value can hold a substitution.
  const substitution = (j: number): number | null => {
    const r = scan(cmd, j + 2, true);
    if (!r) return null;
    out.push(...nestedIn(r.parts));
    if (cmd[j] === "$" && cmd[j + 2] === "(") unknown = true;
    return r.end;
  };
  // $ at j outside single quotes: the word it is in is made by an expansion.
  // ${name}, ${#name} and the forms that default, trim or replace are followed;
  // the rest index, slice or evaluate (${a[i]}, ${x:i}, ${!x}, ${x@P}, $[...])
  // and can run what a value holds.
  const dollar = (j: number, inDouble: boolean) => {
    const n = cmd[j + 1] ?? "";
    if (n === '"' && !inDouble) made = true; // $"..." is the string with the $ dropped: the word is not what it reads
    else if (n === "[") unknown = true;
    else if (n === "{") {
      made = true;
      splits ||= !inDouble;
      if (!inDouble) param++;
      if (!/^\$\{#?[A-Za-z_][A-Za-z0-9_]*(\}|:?[-=?+]|[#%\/^,])/.test(cmd.slice(j, j + 200))) unknown = true;
    } else if (/[A-Za-z0-9_@*!=~^+-]/.test(n)) { // $=x, $~x, $^x and $+x are zsh's
      made = true;
      splits ||= !inDouble || n === "@" || n === "*";
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
    const r = scan(code, 0, false);
    if (!r) return null;
    out.push(...nestedIn(r.parts));
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
        for (let k = first; k < last; k++) {
          if (cmd[k] === "\\") { k++; continue; }
          if (cmd[k] === "$" && cmd[k + 1] !== "(") dollar(k, true);
          const end = cmd[k] === "$" && cmd[k + 1] === "(" ? substitution(k) : cmd[k] === "`" ? backquoted(k, false) : k;
          if (end === null) return null;
          k = Math.min(end, last);
        }
        [made, splits] = word as [boolean, boolean];
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
        if (ansi && cmd[j] === "\\" && j + 1 < cmd.length) { j++; made = true; }
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
          const end = cmd[j] === "$" ? substitution(j) : backquoted(j, true);
          if (end === null) return null;
          lit += cmd[j] === "$" ? "$(...)" : "`...`";
          made = true;
          j = end;
          continue;
        }
        if (cmd[j] === "$") { dollar(j, true); if (cmd[j + 1] === "{") braces++; }
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
      const end = substitution(i);
      if (end === null) return null;
      // <(...) and >(...) become a file name; $(...) becomes whatever the command prints.
      if (c === "$") made = splits = true;
      word += "$(...)"; inWord = true; text += cmd.slice(i, end + 1); i = end;
      continue;
    }
    if (c === "`") {
      const end = backquoted(i, false);
      if (end === null) return null;
      made = splits = true;
      word += "`...`"; inWord = true; text += cmd.slice(i, end + 1); i = end;
      continue;
    }
    if (c === "$") {
      dollar(i, false);
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
      flushCmd();
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
    if (c === "{" && cmd[i - 1] !== "$" && braceExpands(cmd, i)) made = splits = true;
    if (c === "}" && param) param--;
    // A glob that opens a word can expand to an option (a file named -o): not known from the text.
    if ((c === "*" || c === "?" || c === "[") && !want && !words.every((w) => CONTROL.test(w)) && (word === "" || word.startsWith("-"))) made = splits = true;
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
  "sha256sum", "md5sum", "free", "uptime", "nproc", "lsof", "ps", "printenv",
]);
const GIT_READ = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "grep", "describe", "shortlog",
  "cat-file", "merge-base", "rev-list", "reflog", "whatchanged", "name-rev", "for-each-ref", "check-ignore",
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

// A GNU long option, which may be cut short as far as it stays one option: --out is --output.
const long = (a: string, ...names: string[]) => {
  if (!a.startsWith("--") || a.length < 3) return false;
  const given = a.slice(2).split("=")[0]!;
  return names.some((n) => n.startsWith(given));
};

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
function sedReadOnly(args: string[]): boolean {
  const scripts: string[] = [];
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") { operands.push(...args.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      if (a.startsWith("--expression=")) scripts.push(a.slice(13));
      else if (a === "--expression" && i + 1 < args.length) scripts.push(args[++i]!);
      else if (!/^--(quiet|silent|regexp-extended|separate|unbuffered|null-data|posix|debug|sandbox|line-length=\d+)$/.test(a)) return false; // --in-place, --file, a cut-short form
    } else if (a.startsWith("-") && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        if ("nErsuz".includes(a[k]!)) continue;
        if (a[k] !== "e" && a[k] !== "l") return false; // -i, -f, and what is not known
        const value = a.slice(k + 1) || args[++i];
        if (value === undefined) return false;
        if (a[k] === "e") scripts.push(value);
        break;
      }
    } else operands.push(a);
  }
  if (!scripts.length && operands.length) scripts.push(operands[0]!);
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
const GIT_TAG_LIST = /^(-l|--list|-n\d*|-i|--ignore-case|--sort=.+|--format=.+|--color(=.+)?|--no-color|--column(=.+)?|--no-column)$/;

function gitReadOnly(args: string[]): boolean {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    if (GIT_VALUE.test(args[i]!)) i += 2;
    else if (GIT_FLAG.test(args[i]!)) i++;
    else return false; // -c, --exec-path and --config-env run or set things; the rest is not known
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (rest.some((a) => a.startsWith("--output") || a === "--ext-diff")) return false;
  // git grep -O / --open-files-in-pager runs the pager it names on the hits.
  if (sub === "grep" && rest.some((a) => /^-[a-zA-Z0-9]*O/.test(a) || long(a, "open-files-in-pager") || a.startsWith("--open-files-in-pager"))) return false;
  if (sub === "branch") return rest.every((a) => /^(-a|-r|-v|-vv|--list|--all|--show-current|--contains|--merged|--no-merged)$/.test(a) || !a.startsWith("-") && rest.includes("--list"));
  if (sub === "remote") return rest.length === 0 || (rest.length === 1 && rest[0] === "-v") || rest[0] === "get-url";
  if (sub === "tag") return rest.every((a) => (a.startsWith("-") ? GIT_TAG_LIST.test(a) : rest.includes("-l") || rest.includes("--list")));
  if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
  if (sub === "config") return /^(--get|--list|-l)$/.test(rest[0] ?? "") && !rest.some((a) => /^(-e|--edit|--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section)$/.test(a));
  // reflog expire, delete, drop and write change it; a bare ref name shows it, and is not told from a later subcommand.
  if (sub === "reflog") return rest[0] === undefined || rest[0].startsWith("-") || /^(show|list|exists)$/.test(rest[0]);
  return !!sub && GIT_READ.has(sub);
}

// A command that cannot change anything (files, processes, the network state).
export function isReadOnly(s: Simple): boolean {
  if (s.heredoc) return true;
  if (s.unknown || s.redirects) return false;
  const { env, words } = body(s.words);
  if (env || !words.length) return !words.length && !env;
  const [prog, ...args] = words;
  const dyn = s.dyn ?? [];
  if (dyn.includes(0)) return false; // the program's name is made by an expansion
  if (READ_PROGRAMS.has(prog!)) return true;
  // Builtins that evaluate one of their words.
  if (prog === "test" || prog === "[") return testReadOnly(prog, args, dyn, !!s.splits);
  // printf -v NAME (or -vNAME) assigns, and a subscript in the name is evaluated. Its first word is an option or the format.
  if (prog === "printf") return !dyn.includes(1) && (!args[0]?.startsWith("-") || args[0] === "--");
  // The rest read or write by their arguments: one an expansion makes ($(echo -delete), {-delete,x}) is not known.
  if (dyn.length) return false;
  if (prog === "env" || prog === "hostname") return args.length === 0; // `env CMD` runs CMD; `hostname X` sets it
  if (prog === "date") return !dateSets(args);
  if (prog === "find") return !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a));
  // Flags that write a file or run another program.
  if (prog === "sort") return !args.some((a) => /^-[a-zA-Z0-9]*o/.test(a) || long(a, "output", "compress-program"));
  if (prog === "rg") return !args.some((a) => /^--(pre|hostname-bin)(=|$)/.test(a));
  if (prog === "fd") return !args.some((a) => /^-[a-zA-Z0-9]*[xX]/.test(a) || /^--exec(-batch)?(=|$)/.test(a));
  if (prog === "tree") return !args.some((a) => /^-[a-zA-Z0-9]*[oR]/.test(a) || a.startsWith("--output")); // -R writes 00Tree.html in each folder
  if (prog === "uniq") return uniqOperands(args) <= 1 && !args.some((a) => /[*?[]/.test(a)); // a second operand is the file it writes
  if (prog === "file") return !args.some((a) => /^-[a-zA-Z0-9]*C/.test(a) || long(a, "compile"));
  if (prog === "sed") return sedReadOnly(args);
  if (prog === "awk" || prog === "gawk" || prog === "mawk" || prog === "nawk") return awkReadOnly(args);
  if (prog === "git") return gitReadOnly(args);
  return false;
}

// Whether a whole command line only reads. Not one the parser cannot split, and not an empty one.
export function readOnlyCommand(command: string): boolean {
  const parts = splitCommand(command);
  return !!parts && parts.length > 0 && parts.every(isReadOnly);
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
