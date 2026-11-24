import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, cellsOf } from "./diff.ts";
import { pairsOf } from "./pairs.ts";
import { encodePng, type Image } from "./png.ts";

// A 64x64 white picture with some 8x8 cells painted.
const pic = (cells: [number, number, number][] = []): Image => {
  const w = 64, h = 64, rgba = new Uint8Array(w * h * 4).fill(255);
  for (const [cx, cy, v] of cells) for (let y = cy * 8; y < cy * 8 + 8; y++) for (let x = cx * 8; x < cx * 8 + 8; x++) { const i = (y * w + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = v; }
  return { w, h, rgba };
};

const root = mkdtempSync(join(tmpdir(), "keel-pairs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function sides(name: string, before: Image, after: Image, again: Image) {
  const at = join(root, name);
  for (const [s, img] of [["before", before], ["after", after], ["again", again]] as const) { mkdirSync(join(at, s), { recursive: true }); writeFileSync(join(at, s, "x.png"), encodePng(img)); }
  return pairsOf(join(at, "before"), join(at, "after"), ["x.png"], ["x.png"], { dir: join(at, "again"), names: ["x.png"] })[0]!;
}

describe("a pair against a second run of the base", () => {
  test("a change in a cell next to one the base moves in is still a change, outlined alone", () => {
    const base = pic([[2, 2, 0]]), again = pic([[2, 2, 90]]);
    const c = compare(base, pic([[2, 2, 40], [3, 2, 0]]), undefined, cellsOf(base, again));
    expect(c.changed).toBe(64);
    expect(c.boxes).toEqual([{ x: 24, y: 16, w: 8, h: 8 }]);
    expect(c.noise).toBe(64);
  });

  test("a pair that moves only where the base moves is unstable, never changed or same", () => {
    const p = sides("shaky", pic([[1, 1, 0]]), pic([[1, 1, 60]]), pic([[1, 1, 120]]));
    expect(p.state).toBe("unstable");
    expect(p.boxes).toEqual([{ x: 8, y: 8, w: 8, h: 8 }]);
  });

  test("a real change beside the noise makes the pair changed", () => {
    const p = sides("both", pic([[1, 1, 0]]), pic([[1, 1, 60], [2, 1, 0]]), pic([[1, 1, 120]]));
    expect(p.state).toBe("changed");
    expect(p.boxes).toEqual([{ x: 16, y: 8, w: 8, h: 8 }]);
  });
});
