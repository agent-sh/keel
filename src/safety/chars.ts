// What a reader cannot see in a text, or what changes how it looks. Read once
// by the daemon for every approval (src/safety/card.ts), so every client is
// told the same: the page, the phone, an editor, a terminal. No imports: the
// page loads this file too.
//
// Three kinds, each said in its own way:
// - hidden: controls and format characters (the right-to-left override that
//   shows "echo txt.r < x.txt" for a command writing r.txt, zero-width spaces
//   and joiners), the line and paragraph separators, every code point a
//   renderer ignores by default (a variation selector, a Hangul filler), every
//   space other than the plain one, the braille blank and the object
//   replacement character. They are spelled out by code point (`spellHidden`).
// - letters written right to left (Hebrew, Arabic and the like): among
//   left-to-right text a renderer reorders them. They are shown in the order
//   they are written, each run by itself (`rtlRuns`).
// - look-alikes: characters outside plain ASCII that draw as something (a
//   Cyrillic a, a fullwidth r, an accent that sits on its neighbour). They are
//   named (`lookAlikes`).
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800\uFFFC]|(?!\u0020)\p{Zs}/u;

// Nothing but the printable characters of ASCII: what one line can show exactly as it will run.
export const plainAscii = (text: string): boolean => /^[\x20-\x7E]*$/.test(text);

// One line a home row or a list can show whole. Anything longer is opened.
export const SHORT_MAX = 160;
export const oneLine = (text: string): boolean => text.length <= SHORT_MAX && plainAscii(text);

const RTL = "\\p{Script=Hebrew}\\p{Script=Arabic}\\p{Script=Syriac}\\p{Script=Thaana}\\p{Script=Nko}\\p{Script=Samaritan}\\p{Script=Mandaic}\\p{Script=Adlam}";
export const hasRtl = (text: string): boolean => new RegExp(`[${RTL}]`, "u").test(text);

// The text cut at its right-to-left runs: a run is letters of those scripts with
// the marks that sit on them (a word; a space ends it). The rest is as written.
export function rtlRuns(text: string): { text: string; rtl?: true }[] {
  const out: { text: string; rtl?: true }[] = [];
  let at = 0;
  for (const m of text.matchAll(new RegExp(`[${RTL}][${RTL}\\p{M}]*`, "gu"))) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: m[0], rtl: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

const code = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

// Each look-alike once, in the order they come; what is hidden, and letters
// written right to left, are said in their own ways and left out. `shown`: the
// character, where it draws by itself.
export function lookAlikes(text: string): { shown: string; code: string }[] {
  const rtl = new RegExp(`[${RTL}]`, "u");
  const out = new Map<string, { shown: string; code: string }>();
  for (const ch of text) {
    if (/^[\x20-\x7E\n\t]$/.test(ch) || HIDDEN.test(ch) || rtl.test(ch)) continue;
    out.set(ch, { shown: /\p{M}/u.test(ch) ? "" : ch, code: code(ch.codePointAt(0)!) });
  }
  return [...out.values()];
}

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

// The text in pieces: what is plain as it is, and each hidden character as its
// code point (`shown`, as "<U+202E>") with its name.
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

// The text as a place that cannot mark characters shows it (a terminal, a
// notification, an editor's request): each hidden one written as its code point.
export const spelled = (text: string, allow = "\n\t"): string => spellHidden(text, allow).map((p) => p.hidden?.shown ?? p.text).join("");

// What a text holds that a reader could miss, counted once.
export type Marks = { hidden: number; rtl: boolean; alike: { shown: string; code: string }[] };
export function marksOf(text: string): Marks {
  let hidden = 0;
  for (const ch of text) if (ch !== "\n" && ch !== "\t" && HIDDEN.test(ch)) hidden++;
  return { hidden, rtl: hasRtl(text), alike: lookAlikes(text) };
}
export const marked = (m: Marks): boolean => m.hidden > 0 || m.rtl || m.alike.length > 0;

// The marks as words, as the page's card says them: one sentence for each kind.
export function marksSaid(m: Marks, thing = "text"): string[] {
  const out: string[] = [];
  if (m.hidden) out.push(`This ${thing} holds characters that do not show as written. Each is spelled out (${m.hidden} of them, as <U+...>).`);
  if (m.alike.length) out.push(`Not all of it is plain ASCII, and some of these can pass for plain letters: ${m.alike.slice(0, 6).map((a) => (a.shown ? `${a.shown} ${a.code}` : a.code)).join(", ")}${m.alike.length > 6 ? `, and ${m.alike.length - 6} more` : ""}.`);
  if (m.rtl) out.push(`It holds letters written right to left: each word reads as written, and the words stand in the order the ${thing} is written.`);
  return out;
}
