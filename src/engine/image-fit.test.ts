// The pure parts of keeping an image from breaking a session: the size an
// image is scaled to, what a refusal is taken for, the fit of one image, of a
// tool's result, of a prompt and of a request. What the engine does with them
// (a turn, a refusal, a compaction) is in test/e2e/images.spec.ts.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { Message } from "../core/types.ts";
import { imageSize } from "./images.ts";

// A grey PNG of w x h; `noise` makes it one that does not compress.
function png(w: number, h: number, noise = false): Buffer {
  const raw = Buffer.alloc(h * (w + 1), 0x80);
  let x = 1;
  for (let i = 0; i < raw.length; i++) raw[i] = i % (w + 1) === 0 ? 0 : noise ? (x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 24 : 0x80;
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(Bun.hash.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8; // 8 bits, greyscale
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}
const block = (b: Buffer, media_type = "image/png") => ({ type: "image" as const, media_type, data: b.toString("base64") });
const scratch = (name: string) => mkdtempSync(join(process.env.TMPDIR ?? ".", name));
const imagesOf = (messages: any[]): any[] => messages.flatMap((m) => m.content.flatMap((b: any) => (b.type === "image" ? [b] : b.type === "tool_result" && Array.isArray(b.content) ? b.content.filter((c: any) => c.type === "image") : [])));

test("the size an image is scaled to keeps its aspect ratio within the edge and the patch limits", async () => {
  const { fitSize, imageLimits, STORE, within } = await import("../providers/image-limits.ts");
  expect(fitSize(2000, 6000, STORE)).toEqual({ w: 667, h: 2000 });
  expect(fitSize(3840, 2160, STORE)).toEqual({ w: 2000, h: 1125 });
  expect(fitSize(1920, 1040, STORE)).toEqual({ w: 1920, h: 1040 }); // never enlarged, never touched
  expect(within(2000, 2000, STORE)).toBe(true);
  // 30,000 patches of 32 px: 8000 x 4000 covers 31,250.
  const gpt = imageLimits("gpt");
  const f = fitSize(8000, 4000, gpt);
  expect(Math.ceil(f.w / 32) * Math.ceil(f.h / 32)).toBeLessThanOrEqual(30_000);
  expect(f.w / f.h).toBeCloseTo(2, 2);
  expect(f.w).toBeGreaterThan(7700);
  // A limit the provider stated wins when it is lower than the family's.
  expect(imageLimits("claude").edge).toBe(3000);
  expect(imageLimits("claude", 2000).edge).toBe(2000);
  expect(imageLimits("claude", 8000).edge).toBe(3000);
  expect(imageLimits("gpt", 2000).edge).toBe(2000);
});

test("a provider's refusal over an image is told from other refusals, with the limit it states", async () => {
  const { imageRefusal, requestTooLarge } = await import("../providers/image-limits.ts");
  const { errorClass } = await import("../admin/classes.ts");
  const { classify, ProviderError } = await import("../providers/http.ts");
  const inv = (m: string, status = 400) => new ProviderError("invalid", m, status);
  const at = "p: HTTP 400: messages.0.content.0.image.source.base64.data:";
  const many = inv(`${at} At least one of the image dimensions exceed max allowed size for many-image requests: 3000 pixels`);
  expect(imageRefusal(many)).toEqual({ edge: 3000 });
  expect(errorClass(many)).toBe("image");
  // Refusals over an image, in the words several hosts use.
  for (const m of [
    `${at} At least one of the image dimensions exceed max allowed size: 8000 pixels`,
    `${at} Image does not match the provided media type image/png`,
    `${at} The image was specified using the image/png media type, but does not appear to be a valid png image`,
    "p: HTTP 400: messages.0.content.1.image.source.base64.media_type: Input should be 'image/jpeg', 'image/png', 'image/gif' or 'image/webp'",
    "p: HTTP 400: Too many images and documents: 101 + 0 > 100",
    "p: HTTP 400: image exceeds 5 MB maximum: 6291456 bytes > 5242880 bytes",
    "p: HTTP 400: The image data you provided does not represent a valid image. Please check your input and try again.",
    "p: HTTP 400: You uploaded an unsupported image. Please make sure your image has of one the following formats: ['png', 'jpeg', 'gif', 'webp'].",
    "p: HTTP 400: Invalid base64 image_url.",
    "gemini: INVALID_ARGUMENT: Unable to process input image. Please retry or report in the troubleshooting guide",
    "p: HTTP 400: This model does not support image input.",
    "p: HTTP 400: this model is missing data required for image input",
  ]) expect([m, !!imageRefusal(inv(m))]).toEqual([m, true]);
  expect(imageRefusal(new ProviderError("invalid", "Bedrock: validationException: The model returned the following errors: Could not process image"))).toEqual({});
  expect(imageRefusal(Object.assign(new Error("Invalid image data in input_image"), { status: 400 }))).toEqual({});
  // Not over an image: a tool, a schema, image generation, a policy, a PDF's
  // pages, the window, a rate; and an error that is no provider's answer.
  for (const e of [
    inv("p: HTTP 400: Invalid schema for function 'render-image': In context=(), 'additionalProperties' is required to be supplied and to be false"),
    inv("p: HTTP 400: tools.14.custom.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$' (generate image)"),
    inv("p: HTTP 400: Hosted tool 'image_generation' is not supported with this model."),
    inv("p: HTTP 400: Image generation is not supported for this account."),
    inv("p: HTTP 400: Invalid prompt: your prompt was flagged as potentially violating our usage policy (images of minors)."),
    inv("p: HTTP 400: messages.0.content.2.document: PDF exceeds the maximum of 100 pages; images of pages are counted"),
    inv("p: HTTP 400: messages.3.content.0: Invalid `signature` in `thinking` block"),
    inv("p: HTTP 400: tools.0.input_schema: invalid schema"),
    new ProviderError("context", "p: HTTP 400: prompt is too long", 400),
    new ProviderError("rate", "p: HTTP 429: too many images a minute", 429),
    new Error("Cannot serialize the request: image block 3 failed"),
  ]) expect([String((e as Error).message), imageRefusal(e)]).toEqual([String((e as Error).message), null]);
  expect(errorClass(inv("p: HTTP 400: tools.0.input_schema: invalid schema"))).toBe("invalid_request");
  // A number of pixels under the floor is not a limit (a thumbnail size, say).
  expect(imageRefusal(inv("p: HTTP 400: Invalid image: got 1900x1000 pixels; thumbnails of 128 px are generated for previews"))).toEqual({});
  expect(imageRefusal(inv(`${at} max allowed size for many-image requests: 2000 pixels (the image is 2600 px)`))).toEqual({ edge: 2000 });
  // Too large in bytes: a 413 or its words; not one that reports a rate.
  expect(requestTooLarge(classify("p", 413, new Headers(), JSON.stringify({ type: "error", error: { type: "request_too_large", message: "Request exceeds the maximum size" } })))).toBe(true);
  expect(requestTooLarge(classify("p", 413, new Headers(), "<html><h1>413 Request Entity Too Large</h1></html>"))).toBe(true);
  expect(requestTooLarge(inv("gemini: INVALID_ARGUMENT: Request payload size exceeds the limit: 20971520 bytes."))).toBe(true);
  expect(requestTooLarge(classify("p", 413, new Headers(), JSON.stringify({ error: { message: "Request too large for model `x` in organization `o` on tokens per minute (TPM): Limit 6000, Requested 9106" } })))).toBe(false);
  expect(requestTooLarge(inv("p: HTTP 400: Input is too long for requested model."))).toBe(false);
});

test("an image over what Keel stores is scaled, a format no provider shares is converted, one that cannot be decoded is refused", async () => {
  const { fitImage } = await import("./image-fit.ts");
  const { STORE } = await import("../providers/image-limits.ts");
  const tall = block(png(2000, 6000));
  const f: any = await fitImage(tall, STORE);
  expect(imageSize(f.block.data)).toEqual({ w: 667, h: 2000 });
  expect(f.block.media_type).toBe("image/png");
  expect(f.from).toEqual({ w: 2000, h: 6000, type: "image/png" });
  // The same input gives the same bytes: a copy made again is the same request.
  expect(((await fitImage(tall, STORE)) as any).block.data).toBe(f.block.data);
  // Within the limits: the block itself, untouched.
  const small = block(png(1920, 1040));
  expect(((await fitImage(small, STORE)) as any).block).toBe(small);
  // The sender's media type is corrected to what the bytes are.
  expect(((await fitImage({ ...small, media_type: "image/jpeg" }, STORE)) as any).block).toEqual(small);
  // Over the byte limit at its size: JPEG, then smaller, until it passes.
  const heavy: any = await fitImage(block(png(600, 600, true)), { ...STORE, base64: 60_000 });
  expect(heavy.block.media_type).toBe("image/jpeg");
  expect(heavy.block.data.length).toBeLessThanOrEqual(60_000);
  expect(heavy.to.w).toBeLessThan(600);
  expect(heavy.to.w).toBe(heavy.to.h);
  // A GIF (first frame) is stored as PNG.
  const gif = Buffer.from("R0lGODlhAQABAIAAAP8AAP///ywAAAAAAQABAAACAkQBADs=", "base64");
  const g: any = await fitImage(block(gif, "image/gif"), STORE);
  expect(g.block.media_type).toBe("image/png");
  expect(imageSize(g.block.data)).toEqual({ w: 1, h: 1 });
  // Not an image, a damaged one, one too large to decode.
  expect(await fitImage(block(Buffer.from("<svg/>"), "image/svg+xml"), STORE)).toEqual({ refused: "it is not a PNG, JPEG, WebP, GIF or BMP image", fix: "convert it to PNG or JPEG with a tool and read the copy" });
  expect(((await fitImage(block(png(2000, 6000).subarray(0, 3000)), STORE)) as any).refused).toBe("its data is damaged or cut short");
  // Over 64 megapixels: what it is and that it needs scaling, not converting.
  expect(await fitImage(block(png(4000, 20000).subarray(0, 200)), STORE)).toEqual({ refused: "it is 4000x20000, more than the 64 megapixels decoded here", fix: "scale it down with a tool (for example magick) and read the copy" });
  // An animated WebP over the bound is named as one (the decoder reads stills only).
  const anim = Buffer.alloc(64);
  anim.write("RIFF", 0, "latin1"); anim.writeUInt32LE(56, 4); anim.write("WEBPVP8X", 8, "latin1"); anim.writeUInt32LE(10, 16);
  anim[20] = 0x02; // the animation flag
  anim.writeUIntLE(2999, 24, 3); anim.writeUIntLE(99, 27, 3); // a 3000 x 100 canvas
  expect(((await fitImage(block(anim, "image/webp"), STORE)) as any).refused).toBe("it is an animated WebP, which cannot be scaled here");
});

test("a tool's image result says what was scaled and where the original is", async () => {
  const { fitToolImages } = await import("./image-fit.ts");
  const dir = scratch("fit-tool-");
  const tall = block(png(2000, 6000));
  // From a file: the note names the file.
  const read: any = await fitToolImages([{ ...tall, path: "/shots/page.png" }], dir);
  expect(imageSize(read[0].data)).toEqual({ w: 667, h: 2000 });
  expect(read[0].path).toBeUndefined();
  expect(read[1]).toEqual({ type: "text", text: "[Image scaled from 2000x6000 to 667x2000 to fit the providers' image limits; the original is at /shots/page.png.]" });
  // From no file (an MCP capture): the original is kept beside the session's outputs.
  const mcp: any = await fitToolImages([{ type: "text", text: "captured" }, tall], dir);
  const at = /the original is at (\S+)\.\]$/.exec(mcp[2].text)![1]!;
  expect(at.startsWith(join(dir, "images"))).toBe(true);
  expect(Buffer.from(await Bun.file(at).arrayBuffer()).toString("base64")).toBe(tall.data);
  // One that cannot be decoded is not stored.
  const bad: any = await fitToolImages([block(Buffer.from("not an image"))], dir);
  expect(bad).toHaveLength(1);
  expect(bad[0].text).toMatch(/^\[Image left out: it is not a PNG, JPEG, WebP, GIF or BMP image\. It is at .+; convert it/);
  // The session's tools run on another machine: the copy kept here is said to be here.
  const far: any = await fitToolImages([tall], dir, true);
  expect(far[1].text).toMatch(/the original is at \S+ on the machine Keel runs on\.\]$/);
  // A copy that cannot be written does not fail the tool call.
  const nowhere: any = await fitToolImages([tall], "/proc/nope");
  expect(nowhere[1].text).toMatch(/^\[Image scaled from 2000x6000 to 667x2000 to fit the providers' image limits; the original is not kept \(.+\)\.\]$/);
  // Text and small images pass as they are.
  const plain = [{ type: "text" as const, text: "x" }, block(png(10, 10))];
  expect(await fitToolImages(plain, dir)).toEqual(plain);
  expect(await fitToolImages("text", dir)).toBe("text");
});

test("a request carries a scaled copy of an oversized image in the history, the same bytes each time, and the history is not rewritten", async () => {
  const { fitForWire, imageKeys, LEFT_OUT } = await import("./image-fit.ts");
  let told = 0;
  const { imageLimits } = await import("../providers/image-limits.ts");
  const big = block(png(2000, 6000)), ok = block(png(800, 600)), cut = block(png(4000, 4000).subarray(0, 4000));
  const history = (): Message[] => [
    { role: "user", content: [big, { type: "text", text: "look" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "shot" }, big, ok, cut] }] },
  ];
  const stored = history(), before = JSON.stringify(stored);
  const claude = imageLimits("claude");
  const a = await fitForWire(stored, claude, undefined, () => told++);
  expect(told).toBe(1); // said once that copies are being made
  expect(JSON.stringify(stored)).toBe(before);
  const sent = imagesOf(a);
  expect(sent.map((b) => imageSize(b.data))).toEqual([{ w: 1000, h: 3000 }, { w: 1000, h: 3000 }, { w: 800, h: 600 }]);
  expect(sent[2]).toBe(ok);
  // The one that cannot be scaled is a note in its place.
  expect((a[2]!.content[0] as any).content[3]).toEqual({ type: "text", text: "[Image left out of this request: its data is damaged or cut short.]" });
  // A later request of the same history, with a turn added: the prefix is the same bytes.
  const b = await fitForWire([...history(), { role: "assistant", content: [{ type: "text", text: "seen" }] }, { role: "user", content: [{ type: "text", text: "next" }] }], claude);
  expect(JSON.stringify(b.slice(0, 3))).toBe(JSON.stringify(a));
  // Nothing over the limits: the same array, nothing copied.
  const fine: Message[] = [{ role: "user", content: [ok, { type: "text", text: "hi" }] }];
  expect(await fitForWire(fine, claude, undefined, () => told++)).toBe(fine);
  expect(told).toBe(1);
  // GPT's limit is patches, not an edge: 2000 x 6000 passes whole. Gemini reads no GIF.
  expect(imagesOf(await fitForWire(stored.slice(0, 1), imageLimits("gpt")))[0]).toBe(big);
  const gif = block(Buffer.from("R0lGODlhAQABAIAAAP8AAP///ywAAAAAAQABAAACAkQBADs=", "base64"), "image/gif");
  expect(imagesOf(await fitForWire([{ role: "user", content: [gif] }], imageLimits("gemini")))[0].media_type).toBe("image/png");
  expect(imagesOf(await fitForWire([{ role: "user", content: [gif] }], claude))[0]).toBe(gif);
  expect(imagesOf(await fitForWire([{ role: "user", content: [gif] }], imageLimits("gpt")))[0].media_type).toBe("image/png"); // only a still GIF is read there
  // Images left out after a refusal are notes, whatever their size.
  const out = await fitForWire(stored, claude, new Set(imageKeys(stored)));
  expect(imagesOf(out)).toEqual([]);
  expect(out[0]!.content[0]).toEqual({ type: "text", text: LEFT_OUT });
});

test("a prompt's oversized image is stored scaled with its original as a file the model is told of", async () => {
  const { fitPromptImages } = await import("./image-fit.ts");
  const { attachmentPath, resolveAttachments, setAttachmentsRoot } = await import("./attachments.ts");
  setAttachmentsRoot(scratch("fit-prompt-"));
  const tall = block(png(2000, 6000)), small = block(png(100, 100));
  const file = { type: "attachment", id: "0".repeat(64), name: "notes.txt", media_type: "text/plain", size: 3 };
  const out = await fitPromptImages([tall, small, file, block(Buffer.from("junk"))]);
  expect(out.map((b) => b.type)).toEqual(["image", "attachment", "image", "attachment", "attachment"]);
  expect(imageSize(out[0].data)).toEqual({ w: 667, h: 2000 });
  expect(out[1].scaled).toEqual({ from: [2000, 6000], to: [667, 2000] });
  expect(Buffer.from(await Bun.file(attachmentPath(out[1].id)!).arrayBuffer()).toString("base64")).toBe(tall.data);
  expect(out[2]).toEqual(small);
  expect(out[3]).toBe(file);
  const told = resolveAttachments([{ role: "user", content: [out[0], out[1], out[4]] }], { name: "M" });
  expect((told[0]!.content[1] as any).text).toBe(`[The image before this was scaled from 2000x6000 to 667x2000 to fit the providers' image limits; the original is at ${attachmentPath(out[1].id)}.]`);
  expect((told[0]!.content[2] as any).text).toContain("it was not inlined because");
  expect(await fitPromptImages(undefined)).toEqual([]);
});

test("the images that do not decode in full are found among those a request holds", async () => {
  const { anyOver, damagedImages, imageKey } = await import("./image-fit.ts");
  const good = block(png(300, 200)), cut = block(png(600, 400, true).subarray(0, 60_000)), gone = block(png(500, 300, true).subarray(0, 40_000));
  // Both cut files pass a read of their header: that is how they were stored.
  expect([imageSize(cut.data), imageSize(gone.data)]).toEqual([{ w: 600, h: 400 }, { w: 500, h: 300 }]);
  const messages: Message[] = [
    { role: "user", content: [good, cut] },
    { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [gone, good] }] },
  ];
  expect((await damagedImages(messages, new Set())).sort()).toEqual([imageKey(cut.data), imageKey(gone.data)].sort());
  expect(await damagedImages(messages, new Set([imageKey(gone.data)]))).toEqual([imageKey(cut.data)]);
  expect(await damagedImages(messages.slice(0, 1).map((m) => ({ ...m, content: [good] }) as Message), new Set())).toEqual([]);
  expect([anyOver(messages, 512), anyOver(messages, 600)]).toEqual([true, false]);
});

test("a copy made twice at once is counted once", async () => {
  const { copiesHeld, fitForWire } = await import("./image-fit.ts");
  const { imageLimits } = await import("../providers/image-limits.ts");
  const big = block(png(1200, 3600, true));
  const before = copiesHeld();
  const [a, b] = await Promise.all([0, 1].map(() => fitForWire([{ role: "user", content: [big] }], imageLimits("claude"))));
  const copy = imagesOf(a!)[0].data as string;
  expect(imagesOf(b!)[0].data).toBe(copy);
  expect(copiesHeld()).toEqual({ copies: before.copies + 1, bytes: before.bytes + copy.length });
});

test("a session's prompts are handed on in the order they came, however long an image takes to scale", async () => {
  const { fitted } = await import("./image-fit.ts");
  const order: string[] = [];
  const slow = fitted("s1", [block(png(2000, 6000))], (images) => { order.push(`first with ${images.filter((b) => b.type === "image").length} image`); return 1; });
  const quick = fitted("s1", [], () => { order.push("second"); return 2; });
  const other = fitted("s2", undefined, () => { order.push("another session"); return 3; });
  expect(await Promise.all([slow, quick, other])).toEqual([1, 2, 3]);
  expect(order).toEqual(["another session", "first with 1 image", "second"]);
  // A prompt whose send throws does not hold the ones after it.
  await expect(fitted("s1", [], () => { throw new Error("refused"); })).rejects.toThrow("refused");
  expect(await fitted("s1", [], () => "sent")).toBe("sent");
});

test("after a refusal as too large the oldest images are left out until half the bytes are, the newest stay", async () => {
  const { imageKeys, oldestForSize } = await import("./image-fit.ts");
  const a = block(png(40, 40, true)), b = block(png(40, 41, true)), c = block(png(40, 42, true)), d = block(png(40, 43, true));
  const messages: Message[] = [{ role: "user", content: [a, b, c, d] }];
  const keys = imageKeys(messages);
  const drop = oldestForSize(messages, keys);
  expect(drop).toEqual(keys.slice(0, drop.length));
  expect(drop.length).toBeGreaterThanOrEqual(1);
  expect(drop.length).toBeLessThan(keys.length);
  // Asked again with what is left, and down to the last one.
  expect(oldestForSize(messages, keys.slice(-2))).toEqual([keys[2]!]);
  expect(oldestForSize(messages, keys.slice(-1))).toEqual([keys[3]!]);
});
