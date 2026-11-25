// What the Files panel needs to show a file by its kind, read in bounded parts: the kind from the
// first bytes and the name, a text range (never the whole file), the line count of a table, the
// names and sizes inside a ZIP or a tar (no extraction), the size of an image against what Keel
// stores. A file is never read whole: the most any call reads is one range, the tail of a ZIP, or
// the headers of a tar.
import { DECODE_PIXELS, STORE } from "../providers/image-limits.ts";
import { chunks } from "../core/proc.ts";
import { imageSize } from "../engine/images.ts";

export const RANGE = 512 * 1024;
// The most rows of a table or entries of an archive sent to the page.
export const LISTED = 1000;
// A page in a frame is bounded; a larger one is read as source.
export const HTML_MAX = 2 * 1024 * 1024;
// Counting a table's rows stops here (the count then says "at least").
const COUNT_MAX = 64 * 1024 * 1024;
// Walking an archive stops at this many bytes of a compressed tar's stream, or this many headers.
const WALK_MAX = 256 * 1024 * 1024;
const HEADERS_MAX = 20_000;

export type Kind = "markdown" | "csv" | "tsv" | "json" | "html" | "image" | "archive" | "text" | "binary";
export type Entry = { name: string; size: number; dir?: boolean };

const TEXT_BY_EXT: Record<string, Kind> = { md: "markdown", markdown: "markdown", mdx: "markdown", csv: "csv", tsv: "tsv", json: "json", html: "html", htm: "html" };
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const ext = (path: string) => (path.includes(".") ? path.split(".").pop()!.toLowerCase() : "");
const hasAt = (h: Uint8Array, at: number, s: string) => [...s].every((c, i) => h[at + i] === c.charCodeAt(0));

// What a binary file is, from its first bytes: a few that are common in a folder of code.
const MAGIC: [string, string][] = [
  ["%PDF-", "PDF document"], ["SQLite format 3", "SQLite database"], ["\x7fELF", "executable (ELF)"], ["\x00asm", "WebAssembly module"],
  ["7z\xbc\xaf\x27\x1c", "7-Zip archive"], ["\xfd7zXZ", "xz archive"], ["BZh", "bzip2 file"], ["\x1f\x8b", "gzip file"], ["Rar!", "RAR archive"],
  ["MZ", "Windows executable"], ["\xca\xfe\xba\xbe", "Java class or universal binary"], ["wOFF", "web font"], ["wOF2", "web font"], ["OggS", "Ogg media"],
  ["ID3", "MP3 audio"], ["RIFF", "RIFF media"], ["\x00\x00\x00", "media or data file"], ["\x1a\x45\xdf\xa3", "Matroska or WebM video"], ["II*\x00", "TIFF image"], ["MM\x00*", "TIFF image"], ["BM", "bitmap image"],
];

export function imageMime(h: Uint8Array): string | null {
  if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return "image/png";
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return "image/jpeg";
  if (hasAt(h, 0, "GIF8")) return "image/gif";
  if (hasAt(h, 0, "RIFF") && hasAt(h, 8, "WEBP")) return "image/webp";
  return null;
}

export type Shape = { kind: Kind; what: string; archive?: "zip" | "tar" | "tgz"; mime?: string };

// The kind of a file: by what its first bytes say, then its name.
export function shapeOf(path: string, head: Uint8Array): Shape {
  const e = ext(path);
  const mime = imageMime(head);
  if (mime) return { kind: "image", what: `${mime.slice(6).toUpperCase()} image`, mime };
  if (hasAt(head, 0, "PK\x03\x04") || hasAt(head, 0, "PK\x05\x06")) return { kind: "archive", what: "ZIP archive", archive: "zip" };
  if (hasAt(head, 257, "ustar")) return { kind: "archive", what: "tar archive", archive: "tar" };
  if (hasAt(head, 0, "\x1f\x8b") && /\.(tar\.gz|tgz)$/i.test(path)) return { kind: "archive", what: "compressed tar archive", archive: "tgz" };
  if (head.includes(0)) {
    const m = MAGIC.find(([s]) => hasAt(head, 0, s));
    return { kind: "binary", what: m?.[1] ?? (e ? `${e.toUpperCase()} file` : "binary file") };
  }
  const kind = TEXT_BY_EXT[e] ?? "text";
  return { kind, what: kind === "text" ? "text file" : `${kind === "markdown" ? "Markdown" : kind.toUpperCase()} file` };
}

// A text range from `offset`: starts and ends on whole characters, and when more follows, ends on a
// line so a table or a document is cut between rows. `to` is where the next range begins.
export async function textRange(f: Bun.BunFile, size: number, offset: number): Promise<{ text: string; from: number; to: number }> {
  const start = Math.max(0, Math.min(offset, size));
  const bytes = new Uint8Array(await f.slice(start, Math.min(size, start + RANGE + 4)).arrayBuffer());
  let a = 0;
  // A range that begins inside a character begins at the next one.
  if (start > 0) while (a < bytes.length && a < 4 && (bytes[a]! & 0xc0) === 0x80) a++;
  let b = Math.min(bytes.length, RANGE + a);
  if (start + b < size) {
    const nl = bytes.lastIndexOf(10, b - 1);
    if (nl > a) b = nl + 1;
    else while (b > a && (bytes[b]! & 0xc0) === 0x80) b--; // no line in it: end before a split character
  }
  return { text: new TextDecoder().decode(bytes.subarray(a, b)), from: start + a, to: start + b };
}

// The lines of a file: counted in chunks as they stream by, to `COUNT_MAX` bytes.
export async function countLines(f: Bun.BunFile, size: number): Promise<{ lines: number; exact: boolean }> {
  let lines = 0, last = 10, seen = 0;
  for await (const c of chunks(f.stream())) {
    for (let i = c.indexOf(10); i >= 0; i = c.indexOf(10, i + 1)) lines++;
    if (c.length) last = c[c.length - 1]!;
    seen += c.length;
    if (seen >= COUNT_MAX && seen < size) return { lines, exact: false };
  }
  return { lines: last === 10 ? lines : lines + 1, exact: true };
}

// An image against what Keel stores: shown when its bytes and pixels are within the limits, else
// named with its size.
export function imageFacts(head: Uint8Array, size: number): { w?: number; h?: number; shown: boolean; why?: string } {
  const dims = imageSize(Buffer.from(head).toString("base64"));
  // The base64 of the file is what a provider counts (image-limits.ts).
  if (STORE.base64 && Math.ceil(size / 3) * 4 > STORE.base64) return { ...dims, shown: false, why: `over ${Math.round(STORE.base64 / 1024 / 1024)} MB as base64` };
  if (dims && dims.w * dims.h > DECODE_PIXELS) return { ...dims, shown: false, why: `over ${DECODE_PIXELS.toLocaleString("en-US")} pixels` };
  return { ...dims, shown: true };
}

// ---- Archives ----

type Source = { read(n: number): Promise<Uint8Array>; skip(n: number): Promise<void> };

const u16 = (v: DataView, at: number) => v.getUint16(at, true);
const u32 = (v: DataView, at: number) => v.getUint32(at, true);
const u64 = (v: DataView, at: number) => Number(v.getBigUint64(at, true));
const view = (u: Uint8Array) => new DataView(u.buffer, u.byteOffset, u.byteLength);

// A ZIP's names and sizes from its central directory at the end: the tail of the file, then the directory.
export async function zipEntries(f: Bun.BunFile, size: number): Promise<{ entries: Entry[]; total: number; partial: boolean }> {
  const tailAt = Math.max(0, size - 65_557);
  const tail = new Uint8Array(await f.slice(tailAt, size).arrayBuffer());
  let e = tail.length - 22;
  while (e >= 0 && !(tail[e] === 0x50 && tail[e + 1] === 0x4b && tail[e + 2] === 5 && tail[e + 3] === 6)) e--;
  if (e < 0) return { entries: [], total: 0, partial: true };
  const tv = view(tail);
  let total = u16(tv, e + 10), cdSize = u32(tv, e + 12), cdAt = u32(tv, e + 16);
  if (total === 0xffff || cdAt === 0xffffffff || cdSize === 0xffffffff) {
    // ZIP64: the record that holds the real numbers is named by the locator before the end record.
    if (e >= 20 && u32(tv, e - 20) === 0x07064b50) {
      const rec = new Uint8Array(await f.slice(u64(tv, e - 20 + 8), u64(tv, e - 20 + 8) + 56).arrayBuffer());
      if (rec.length >= 56 && u32(view(rec), 0) === 0x06064b50) { const rv = view(rec); total = u64(rv, 32); cdSize = u64(rv, 40); cdAt = u64(rv, 48); }
    }
  }
  const CD_MAX = 8 * 1024 * 1024;
  const cd = new Uint8Array(await f.slice(cdAt, cdAt + Math.min(cdSize, CD_MAX)).arrayBuffer());
  const cv = view(cd);
  const entries: Entry[] = [];
  const text = new TextDecoder();
  for (let at = 0; at + 46 <= cd.length && entries.length < LISTED; ) {
    if (u32(cv, at) !== 0x02014b50) break;
    let usize = u32(cv, at + 24);
    const nameLen = u16(cv, at + 28), extraLen = u16(cv, at + 30), commentLen = u16(cv, at + 32);
    if (at + 46 + nameLen + extraLen > cd.length) break;
    const name = text.decode(cd.subarray(at + 46, at + 46 + nameLen));
    if (usize === 0xffffffff) {
      for (let x = at + 46 + nameLen; x + 4 <= at + 46 + nameLen + extraLen;) {
        const id = u16(cv, x), len = u16(cv, x + 2);
        if (id === 1 && len >= 8) { usize = u64(cv, x + 4); break; }
        x += 4 + len;
      }
    }
    entries.push({ name, size: usize, dir: name.endsWith("/") });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, total, partial: total > entries.length };
}

const octal = (b: Uint8Array) => {
  // A size too large for octal is base-256 (top bit set).
  if (b[0]! & 0x80) { let n = 0; for (let i = 1; i < b.length; i++) n = n * 256 + b[i]!; return n; }
  return parseInt(new TextDecoder().decode(b).replace(/\0.*$/s, "").trim() || "0", 8) || 0;
};
const cstr = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\0.*$/s, "");

type Walked = { entries: Entry[]; total: number; partial: boolean };
// Fills `out` as it goes, so a walk that fails midway leaves what it listed.
async function tarWalk(src: Source, out: Walked): Promise<Walked> {
  const entries = out.entries;
  let headers = 0, long = "", pax = "";
  for (;;) {
    if (headers++ >= HEADERS_MAX) return { ...out, partial: true };
    const h = await src.read(512);
    if (h.length < 512 || h.every((x) => x === 0)) return out;
    const size = octal(h.subarray(124, 136));
    const type = String.fromCharCode(h[156] || 48);
    const body = Math.ceil(size / 512) * 512;
    if (type === "L" && size <= 65_536) { long = cstr(await src.read(size)); await src.skip(body - size); continue; }
    if ((type === "x" || type === "g") && size <= 65_536) {
      const data = new TextDecoder().decode(await src.read(size));
      await src.skip(body - size);
      const m = /\d+ path=([^\n]*)\n/.exec(data);
      if (type === "x" && m) pax = m[1]!;
      continue;
    }
    let name = long || pax;
    if (!name) { const prefix = hasAt(h, 257, "ustar") ? cstr(h.subarray(345, 500)) : ""; name = (prefix ? `${prefix}/` : "") + cstr(h.subarray(0, 100)); }
    long = pax = "";
    const dir = type === "5" || name.endsWith("/");
    out.total++;
    if (entries.length < LISTED) entries.push({ name, size: dir ? 0 : size, dir });
    await src.skip(body);
  }
}

// A tar's names and sizes by its headers: a plain tar by seeking from header to header, a gzipped
// one by decompressing as a stream and passing over each file's bytes (nothing is written).
export async function tarEntries(f: Bun.BunFile, size: number, gz: boolean): Promise<{ entries: Entry[]; total: number; partial: boolean }> {
  if (!gz) {
    let pos = 0;
    return tarWalk({
      read: async (n) => { const b = new Uint8Array(await f.slice(pos, Math.min(size, pos + n)).arrayBuffer()); pos += n; return b; },
      skip: async (n) => { pos += n; },
    }, { entries: [], total: 0, partial: false });
  }
  const reader = chunks(f.stream().pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>));
  let buf: Uint8Array = new Uint8Array(0), scanned = 0, done = false;
  const pull = async () => {
    if (scanned > WALK_MAX) throw new Error("past the bytes walked");
    const r = await reader.next();
    if (r.done) { done = true; return null; }
    scanned += r.value.length;
    return r.value;
  };
  const src: Source = {
    read: async (n) => {
      while (buf.length < n && !done) {
        const c = await pull();
        if (!c) break;
        const o = new Uint8Array(buf.length + c.length);
        o.set(buf); o.set(c, buf.length);
        buf = o;
      }
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    },
    skip: async (n) => {
      const own = Math.min(buf.length, n);
      buf = buf.subarray(own);
      for (let left = n - own; left > 0 && !done;) {
        const c = await pull();
        if (!c) break;
        if (c.length > left) { buf = c.subarray(left); left = 0; } else left -= c.length;
      }
    },
  };
  const out: Walked = { entries: [], total: 0, partial: false };
  try {
    return await tarWalk(src, out);
  } catch {
    // Past what is walked, or a stream that ends early: what was listed stands, marked partial.
    return { ...out, partial: true };
  } finally {
    reader.return().catch(() => {});
  }
}
