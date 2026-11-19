// Streaming Markdown, pure parts. A reply that is still being written is
// lexed from where its last finished block ends, not from its start, and its
// unfinished last block is mended so half-written syntax does not flash as
// raw marks: an open `**` or `` ` `` is closed, a link still missing its
// address reads as its words.

// The top-level blocks of `src` that are finished: every block but the last
// one that has text (a later delta can still extend it: a paragraph, a list
// item, a code fence). Returns how many characters they span.
export function finishedLength(tokens: { type: string; raw: string }[]): { done: number; count: number } {
  let last = tokens.length - 1;
  while (last >= 0 && tokens[last]!.type === "space") last--;
  let done = 0;
  for (let i = 0; i < last; i++) done += tokens[i]!.raw.length;
  return { done, count: Math.max(0, last) };
}

// Closes what the unfinished last block left open. Code blocks are left as
// they are (a fence open to the end already reads as code).
export function mend(block: string): string {
  if (/^ {0,3}(`{3,}|~{3,})/.test(block)) return block;
  let s = block;
  // A link or image whose address is still coming: its words only.
  s = s.replace(/!?\[([^\]\n]*)\]\([^)\s]*$/, "$1");
  // A link whose label is still coming: the words so far.
  s = s.replace(/!?\[([^\]\n]*)$/, "$1");
  // Inline code: an odd number of backticks outside code spans leaves one open.
  const ticks = (s.match(/`/g) ?? []).length;
  if (ticks % 2 === 1) s += "`";
  // Emphasis outside inline code.
  const plain = s.replace(/`[^`]*`/g, "");
  if (((plain.match(/\*\*/g) ?? []).length) % 2 === 1) s = closeAt(s, "**");
  if (((plain.match(/~~/g) ?? []).length) % 2 === 1) s = closeAt(s, "~~");
  return s;
}

// The closing mark goes before trailing whitespace (a mark after a space does not close).
function closeAt(s: string, mark: string): string {
  const m = /\s*$/.exec(s)!;
  const body = s.slice(0, m.index);
  // An opener with nothing after it yet shows nothing rather than two marks.
  if (body.endsWith(mark)) return body.slice(0, -mark.length) + m[0];
  return body + mark + m[0];
}
