// Where a photo was taken never leaves the machine with it. A phone writes the
// place into the photo (EXIF GPS, XMP), and an image that fits the providers'
// limits is sent as it came (src/engine/image-fit.ts), so the place would reach
// the provider. Every image stored from a prompt or an upload is scrubbed here
// first: the GPS fields are cleared in place (the rest of EXIF stays, its
// orientation among them, so the picture keeps its way up), and XMP, which can
// carry the place again, is dropped. No decode, no re-encode: the pixels are
// the same bytes. JPEG, PNG and WebP; anything else is returned as it is.
import { crc32 } from "node:zlib";

// The bytes each TIFF type takes per value.
const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
const GPS_IFD = 0x8825;
const XMP_ID = "http://ns.adobe.com/xap/1.0/\0";
const XMP_EXT_ID = "http://ns.adobe.com/xmp/extension/\0";

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

// Clears the GPS directory of a TIFF block (EXIF's body) in place: each entry
// and the values it points at become zeros, and the directory holds no entry.
// True when there was something to clear.
export function clearGps(t: Uint8Array): boolean {
  if (t.length < 8) return false;
  const le = ascii(t, 0, 2) === "II";
  if (!le && ascii(t, 0, 2) !== "MM") return false;
  const v = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const u16 = (at: number) => v.getUint16(at, le), u32 = (at: number) => v.getUint32(at, le);
  const ifd0 = u32(4);
  if (ifd0 + 2 > t.length) return false;
  let gps = 0;
  for (let i = 0, n = u16(ifd0); i < n; i++) {
    const e = ifd0 + 2 + i * 12;
    if (e + 12 > t.length) break;
    if (u16(e) === GPS_IFD) gps = u32(e + 8);
  }
  if (!gps || gps + 2 > t.length) return false;
  const n = u16(gps);
  if (!n) return false;
  for (let i = 0; i < n; i++) {
    const e = gps + 2 + i * 12;
    if (e + 12 > t.length) break;
    const bytes = (SIZE[u16(e + 2)] ?? 1) * u32(e + 4);
    if (bytes > 4) { const at = u32(e + 8); if (at < t.length) t.fill(0, at, Math.min(t.length, at + bytes)); }
    t.fill(0, e, e + 12);
  }
  v.setUint16(gps, 0, le);
  return true;
}

function jpeg(b: Uint8Array): Uint8Array | null {
  const keep: Uint8Array[] = [b.subarray(0, 2)];
  let at = 2, changed = false;
  while (at + 4 <= b.length && b[at] === 0xff) {
    const marker = b[at + 1]!;
    // Start of scan: the rest is the picture.
    if (marker === 0xda) break;
    // Markers with no length of their own.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { keep.push(b.subarray(at, at + 2)); at += 2; continue; }
    const len = (b[at + 2]! << 8) | b[at + 3]!;
    const seg = b.subarray(at, at + 2 + len);
    if (marker === 0xe1) {
      const body = seg.subarray(4);
      if (ascii(body, 0, 6) === "Exif\0\0") {
        const copy = seg.slice();
        if (clearGps(copy.subarray(10))) { changed = true; keep.push(copy); } else keep.push(seg);
      } else if (ascii(body, 0, XMP_ID.length) === XMP_ID || ascii(body, 0, XMP_EXT_ID.length) === XMP_EXT_ID) changed = true;
      else keep.push(seg);
    } else keep.push(seg);
    at += 2 + len;
  }
  if (!changed) return null;
  keep.push(b.subarray(at));
  return Buffer.concat(keep);
}

function png(b: Uint8Array): Uint8Array | null {
  const keep: Uint8Array[] = [b.subarray(0, 8)];
  let at = 8, changed = false;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (at + 12 <= b.length) {
    const len = v.getUint32(at), type = ascii(b, at + 4, 4);
    const chunk = b.subarray(at, at + 12 + len);
    if (type === "eXIf") {
      const copy = chunk.slice();
      if (clearGps(copy.subarray(8, 8 + len))) {
        new DataView(copy.buffer).setUint32(8 + len, crc32(copy.subarray(4, 8 + len)) >>> 0);
        changed = true; keep.push(copy);
      } else keep.push(chunk);
    } else if (type === "iTXt" && ascii(b, at + 8, 18) === "XML:com.adobe.xmp\0") changed = true;
    else keep.push(chunk);
    at += 12 + len;
    if (type === "IEND") break;
  }
  if (!changed) return null;
  keep.push(b.subarray(at));
  return Buffer.concat(keep);
}

function webp(b: Uint8Array): Uint8Array | null {
  const keep: Uint8Array[] = [];
  let at = 12, changed = false, vp8x = -1;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (at + 8 <= b.length) {
    const type = ascii(b, at, 4), len = v.getUint32(at + 4, true);
    const chunk = b.subarray(at, at + 8 + len + (len & 1));
    if (type === "EXIF") {
      const copy = chunk.slice();
      // Some writers put EXIF's JPEG prefix in front of the TIFF block.
      const off = ascii(copy, 8, 6) === "Exif\0\0" ? 14 : 8;
      if (clearGps(copy.subarray(off, 8 + len))) { changed = true; keep.push(copy); } else keep.push(chunk);
    } else if (type === "XMP ") changed = true;
    else { if (type === "VP8X") vp8x = keep.length; keep.push(chunk); }
    at += 8 + len + (len & 1);
  }
  if (!changed) return null;
  // The extended header says whether XMP follows: it does not any more.
  if (vp8x >= 0) { const c = keep[vp8x]!.slice(); c[8] = c[8]! & ~0x04; keep[vp8x] = c; }
  const body = Buffer.concat(keep);
  const head = Buffer.from(b.subarray(0, 12));
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}

/** The image without where it was taken: the same bytes when it says nothing of it. */
export function withoutLocation(b: Uint8Array): Uint8Array {
  try {
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpeg(b) ?? b;
    if (b.length > 8 && ascii(b, 1, 3) === "PNG") return png(b) ?? b;
    if (b.length > 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return webp(b) ?? b;
  } catch {
    // A damaged header: left to the decoder to refuse, as before.
  }
  return b;
}

/** The same for an image block's base64. */
export function base64WithoutLocation(data: string): string {
  const b = Buffer.from(data, "base64");
  const out = withoutLocation(b);
  return out === b ? data : Buffer.from(out).toString("base64");
}
