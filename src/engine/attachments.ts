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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { decodeText, textEncoding } from "../core/text.ts";
import type { AttachmentBlock, Message } from "../core/types.ts";
import type { ModelInfo } from "../providers/types.ts";

export const ATTACHMENT_MAX = 20 * 1024 * 1024; // the same cap as the Rust Keel's uploads
// About 25k tokens: what one Read of a file returns in Claude Code. Longer text
// goes by path. Shared with the context estimate (src/engine/compact.ts).
export { TEXT_INLINE } from "./compact.ts";
import { TEXT_INLINE, TEXT_MEDIA } from "./compact.ts";

let root = "";
export const setAttachmentsRoot = (dir: string) => void (root = join(dir, "attachments"));

// The name the owner sees and the model reads: the file's own name in any
// script, without path parts, control characters or quotes.
const shownName = (n: string) => basename(n.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f"<>]/g, "_").trim().slice(0, 120) || "file";
// On disk: the name when it is plain ASCII, else `file` plus its extension,
// so the path stays safe everywhere and the extension still gives the type.
const diskName = (n: string) => (/^[\w.\- ()+]+$/.test(n) ? n : `file${/\.[A-Za-z0-9]{1,10}$/.exec(n)?.[0]?.toLowerCase() ?? ""}`);

export function saveAttachment(bytes: Uint8Array, name: string, mediaType: string, charset?: string): AttachmentBlock {
  const id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const dir = join(root, id);
  const shown = shownName(name);
  // The same bytes under another name or extension: one copy; each prompt keeps its own name.
  if (!existsSync(dir) || !readdirSync(dir).length) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, diskName(shown)), bytes);
  }
  const cs = charset?.trim().toLowerCase().replace(/^"|"$/g, "");
  return { type: "attachment", id, name: shown, media_type: mediaType || "application/octet-stream", size: bytes.byteLength, ...(cs && /^[\w.:-]{1,40}$/.test(cs) ? { charset: cs } : {}) };
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

export function resolveAttachments(messages: Message[], info: Pick<ModelInfo, "pdf" | "name">): Message[] {
  if (!messages.some((m) => m.role === "user" && m.content.some((b: any) => b.type === "attachment"))) return messages;
  return messages.map((m) => {
    if (m.role !== "user" || !m.content.some((b: any) => b.type === "attachment")) return m;
    const content = m.content.map((b: any) => {
      if (b.type !== "attachment") return b;
      const a = b as AttachmentBlock;
      const path = attachmentPath(a.id);
      if (!path) return { type: "text", text: `[Attached file ${a.name} is no longer stored.]` };
      const bytes = read(path);
      if (a.media_type === "application/pdf" && info.pdf) return { type: "document", media_type: a.media_type, data: bytes.toString("base64"), name: a.name };
      const t = a.media_type === "application/pdf" || a.size > TEXT_INLINE ? undefined : attachmentText(a, bytes);
      if (t && "text" in t) return { type: "text", text: `<attached-file name="${a.name}" path="${path}">\n${t.text}\n</attached-file>` };
      // A PDF the listing does not say either way about is not sent inline, and
      // the note says support is unverified rather than missing.
      const why = a.media_type === "application/pdf"
        ? info.pdf === false ? `${info.name} does not read PDFs` : `PDF support of ${info.name} is unverified`
        : a.size > TEXT_INLINE ? "it is too long to inline" : t!.why;
      return { type: "text", text: `[Attached file ${a.name} (${a.media_type}, ${a.size} bytes) is saved at ${path}; it was not inlined because ${why}. Read it with your tools if it matters.]` };
    });
    return { ...m, content } as Message;
  });
}
