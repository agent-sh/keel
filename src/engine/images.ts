// A model whose listing says it does not read images is sent a short note in
// place of each image (a pasted screenshot, a Read of a PNG, an MCP capture),
// so a session that switched to it, or its compaction, keeps working instead
// of failing on the provider's "image not supported" error. Only an explicit
// `images: false` strips them: an unknown capability sends the image, since a
// vision model treated as text-only is the worse mistake. Pure, so the request
// prefix stays byte-stable for that model.
import type { Message } from "../core/types.ts";

export function withoutImages(messages: Message[], model: string): Message[] {
  const note = { type: "text" as const, text: `[image not sent: ${model} does not read images]` };
  let changed = false;
  const out = messages.map((m) => {
    if (!m.content.some((b: any) => b.type === "image" || (b.type === "tool_result" && Array.isArray(b.content) && b.content.some((c: any) => c.type === "image")))) return m;
    changed = true;
    const content = m.content.map((b: any) => {
      if (b.type === "image") return note;
      if (b.type === "tool_result" && Array.isArray(b.content)) return { ...b, content: b.content.map((c: any) => (c.type === "image" ? note : c)) };
      return b;
    });
    return { ...m, content } as Message;
  });
  return changed ? out : messages;
}

// What an image's first bytes say it is, for the four formats a model reads
// inline; undefined for anything else, whatever its name or declared type says.
export function imageType(u: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | undefined {
  const tag = (at: number, n: number) => String.fromCharCode(...u.subarray(at, at + n));
  if (u.length >= 8 && u[0] === 0x89 && tag(1, 3) === "PNG") return "image/png";
  if (u.length >= 3 && u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return "image/jpeg";
  if (u.length >= 6 && (tag(0, 6) === "GIF87a" || tag(0, 6) === "GIF89a")) return "image/gif";
  if (u.length >= 12 && tag(0, 4) === "RIFF" && tag(8, 4) === "WEBP") return "image/webp";
  return undefined;
}

// Tokens an image costs, estimated from its pixel size before any reply has
// measured it: Claude's documented rule is one visual token per 28x28 patch
// (ceil(w/28) * ceil(h/28)); a model that downscales large images costs less,
// which the next measured reply corrects. Its base64 length is no measure:
// a 400 KB screenshot is about a thousand tokens, not a hundred thousand.
export function imageTokens(b: { data: string }): number {
  const size = imageSize(b.data);
  if (!size) return 1_600; // unreadable header: a typical screenshot's cost
  return Math.ceil(size.w / 28) * Math.ceil(size.h / 28);
}

// Width and height from a base64 PNG, GIF, WebP or JPEG header (atob, not
// Buffer: the page counts its context with the same code).
export function imageSize(base64: string): { w: number; h: number } | undefined {
  const bytes = (b64: string) => {
    try {
      const bin = atob(b64.slice(0, b64.length - (b64.length % 4)));
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    } catch {
      return new Uint8Array();
    }
  };
  const read = (u: Uint8Array): { w: number; h: number } | null | undefined => {
    const v = new DataView(u.buffer);
    const tag = (at: number, n: number) => String.fromCharCode(...u.subarray(at, at + n));
    if (u.length >= 24 && v.getUint32(0) === 0x89504e47) return { w: v.getUint32(16), h: v.getUint32(20) };
    if (u.length >= 10 && tag(0, 3) === "GIF") return { w: v.getUint16(6, true), h: v.getUint16(8, true) };
    if (u.length >= 30 && tag(0, 4) === "RIFF" && tag(8, 4) === "WEBP") {
      const kind = tag(12, 4);
      const u24 = (at: number) => u[at]! | (u[at + 1]! << 8) | (u[at + 2]! << 16);
      if (kind === "VP8X") return { w: 1 + u24(24), h: 1 + u24(27) };
      if (kind === "VP8L") { const x = v.getUint32(21, true); return { w: 1 + (x & 0x3fff), h: 1 + ((x >> 14) & 0x3fff) }; }
      if (kind === "VP8 ") return { w: v.getUint16(26, true) & 0x3fff, h: v.getUint16(28, true) & 0x3fff };
    }
    if (u.length >= 4 && u[0] === 0xff && u[1] === 0xd8) {
      for (let i = 2; i + 9 < u.length;) {
        if (u[i] !== 0xff) { i++; continue; }
        const m = u[i + 1]!;
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: v.getUint16(i + 5), w: v.getUint16(i + 7) };
        if (m === 0xff) { i++; continue; }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        i += 2 + v.getUint16(i + 2);
      }
      return null; // a JPEG whose frame header lies past the first bytes
    }
    return undefined;
  };
  const r = read(bytes(base64.slice(0, 65_536)));
  if (r === null && base64.length > 65_536) return read(bytes(base64)) ?? undefined;
  return r ?? undefined;
}
