// A line `resolvedLine` will not rewrite (it has an `if`, a loop, `export`, a substitution elsewhere) still says where it
// goes and what it reads in words that may name a variable the line set: `cd "$D"`, `git -C "$D"`, `-F "$B"`. Those words
// only, and only a variable the line sets once, to a written-out value, before the word that uses it. Anything else is
// left as it is, and what the send reads says it could not know.
// `~`, `~/x`, `$HOME/x` and `${HOME}/x` as the folder they stand for.
export function untilde(word: string, home: string): string {
  if (word === "~" || word === "$HOME" || word === "${HOME}") return home;
  if (word.startsWith("~/")) return home + word.slice(1);
  if (word.startsWith("$HOME/")) return home + word.slice(5);
  if (word.startsWith("${HOME}/")) return home + word.slice(7);
  return word;
}

const POS = String.raw`(?:^|[;&|\n(]\s*|\b(?:export|local|readonly|declare)\s+(?:-\w+\s+)?)`;
const LOOSE = new RegExp(`${POS}([A-Za-z_][A-Za-z0-9_]*)\\+?=`, "g");
const REF = String.raw`\$\{[A-Za-z_]\w*\}|\$[A-Za-z_]\w*`;
const STRICT = new RegExp(`${POS}([A-Za-z_][A-Za-z0-9_]*)=("(?:${REF}|[^"$\`\\\\\\n])*"|'[^'\\n]*'|(?:${REF}|[^\\s;&|$\`"'\\\\()<>*?{}=])*)(?=[\\s;&|)]|$)`, "g");
// A name the line binds in another way: a loop's, `read`'s, an arithmetic one, an unset.
const BOUND = (n: string) => new RegExp(`\\b(?:for|select)\\s+${n}\\b|\\b(?:read|getopts|unset|mapfile|readarray)\\b[^;&|\\n]*\\b${n}\\b|\\(\\(\\s*${n}\\b`);
// The words that say where a command goes or what it reads.
const USES = /(?<![\w$])(?:cd\s+|-C\s+|-F\s+|--(?:body-file|notes-file|file|input)(?:=|\s+))("(?:[^"\n\\]|\\.)*"|'[^'\n]*'|[^\s;&|<>]+)/g;

// A value that stands as one plain word when written out unquoted: no space, quote, `;`, `&`, `|`, `<`, `>`, `#` at the
// start (a comment), nothing the shell reads as syntax. Any other value is left in its variable (the line keeps its shape).
const PLAIN_VALUE = /^[\w@%+=:,./~-]+$/;
const plainValue = (v: string) => PLAIN_VALUE.test(v) && !v.startsWith("#");

// Where the text is not the shell's own commands: the bodies of here-documents.
function docRanges(command: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of command.matchAll(/<<-?[ \t]*(['"]?)([A-Za-z_][\w]*)\1[^\n]*\n/g)) {
    const from = m.index! + m[0].length;
    const end = new RegExp(`^[ \\t]*${m[2]}[ \\t]*$`, "m").exec(command.slice(from));
    out.push([from, end ? from + end.index + end[0].length : command.length]);
  }
  return out;
}
// Whether a place in the line is inside a subshell, a substitution or backticks (an assignment there is the subshell's).
function nested(command: string, at: number): boolean {
  let depth = 0, ticks = 0, quote = "";
  for (let i = 0; i < at; i++) {
    const c = command[i]!;
    if (quote) { if (c === quote) quote = ""; else if (c === "\\" && quote === '"') i++; continue; }
    if (c === "\\") { i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "`") ticks ^= 1;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
  }
  return depth > 0 || ticks === 1;
}
// Whether the assignment at `from..to` only sets the variable for the command after it (`D=/a cmd`).
function prefixOf(command: string, to: number): boolean {
  const rest = /^[^;&|\n)]*/.exec(command.slice(to))![0].trim();
  return !!rest && rest.split(/\s+/).some((w) => !/^[A-Za-z_]\w*=/.test(w));
}

export function narrow(command: string, home: string): string | null {
  if (!command.includes("$")) return null;
  // A function's variables are its own, and its body runs when it is called, not where it is written.
  if (/\bfunction\s+\w|\w\s*\(\s*\)\s*\{/.test(command)) return null;
  const docs = docRanges(command);
  const inDoc = (at: number) => docs.some(([a, b]) => at >= a && at < b);
  const count = new Map<string, number>();
  for (const m of command.matchAll(LOOSE)) count.set(m[1]!, (count.get(m[1]!) ?? 0) + 1);
  const known = new Map<string, { value: string; at: number }>();
  for (const m of command.matchAll(STRICT)) {
    const name = m[1]!;
    if (count.get(name) !== 1 || BOUND(name).test(command)) continue;
    // An assignment of a here-document's text, of a subshell or a substitution, of a function's `local`, or one that sets the
    // variable for a single command, binds nothing the later words see.
    const nameAt = m[0].indexOf(`${name}=`);
    const at = m.index + nameAt;
    if (inDoc(at) || nested(command, at) || /\b(?:local|declare|typeset)\b/.test(m[0].slice(0, nameAt)) || prefixOf(command, m.index + m[0].length)) continue;
    let v = m[2]!;
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    if (m[2]!.startsWith("'") && v.includes("$")) continue;
    // (A value may name the variables set before it, and the home folder.)
    v = untilde(v, home).replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (use, x?: string, y?: string) => (x ?? y) === "HOME" ? home : known.get(x ?? y!)?.value ?? use);
    if (!v || /[$`\s*?]/.test(v) || name === "HOME" || !plainValue(v)) continue;
    known.set(name, { value: v, at: m.index });
  }
  if (!known.size) return null;
  let changed = false;
  const out = command.replace(USES, (whole, word: string, at: number) => {
    if (word.startsWith("'") || inDoc(at)) return whole;
    const next = word.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (use, a?: string, b?: string) => {
      const k = known.get(a ?? b!);
      return k && k.at < at ? k.value : use;
    });
    if (next === word) return whole;
    changed = true;
    return whole.slice(0, whole.length - word.length) + next;
  });
  return changed ? out : null;
}
