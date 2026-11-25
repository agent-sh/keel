// What an approval card shows of a call that is neither a command, nor file
// paths, nor a message to a session: the start of its input. Shared by the
// gate, which cuts it, and the page, which says so. No imports: the page
// loads this file too.

// The input is shown up to this many characters.
export const SUMMARY_LIMIT = 400;

// The kinds whose summary is the whole of what they do (the command, the paths, the message).
const WHOLE = ["shell", "edit", "drive", "send"];

// The card shows only the start of its input: it says so, opens to all the
// daemon kept, and is answered alone. A card written before cards were marked
// has no flag: one whose summary is exactly as long as the cut is taken for cut.
export const shownInPart = (a: { cut?: boolean; kind: string; summary: string }): boolean =>
  !!a.cut || (!WHOLE.includes(a.kind) && a.summary.length === SUMMARY_LIMIT);

// The part of a chained command that asked: its text as the parser read it, and which of the parts
// with that text it is (`nth`, from the first). The card marks it in the command's text.
export type AskedPart = { text: string; nth: number };

// Where the asking part stands in the command's text, as [from, to), or undefined when the text
// does not hold it (the command was cut, or read in another form than it is shown in).
export function partSpan(text: string, part: AskedPart | undefined): [number, number] | undefined {
  if (!part || !part.text) return undefined;
  let at = -1;
  for (let n = 0; n <= part.nth; n++) { at = text.indexOf(part.text, at + 1); if (at < 0) return undefined; }
  return [at, at + part.text.length];
}
