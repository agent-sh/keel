import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { clearGps, withoutLocation } from "./exif-scrub.ts";
import { attachmentPath, saveAttachment, saveAttachmentStream, setAttachmentsRoot } from "./attachments.ts";
import { fitPromptImages } from "./image-fit.ts";

// A TIFF block as a phone writes it: IFD0 with the orientation and a pointer to the GPS directory,
// which holds north, 48 degrees 51 minutes 29 seconds (out of line, 24 bytes) and the altitude ref.
function tiff(le = true): Buffer {
  const b = Buffer.alloc(120);
  const u16 = (v: number, at: number) => (le ? b.writeUInt16LE(v, at) : b.writeUInt16BE(v, at));
  const u32 = (v: number, at: number) => (le ? b.writeUInt32LE(v, at) : b.writeUInt32BE(v, at));
  b.write(le ? "II" : "MM", 0, "latin1"); u16(42, 2); u32(8, 4);
  // IFD0 at 8: two entries.
  u16(2, 8);
  u16(0x0112, 10); u16(3, 12); u32(1, 14); u16(6, 18); // orientation: 6 (turn right)
  u16(0x8825, 22); u16(4, 24); u32(1, 26); u32(38, 30); // GPS IFD at 38
  u32(0, 34);
  // GPS IFD at 38: three entries, then the latitude's rationals at 80.
  u16(3, 38);
  u16(0x0001, 40); u16(2, 42); u32(2, 44); b.write("N\0", 48, "latin1");
  u16(0x0002, 52); u16(5, 54); u32(3, 56); u32(80, 60);
  u16(0x0005, 64); u16(1, 66); u32(1, 68); b[72] = 0;
  u32(0, 76);
  [48, 1, 51, 1, 29, 1].forEach((n, i) => u32(n, 80 + i * 4));
  return b;
}
const LAT = (le = true) => tiff(le).subarray(80, 104);
const has = (b: Uint8Array, part: Uint8Array) => Buffer.from(b).indexOf(Buffer.from(part)) >= 0;

const pixels = async (type: "jpeg" | "png" | "webp") => {
  const img = new Bun.Image(Buffer.from(await new Bun.Image(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64")).resize(8, 8).png().bytes()));
  return Buffer.from(await (type === "jpeg" ? img.jpeg({ quality: 80 }) : type === "webp" ? img.webp() : img.png()).bytes());
};
const segment = (marker: number, body: Buffer) => { const h = Buffer.from([0xff, marker, 0, 0]); h.writeUInt16BE(body.length + 2, 2); return Buffer.concat([h, body]); };
const XMP = Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:Description exif:GPSLatitude="48,51.48N"/></x:xmpmeta>', "latin1");

async function jpegWithGps(le = true) {
  const j = await pixels("jpeg");
  return Buffer.concat([j.subarray(0, 2), segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff(le)])), segment(0xe1, XMP), j.subarray(2)]);
}
async function pngWithGps() {
  const p = await pixels("png");
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, "latin1");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  // After IHDR (8 + 25 bytes).
  return Buffer.concat([p.subarray(0, 33), chunk("eXIf", tiff()), p.subarray(33)]);
}
async function webpWithGps() {
  const w = await pixels("webp");
  const chunk = (type: string, data: Buffer) => { const h = Buffer.alloc(8); h.write(type, 0, "latin1"); h.writeUInt32LE(data.length, 4); return Buffer.concat([h, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const body = w.subarray(12);
  // A simple WebP: the extended header first, saying EXIF and XMP follow.
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x08 | 0x04; vp8x.writeUIntLE(7, 4, 3); vp8x.writeUIntLE(7, 7, 3);
  const all = Buffer.concat([chunk("VP8X", vp8x), body, chunk("EXIF", tiff()), chunk("XMP ", XMP.subarray(29))]);
  const head = Buffer.from("RIFF\0\0\0\0WEBP", "latin1"); head.writeUInt32LE(all.length + 4, 4);
  return Buffer.concat([head, all]);
}

describe("a photo leaves without where it was taken", () => {
  test("the GPS directory is cleared, in either byte order, and the rest of EXIF stays", () => {
    for (const le of [true, false]) {
      const t = tiff(le);
      expect(clearGps(t)).toBe(true);
      expect(has(t, LAT(le))).toBe(false);
      expect(t.toString("latin1").includes("N\0")).toBe(false);
      // The orientation is still there: the picture keeps its way up.
      expect(le ? t.readUInt16LE(18) : t.readUInt16BE(18)).toBe(6);
      expect(clearGps(t)).toBe(false);
    }
  });

  test("JPEG, PNG and WebP: the place is gone, the picture decodes the same", async () => {
    for (const [name, make] of [["jpeg", () => jpegWithGps()], ["jpeg (big-endian EXIF)", () => jpegWithGps(false)], ["png", pngWithGps], ["webp", webpWithGps]] as const) {
      const was = await make();
      expect(has(was, LAT(!name.includes("big")))).toBe(true);
      const now = withoutLocation(was);
      expect([name, has(now, LAT(!name.includes("big"))), Buffer.from(now).toString("latin1").includes("GPSLatitude")]).toEqual([name, false, false]);
      const m = await new Bun.Image(Buffer.from(now)).metadata();
      expect([name, m.width, m.height]).toEqual([name, 8, 8]);
      // Nothing to take away: the same bytes.
      expect(withoutLocation(now)).toBe(now);
    }
    const plain = await pixels("jpeg");
    expect(withoutLocation(plain)).toBe(plain);
  });

  test("every way an image is stored drops it: a prompt's image, an upload, a streamed upload", async () => {
    setAttachmentsRoot(mkdtempSync(join(tmpdir(), "keel-exif-")));
    const photo = await jpegWithGps();
    // A prompt's image from the page or the phone: within the limits, so it would go as it came.
    const [block] = await fitPromptImages([{ type: "image", media_type: "image/jpeg", data: photo.toString("base64") }]);
    expect(has(Buffer.from(block.data, "base64"), LAT())).toBe(false);
    // The phone's upload, and the page's.
    const up = saveAttachment(photo, "IMG_1.jpg", "image/jpeg");
    expect(has(await Bun.file(attachmentPath(up.id)!).bytes(), LAT())).toBe(false);
    const streamed = await saveAttachmentStream(new Blob([photo]).stream(), "IMG_2.jpg", "image/jpeg");
    const kept = await Bun.file(attachmentPath(streamed.id)!).bytes();
    expect([has(kept, LAT()), streamed.size, streamed.id]).toEqual([false, kept.length, new Bun.CryptoHasher("sha256").update(kept).digest("hex")]);
  });
});
