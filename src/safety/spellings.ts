// The other spellings of a path in a deny or ask rule and in the command it is matched with.
//
// A rule that names a path (`cat /home/u/decoy/secret.txt`) must also stop `cat ~/decoy/secret.txt`,
// `cat $HOME/decoy/secret.txt`, `cat ./decoy/secret.txt`, `cat /home/u/../u/decoy/secret.txt`,
// `cat /home//u/decoy/secret.txt` and the same file through a link to its folder. Both sides are written in
// one form first: `~` and `$HOME` as the home folder, a relative word as the session's folder joined to it,
// `.`, `..` and doubled slashes collapsed, links followed (`realOf`, the form a file tool opens). The words
// of a rule or a command that are no path stay as they are.
//
// Only a rule that stops something reads this way. An allow rule keeps its text match: a wider match would
// let more run, not less. A word an expansion makes (`$X`, `$(...)`) and any `$` that is not HOME stays as written.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { realOf } from "../core/paths.ts";

// The most words of one command read; the rest stay as written.
const WORDS_MAX = 64;
const HOME_FORM = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;

// A word is a path when it has a slash, a home spelling, is `.` or `..`, or names a file that is there in the folder.
function spelled(word: string, cwd: string, home: string): string {
  if (!word || word.startsWith("-") || word === "*" || word.length > 4_096) return word;
  let w = word;
  const h = HOME_FORM.exec(w);
  if (h) w = home + w.slice(h[0].length);
  else if (/[$`]/.test(w)) return word; // an expansion the shell makes: not read
  const path = w.includes("/") || w === "." || w === ".." || !!h || (!w.includes("*") && existsSync(join(cwd, w)));
  if (!path) return word;
  const abs = isAbsolute(w) ? w : join(cwd, w);
  // A `*` stands for any text: the part before the first segment that holds one is a real path, the rest is kept.
  const segs = abs.split("/");
  const star = segs.findIndex((s) => s.includes("*"));
  const head = star < 0 ? abs : segs.slice(0, star).join("/") || "/";
  const tail = star < 0 ? "" : "/" + segs.slice(star).join("/");
  const slash = w.length > 1 && w.endsWith("/") && star < 0;
  const done = realOf(head) + (tail ? (head === "/" ? tail.slice(1) : tail) : "");
  return slash && !done.endsWith("/") ? `${done}/` : done;
}

// The words of a rule's pattern, or of one command, in the one form. The words are cut at spaces (the rule's
// text) or are the parsed words of the command (quotes gone).
export function spell(words: string[], cwd: string, home: string): string {
  return words.slice(0, WORDS_MAX).map((w) => spelled(w, cwd, home)).join(" ") + (words.length > WORDS_MAX ? " " + words.slice(WORDS_MAX).join(" ") : "");
}
export const spellPattern = (pattern: string, cwd: string, home: string): string => spell(pattern.split(/ +/), cwd, home);
