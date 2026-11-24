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
import { during } from "../admin/activity.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ImageBlock, Message, TextBlock, ToolRefBlock } from "../core/types.ts";
import { DECODE_PIXELS, fitSize, type ImageLimits, STORE, within } from "../providers/image-limits.ts";
import { hasAttachmentsRoot, saveAttachment } from "./attachments.ts";
import { imageSize } from "./images.ts";
import { base64WithoutLocation } from "./exif-scrub.ts";

// The same bytes on every machine a session may run on (macOS would resize
// with its own library otherwise).
Bun.Image.backend = "bun";

type Size = { w: number; h: number };
export type Fitted =
  | { block: ImageBlock; from?: Size & { type: string }; to?: Size } // `from`: the block was made again
  | { refused: string; fix: string }; // why not, and what to do with its file

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp" };
const MB = (n: number) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;

const CONVERT = "convert it to PNG or JPEG with a tool and read the copy";
const SCALE = "scale it down with a tool (for example magick) and read the copy";
function why(e: unknown, size?: Size): { refused: string; fix: string } {
  switch ((e as any)?.code) {
    case "ERR_IMAGE_UNKNOWN_FORMAT": return { refused: "it is not a PNG, JPEG, WebP, GIF or BMP image", fix: CONVERT };
    case "ERR_IMAGE_FORMAT_UNSUPPORTED": return { refused: "its format (HEIC, AVIF or TIFF) cannot be decoded on this machine", fix: CONVERT };
    case "ERR_IMAGE_TOO_MANY_PIXELS": return { refused: `it is ${size ? `${size.w}x${size.h}, ` : ""}more than the 64 megapixels decoded here`, fix: SCALE };
    case "ERR_IMAGE_DECODE_FAILED": return { refused: "its data is damaged or cut short", fix: "write the file again, or convert it with a tool, and read that" };
    default: return { refused: `it could not be decoded (${String((e as Error)?.message ?? e).slice(0, 120)})`, fix: CONVERT };
  }
}

// An animated WebP: the extended header's animation flag. Bun's decoder reads
// still images only.
const animatedWebp = (b: Buffer) => b.length > 20 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 16) === "WEBPVP8X" && (b[20]! & 0x02) !== 0;

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
  return decoding(() => during("task", async () => {
    const bytes = Buffer.from(b.data, "base64");
    // Within the limits it passed above as it is; here it would have to be made again.
    if (animatedWebp(bytes)) return { refused: "it is an animated WebP, which cannot be scaled here", fix: "save one frame as PNG with a tool and read that" };
    const open = () => new Bun.Image(bytes, { maxPixels: DECODE_PIXELS });
    let meta: Bun.Image.Metadata;
    try { meta = await open().metadata(); } catch (e) { return why(e, size); }
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
      return why(e, size);
    }
    return { refused: `it is over ${MB(l.base64!)} of base64 even scaled down`, fix: SCALE };
  }, "decoding an image to fit its limits"));
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
// `remote`: the session's tools run on another machine, which cannot read a
// copy kept here (the file a tool read there is named as it is).
export async function fitToolImages(content: string | ToolBlock[], dir: string, remote = false): Promise<string | ToolBlock[]> {
  if (typeof content === "string" || !content.some((b) => b.type === "image")) return content;
  const out: ToolBlock[] = [];
  for (const b of content) {
    if (b.type !== "image") { out.push(b); continue; }
    const { path, ...img } = b;
    const f = await fitImage(img, STORE);
    // Where its bytes are: the file it was read from, else a copy kept here.
    // A copy that cannot be written does not fail the call.
    const at = async (is: string) => {
      if (path) return `${is} at ${path}`;
      try { return `${is} at ${await keep(img, dir)}${remote ? " on the machine Keel runs on" : ""}`; } catch (e) { return `${is} not kept (${String((e as Error).message ?? e).slice(0, 100)})`; }
    };
    if ("refused" in f) {
      out.push({ type: "text", text: `[Image left out: ${f.refused}. ${await at("It is")}; ${f.fix}.]` });
      continue;
    }
    out.push(f.block);
    if (f.from) out.push({ type: "text", text: `[Image ${changed(f)}; ${await at("the original is")}.]` });
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
    // Where the photo was taken stays here (src/engine/exif-scrub.ts): an image that fits is sent as it is.
    const data = base64WithoutLocation(b.data);
    const f = await fitImage({ type: "image", media_type: String(b.media_type ?? ""), data }, STORE);
    const original = (type: string, name = `image-${n}`) => saveAttachment(Buffer.from(data, "base64"), `${name}.${EXT[type] ?? "bin"}`, type);
    if ("refused" in f) {
      out.push(hasAttachmentsRoot() ? original(String(b.media_type || "application/octet-stream")) : { ...b, data });
      continue;
    }
    out.push(f.block);
    if (f.from && hasAttachmentsRoot()) out.push({ ...original(f.from.type, `original-${f.from.w}x${f.from.h}`), scaled: { from: [f.from.w, f.from.h], to: [f.to!.w, f.to!.h] } });
  }
  return out;
}

// A session's prompts are fitted and handed on one at a time, in the order
// they came: a prompt with a large image takes a moment to scale and must not
// land behind the words sent just after it.
const lines = new Map<string, Promise<unknown>>();
export function fitted<T>(session: string, images: unknown, send: (images: any[]) => T): Promise<T> {
  const run = (lines.get(session) ?? Promise.resolve()).then(async () => send(await fitPromptImages(images)));
  const tail = run.catch(() => {});
  lines.set(session, tail);
  void tail.then(() => { if (lines.get(session) === tail) lines.delete(session); });
  return run;
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
  // Two requests can make the same copy at once: the one already kept is
  // counted once.
  const old = copies.get(key);
  if (old) { held -= cost(old); copies.delete(key); }
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
// What the copies kept come to (for the storage view and the tests).
export const copiesHeld = () => ({ copies: copies.size, bytes: held });

export const LEFT_OUT = "[Image left out: the provider refused a request over this session's images, so this one is no longer sent. If it is needed, make a smaller copy of its file with a tool and read that.]";

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

// Whether a request carries an image with a side over `edge` px.
export const anyOver = (messages: Message[], edge: number) => images(messages).some((b) => { const z = imageSize(b.data); return !z || z.w > edge || z.h > edge; });

// The identities of the images a request would carry.
export const imageKeys = (messages: Message[]): string[] => [...new Set(images(messages).map((b) => imageKey(b.data)))];

// The images to leave out after a provider refused a request as too large in
// bytes and named none: the oldest, until what they held is half of the bytes
// of the images still sent (at least one), so the newest stay and a few more
// requests find the cap. `left` are the identities still sent, oldest first;
// the last one alone is dropped only when it is all that is left.
export function oldestForSize(messages: Message[], left: readonly string[]): string[] {
  const bytes = new Map<string, number>();
  for (const b of images(messages)) bytes.set(imageKey(b.data), b.data.length);
  const sizes = left.map((k) => bytes.get(k) ?? 0);
  const half = sizes.reduce((a, n) => a + n, 0) / 2;
  const drop: string[] = [];
  let dropped = 0;
  for (let i = 0; i < left.length; i++) {
    if (drop.length && (dropped >= half || i === left.length - 1)) break;
    drop.push(left[i]!);
    dropped += sizes[i]!;
  }
  return drop;
}

// The images of `messages`, less those in `skip`, that do not decode in full.
// A file cut short passes a read of its header, which is all an image within
// the limits gets when it is stored; a provider that then refuses the request
// names no image, so this finds the ones to leave out.
export async function damagedImages(messages: Message[], skip: ReadonlySet<string>): Promise<string[]> {
  const seen = new Map<string, ImageBlock>();
  for (const b of images(messages)) {
    const key = imageKey(b.data);
    if (!skip.has(key)) seen.set(key, b);
  }
  const bad: string[] = [];
  await Promise.all([...seen].map(([key, b]) => decoding(async () => {
    try {
      await new Bun.Image(Buffer.from(b.data, "base64"), { maxPixels: DECODE_PIXELS }).resize(1, 1, { filter: "nearest" }).png().bytes();
    } catch {
      bad.push(key);
    }
  })));
  return bad;
}

// The messages as a request to a host with limits `l` carries them: an image
// over a limit as its scaled copy, one that cannot be scaled as a note, and
// the ones in `out` (left out after a refusal) as a note. The same array when
// nothing changes. `working` is called once when a copy has to be made or
// looked up (the first request after a restart makes them all again).
export async function fitForWire(messages: Message[], l: ImageLimits, out?: ReadonlySet<string>, working?: () => void): Promise<Message[]> {
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
  if (slow.length) working?.();
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
