import { errorLine } from "./error-line.ts";

// Scrolls a box of a command's output so the first line that says the error
// (lib/error-line.ts) stands near its top, with `context` lines above it.
// The box's text is what it shows (no color codes); false when no line says it.
export function scrollToError(box: HTMLElement, context = 2): boolean {
  const lines = (box.textContent ?? "").split("\n");
  const i = errorLine(lines);
  if (i < 0) return false;
  let offset = 0;
  for (let k = 0; k < i; k++) offset += lines[k]!.length + 1;
  // The text node that holds the line's first character.
  const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const len = n.textContent?.length ?? 0;
    if (seen + len <= offset) { seen += len; continue; }
    const range = document.createRange();
    range.setStart(n, offset - seen);
    range.setEnd(n, offset - seen + 1);
    const top = range.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientTop;
    const line = parseFloat(getComputedStyle(box).lineHeight) || 16;
    box.scrollTop = Math.max(0, box.scrollTop + top - context * line);
    return true;
  }
  return false;
}
