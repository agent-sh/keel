// A PNG read into its pixels, and pixels written as a PNG (for a test's or a scratch repository's own
// pictures). Eight-bit gray, gray with alpha, RGB and RGBA, not interlaced: what a browser's screenshot
// is. Anything else is said, not guessed.
import { deflateSync, inflateSync } from "node:zlib";

export type Image = { w: number; h: number; rgba: Uint8Array };

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
// The most pixels one picture may have: a full-page shot of a tall page, with room.
export const MAX_PIXELS = 64_000_000;

export function decodePng(bytes: Uint8Array): Image | string {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 33 || !b.subarray(0, 8).equals(SIG)) return "not a PNG";
  let at = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  const data: Buffer[] = [];
  while (at + 8 <= b.length) {
    const len = b.readUInt32BE(at);
    const kind = b.toString("latin1", at + 4, at + 8);
    const body = b.subarray(at + 8, at + 8 + len);
    if (kind === "IHDR") { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]!; type = body[9]!; interlace = body[12]!; }
    else if (kind === "IDAT") data.push(body);
    else if (kind === "IEND") break;
    at += 12 + len;
  }
  const ch = CHANNELS[type];
  if (!w || !h) return "it has no header";
  if (depth !== 8 || !ch) return `its pixels are ${depth}-bit of color type ${type}, which is not read`;
  if (interlace) return "it is interlaced, which is not read";
  if (w * h > MAX_PIXELS) return `it is ${w}x${h}, over ${MAX_PIXELS} pixels`;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(data)); } catch (e) { return `its data does not inflate: ${(e as Error).message}`; }
  const stride = w * ch;
  if (raw.length < h * (stride + 1)) return "its data is short";
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1, row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= ch ? px[row + x - ch]! : 0;
      const up = y ? px[prev + x]! : 0;
      const c = y && x >= ch ? px[prev + x - ch]! : 0;
      let o: number;
      switch (f) {
        case 0: o = v; break;
        case 1: o = v + a; break;
        case 2: o = v + up; break;
        case 3: o = v + ((a + up) >> 1); break;
        case 4: { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); o = v + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c); break; }
        default: return `row ${y} has filter ${f}, which is not one`;
      }
      px[row + x] = o & 255;
    }
  }
  if (ch === 4) return { w, h, rgba: px };
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += ch) {
    const k = i * 4;
    if (ch === 3) { rgba[k] = px[j]!; rgba[k + 1] = px[j + 1]!; rgba[k + 2] = px[j + 2]!; rgba[k + 3] = 255; }
    else { const g = px[j]!; rgba[k] = rgba[k + 1] = rgba[k + 2] = g; rgba[k + 3] = ch === 2 ? px[j + 1]! : 255; }
  }
  return { w, h, rgba };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(kind: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(kind, 4, "latin1");
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

export function encodePng(img: Image): Uint8Array {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(img.w, 0); head.writeUInt32BE(img.h, 4);
  head[8] = 8; head[9] = 6;
  const stride = img.w * 4;
  const raw = Buffer.alloc(img.h * (stride + 1));
  for (let y = 0; y < img.h; y++) raw.set(img.rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return new Uint8Array(Buffer.concat([SIG, chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]));
}
