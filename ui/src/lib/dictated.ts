// The words dictation puts in the message box (pure). Apart from lib/talk-core.ts so the box, which is
// drawn at the first view, does not carry the rest of the speech turns.

// What stood before and after the caret when dictation began.
export type Base = { before: string; after: string };
const closes = /^[\s.,;:!?)\]}'"]/;
// The box with the dictated words at the caret: a space between words and what is around them where
// there is none, and the caret at the end of the words.
export function dictated(base: Base, words: string): { text: string; caret: number } {
  const w = words.trim();
  if (!w) return { text: base.before + base.after, caret: base.before.length };
  const lead = base.before && !/\s$/.test(base.before) ? " " : "";
  const trail = base.after && !closes.test(base.after) ? " " : "";
  const head = base.before + lead + w;
  return { text: head + trail + base.after, caret: head.length };
}
