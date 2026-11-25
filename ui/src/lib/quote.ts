// Quotes and comments on a selection. The owner selects words in the conversation (a reply, a
// tool's output, a diff hunk, the board); the page offers to put them in the message box as a quote
// or to send a comment on them now. A comment is an ordinary message of the owner's: a line that
// says where the words are, the words as a quote block, then the comment. Nothing else is added, so
// the history's cache prefix is what a typed message would have made.

// What of a selection is kept. A longer one is cut and says how much (a whole page of output is not
// a quote; the model can read the file it came from).
export const QUOTE_MAX = 1500;

export function quoteBlock(selected: string): string {
  const text = selected.replace(/\r\n?/g, "\n").replace(/^\n+/, "").trimEnd();
  const cut = text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX).trimEnd()}\n[${text.length - QUOTE_MAX} more characters not quoted]` : text;
  return cut.split("\n").map((l) => (l.trim() ? `> ${l}` : ">")).join("\n");
}

// The message a comment sends: where, the quote, the comment.
export const commentMessage = (where: string, selected: string, comment: string): string => `On ${where}:\n${quoteBlock(selected)}\n\n${comment.trim()}`;

// What goes in the message box for a quote: after what is there, set apart by a blank line, and
// a blank line under it for the owner's words.
export function withQuote(draft: string, selected: string): string {
  const gap = !draft.trim() ? "" : draft.endsWith("\n\n") ? "" : draft.endsWith("\n") ? "\n" : "\n\n";
  return `${draft}${gap}${quoteBlock(selected)}\n\n`;
}

// "lines 3 to 5", "line 3": the numbers of the lines a run covers.
export function lineWords(lines: number[], removed = false): string {
  if (!lines.length) return "";
  const a = Math.min(...lines), b = Math.max(...lines);
  const noun = `${removed ? "removed " : ""}${a === b ? "line" : "lines"}`;
  return a === b ? `${noun} ${a}` : `${noun} ${a} to ${b}`;
}

// A message box that takes what the selection bar hands it, by the session it belongs to.
// `say` answers whether the message went (false: the box refused it and said why).
export type Box = { say: (text: string, queue: boolean) => boolean; quote: (selected: string) => void };
const boxes = new Map<string, Box>();
export function registerBox(sid: string, box: Box): () => void {
  boxes.set(sid, box);
  return () => { if (boxes.get(sid) === box) boxes.delete(sid); };
}
export const boxOf = (sid: string): Box | undefined => boxes.get(sid);

const elementOf = (n: Node): Element | null => (n instanceof Element ? n : n.parentElement);

// Where a selection is, in words: the nearest region that names itself (`data-quote-from`), and for
// a diff the file and the lines. Null where nothing names a place: the bar is not offered there.
export function whereOf(range: Range): string | null {
  const at = elementOf(range.commonAncestorContainer);
  if (!at) return null;
  const table = at.closest<HTMLElement>("table[data-path]");
  if (table) {
    const rows = [...table.querySelectorAll<HTMLElement>("tr.k-diff-line")].filter((r) => (r.dataset.new || r.dataset.old) && range.intersectsNode(r));
    const added = rows.filter((r) => r.dataset.new).map((r) => Number(r.dataset.new));
    const removed = rows.filter((r) => !r.dataset.new && r.dataset.old).map((r) => Number(r.dataset.old));
    const lines = [lineWords(added), lineWords(removed, true)].filter(Boolean).join(" and ");
    return `${table.dataset.path}${lines ? `, ${lines}` : ""}`;
  }
  const region = at.closest<HTMLElement>("[data-quote-from]");
  if (!region) return null;
  // A selection across blocks (a reply and a tool call, two replies) names each of them.
  const inside = [...region.querySelectorAll<HTMLElement>("[data-quote-from]")].filter((r) => range.intersectsNode(r));
  if (inside.length) return joinNames(inside.map((r) => r.dataset.quoteFrom!));
  if (region.dataset.quoteOut && at.closest(".k-out")) return region.dataset.quoteOut;
  return region.dataset.quoteFrom ?? null;
}

// "the reply", "the reply and the Bash call", "your message, the reply and the Bash call": each place once,
// in the order it stands. More than three is the conversation as a whole.
export function joinNames(names: string[]): string {
  const each = [...new Set(names)];
  if (each.length > 3) return "the conversation";
  return each.length < 2 ? (each[0] ?? "") : `${each.slice(0, -1).join(", ")} and ${each.at(-1)}`;
}

// A message of the owner's as it is shown: the lines that quote (a run of lines behind `>`, from the
// start, after an "On <where>:" line, or after a blank line; not inside a code fence) are set apart
// from the words around them. Display only: the text itself is never changed.
export type Part = { quote: boolean; text: string };
export function quoteParts(text: string): Part[] {
  const lines = text.split("\n");
  const parts: Part[] = [];
  let fence = false, prev: string | null = null;
  const put = (quote: boolean, l: string) => {
    const last = parts.at(-1);
    if (last && last.quote === quote) last.text += `\n${l}`;
    else parts.push({ quote, text: l });
  };
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const q = !fence && /^>/.test(l) && (prev === null || !prev.trim() || /^On [^\n]+:$/.test(prev) || parts.at(-1)?.quote === true);
    put(q, q ? l.replace(/^> ?/, "") : l);
    prev = l;
  }
  // The lines that join a quote to the words around it (blank ones) are the gap the page draws.
  parts.forEach((p, i) => {
    if (p.quote) return;
    if (parts[i - 1]?.quote) p.text = p.text.replace(/^\n+/, "");
    if (parts[i + 1]?.quote) p.text = p.text.replace(/\n+$/, "");
  });
  return parts.filter((p) => p.quote || p.text !== "");
}

// A selection made by a triple click, or dragged past the end of a block, ends at the start of the
// next one: it names a place the owner did not select. The range cut back to its first and last
// words that are selected (not blank, not of a part the page keeps out of a selection). The same
// range when it already is; null when nothing in it is.
export function tighten(range: Range): Range | null {
  const root = range.commonAncestorContainer;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let first: [Text, number] | null = null, last: [Text, number] | null = null;
  const kept = (t: Text, from: number, to: number) => !!t.data.slice(from, to).trim() && getComputedStyle(t.parentElement!).userSelect !== "none";
  const nodes: Text[] = [];
  for (let n = root.nodeType === Node.TEXT_NODE ? (walk.currentNode as Text) : (walk.nextNode() as Text | null); n; n = walk.nextNode() as Text | null) {
    if (range.intersectsNode(n)) nodes.push(n);
    else if (nodes.length) break;
  }
  const span = (t: Text): [number, number] => [t === range.startContainer ? range.startOffset : 0, t === range.endContainer ? range.endOffset : t.length];
  for (const t of nodes) { const [a, b] = span(t); if (kept(t, a, b)) { first = [t, a + (t.data.slice(a, b).length - t.data.slice(a, b).trimStart().length)]; break; } }
  for (const t of [...nodes].reverse()) { const [a, b] = span(t); if (kept(t, a, b)) { last = [t, b - (t.data.slice(a, b).length - t.data.slice(a, b).trimEnd().length)]; break; } }
  if (!first || !last) return null;
  if (first[0] === range.startContainer && first[1] === range.startOffset && last[0] === range.endContainer && last[1] === range.endOffset) return range;
  const tight = document.createRange();
  tight.setStart(...first);
  tight.setEnd(...last);
  return tight;
}
