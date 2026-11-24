// The transcript keeps only the blocks of rows near the view in the document (rows.ts makes the
// blocks). Every other block stands as one light box: as tall as the block was when it was last
// drawn (or an estimate before that), with the rows' plain words in it, so the browser's Find,
// a screen reader and a selection still reach them, and with their event ids, so a jump or a
// place finds where they are. What is shown near the view is the same as before; what is far
// costs a handful of layout objects instead of every span of its replies.
//
// Kept pure: what the transcript measures goes in, which blocks are drawn comes out.
import type { Row } from "./rows.ts";
import { sentence, summarize } from "./work.ts";

// A block's place on screen: from its mark (the top of its first row) to the next block's mark.
export type Span = { key: number; top: number; bottom: number };

// The blocks to draw. A block comes in when it is within one view's height of the view, and
// leaves only when it is more than two away: a reader scrolling back and forth does not draw
// and drop the same block over and over, and what they opened a moment ago is still open.
// `last`: the newest blocks are always drawn (the end of the conversation keeps its height
// through every event, see Transcript.tsx). `pins`: blocks something needs drawn now (a jump,
// a place put back, the keyboard, a selection).
export function windowOf(spans: Span[], view: { top: number; bottom: number }, was: ReadonlySet<number> | null, pins: ReadonlySet<number>, last = 2): Set<number> {
  const h = Math.max(1, view.bottom - view.top);
  const near = (s: Span, m: number) => s.bottom >= view.top - m && s.top <= view.bottom + m;
  const out = new Set<number>();
  spans.forEach((s, i) => {
    if (i >= spans.length - last || pins.has(s.key) || near(s, h) || (was?.has(s.key) && near(s, 2 * h))) out.add(s.key);
  });
  return out;
}

export const sameKeys = (a: ReadonlySet<number> | null, b: ReadonlySet<number>) => !!a && a.size === b.size && [...b].every((k) => a.has(k));

// What Markdown means to say, as words: the marks of emphasis, code and links taken away, as a
// copy of the drawn reply has them. Find in a block that is not drawn looks for the words a reader
// sees, not for the asterisks around them, and a selection across held and drawn blocks copies the
// same text for both. As both engines copy a drawn reply: a list item without its bullet or number,
// a table row as its cells with a tab between them, a heading and code as their lines. Math stays
// as it was written (TeX), which a drawn reply does not show.
export function plain(md: string): string {
  return tables(md)
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~|`)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/`/g, "");
}

// A table's rows as their cells, a tab between them; the line under its head goes. (A table is a
// head row, the line of dashes under it, and the rows after it that have a pipe.)
const RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
function tables(md: string): string {
  if (!md.includes("|")) return md;
  const lines = md.split("\n");
  const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|")).join("\t");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i]!;
    const rule = lines[i + 1];
    // (As GitHub reads one: the line of dashes has as many cells as the head.)
    if (head.includes("|") && rule !== undefined && RULE.test(rule) && cells(rule).split("\t").length === cells(head).split("\t").length) {
      out.push(cells(head));
      i++;
      while (i + 1 < lines.length && lines[i + 1]!.includes("|") && lines[i + 1]!.trim()) out.push(cells(lines[++i]!));
      continue;
    }
    out.push(head);
  }
  return out.join("\n");
}

// The words a row shows that Find reaches when it is drawn: the prompt, the reply's prose, what
// was said between calls, a note's line. (Not what a fold hides: Find does not reach that drawn either.)
export function wordsOf(row: Row): string {
  const d = row.e.data ?? {};
  switch (row.kind) {
    case "user": return String(d.text ?? "");
    case "assistant": return (row.prose ?? []).map((i) => d.blocks?.[i]).filter((b: any) => b?.type === "text").map((b: any) => plain(b.text)).join("\n");
    case "work": return (row.steps ?? []).flatMap((s) => s.items).filter((i) => i.t === "note").map((i) => plain((i as { text: string }).text)).join("\n");
    case "end": case "images": case "fork": return "";
    case "checkpoint": return String(d.label ?? "");
    default: return String(d.short ?? d.text ?? "");
  }
}

// The words a held row stands for, as a selection over the drawn row copies them: its words
// (wordsOf), and also what a drawn row shows beside them. A prompt's attachments, in the order
// they were sent (an image by the words it is drawn with, a file by its name), and a
// run of work's lines: each step's line, among what was said between its calls. (Held rows are
// far from the end: none of their calls is running.)
export function heldWords(row: Row): string {
  const d = row.e.data ?? {};
  if (row.kind === "user") {
    // (A drawn image copies no words, its alt text is not in a selection: a held one copies none either.)
    const kept = ((d.images ?? []) as { type: string; name?: string }[])
      .map((b) => (b.type === "attachment" ? b.name ?? "" : ""))
      .filter(Boolean);
    return [String(d.text ?? ""), ...kept].filter(Boolean).join("\n");
  }
  if (row.kind !== "work") return wordsOf(row);
  const out: string[] = [];
  for (const step of row.steps ?? []) {
    let line = false;
    for (const i of step.items) {
      if (i.t === "note") out.push(plain(i.text));
      else if (i.t === "call" && !line) { out.push(sentence(summarize(step, { working: false }))); line = true; }
    }
  }
  return out.join("\n");
}

// How tall a block stands before it was ever drawn, in px: lines of its words at the column's
// width, and a row's own frame. Only a start: the place the reader holds is kept by the view's
// anchor when the block is drawn and takes its real height (Transcript.tsx).
export function rowHeights(rows: Row[], width: number, rem: number, gap = rem): number[] {
  const perLine = Math.max(20, Math.floor(width / (0.5 * rem)));
  const lines = (s: string) => s.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  return rows.map((r) => {
    if (r.kind === "end" && r.folded) return 0;
    const words = wordsOf(r);
    const body = r.kind === "user" ? Math.min(lines(words), 12) * 1.6 + 3.5
      : r.kind === "assistant" ? lines(words) * 1.75 + 0.5
      : r.kind === "work" ? (r.steps?.length ?? 1) * 2.25 + (words ? lines(words) * 1.5 : 0)
      : r.kind === "end" ? 1.75
      : 2.5;
    return body * rem + gap; // and the gap under it
  });
}
export const estimate = (rows: Row[], width: number, rem: number, gap = rem) => Math.round(rowHeights(rows, width, rem, gap).reduce((a, b) => a + b, 0));

// Where each row of a held block stands in its box: the block's height shared out by the rows'
// estimates, so a row Find or a jump reaches in the box is about where it stands drawn, and the
// view's anchor holds the right line when the block is drawn in its place.
export function shares(rows: Row[], span: number, width: number, rem: number, gap = rem): number[] {
  const est = rowHeights(rows, width, rem, gap);
  const sum = est.reduce((a, b) => a + b, 0) || 1;
  return est.map((h) => Math.round((h * span) / sum));
}
