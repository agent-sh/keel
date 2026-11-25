// The stand-in image maker's pictures (src/providers/scripted.ts): a round cartoon face, its colors and parts
// taken from a seed, so one ask gives a few different faces and the same ask gives the same ones. Test-only.
import { encodePng } from "../pictures/png.ts";

const SIZE = 256;
type Rgb = [number, number, number];

// A color from a hue (degrees), soft: what a sticker would use.
function hsl(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export function cartoon(seed: string): Uint8Array {
  const n = Number(BigInt.asUintN(32, BigInt(Bun.hash(seed))));
  const bit = (k: number, m: number) => Math.floor(n / 2 ** k) % m;
  const hue = (n % 360 + 360) % 360;
  const bg = hsl(hue, 0.55, 0.88), face = hsl((hue + 30 + bit(9, 40)) % 360, 0.7, 0.66), dark: Rgb = [40, 36, 52];
  const ears = bit(3, 3), mouth = bit(5, 3), brows = bit(7, 2) === 1;
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  const put = (x: number, y: number, c: Rgb, cover: number) => {
    const i = (y * SIZE + x) * 4;
    for (let k = 0; k < 3; k++) rgba[i + k] = Math.round(rgba[i + k]! * (1 - cover) + c[k]! * cover);
    rgba[i + 3] = 255;
  };
  const fill = (inside: (x: number, y: number) => number, c: Rgb) => {
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) { const d = inside(x + 0.5, y + 0.5); if (d > 0) put(x, y, c, Math.min(1, d)); }
  };
  const disc = (cx: number, cy: number, r: number) => (x: number, y: number) => r - Math.hypot(x - cx, y - cy) + 0.5;
  fill(() => 1, bg);
  if (ears === 1) { fill(disc(58, 70, 34), face); fill(disc(198, 70, 34), face); fill(disc(58, 70, 18), hsl(hue, 0.6, 0.8)); fill(disc(198, 70, 18), hsl(hue, 0.6, 0.8)); }
  if (ears === 2) { fill((x, y) => 30 - Math.hypot((x - 70) * 1.6, y - 54) + 0.5, dark); fill((x, y) => 30 - Math.hypot((x - 186) * 1.6, y - 54) + 0.5, dark); }
  fill(disc(128, 138, 92), face);
  fill(disc(94, 128, 13), [255, 255, 255]); fill(disc(162, 128, 13), [255, 255, 255]);
  fill(disc(97, 130, 7), dark); fill(disc(159, 130, 7), dark);
  fill(disc(100, 127, 2.5), [255, 255, 255]); fill(disc(162, 127, 2.5), [255, 255, 255]);
  fill(disc(66, 160, 12), hsl(hue, 0.8, 0.78)); fill(disc(190, 160, 12), hsl(hue, 0.8, 0.78));
  if (brows) { fill((x, y) => 3 - Math.abs(y - (104 - (x - 94) * 0.1)) + (Math.abs(x - 94) < 14 ? 0.5 : -9), dark); fill((x, y) => 3 - Math.abs(y - (104 + (x - 162) * 0.1)) + (Math.abs(x - 162) < 14 ? 0.5 : -9), dark); }
  // The mouth: a smile, a wide smile or a small round "o".
  if (mouth === 2) fill(disc(128, 178, 9), dark);
  else {
    const w = mouth === 0 ? 24 : 34;
    fill((x, y) => 3.2 - Math.abs(y - (186 - ((x - 128) / w) ** 2 * 14)) + (Math.abs(x - 128) < w ? 0.5 : -9), dark);
  }
  return encodePng({ w: SIZE, h: SIZE, rgba });
}
