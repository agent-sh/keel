// A selection in a held row (lib/window.ts) is carried to the row when it is drawn. The browser's
// Find selects what it found in a held block's words; the block is drawn when the view goes there,
// and the words it selected are taken away with the box: without this, what was found is no longer
// marked, and Find's next search starts again from the top. The same words are selected in the
// drawn row, the same one of them when they stand there more than once.

// Where a selection in one held row stands: the row (a child of a `.k-hold`), its event, the
// words selected, and which of their places in the row it was.
export type HeldPick = { row: Element; ev: string; text: string; nth: number };

const rowOf = (n: Node): Element | null => {
  const el = n instanceof Element ? n : n.parentElement;
  const row = el?.closest(".k-hold > *") ?? null;
  return row;
};

// The pick a selection makes, when it lies in one held row; null otherwise.
export function heldPick(sel: Selection | null): HeldPick | null {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const row = rowOf(r.startContainer);
  if (!row || rowOf(r.endContainer) !== row) return null;
  const ev = (row as HTMLElement).dataset.eventId ?? (row as HTMLElement).dataset.events?.split(" ")[0];
  const text = r.toString();
  if (!ev || !text.trim()) return null;
  const before = document.createRange();
  before.setStart(row, 0);
  before.setEnd(r.startContainer, r.startOffset);
  return { row, ev, text, nth: count(before.toString(), text) };
}

const count = (hay: string, needle: string) => { let n = 0; for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++; return n; };

// Selects the pick's words in `root` (the drawn row): the nth place they stand, else the last.
// False when the row does not have them.
export function carryPick(root: Element, pick: HeldPick): boolean {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [], starts: number[] = [];
  let all = "";
  for (let n = walk.nextNode(); n; n = walk.nextNode()) { nodes.push(n as Text); starts.push(all.length); all += (n as Text).data; }
  const at: number[] = [];
  for (let i = all.indexOf(pick.text); i >= 0; i = all.indexOf(pick.text, i + 1)) at.push(i);
  if (!at.length) return false;
  const from = at[Math.min(pick.nth, at.length - 1)]!, to = from + pick.text.length;
  const point = (off: number, end: boolean): [Text, number] => {
    let k = 0;
    while (k + 1 < nodes.length && (end ? starts[k + 1]! < off : starts[k + 1]! <= off)) k++;
    return [nodes[k]!, off - starts[k]!];
  };
  const range = document.createRange();
  range.setStart(...point(from, false));
  range.setEnd(...point(to, true));
  const sel = getSelection();
  if (!sel) return false;
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}
