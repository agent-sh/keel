// Two pictures of the same view compared: which pixels differ past a threshold, and the areas around
// them, outlined. Pure. A pixel differs when its color moved more than `threshold` in YIQ space, as
// pixelmatch measures it (its default threshold is 0.1; Playwright's toHaveScreenshot uses it too, at 0.2).
// Transparent pixels are seen over white. The changed pixels are gathered in cells, cells near each other
// are one area, and areas are merged until at most MAX_AREAS are left (the smallest growth first).
// `noise`: the cells two runs of the base differ in. A cell of the change that is one of them is not the
// branch's (it is unstable); every other cell is, a cell next to a noisy one too: nothing real is hidden
// by what moves beside it.
import type { Image } from "./png.ts";

export type Box = { x: number; y: number; w: number; h: number };
export type Compared = { changed: number; share: number; boxes: Box[]; size?: { before: [number, number]; after: [number, number] } };
export const THRESHOLD = 0.1;
// A cell's side, in pixels, and how many cells apart two changes may be and still be one area.
const CELL = 8;
const NEAR = 2;
// More outlines than this on one picture read as noise: merged into fewer, larger ones.
export const MAX_AREAS = 12;

const MAX_DELTA = 35215;
function yiq(r: number, g: number, b: number, a: number): [number, number, number] {
  if (a < 255) { const k = a / 255; r = 255 + (r - 255) * k; g = 255 + (g - 255) * k; b = 255 + (b - 255) * k; }
  return [r * 0.29889531 + g * 0.58662247 + b * 0.11448223, r * 0.59597799 - g * 0.2741761 - b * 0.32180189, r * 0.21147017 - g * 0.52261711 + b * 0.31114694];
}

// The cells of the grid over two pictures where a pixel differs, with how many pixels differ in each.
export type Cells = { counts: Uint16Array; cw: number; ch: number; W: number; H: number };
export function cellsOf(a: Image, b: Image, threshold = THRESHOLD): Cells {
  const W = Math.max(a.w, b.w), H = Math.max(a.h, b.h);
  const cw = Math.ceil(W / CELL), ch = Math.ceil(H / CELL);
  const counts = new Uint16Array(cw * ch);
  const limit = MAX_DELTA * threshold * threshold;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let diff: boolean;
      if (x >= a.w || y >= a.h || x >= b.w || y >= b.h) diff = true;
      else {
        const i = (y * a.w + x) * 4, j = (y * b.w + x) * 4;
        const pa = a.rgba, pb = b.rgba;
        if (pa[i] === pb[j] && pa[i + 1] === pb[j + 1] && pa[i + 2] === pb[j + 2] && pa[i + 3] === pb[j + 3]) continue;
        const [y1, i1, q1] = yiq(pa[i]!, pa[i + 1]!, pa[i + 2]!, pa[i + 3]!);
        const [y2, i2, q2] = yiq(pb[j]!, pb[j + 1]!, pb[j + 2]!, pb[j + 3]!);
        const dy = y1 - y2, di = i1 - i2, dq = q1 - q2;
        diff = 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq > limit;
      }
      if (diff) { const k = Math.floor(y / CELL) * cw + Math.floor(x / CELL); counts[k] = counts[k]! + 1; }
    }
  }
  return { counts, cw, ch, W, H };
}

export function compare(a: Image, b: Image, threshold = THRESHOLD, noise?: Cells): Compared & { noise: number; unstable: Box[] } {
  const c = cellsOf(a, b, threshold);
  const { cw, ch, W, H } = c;
  const marked = new Uint8Array(cw * ch), noisy = new Uint8Array(cw * ch);
  let changed = 0, masked = 0;
  const same = noise && noise.cw === cw && noise.ch === ch;
  for (let k = 0; k < marked.length; k++) {
    if (!c.counts[k]) continue;
    if (same && noise!.counts[k]) { noisy[k] = 1; masked += c.counts[k]!; continue; }
    marked[k] = 1;
    changed += c.counts[k]!;
  }
  const px = (r: Box) => clip({ x: r.x * CELL, y: r.y * CELL, w: r.w * CELL, h: r.h * CELL }, W, H);
  const boxes = changed ? areasOf(marked, cw, ch).map(px) : [];
  const unstable = masked ? areasOf(noisy, cw, ch).map(px) : [];
  return { changed, share: changed / (W * H), boxes, noise: masked, unstable, ...(a.w !== b.w || a.h !== b.h ? { size: { before: [a.w, a.h], after: [b.w, b.h] } } : {}) };
}

const clip = (r: Box, W: number, H: number): Box => ({ x: r.x, y: r.y, w: Math.min(r.w, W - r.x), h: Math.min(r.h, H - r.y) });

// The marked cells gathered into areas: cells within NEAR of each other are one.
export function areasOf(cells: Uint8Array, cw: number, ch: number): Box[] {
  const seen = new Uint8Array(cells.length);
  let boxes: Box[] = [];
  for (let s = 0; s < cells.length; s++) {
    if (!cells[s] || seen[s]) continue;
    let x0 = s % cw, x1 = x0, y0 = Math.floor(s / cw), y1 = y0;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % cw, cy = Math.floor(c / cw);
      x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
      for (let dy = -NEAR; dy <= NEAR; dy++) for (let dx = -NEAR; dx <= NEAR; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
        const n = ny * cw + nx;
        if (cells[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    boxes.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  // Boxes that overlap are one; then the pair whose union grows least is merged until few are left.
  boxes = mergeOverlaps(boxes);
  while (boxes.length > MAX_AREAS) {
    let bi = 0, bj = 1, best = Infinity;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const u = union(boxes[i]!, boxes[j]!);
      const grow = u.w * u.h - boxes[i]!.w * boxes[i]!.h - boxes[j]!.w * boxes[j]!.h;
      if (grow < best) { best = grow; bi = i; bj = j; }
    }
    const u = union(boxes[bi]!, boxes[bj]!);
    boxes = mergeOverlaps([...boxes.filter((_, k) => k !== bi && k !== bj), u]);
  }
  return boxes.sort((p, q) => p.y - q.y || p.x - q.x);
}
const union = (a: Box, b: Box): Box => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; };
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function mergeOverlaps(boxes: Box[]): Box[] {
  const out = [...boxes];
  for (let again = true; again;) {
    again = false;
    for (let i = 0; i < out.length && !again; i++) for (let j = i + 1; j < out.length; j++) {
      if (!overlap(out[i]!, out[j]!)) continue;
      out[i] = union(out[i]!, out[j]!);
      out.splice(j, 1);
      again = true;
      break;
    }
  }
  return out;
}

// The pictures of two sides paired by name: both (compared), only after (new), only before (gone).
export type PairOf = { name: string; before: boolean; after: boolean };
export function pairNames(before: readonly string[], after: readonly string[]): PairOf[] {
  const b = new Set(before), a = new Set(after);
  return [...new Set([...before, ...after])].sort().map((name) => ({ name, before: b.has(name), after: a.has(name) }));
}

// A picture's name read for its view: "<shot>-<W>x<H>-<theme>.png" as the repository's shoot() writes it, else the name alone.
export function viewOf(name: string): { shot: string; size: string | null; theme: string | null } {
  const m = /^(.*?)(?:-(\d{2,5}x\d{2,5}))?(?:-(light|dark))?\.png$/.exec(name);
  return m ? { shot: m[1]!, size: m[2] ?? null, theme: m[3] ?? null } : { shot: name, size: null, theme: null };
}
