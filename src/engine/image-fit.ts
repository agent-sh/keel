// An image never breaks a session. A provider refuses the whole request when
// one image in it is over a limit, and an image stays in the history, so every
// later request of that session would fail the same way.
//   - At the source (a tool's result, a prompt's image) an image over what
//     Keel stores (STORE in src/providers/image-limits.ts) is scaled down
//     before it is stored, and one that cannot be decoded is not stored.
//   - At the wire, a history that already holds a larger image sends a scaled
//     copy for that request, or a note when it cannot be scaled. The stored
//     history is never rewritten. The copy is made once (the encoder gives the
//     same bytes for the same input, and a made copy is kept), so the request
//     prefix is the same bytes from request to request.
// Bun.Image decodes and encodes (libjpeg-turbo, libspng, libwebp built into
// Bun): no dependency.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ImageBlock, Message, TextBlock, ToolRefBlock } from "../core/types.ts";
import { DECODE_PIXELS, fitSize, type ImageLimits, STORE, within } from "../providers/image-limits.ts";
import { hasAttachmentsRoot, saveAttachment } from "./attachments.ts";
import { imageSize } from "./images.ts";

// The same bytes on every machine a session may run on (macOS would resize
// with its own library otherwise).
Bun.Image.backend = "bun";

type Size = { w: number; h: number };
export type Fitted =
  | { block: ImageBlock; from?: Size & { type: string }; to?: Size } // `from`: the block was made again
  | { refused: string };

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp" };
const MB = (n: number) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;

function why(e: unknown): string {
  switch ((e as any)?.code) {
    case "ERR_IMAGE_UNKNOWN_FORMAT": return "it is not a PNG, JPEG, WebP, GIF or BMP image";
    case "ERR_IMAGE_FORMAT_UNSUPPORTED": return "its format (HEIC, AVIF or TIFF) cannot be decoded on this machine";
    case "ERR_IMAGE_TOO_MANY_PIXELS": return "it is larger than 8000 x 8000 px";
    case "ERR_IMAGE_DECODE_FAILED": return "its data is damaged or cut short";
    default: return `it could not be decoded (${String((e as Error)?.message ?? e).slice(0, 120)})`;
  }
}

// At most four images are decoded at once in the whole process, whoever asks
// (a dozen sessions building their first request after a restart, tool
// results, prompts): a decode holds the image's pixels, up to 256 MB each
// (DECODE_PIXELS), so four bound the work at about 1 GB instead of one share
// per image asked for. The rest wait their turn; nothing is skipped.
const DECODES = 4;
let decodes = 0;
const queue: (() => void)[] = [];
async function decoding<T>(work: () => Promise<T>): Promise<T> {
  if (decodes >= DECODES) await new Promise<void>((go) => queue.push(go)); // the slot is handed over
  else decodes++;
  try {
    return await work();
  } finally {
    const next = queue.shift();
    if (next) next();
    else decodes--;
  }
}

// The block as `l` allows it: itself when it passes, else scaled to fit with
// its aspect ratio kept. A PNG stays PNG (text in a screenshot stays sharp), a
// JPEG stays JPEG, any other format becomes PNG; a copy still over the byte
// limit is encoded as JPEG, then made smaller until it passes.
export async function fitImage(b: ImageBlock, l: ImageLimits): Promise<Fitted> {
  const heavy = (data: string) => !!l.base64 && data.length > l.base64;
  // Within the limits by its header: the block itself, and nothing is decoded
  // (not even its base64), so an ordinary image costs no memory here.
  const size = imageSize(b.data), sniffed = sniff(b.data);
  if (size && sniffed && within(size.w, size.h, l) && l.formats.includes(sniffed) && !heavy(b.data)) return { block: b.media_type === sniffed ? b : { type: "image", media_type: sniffed, data: b.data } };
  return decoding(async () => {
    const bytes = Buffer.from(b.data, "base64");
    const open = () => new Bun.Image(bytes, { maxPixels: DECODE_PIXELS });
    let meta: Bun.Image.Metadata;
    try { meta = await open().metadata(); } catch (e) { return { refused: why(e) }; }
    const type = `image/${meta.format}`;
    let { w, h } = fitSize(meta.width, meta.height, l);
    if (w === meta.width && h === meta.height && l.formats.includes(type) && !heavy(b.data)) return { block: b.media_type === type ? b : { type: "image", media_type: type, data: b.data } };
    let jpeg = meta.format === "jpeg";
    try {
      for (let i = 0; i < 12; i++) {
        const img = w === meta.width && h === meta.height ? open() : open().resize(w, h);
        const data = Buffer.from(await (jpeg ? img.jpeg({ quality: 85 }) : img.png()).bytes()).toString("base64");
        if (!heavy(data)) return { block: { type: "image", media_type: jpeg ? "image/jpeg" : "image/png", data }, from: { w: meta.width, h: meta.height, type }, to: { w: img.width, h: img.height } };
        if (!jpeg) jpeg = true;
        else { w = Math.max(1, Math.round(w * 0.75)); h = Math.max(1, Math.round(h * 0.75)); }
      }
    } catch (e) {
      return { refused: why(e) };
    }
    return { refused: `it is over ${MB(l.base64!)} of base64 even scaled down` };
  });
}

const changed = (f: Extract<Fitted, { block: ImageBlock }>) =>
  f.to!.w !== f.from!.w || f.to!.h !== f.from!.h
    ? `scaled from ${f.from!.w}x${f.from!.h} to ${f.to!.w}x${f.to!.h} to fit the providers' image limits`
    : f.from!.type !== f.block.media_type ? `converted from ${f.from!.type.slice(6).toUpperCase()} to ${f.block.media_type.slice(6).toUpperCase()}` : "encoded again to fit the providers' image limits";

// The bytes of an image that has no file of its own (an MCP capture), kept
// beside the session's spilled outputs so the model can open them with a tool.
async function keep(b: ImageBlock, dir: string): Promise<string> {
  const at = join(dir, "images");
  mkdirSync(at, { recursive: true });
  const path = join(at, `${Bun.hash(b.data).toString(36)}.${EXT[b.media_type] ?? "bin"}`);
  await Bun.write(path, Buffer.from(b.data, "base64"));
  return path;
}

type ToolBlock = TextBlock | ImageBlock | ToolRefBlock;

// A tool's result before it is stored: each image within STORE, with one line
// after a changed image that says what was done and where the original is.
export async function fitToolImages(content: string | ToolBlock[], dir: string): Promise<string | ToolBlock[]> {
  if (typeof content === "string" || !content.some((b) => b.type === "image")) return content;
  const out: ToolBlock[] = [];
  for (const b of content) {
    if (b.type !== "image") { out.push(b); continue; }
    const { path, ...img } = b;
    const f = await fitImage(img, STORE);
    if ("refused" in f) {
      out.push({ type: "text", text: `[Image left out: ${f.refused}. It is at ${path ?? (await keep(img, dir))}; convert it to PNG or JPEG with a tool and read the copy.]` });
      continue;
    }
    out.push(f.block);
    if (f.from) out.push({ type: "text", text: `[Image ${changed(f)}; the original is at ${path ?? (await keep(img, dir))}.]` });
  }
  return out;
}

// A prompt's images before they are stored. A scaled image is followed by its
// original as an attached file (the model is told its path); one that cannot
// be decoded goes as an attached file alone. Other blocks pass.
export async function fitPromptImages(blocks: unknown): Promise<any[]> {
  if (!Array.isArray(blocks) || !blocks.some((b) => b?.type === "image" && typeof b.data === "string")) return Array.isArray(blocks) ? blocks : [];
  const out: any[] = [];
  let n = 0;
  for (const b of blocks) {
    if (b?.type !== "image" || typeof b.data !== "string") { out.push(b); continue; }
    n++;
    const f = await fitImage({ type: "image", media_type: String(b.media_type ?? ""), data: b.data }, STORE);
    const original = (type: string, name = `image-${n}`) => saveAttachment(Buffer.from(b.data, "base64"), `${name}.${EXT[type] ?? "bin"}`, type);
    if ("refused" in f) {
      out.push(hasAttachmentsRoot() ? original(String(b.media_type || "application/octet-stream")) : b);
      continue;
    }
    out.push(f.block);
    if (f.from && hasAttachmentsRoot()) out.push({ ...original(f.from.type, `original-${f.from.w}x${f.from.h}`), scaled: { from: [f.from.w, f.from.h], to: [f.to!.w, f.to!.h] } });
  }
  return out;
}

// ---- the wire ----

// An image's identity: a hash of its base64 and its length.
export const imageKey = (data: string) => `${Bun.hash(data).toString(36)}.${data.length.toString(36)}`;

// The format a base64 image starts with (the block's media type is the
// sender's word).
function sniff(data: string): string | undefined {
  if (data.startsWith("iVBORw0KGgo")) return "image/png";
  if (data.startsWith("/9j/")) return "image/jpeg";
  if (data.startsWith("R0lGOD")) return "image/gif";
  if (data.startsWith("UklGR")) return "image/webp";
  return undefined;
}

// Copies made for the wire, newest last. 256 MB of base64: twice the largest
// request a wire that needs copies takes (128 MB, the Claude API), so the
// copies of a whole history stay made while its session works.
const COPIES_MAX = 256 * 1024 * 1024;
const copies = new Map<string, ImageBlock | TextBlock | "same">();
let held = 0;
const cost = (v: ImageBlock | TextBlock | "same") => (v === "same" ? 0 : v.type === "image" ? v.data.length : v.text.length);
function remember(key: string, v: ImageBlock | TextBlock | "same") {
  copies.set(key, v);
  held += cost(v);
  for (const [k, old] of copies) {
    if (held <= COPIES_MAX || k === key) break;
    copies.delete(k);
    held -= cost(old);
  }
}

// The same image read again is the same image and stays out; a copy made with
// a tool (a crop, a conversion) is a new one.
export const LEFT_OUT = "[Image left out: the provider refused a request over this session's images, so the ones sent until then are no longer sent. If it is needed, make a smaller copy of its file with a tool and read that.]";

async function wireCopy(b: ImageBlock, l: ImageLimits, sig: string): Promise<ImageBlock | TextBlock> {
  const key = `${imageKey(b.data)}|${sig}`;
  const hit = copies.get(key);
  if (hit) {
    copies.delete(key);
    copies.set(key, hit); // newest last
    return hit === "same" ? b : hit;
  }
  const f = await fitImage(b, l);
  const made: ImageBlock | TextBlock = "refused" in f ? { type: "text", text: `[Image left out of this request: ${f.refused}.]` } : f.block;
  remember(key, made === b ? "same" : made);
  return made;
}

const images = (messages: Message[]): ImageBlock[] =>
  messages.flatMap((m) => (m.role !== "user" ? [] : m.content.flatMap((b): ImageBlock[] =>
    b.type === "image" ? [b] : b.type === "tool_result" && Array.isArray(b.content) ? b.content.filter((c): c is ImageBlock => c.type === "image") : [])));

// The identities of the images a request would carry.
export const imageKeys = (messages: Message[]): string[] => [...new Set(images(messages).map((b) => imageKey(b.data)))];

// The messages as a request to a host with limits `l` carries them: an image
// over a limit as its scaled copy, one that cannot be scaled as a note, and
// the ones in `out` (left out after a refusal) as a note. The same array when
// nothing changes.
export async function fitForWire(messages: Message[], l: ImageLimits, out?: ReadonlySet<string>): Promise<Message[]> {
  const all = images(messages);
  if (!all.length) return messages;
  const sig = `${l.edge ?? ""},${l.patches ? `${l.patches.px}:${l.patches.max}` : ""},${l.base64 ?? ""},${l.formats.join("+")}`;
  const swap = new Map<ImageBlock, ImageBlock | TextBlock>();
  const slow: ImageBlock[] = [];
  for (const b of all) {
    if (out?.size && out.has(imageKey(b.data))) { swap.set(b, { type: "text", text: LEFT_OUT }); continue; }
    const size = imageSize(b.data), type = sniff(b.data);
    if (size && type && within(size.w, size.h, l) && l.formats.includes(type) && !(l.base64 && b.data.length > l.base64)) continue;
    slow.push(b);
  }
  // All asked at once: fitImage decodes four at a time across the process.
  await Promise.all(slow.map(async (b) => {
    const r = await wireCopy(b, l, sig);
    if (r !== b) swap.set(b, r);
  }));
  if (!swap.size) return messages;
  const put = <B extends { type: string }>(b: B) => (b.type === "image" ? swap.get(b as unknown as ImageBlock) ?? b : b);
  return messages.map((m) => {
    if (m.role !== "user" || !m.content.some((b) => (b.type === "image" && swap.has(b)) || (b.type === "tool_result" && Array.isArray(b.content) && b.content.some((c) => c.type === "image" && swap.has(c))))) return m;
    return { ...m, content: m.content.map((b) => (b.type === "tool_result" && Array.isArray(b.content) ? { ...b, content: b.content.map(put) } : put(b))) } as Message;
  });
}
