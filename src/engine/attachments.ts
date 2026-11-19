// Files attached to a prompt. Each is stored once by content under
// <state>/attachments/<sha256>/<name>; the prompt keeps a small reference
// (AttachmentBlock), so the history stays light and its bytes stable. Just
// before a request each reference becomes what the model can read:
//   - text (UTF-8, up to TEXT_INLINE bytes): the file inline, named;
//   - a PDF, where the model's listing says it reads PDFs: a document block;
//   - anything else (a PDF for a model without PDF input, a spreadsheet, a
//     long log): a note with the saved path, for the model's own tools.
// The same reference always resolves to the same bytes for a given model.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AttachmentBlock, Message } from "../core/types.ts";
import type { ModelInfo } from "../providers/types.ts";

export const ATTACHMENT_MAX = 20 * 1024 * 1024; // the same cap as the Rust Keel's uploads
// About 25k tokens: what one Read of a file returns in Claude Code. Longer text goes by path.
export const TEXT_INLINE = 100_000;

let root = "";
export const setAttachmentsRoot = (dir: string) => void (root = join(dir, "attachments"));

const safeName = (n: string) => basename(n).replace(/[^\w.\- ()+]/g, "_").slice(0, 120) || "file";

export function saveAttachment(bytes: Uint8Array, name: string, mediaType: string): AttachmentBlock {
  const id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const dir = join(root, id);
  const file = join(dir, safeName(name));
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, bytes);
  }
  return { type: "attachment", id, name: safeName(name), media_type: mediaType || "application/octet-stream", size: bytes.byteLength };
}

export function attachmentPath(id: string): string | undefined {
  if (!/^[0-9a-f]{64}$/.test(id)) return undefined;
  const dir = join(root, id);
  if (!existsSync(dir)) return undefined;
  const f = readdirSync(dir)[0];
  return f ? join(dir, f) : undefined;
}

const isText = (a: AttachmentBlock, bytes: Buffer) =>
  (/^text\/|json|xml|yaml|toml|javascript|typescript|x-sh|csv|markdown/.test(a.media_type) || a.media_type === "application/octet-stream") &&
  !bytes.subarray(0, 8000).includes(0);

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
      if (a.size <= TEXT_INLINE && isText(a, bytes)) return { type: "text", text: `<attached-file name="${a.name}" path="${path}">\n${bytes.toString("utf8")}\n</attached-file>` };
      const why = a.media_type === "application/pdf" ? `${info.name} does not read PDFs` : a.size > TEXT_INLINE ? "it is too long to inline" : "it is not text";
      return { type: "text", text: `[Attached file ${a.name} (${a.media_type}, ${a.size} bytes) is saved at ${path}; it was not inlined because ${why}. Read it with your tools if it matters.]` };
    });
    return { ...m, content } as Message;
  });
}
