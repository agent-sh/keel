// Binary tool results as files. A blob an MCP server returns (an embedded
// resource, audio, a large base64 text) is saved under the session's spill
// folder with the extension its type gives, and the result names the path, so
// the model can Read it where it reads that type and the context does not
// carry base64. The folder is `files/` inside the spill folder: the storage
// retention removes it with the rest, and the page serves it from there.
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

// The extension of each type, one place (a type is read without its
// parameters).
export const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/json": "json",
  "application/xml": "xml", "text/xml": "xml",
  "application/zip": "zip", "application/x-zip-compressed": "zip",
  "application/gzip": "gz", "application/x-gzip": "gz",
  "application/x-tar": "tar", "application/x-7z-compressed": "7z", "application/vnd.rar": "rar",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/rtf": "rtf", "text/rtf": "rtf",
  "application/epub+zip": "epub",
  "application/wasm": "wasm",
  "application/vnd.sqlite3": "sqlite", "application/x-sqlite3": "sqlite",
  "text/plain": "txt", "text/markdown": "md", "text/csv": "csv", "text/html": "html", "text/tab-separated-values": "tsv",
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp",
  "image/svg+xml": "svg", "image/tiff": "tiff", "image/heic": "heic", "image/heif": "heif", "image/avif": "avif",
  "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
  "audio/ogg": "ogg", "audio/opus": "opus", "audio/flac": "flac", "audio/x-flac": "flac", "audio/aac": "aac",
  "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/webm": "weba", "audio/l16": "pcm",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/mpeg": "mpeg",
};

// What a type is when it says nothing: the server did not know, or sent the
// catch-all. The bytes decide then.
const GENERIC = new Set(["", "application/octet-stream", "binary/octet-stream", "application/x-binary", "application/unknown"]);

const typeOf = (mime?: string) => (mime ?? "").split(";")[0]!.trim().toLowerCase();

// The type the first bytes of a file give, for the formats a tool result is
// likely to carry; undefined when they say nothing.
export function sniffType(b: Uint8Array): string | undefined {
  const at = (i: number, s: string) => b.length >= i + s.length && [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (at(0, "%PDF-")) return "application/pdf";
  if (b[0] === 0x89 && at(1, "PNG\r\n\x1a\n")) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "image/gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  if (at(0, "RIFF") && at(8, "WAVE")) return "audio/wav";
  if (at(0, "OggS")) return "audio/ogg";
  if (at(0, "fLaC")) return "audio/flac";
  if (at(0, "ID3") || (b[0] === 0xff && b.length > 1 && (b[1]! & 0xe6) === 0xe2)) return "audio/mpeg";
  if (at(4, "ftyp")) return at(8, "M4A ") ? "audio/mp4" : "video/mp4";
  if (at(0, "PK\x03\x04")) return "application/zip";
  if (b[0] === 0x1f && b[1] === 0x8b) return "application/gzip";
  if (at(0, "SQLite format 3\0")) return "application/vnd.sqlite3";
  if (b[0] === 0 && at(1, "asm")) return "application/wasm";
  return undefined;
}

// The formats whose first bytes leave no doubt: a blob that starts like one
// of them is that, whatever its server declared. The others (a zip may be an
// Office file, a frame sync may be anything) only fill in a missing type.
const SURE = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "audio/wav", "audio/ogg", "audio/flac", "application/vnd.sqlite3", "application/wasm"]);

// The type a blob is: what its bytes say when they are sure, else the one its
// server declared, unless that says nothing (no type, or the catch-all): then
// what the bytes suggest, else the catch-all.
export function blobType(declared: string | undefined, bytes: Uint8Array): string {
  const t = typeOf(declared), sniffed = sniffType(bytes);
  if (sniffed && SURE.has(sniffed)) return sniffed;
  if (!GENERIC.has(t)) return t;
  return sniffed ?? "application/octet-stream";
}

// The extension a type gives, without the dot: from the table, else from a
// structured suffix (`application/vnd.x+json`), else the subtype when it is a
// plain word (`audio/amr`), else `bin`.
export function extOf(mime: string): string {
  const t = typeOf(mime);
  const known = MIME_EXT[t];
  if (known) return known;
  const suffix = /\+(json|xml|zip)$/.exec(t)?.[1];
  if (suffix) return suffix;
  const sub = /^(?:audio|video|image)\/(?:x-)?([a-z0-9]{1,6})$/.exec(t)?.[1];
  return sub ?? "bin";
}

// A size in words, as the transcript shows file sizes.
export function sizeWords(n: number): string {
  if (n < 1024) return n === 1 ? "1 byte" : `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// The bytes base64 holds (padding deducted).
export const base64Bytes = (b: string) => {
  const t = b.replace(/\s/g, "");
  return Math.max(0, Math.floor((t.length * 3) / 4) - (t.endsWith("==") ? 2 : t.endsWith("=") ? 1 : 0));
};

// A text part is a blob when it is base64 of at least this many characters
// that decodes to bytes, not to text. Past a few thousand characters base64
// costs more of the context than anything it could be read for; shorter
// strings (a token, a hash, a key) are what a tool says in words.
export const BASE64_TEXT_MIN = 4096;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_URI = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w.=+-]+)*;base64,/i;

// The blob a text part is, or undefined when it is words. A `data:` address
// gives its type; wrapped lines (MIME base64) are one value. Base64 of text
// stays text: the model reads it as it is, and a file of it would only hide it.
export function base64Blob(text: string): { bytes: Buffer; mime?: string } | undefined {
  if (text.length < BASE64_TEXT_MIN) return undefined;
  const t = text.trim();
  const uri = DATA_URI.exec(t);
  const raw = uri ? t.slice(uri[0].length) : t;
  // Wrapped lines are the same length (the last may be shorter); a space is never in base64, and prose without
  // punctuation has the same letters.
  if (/[ \t]/.test(raw)) return undefined;
  const lines = raw.split(/\r?\n/);
  if (lines.length > 1 && lines.slice(0, -1).some((l) => l.length !== lines[0]!.length || l.length < lines.at(-1)!.length)) return undefined;
  const body = lines.join("");
  if (body.length < BASE64_TEXT_MIN || body.length % 4 !== 0 || !B64.test(body)) return undefined;
  const bytes = Buffer.from(body, "base64");
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return undefined; } catch {}
  return { bytes, mime: uri?.[1] };
}

// What a name may be made of: letters, digits, dots, dashes, underscores.
const part = (s: string) => s.replace(/[^\w.-]/g, "_").replace(/^\.+/, "").slice(0, 40);

export type SavedFile = { name: string; path: string; media_type: string; size: number };

// The blob as a file under `<dir>/files/`, named from what it came from and a
// digest of its bytes: the same bytes in the same session are one file.
// `from`: a file name the blob came with (a resource's own), else the label
// of the tool. `name` of the result is what the owner sees for it.
export async function saveBlob(dir: string, label: string, bytes: Uint8Array, mime: string, from?: string): Promise<SavedFile> {
  const folder = join(dir, "files");
  mkdirSync(folder, { recursive: true });
  const ext = extOf(mime);
  const base = part((from ? basename(from).replace(/\.[A-Za-z0-9]{1,8}$/, "") : "") || label) || "blob";
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 12);
  const path = join(folder, `${base}-${digest}.${ext}`);
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // the same bytes were saved before
  }
  return { name: `${base}.${ext}`, path, media_type: mime, size: bytes.byteLength };
}
