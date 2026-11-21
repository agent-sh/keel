// One line of plain words from text a model wrote in markdown: an alert's line
// in the inbox, a notification's body. The first line that says something,
// without the marks that only a renderer reads (a heading's #, emphasis,
// backticks, a link's address, a list bullet, a table's pipes). What stands
// inside a code span is kept as written: its underscores and stars are code.
const RULE = /^\s*([-*_=]\s*){3,}$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
// A fence opens with three or more of one mark and closes with at least as many of the same.
const fenceOf = (line: string) => /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
// A stand-in for a code span while the marks around it are read (a character no text holds).
const HELD = "\uE000";

export function plainInline(s: string): string {
  const code: string[] = [];
  return s
    .replace(/(`+)(.+?)\1(?!`)/g, (_m, _t, inner: string) => `${HELD}${code.push(inner.trim()) - 1}${HELD}`)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(/(?<![\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?=\S)([^_]+?)(?<=\S)_(?![\w_])/g, "$1")
    .replace(new RegExp(`${HELD}(\\d+)${HELD}`, "g"), (_m, i: string) => code[Number(i)]!)
    .replace(/\s+/g, " ")
    .trim();
}

export function plainLine(md: string, max = 300): string {
  let fence: string | undefined;
  // A heading that opens the text names what follows: it is joined with the
  // next line that says something ("Result: the tests pass"), not shown alone.
  let head = "";
  const cut = (line: string) => { const chars = [...line]; return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : line; };
  for (const whole of md.split("\n")) {
    // No more of a line is read than can be shown: a very long line of
    // unclosed marks is not worth seconds of matching at a turn's end.
    const raw = whole.length > 4 * max ? whole.slice(0, 4 * max) : whole;
    const mark = fenceOf(raw);
    // A fence's mark with its own closing on the same line is a code span, not a fence.
    const span = mark && raw.trim().indexOf(mark, mark.length) > 0;
    if (fence) { if (mark && mark[0] === fence[0] && mark.length >= fence.length && !raw.trim().slice(mark.length).trim()) fence = undefined; continue; }
    if (mark && !span) { fence = mark; continue; }
    if (RULE.test(raw) || TABLE_RULE.test(raw)) continue;
    const heading = /^\s*(>\s*)*#{1,6}\s+/.test(raw);
    let line = raw.trim()
      .replace(/^(>\s*)+/, "")
      .replace(/^#{1,6}\s+/, "")
      .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "");
    if (/^\|.*\|$/.test(line)) line = line.slice(1, -1).split("|").map((c) => c.trim()).filter(Boolean).join(", ");
    line = plainInline(line);
    if (!line) continue;
    if (heading && !head) { head = line.replace(/[:.]$/, ""); continue; }
    // Cut between characters, never inside one (an emoji is two units).
    return cut(head ? `${head}: ${line}` : line);
  }
  return cut(head);
}
