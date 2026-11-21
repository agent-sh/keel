// What an image may be before a provider refuses the request that carries it.
// The one place for these numbers: each with its reason and its source. They
// are per model family (the host that reads the image), never per model, and
// none of the listings or the models.dev catalog states an image limit today;
// when a provider states its own limit in a refusal, that value wins for the
// session (SessionSettings.image_edge, src/engine/turn.ts).
import type { Family } from "./types.ts";

export type ImageLimits = {
  edge?: number;                          // px: the longest side
  patches?: { px: number; max: number };  // squares of px by px the image may cover
  base64?: number;                        // characters of base64 one image may be
  formats: readonly string[];             // media types the host reads
};

const MB = 1024 * 1024;

// What Keel stores. An image is in every later request of its session, and a
// session may move to another model, so a stored image has to pass every
// family's limits in a request that holds many images.
//   edge 2000: the Anthropic wire refuses the whole request when it holds more
//     than 20 images and one is over its many-image limit. That limit is 3000
//     px today and was 2000 px before; the refusal states the current value.
//     2000 px is the lowest it has been, and what Claude Code scales to (Codex:
//     2048). A standard-tier Claude model scales to 1568 px itself, so only a
//     high-resolution-tier model (2576 px) loses detail, on images over 2000 px.
//     https://platform.claude.com/docs/en/build-with-claude/vision#request-limits
//     https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
//   base64 5 MB: the per-image limit of the Anthropic wire on Amazon Bedrock
//     (10 MB on the Claude API), the tightest of the hosts. Same page.
//   formats: PNG, JPEG and WebP are read by every family; a GIF is not read by
//     Gemini and only its first frame by the others, so it is stored as PNG.
export const STORE: ImageLimits = { edge: 2000, base64: 5 * MB, formats: ["image/png", "image/jpeg", "image/webp"] };

// What a request may carry, for a history that already holds larger images.
const WIRE: Record<Family, ImageLimits> = {
  // 3000 px: the documented many-image limit ("resize each image so that
  // neither dimension exceeds 3,000 px"); applied to every request, not only
  // those over 20 images, so an image's bytes never change as the count grows.
  // 5 MB base64: Bedrock. Formats: the vision page's list.
  claude: { edge: 3000, base64: 5 * MB, formats: ["image/png", "image/jpeg", "image/gif", "image/webp"] },
  // An image over 30,000 patches of 32 px is rejected, not resized; 512 MB a
  // request, so no per-image byte limit.
  // https://platform.openai.com/docs/guides/images-vision
  // Only a GIF that is not animated is read, and telling the two apart means
  // reading its frames: a GIF from before they were stored as PNG is sent as
  // PNG (its first frame).
  gpt: { patches: { px: 32, max: 30_000 }, formats: ["image/png", "image/jpeg", "image/webp"] },
  // No dimension limit is documented (large images are tiled); 20 MB of inline
  // data a request is a request limit, not an image's. No GIF.
  // https://ai.google.dev/gemini-api/docs/image-understanding
  gemini: { formats: ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"] },
  // A host that documents nothing here gets what Keel stores.
  other: STORE,
};

// The limits of a request to a model of `family`; `edge` is the limit the
// provider itself stated in a refusal on this session.
export function imageLimits(family: Family, edge?: number): ImageLimits {
  const l = WIRE[family] ?? STORE;
  return edge && edge > 0 && !(l.edge && l.edge <= edge) ? { ...l, edge } : l;
}

// The largest image decoded: 8000 x 8000 px, the most the Anthropic wire takes
// in any request (a decode holds four bytes a pixel, 256 MB at this size).
export const DECODE_PIXELS = 8000 * 8000;

// The size an image of w x h is scaled to so it passes `l`: the largest that
// keeps its aspect ratio, never larger than it is.
export function fitSize(w: number, h: number, l: Pick<ImageLimits, "edge" | "patches">): { w: number; h: number } {
  let s = l.edge ? Math.min(1, l.edge / Math.max(w, h)) : 1;
  const at = (k: number) => ({ w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) });
  const p = l.patches;
  if (p) {
    const over = (k: number) => Math.ceil(at(k).w / p.px) * Math.ceil(at(k).h / p.px) > p.max;
    if (over(s)) s = Math.min(s, Math.sqrt((p.max * p.px * p.px) / (w * h)));
    while (over(s)) s *= 0.99; // rounding up to whole patches can leave it a row over
  }
  return at(s);
}

export const within = (w: number, h: number, l: Pick<ImageLimits, "edge" | "patches">) => {
  const f = fitSize(w, h, l);
  return f.w === w && f.h === h;
};

// A provider's refusal of a request for one of its images: a size or count
// limit, a format it does not read, bytes it could not decode, a model that
// takes no images. `edge`: the pixel limit it stated, when it stated one.
// Matched on the message, since every provider sends these as a plain 400. A
// wrong match costs one more request and nothing else: the engine keeps
// nothing unless the request then passes, and throws the first error if not.
const IMAGE = /\bimages?\b|image_url|input_image|inline_?data/i;
const FAULT = /exceed|too (large|big|many|small)|maximum|max allowed|limit|invalid|unsupported|not support|could ?n[o']t|cannot|can't|unable|failed|valid|match|should be|missing|malformed|corrupt|decode|process/i;
// Refusals over how much is asked, not over an image: the window, a rate or a
// quota (a 413 that reports tokens a minute is one of these). And refusals
// that only name something with "image" in it: a tool, its schema, image
// generation, a usage policy, the pages of a PDF.
const NOT_IMAGE = /context.{0,20}(length|window)|too many tokens|prompt is too long|rate.?limit|quota|\b[tr]pm\b|(tokens|requests) per (minute|day)|per.minute|schema|function|hosted tool|tools?\.\d|image.?generation|usage polic|flagged|\bpdf\b|\bpages\b/i;
// The smallest pixel limit a refusal is believed to state: 512 px, the
// smallest size a provider documents for reading an image at all (OpenAI's low
// detail fits an image within 512 x 512). A smaller number beside "px" in a
// refusal is something else (a thumbnail size, the image's own size), and
// taking it as the limit would send every later image at that size.
export const EDGE_FLOOR = 512;
export function imageRefusal(e: unknown): { edge?: number } | null {
  const err = e as any;
  if (!err) return null;
  // A driver's invalid request, or a plain 400, 413 or 422. An error with
  // neither is not a provider's answer.
  if (typeof err.kind === "string" ? err.kind !== "invalid" : ![400, 413, 422].includes(Number(err.status ?? err.statusCode ?? 0))) return null;
  const msg = String(err.message ?? "");
  if (!IMAGE.test(msg) || !FAULT.test(msg) || NOT_IMAGE.test(msg)) return null;
  // "3000 pixels", not the second half of a size ("1900x1000 pixels").
  const px = [...msg.matchAll(/(?<![\dx×*])(\d{3,5})\s*(?:px|pixels)/gi)].map((m) => Number(m[1])).filter((n) => n >= EDGE_FLOOR);
  return px.length ? { edge: Math.min(...px) } : {};
}

// A request refused as too large in bytes (HTTP 413, Anthropic's
// request_too_large; 128 MB on the Claude API, less on Bedrock and Vertex).
// When the request holds images they are what made it so: base64 images are
// megabytes each, the words of a full context window are not. A 413 can also
// be a gateway's passing answer or a rate limit's: the engine sends the same
// request once more before it acts on one, and a 413 about a rate, a quota or
// tokens is not one of these.
export function requestTooLarge(e: unknown): boolean {
  const err = e as any;
  if (!err || (typeof err.kind === "string" && err.kind !== "invalid")) return false;
  const msg = String(err.message ?? "");
  if (NOT_IMAGE.test(msg)) return false;
  return Number(err.status ?? err.statusCode ?? 0) === 413 || /request_too_large|request (entity |body |payload |size )?(is )?too large|payload too large|(request|payload) size exceed/i.test(msg);
}
