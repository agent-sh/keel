// Pasted or dropped pictures become image blocks for the model. Large ones are
// scaled to the long edge the providers read at full detail (1568 px), which
// also keeps the request small; a screenshot stays PNG so text stays sharp.
import type { AttachmentBlock, ImageBlock, PromptBlock } from "../../../src/core/types.ts";

// A picture (sent as an image block) or another file (uploaded once and sent
// as a reference the daemon resolves per model: text inline, PDF as a document).
export type Attachment = ImageBlock & { id: string; name: string; url: string; bytes: number; file?: AttachmentBlock };

const MAX_EDGE = 1568;
const MAX_BYTES = 3_750_000; // providers refuse a base64 image over 5 MB
const SUPPORTED = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const toBase64 = (buf: ArrayBuffer) => {
  let s = "";
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

async function upload(file: File): Promise<Attachment> {
  const r = await fetch(`/api/attachments?name=${encodeURIComponent(file.name || "file")}`, { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
  const body = await r.json();
  if (!r.ok) throw new Error(`${file.name}: ${body.error ?? `HTTP ${r.status}`}`);
  const ref = body as AttachmentBlock;
  return { type: "image", media_type: ref.media_type, data: "", id: crypto.randomUUID(), name: ref.name, url: `/api/attachments/${ref.id}`, bytes: ref.size, file: ref };
}

export async function toAttachment(file: File): Promise<Attachment> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") return upload(file);
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  let blob: Blob = file;
  if (scale < 1 || !SUPPORTED.has(file.type) || file.size > MAX_BYTES) {
    const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    blob = await c.convertToBlob(file.type === "image/png" ? { type: "image/png" } : { type: "image/jpeg", quality: 0.88 });
    if (blob.size > MAX_BYTES) blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  }
  bmp.close();
  const media_type = blob.type || "image/png";
  return {
    type: "image",
    media_type,
    data: toBase64(await blob.arrayBuffer()),
    id: crypto.randomUUID(),
    name: file.name || "pasted image",
    url: URL.createObjectURL(blob),
    bytes: blob.size,
  };
}

export const toBlock = (a: Attachment): PromptBlock => a.file ?? { type: "image", media_type: a.media_type, data: a.data };

// A stored prompt's attachment back in the message box (a prompt forked back to be edited).
export function fromBlock(b: PromptBlock, i: number): Attachment {
  if (b.type === "attachment") return { type: "image", media_type: b.media_type, data: "", id: crypto.randomUUID(), name: b.name, url: `/api/attachments/${b.id}`, bytes: b.size, file: b };
  const bytes = Math.floor((b.data.length * 3) / 4);
  return { type: "image", media_type: b.media_type, data: b.data, id: crypto.randomUUID(), name: `image ${i + 1}`, url: `data:${b.media_type};base64,${b.data}`, bytes };
}
