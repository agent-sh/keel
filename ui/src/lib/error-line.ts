// The line of a failed command's output a reader looks for first: where the
// error is said. A line that says it outright comes first, wherever it is
// ("AssertionError [ERR_ASSERTION]: ...", "error[E0308]: ...", "a.c:3: error:",
// "npm ERR! ...", pytest's "E   ValueError"); else a line with a word of
// failure in it ("No such file", "3 failed"). A count of none ("0 failed",
// "no errors") is not one. Lines are of text without color codes.

// Said outright: a line led by an error's name or word, or a compiler's "error:" anywhere in it.
const SAID = /^(?:E\s{2,}\S|[A-Z]\w*(?:Error|Exception)\b(?!\()|(?:error|fatal|panic)\b|FAIL(?:ED)?\b|npm ERR!)|\berror(?:\[\w+\]| TS\d+)?:/i;
// A word of failure somewhere in the line.
const WORD = /\b(?:error|failed|failure|cannot|not found|no such|denied|refused|does not exist|timed out|killed|panicked|segmentation fault)\b/i;
const NONE = /\b(?:0|no|zero)\s+(?:errors?|failed|failures?)\b/i;

export function errorLine(lines: readonly string[]): number {
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l.trim()) && !NONE.test(l));
  const said = at(SAID);
  return said >= 0 ? said : at(WORD);
}
