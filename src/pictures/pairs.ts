// The pairs of one run: each picture's two sides read and compared. Runs on a thread of its own
// (src/pictures/diff-worker.ts): a browser's picture is millions of pixels.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cellsOf, compare, pairNames, viewOf, type Box } from "./diff.ts";
import { decodePng } from "./png.ts";

// unstable: it differs between two runs of the base, and only where those differ: no change of the branch's is
// seen in it (one that is, next to the noise or not, makes the pair changed).
export type PairState = "same" | "changed" | "unstable" | "new" | "gone" | "unread";
export type Pair = {
  name: string; shot: string; size: string | null; theme: string | null;
  state: PairState;
  w?: number; h?: number;              // the after side's size (the before side's for one that is gone)
  changed?: number; share?: number;    // pixels that differ, and their share of the picture
  boxes?: Box[];                       // the changed areas, in the after side's pixels (of an unstable pair: where it moves)
  resized?: { before: [number, number]; after: [number, number] };
  noise?: number;                      // pixels that differ where two runs of the base differ too (not counted as changed)
  why?: string;                        // why a side could not be read
};

const ORDER: Record<PairState, number> = { changed: 0, new: 1, gone: 2, unread: 3, unstable: 4, same: 5 };

// `again`: a second run of the base (its folder and names), when one was taken: what differs between the two
// runs of the base is no change of the branch's.
export function pairsOf(beforeDir: string, afterDir: string, before: readonly string[], after: readonly string[], again?: { dir: string; names: readonly string[] }): Pair[] {
  const twice = new Set(again?.names ?? []);
  const out: Pair[] = [];
  for (const p of pairNames(before, after)) {
    const v = viewOf(p.name);
    const base = { name: p.name, shot: v.shot, size: v.size, theme: v.theme };
    const read = (dir: string) => { try { return new Uint8Array(readFileSync(join(dir, p.name))); } catch (e) { return (e as Error).message; } };
    const b = p.before ? read(beforeDir) : undefined, a = p.after ? read(afterDir) : undefined;
    if (typeof b === "string" || typeof a === "string") { out.push({ ...base, state: "unread", why: (typeof b === "string" ? b : a) as string }); continue; }
    if (!b || !a) {
      const img = decodePng((a ?? b)!);
      out.push({ ...base, state: a ? "new" : "gone", ...(typeof img === "string" ? { why: img } : { w: img.w, h: img.h }) });
      continue;
    }
    const ia = decodePng(a), ib = decodePng(b);
    if (typeof ib === "string" || typeof ia === "string") { out.push({ ...base, state: "unread", why: `${typeof ib === "string" ? "before" : "after"}: ${typeof ib === "string" ? ib : ia}` }); continue; }
    if (Buffer.from(a).equals(Buffer.from(b))) { out.push({ ...base, state: "same", w: ia.w, h: ia.h, changed: 0, share: 0 }); continue; }
    let noise: ReturnType<typeof cellsOf> | undefined;
    if (again && twice.has(p.name)) {
      const g = (() => { try { return decodePng(new Uint8Array(readFileSync(join(again.dir, p.name)))); } catch { return "unread"; } })();
      if (typeof g !== "string" && g.w === ib.w && g.h === ib.h) noise = cellsOf(ib, g);
    }
    const c = compare(ib, ia, undefined, noise);
    const state: PairState = c.changed ? "changed" : c.noise ? "unstable" : "same";
    const boxes = state === "unstable" ? c.unstable : c.boxes;
    out.push({ ...base, state, w: ia.w, h: ia.h, changed: c.changed, share: c.share, ...(boxes.length ? { boxes } : {}), ...(c.size ? { resized: c.size } : {}), ...(c.noise ? { noise: c.noise } : {}) });
  }
  return out.sort((x, y) => ORDER[x.state] - ORDER[y.state] || (x.name < y.name ? -1 : 1));
}
