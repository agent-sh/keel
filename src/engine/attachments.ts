// Files attached to a prompt. Each is stored once by content under
// <state>/attachments/<sha256>/<name>; the prompt keeps a small reference
// (AttachmentBlock), so the history stays light and its bytes stable. Just
// before a request each reference becomes what the model can read:
//   - text (UTF-8, or UTF-16 with its byte-order mark or declared charset, up
//     to TEXT_INLINE bytes): the file inline, named;
//   - a PDF, where the model's listing says it reads PDFs: a document block;
//   - anything else (a PDF for a model without PDF input, a spreadsheet, a
//     long log): a note with the saved path, for the model's own tools.
// The same reference always resolves to the same bytes for a given model.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { chunks } from "../core/proc.ts";
import { decodeText, textEncoding } from "../core/text.ts";
import type { AttachmentBlock, Message } from "../core/types.ts";
import type { ModelInfo } from "../providers/types.ts";

export const ATTACHMENT_MAX = 20 * 1024 * 1024; // the same cap as the Rust Keel's uploads
// About 25k tokens: what one Read of a file returns in Claude Code. Longer text
// goes by path. Shared with the context estimate (src/engine/compact.ts).
export { TEXT_INLINE } from "./compact.ts";
import { TEXT_INLINE, TEXT_MEDIA } from "./compact.ts";

let root = "";
// A file is written under <root>/.tmp and put in place whole. What a daemon
// that went down mid-upload left there goes at a later start (an upload under
// way now is younger than that).
const PART_KEEP_MS = 3_600_000;
export const setAttachmentsRoot = (dir: string) => {
  root = join(dir, "attachments");
  const parts = join(root, ".tmp");
  if (!existsSync(parts)) return;
  for (const d of readdirSync(parts)) {
    try { if (Date.now() - statSync(join(parts, d)).mtimeMs > PART_KEEP_MS) rmSync(join(parts, d), { recursive: true, force: true }); } catch {}
  }
};
export const hasAttachmentsRoot = () => !!root;

// The name the owner sees and the model reads: the file's own name in any
// script, without path parts, control characters or quotes. A name that is
// only dots names a folder, not a file: it is `file`.
const shownName = (n: string) => {
  const name = basename(n.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f"<>]/g, "_").trim().slice(0, 120);
  return /^\.*$/.test(name) ? "file" : name;
};
// On disk: the name when it is plain ASCII, else `file` plus its extension,
// so the path stays safe everywhere and the extension still gives the type.
const diskName = (n: string) => (/^[\w.\- ()+]+$/.test(n) ? n : `file${/\.[A-Za-z0-9]{1,10}$/.exec(n)?.[0]?.toLowerCase() ?? ""}`);

const refOf = (id: string, shown: string, mediaType: string, size: number, charset?: string): AttachmentBlock => {
  const cs = charset?.trim().toLowerCase().replace(/^"|"$/g, "");
  return { type: "attachment", id, name: shown, media_type: mediaType || "application/octet-stream", size, ...(cs && /^[\w.:-]{1,40}$/.test(cs) ? { charset: cs } : {}) };
};

// A folder of its own for one file on its way in.
function partDir(): string {
  const dir = join(root, ".tmp", Bun.randomUUIDv7());
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The folder that holds a whole file becomes the content's folder in one
// rename: a reader never finds half a file under a content's id, and the same
// bytes under another name or extension stay one copy (the folder is there
// already, so this one goes; each prompt keeps its own name).
function publish(part: string, id: string) {
  try {
    renameSync(part, join(root, id));
  } catch (e) {
    rmSync(part, { recursive: true, force: true });
    if (!["ENOTEMPTY", "EEXIST"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
  }
}

export function saveAttachment(bytes: Uint8Array, name: string, mediaType: string, charset?: string): AttachmentBlock {
  const id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const shown = shownName(name);
  if (!attachmentPath(id)) {
    const part = partDir();
    try { writeFileSync(join(part, diskName(shown)), bytes); } catch (e) { rmSync(part, { recursive: true, force: true }); throw e; }
    publish(part, id);
  }
  return refOf(id, shown, mediaType, bytes.byteLength, charset);
}

const refused = (message: string, status: number) => Object.assign(new Error(message), { status });
export const TOO_LARGE = `a file can be at most ${ATTACHMENT_MAX / 1024 / 1024} MiB`;

// An upload as it arrives: each chunk is hashed and written to its part file
// before the next is read, so a file of any size holds one chunk in memory.
// A body past the cap stops being read there; that, an empty body and an
// upload cut off on its way are refused (`status`) with nothing left on disk.
export async function saveAttachmentStream(body: ReadableStream<Uint8Array>, name: string, mediaType: string, charset?: string): Promise<AttachmentBlock> {
  const shown = shownName(name);
  const part = partDir();
  // Read through chunks(): a read left early cancels the stream, so the body is read no further.
  const read = chunks(body);
  const hash = new Bun.CryptoHasher("sha256");
  let size = 0;
  try {
    const file = await open(join(part, diskName(shown)), "wx");
    try {
      for (;;) {
        const { done, value } = await read.next().catch(() => { throw refused("the upload was cut off before its end", 400); });
        if (done) break;
        size += value.byteLength;
        if (size > ATTACHMENT_MAX) throw refused(TOO_LARGE, 413);
        hash.update(value);
        for (let at = 0; at < value.byteLength;) at += (await file.write(value, at)).bytesWritten;
      }
    } finally {
      await file.close();
    }
    if (!size) throw refused("the file is empty", 400);
  } catch (e) {
    await read.return().catch(() => {});
    rmSync(part, { recursive: true, force: true });
    throw e;
  }
  const id = hash.digest("hex");
  publish(part, id);
  return refOf(id, shown, mediaType, size, charset);
}

// What a download says it is: the type its name gives; a file declared as
// text whose bytes are text is text/plain whatever its name; anything else
// unknown stays binary.
export function servedType(path: string, name: string, declared?: string): string {
  const byName = Bun.file(name).type || Bun.file(path).type;
  if (byName && byName !== "application/octet-stream") return byName;
  if (declared && TEXT_MEDIA.test(declared) && "text" in attachmentText({ type: "attachment", id: "", name, media_type: declared, size: 0 }, read(path))) return "text/plain;charset=utf-8";
  return "application/octet-stream";
}

// A stored file removed again: what an import wrote before it failed.
export function dropAttachment(id: string) {
  if (/^[0-9a-f]{64}$/.test(id)) rmSync(join(root, id), { recursive: true, force: true });
}

export function attachmentPath(id: string): string | undefined {
  if (!/^[0-9a-f]{64}$/.test(id)) return undefined;
  const dir = join(root, id);
  if (!existsSync(dir)) return undefined;
  const f = readdirSync(dir)[0];
  return f ? join(dir, f) : undefined;
}

const textType = (a: AttachmentBlock) =>
  TEXT_MEDIA.test(a.media_type) || a.media_type === "application/octet-stream";

// A text file's characters, by the one decoder (core/text.ts) with the
// charset the upload declared. Decoding is strict here: bytes that are not
// text, or not valid in their encoding, give a reason instead.
function attachmentText(a: AttachmentBlock, bytes: Uint8Array): { text: string } | { why: string } {
  if (!textType(a)) return { why: "it is not text" };
  const enc = textEncoding(bytes, a.charset).encoding;
  // A zero byte in UTF-8 text marks a binary file; UTF-16 holds them by design.
  if (!enc.startsWith("utf-16") && bytes.subarray(0, 8000).includes(0)) return { why: "it is not text" };
  let r: ReturnType<typeof decodeText>;
  try {
    r = decodeText(bytes, { charset: a.charset, fatal: true });
  } catch (e) {
    return { why: e instanceof RangeError ? `its declared encoding ${enc} is not supported` : `it is not valid ${enc.toUpperCase()} text` };
  }
  if (r.text.includes("\u0000")) return { why: "it is not text" };
  return { text: r.text };
}

const cache = new Map<string, Buffer>();
const read = (path: string) => {
  let b = cache.get(path);
  if (!b) {
    b = readFileSync(path);
    if (cache.size > 64) cache.clear();
    cache.set(path, b);
  }
  return b;
};

// The folders of the files a session was given by path, as its requests name
// them: its commands read those in a sandbox, and no other session's.
const given = new Map<string, Set<string>>();
export const attachmentsGiven = (sessionId: string): string[] => [...(given.get(sessionId) ?? [])];

// `sessionId`: the session the request is of, when its model may read the files with its tools.
export function resolveAttachments(messages: Message[], info: Pick<ModelInfo, "pdf" | "name">, sessionId?: string): Message[] {
  if (!messages.some((m) => m.role === "user" && m.content.some((b: any) => b.type === "attachment"))) return messages;
  const note = (path: string) => {
    if (!sessionId) return;
    let set = given.get(sessionId);
    if (!set) { if (given.size > 2000) given.clear(); given.set(sessionId, (set = new Set())); }
    set.add(dirname(path));
  };
  return messages.map((m) => {
    if (m.role !== "user" || !m.content.some((b: any) => b.type === "attachment")) return m;
    const content = m.content.map((b: any) => {
      if (b.type !== "attachment") return b;
      const a = b as AttachmentBlock;
      const path = attachmentPath(a.id);
      if (!path) return { type: "text", text: `[Attached file ${a.name} is no longer stored.]` };
      note(path);
      // The original of an image stored scaled down: its path, for the model's tools.
      if (a.scaled) return { type: "text", text: `[The image before this was scaled from ${a.scaled.from.join("x")} to ${a.scaled.to.join("x")} to fit the providers' image limits; the original is at ${path}.]` };
      const bytes = read(path);
      if (a.media_type === "application/pdf" && info.pdf) return { type: "document", media_type: a.media_type, data: bytes.toString("base64"), name: a.name };
      const t = a.media_type === "application/pdf" || a.size > TEXT_INLINE ? undefined : attachmentText(a, bytes);
      if (t && "text" in t) return { type: "text", text: `<attached-file name="${a.name}" path="${path}">\n${t.text}\n</attached-file>` };
      // A PDF the listing does not say either way about is not sent inline, and
      // the note says support is unverified rather than missing.
      const why = a.media_type === "application/pdf"
        ? info.pdf === false ? `${info.name} does not read PDFs` : `PDF support of ${info.name} is unverified`
        : /^image\//.test(a.media_type) ? "it is an image in a format the model is not sent; convert it to PNG or JPEG to look at it"
        : a.size > TEXT_INLINE ? "it is too long to inline" : t!.why;
      return { type: "text", text: `[Attached file ${a.name} (${a.media_type}, ${a.size} bytes) is saved at ${path}; it was not inlined because ${why}. Read it with your tools if it matters.]` };
    });
    return { ...m, content } as Message;
  });
}
