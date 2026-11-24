// What code given on a command line may hold when it handles a file the same line downloaded: a closed set.
// A list of ways to run something is never complete, so the check goes the other way. Once the known reads of the
// file are taken out of the code (risk.ts, PURE_READS), what is left must be made only of the harmless tokens below.
// Any other call, any other attribute, an import of any other module, a lambda or a function, a name that is no
// variable of the code itself: the code may run what it has read, and the line asks.

// Names that may be called. console.log and puts are how JavaScript and Ruby print.
const CALLS = new Set(["print", "len", "str", "int", "float", "list", "dict", "sorted", "sum", "min", "max", "any", "all", "console.log", "puts", "JSON.stringify"]);
// Methods that may be called on a value, and attributes that may be read from one (Python, Ruby, Perl). The first
// four are the dictionary's; the rest only look at a value or cut a string.
const METHODS = new Set(["get", "keys", "values", "items", "head", "tail", "describe", "hexdigest", "digest", "strip", "lstrip", "rstrip", "split", "splitlines", "lower", "upper", "join", "startswith", "endswith", "count"]);
const ATTRS = new Set([...METHODS, "shape", "columns", "dtypes", "size"]);
// Modules a Python import may name. (An import runs nothing of the file. os is here for the known read os.path.getsize
// and the like; any other call or attribute of it is not in the sets above, so the code asks.)
const IMPORTS = new Set(["json", "csv", "yaml", "pandas", "hashlib", "tomllib", "sys", "pathlib", "os"]);
// Words that read as the shape of the code, not as a name.
const WORDS = new Set(["True", "False", "None", "true", "false", "null", "undefined", "NaN", "if", "else", "elif", "for", "while", "in", "of", "not", "and", "or", "is", "const", "let", "var"]);
// Names that run or reach code, or hold the environment (where the tokens are), bound or not, under any spelling.
const NEVER = /^(environ|environb|getenv|getenvb|putenv|exec|execfile|eval|compile|getattr|setattr|delattr|open|input|breakpoint|help|globals|locals|vars|system|require|process|import|Function|constructor|prototype|globalThis|window|global|self|module|exports|Reflect|Proxy|setTimeout|setInterval|setImmediate|Deno|Bun|__\w*)$/;
const STRING = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
const TOKEN = /\s+|(?<num>0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(?<chain>[$@%]?[A-Za-z_$][\w$]*(?:\s*(?:\?\.|\.|->)\s*[A-Za-z_$][\w$]*)*)|(?<dot>\?\.|\.|->)\s*(?<attr>[A-Za-z_$][\w$]*)|(?<str>"")|(?<punct>[()[\]{},:;+\-*/%<>=!&|^~?@])/y;

// Whether code given to interpreter `p` holds only harmless tokens (see above). `text` is the code after the
// known reads of the file were replaced by 0.
export function harmless(p: string, text: string): boolean {
  const py = /^python/.test(p), js = /^(node|nodejs|bun|deno)$/.test(p);
  // A string that can run what is written in it: an f-string, a template, an interpolation.
  if (/`|\$\{|#\{|@\{|\{\$|(?<![\w"'])[fF][rRbB]?["']|(?<![\w"'])[rRbB][fF]["']/.test(text)) return false;
  let code = text.replace(STRING, '""');
  if (code.includes("=>")) return false;
  const bound = new Set<string>();
  // Python's imports: only the modules above. The names they bind (import pandas as pd) are variables of the code.
  if (py) {
    let ok = true;
    code = code.replace(/(^|[;\n])([ \t]*)(?:import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)|from[ \t]+([\w.]+)[ \t]+import[ \t]+(\*|\w+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*\w+(?:[ \t]+as[ \t]+\w+)?)*))(?=[ \t]*(?:[;\n]|$))/g, (all, pre: string, sp: string, mods?: string, from?: string, names?: string) => {
      const listed = mods ? mods.split(",").map((m) => m.trim()) : [];
      if (from !== undefined ? !IMPORTS.has(from) : !listed.every((m) => IMPORTS.has(m.split(/\s+/)[0]!))) { ok = false; return all; }
      for (const m of [...listed, ...(names && names !== "*" ? names.split(",") : [])]) { const as = /\bas\s+(\w+)$/.exec(m.trim()); if (as) bound.add(as[1]!); else if (from !== undefined || /^\w+$/.test(m.trim())) bound.add(m.trim().split(/[\s.]/)[0]!); }
      return `${pre}${sp}`;
    });
    if (!ok) return false;
  }
  // The variables the code makes: assigned, bound by a loop or by const, let and var.
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*[-+*/%|&^]?=(?![=>~])/g)) for (const v of m[1]!.split(",")) bound.add(v.trim());
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]!);
  for (const m of code.matchAll(/\bfor\s*\(?\s*(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*\)?\s+(?:in|of)\b/g)) for (const v of m[1]!.split(",")) bound.add(v.trim());
  const name = (s: string) => s.replace(/^[$@%]/, "");
  const attr = (a: string, called: boolean) => !/^__|^constructor$|^prototype$/.test(a) && (called ? METHODS.has(a) : js || ATTRS.has(a));
  const callAt = (at: number) => /^\s*\(/.test(code.slice(at));
  let prev: "none" | "op" | "name" | "close" | "value" = "none";
  for (let at = 0; at < code.length; ) {
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(code);
    if (!m) return false;
    at = TOKEN.lastIndex;
    const g = m.groups!;
    if (g.num !== undefined) prev = "value";
    else if (g.str !== undefined) prev = "value";
    else if (g.dot !== undefined) {
      if (!attr(g.attr!, callAt(at))) return false;
      prev = "name";
    } else if (g.chain !== undefined) {
      const segs = g.chain.split(/\s*(?:\?\.|\.|->)\s*/), root = segs[0]!, base = name(root);
      const called = callAt(at);
      if (segs.length === 1 && WORDS.has(base)) { prev = "op"; continue; }
      if (NEVER.test(base)) return false;
      if (!CALLS.has(segs.join("."))) {
        if (segs.length === 1 ? called || !(CALLS.has(base) || bound.has(base) || /^[$@]/.test(root)) : !(bound.has(base) || /^[$@]/.test(root))) return false;
        for (let k = 1; k < segs.length; k++) if (!attr(segs[k]!, called && k === segs.length - 1)) return false;
      }
      prev = "name";
    } else {
      const c = g.punct;
      if (c === undefined) continue; // white space
      // A call of something that is no name: f()(), [..](), "..."().
      if (c === "(" && (prev === "close" || prev === "value")) return false;
      prev = c === ")" || c === "]" ? "close" : "op";
    }
  }
  return true;
}

// ---- programs that run what they read, or what an option names ----

// An option of a reader that names a program to run, by program. A fetched file named in the command (as an
// argument or as the value of one of these) may be what runs, so a reader given one of them is no reader.
const RUNNING_OPTION: Record<string, RegExp> = {
  tar: /^(--(use-compress-program|to-command|checkpoint-action|info-script|new-volume-script|rsh-command|rmt-command)(=|$)|-[A-Za-z]*[IF][A-Za-z]*$)/,
  rg: /^--(pre|hostname-bin)(=|$)/,
  sort: /^--compress-program(=|$)/,
  bat: /^--(pager|lessopen)(=|$)/,
  ag: /^--pager(=|$)/,
  install: /^--strip-program(=|$)/,
  gpg: /^--(photo-viewer|exec-path|agent-program|dirmngr-program|pinentry-program)(=|$)/,
  git: /^(--upload-pack|--receive-pack|--exec|--ext-cmd|--open-files-in-pager|-O|--run|--tool|--textconv|--ext-diff)(=|$)/,
};
// git's subcommands that only read a file or an object, or put a file in the index or the work tree.
const GIT_READS = /^(add|apply|blame|bundle|cat-file|check-ignore|describe|diff|grep|hash-object|init|log|ls-files|ls-tree|mv|rev-list|rev-parse|rm|shortlog|show|status|verify-commit|version)$/;
// Whether `q` given `args` runs a program that an option or a subcommand names, and that program may be a file `hit` picks.
export function runsProgram(q: string, args: string[], hit: (a: string) => boolean): boolean {
  const named = (a: string) => hit(a) || a.split(/[\s=]/).some((t) => t !== "" && hit(t)) || (/^-[A-Za-z]/.test(a) && hit(a.slice(2)));
  if (!args.some(named)) return false;
  if (q === "tar" && /^[A-Za-z]+$/.test(args[0] ?? "") && /[IF]/.test(args[0]!)) return true;
  if (q === "git") {
    // The words before the subcommand are git's own options: -c names a setting, which can name a program.
    let i = 0;
    for (; i < args.length && args[i]!.startsWith("-"); i++) { if (/^(-c|--config-env|--exec-path)(=|$)/.test(args[i]!)) return true; if (/^(-C|--git-dir|--work-tree|--namespace|--super-prefix)$/.test(args[i]!)) i++; }
    if (args[i] === undefined || !GIT_READS.test(args[i]!)) return true;
    return args.slice(i + 1).some((a) => RUNNING_OPTION.git!.test(a));
  }
  const re = RUNNING_OPTION[q];
  return re !== undefined && args.some((a) => re.test(a));
}

// Whether a sed script runs a command, or writes a file: only the commands below, and the s command's flags
// without e, w and W, are known not to.
export function sedReads(script: string): boolean {
  let i = 0;
  const n = script.length;
  // A part of s and y up to its closing delimiter d (a backslash takes the next character).
  const part = (d: string) => { while (i < n && script[i] !== d) { if (script[i] === "\\") i++; i++; } if (i >= n) return false; i++; return true; };
  while (i < n) {
    while (i < n && /[\s;{}]/.test(script[i]!)) i++;
    if (i >= n) break;
    // An address: lines, the last line, a pattern, a step, then a range and a negation.
    for (let more = true; more; ) {
      if (/\d/.test(script[i]!)) { while (i < n && /\d/.test(script[i]!)) i++; if (script[i] === "~") { i++; while (i < n && /\d/.test(script[i]!)) i++; } }
      else if (script[i] === "$") i++;
      else if (script[i] === "/" || (script[i] === "\\" && i + 1 < n)) { const d = script[i] === "/" ? "/" : script[i + 1]!; i += script[i] === "/" ? 1 : 2; if (!part(d)) return false; while (/[IM]/.test(script[i] ?? "")) i++; }
      else break;
      while (script[i] === " ") i++;
      if (script[i] === ",") { i++; while (script[i] === " ") i++; } else more = false;
    }
    while (/[\s!]/.test(script[i] ?? "")) i++;
    const c = script[i++];
    if (c === undefined) break;
    if (c === "s" || c === "y") {
      const d = script[i++];
      if (d === undefined || /[\w\s\\]/.test(d) || !part(d) || !part(d)) return false;
      const flags = /^[A-Za-z0-9]*/.exec(script.slice(i))![0];
      i += flags.length;
      if (c === "s" ? !/^[gpiImM0-9]*$/.test(flags) : flags !== "") return false;
    } else if (/[pdDnNPGgHhx=l]/.test(c)) continue;
    else if (c === "q" || c === "Q") { while (/\d/.test(script[i] ?? "")) i++; }
    else return false;
  }
  return true;
}

// Whether an awk program runs no command and writes no file: no call but the builtins below, no pipe, no getline,
// no output redirect.
const AWK_CALLS = new Set(["length", "substr", "index", "split", "sub", "gsub", "match", "tolower", "toupper", "sprintf", "int", "sqrt", "print", "printf"]);
export function awkReads(program: string): boolean {
  const code = program.replace(STRING, '""');
  if (/(?<!\|)\|(?!\|)|>>|\bgetline\b|@|\bprintf?\b[^;}\n]*>/.test(code)) return false;
  for (const m of code.matchAll(/([A-Za-z_]\w*)\s*\(/g)) if (!AWK_CALLS.has(m[1]!)) return false;
  return true;
}
