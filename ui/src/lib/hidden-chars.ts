// Characters a reader cannot see, or that change what a line looks like:
// - controls and format characters (the right-to-left override that shows
//   "echo txt.r < x.txt" for a command writing r.txt, zero-width spaces and
//   joiners), and the line and paragraph separators;
// - every code point a renderer ignores by default (a variation selector, a
//   Hangul filler, a combining grapheme joiner): it draws nothing;
// - every space other than the plain one (a no-break space, an ideographic
//   space) and the braille blank, which draw as a plain space and are not one;
// - the object replacement character, a place holder that draws nothing or a box.
// Text that is to be approved is never shown with one of them left as it is:
// a place that shows one line refuses the text (`plainAscii`), a place that
// shows it whole spells each one out (`spellHidden`).
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800\uFFFC]|(?!\u0020)\p{Zs}/u;

// Nothing but the printable characters of ASCII: what a one-line row can show exactly as it will run.
export const plainAscii = (text: string): boolean => /^[\x20-\x7E]*$/.test(text);

// Letters written right to left (Hebrew, Arabic and the like): among left-to-right text a
// renderer reorders them, so "cp \u05d0 1 2 \u05d1 > \u05d2" reads as its mirror. A command
// that holds them is shown in the order it is written.
export const hasRtl = (text: string): boolean => /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u.test(text);

// `allow`: characters of those classes that are plain here (a newline and a tab in a text of many lines).
export const hasHidden = (text: string, allow = ""): boolean => {
  for (const ch of text) if (HIDDEN.test(ch) && !allow.includes(ch)) return true;
  return false;
};

const NAMES: Record<number, string> = {
  0x200b: "zero-width space", 0x200c: "zero-width non-joiner", 0x200d: "zero-width joiner", 0x2060: "word joiner", 0xfeff: "zero-width no-break space",
  0x200e: "left-to-right mark", 0x200f: "right-to-left mark", 0x061c: "Arabic letter mark",
  0x202a: "left-to-right embedding", 0x202b: "right-to-left embedding", 0x202c: "pop directional formatting", 0x202d: "left-to-right override", 0x202e: "right-to-left override",
  0x2066: "left-to-right isolate", 0x2067: "right-to-left isolate", 0x2068: "first strong isolate", 0x2069: "pop directional isolate",
  0x3164: "Hangul filler", 0x115f: "Hangul filler", 0x1160: "Hangul filler", 0xffa0: "Hangul filler", 0xfe0f: "variation selector", 0xfe0e: "variation selector", 0x034f: "combining grapheme joiner",
  0xfffc: "object replacement character", 0x2800: "braille blank", 0x00a0: "no-break space", 0x3000: "ideographic space", 0x202f: "narrow no-break space", 0x2009: "thin space", 0x2003: "em space", 0x2002: "en space", 0x180e: "Mongolian vowel separator",
  0x00ad: "soft hyphen", 0x2028: "line separator", 0x2029: "paragraph separator", 0x1b: "escape", 0x7f: "delete", 0x00: "null", 0x08: "backspace", 0x0d: "carriage return", 0x09: "tab",
};
const code = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

// The text in pieces: what is plain as it is, and each hidden character as its
// code point (`shown`, as "<U+202E>") with its name for a tooltip.
export type Piece = { text: string; hidden?: { shown: string; name: string } };
export function spellHidden(text: string, allow = "\n\t"): Piece[] {
  const out: Piece[] = [];
  let plain = "";
  for (const ch of text) {
    if (!HIDDEN.test(ch) || allow.includes(ch)) { plain += ch; continue; }
    if (plain) { out.push({ text: plain }); plain = ""; }
    const cp = ch.codePointAt(0)!;
    out.push({ text: ch, hidden: { shown: `<${code(cp)}>`, name: NAMES[cp] ?? (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) ? "control character" : /\p{Zs}/u.test(ch) ? "a space that is not the plain one" : /\p{Cf}/u.test(ch) ? "format character" : "a character that draws nothing") } });
  }
  if (plain) out.push({ text: plain });
  return out;
}
