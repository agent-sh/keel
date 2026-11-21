// Characters a reader cannot see, or that change what a line looks like, for
// text that comes from outside and is shown to the owner as words to act on
// (what an MCP server writes on a question card). The class is the one the
// page's own helper for text to approve uses (ui/src/lib/hidden-chars.ts):
// controls and format characters (a right-to-left override, zero-width
// spaces and joiners, tag characters), the line and paragraph separators,
// every code point a renderer ignores by default (a variation selector, a
// Hangul filler), the braille blank, the object replacement character (a
// place holder for something that is not there), and every space other than
// the plain one.
const DRAWS_NOTHING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800\uFFFC]/gu;
const OTHER_SPACE = /(?!\u0020)\p{Zs}/gu;

// The text with each of them gone: a space that is not the plain one becomes
// one, a line end stays a line end (a tab becomes a space), the rest is removed.
export function withoutHidden(text: string): string {
  return text
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(/\t/g, " ")
    .replace(OTHER_SPACE, " ")
    .replace(DRAWS_NOTHING, (ch) => (ch === "\n" ? "\n" : ""));
}
