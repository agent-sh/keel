// An image never breaks a session: scaled when stored, scaled or left out on
// the wire, and a provider's refusal over an image ends with the turn going on.
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
  const { imageRefusal } = await import("../providers/image-limits.ts");
  const { errorClass } = await import("../admin/classes.ts");
  const { ProviderError } = await import("../providers/http.ts");
  const many = new ProviderError("invalid", "Bedrock: HTTP 400: messages.12.content.3.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 3000 pixels", 400);
  expect(imageRefusal(many)).toEqual({ edge: 3000 });
  expect(errorClass(many)).toBe("image");
  expect(imageRefusal(new ProviderError("invalid", "p: HTTP 400: image exceeds 5 MB maximum: 6291456 bytes > 5242880 bytes", 400))).toEqual({});
  expect(imageRefusal(new ProviderError("invalid", "p: HTTP 400: Could not process image", 400))).toEqual({});
  expect(imageRefusal(Object.assign(new Error("Invalid image data in input_image"), { status: 400 }))).toEqual({});
  expect(imageRefusal(new ProviderError("context", "p: HTTP 400: prompt is too long", 400))).toBeNull();
  expect(imageRefusal(new ProviderError("invalid", "p: HTTP 400: tools.0.input_schema: invalid schema", 400))).toBeNull();
  expect(imageRefusal(new ProviderError("rate", "p: HTTP 429: too many images a minute", 429))).toBeNull();
  expect(errorClass(new ProviderError("invalid", "p: HTTP 400: tools.0.input_schema: invalid schema", 400))).toBe("invalid_request");
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
  expect(((await fitImage(block(Buffer.from("<svg/>"), "image/svg+xml"), STORE)) as any).refused).toContain("not a PNG, JPEG, WebP, GIF or BMP");
  expect(((await fitImage(block(png(2000, 6000).subarray(0, 3000)), STORE)) as any).refused).toContain("damaged or cut short");
  expect(((await fitImage(block(png(9000, 9000).subarray(0, 200)), STORE)) as any).refused).toContain("larger than 8000 x 8000");
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
  // Text and small images pass as they are.
  const plain = [{ type: "text" as const, text: "x" }, block(png(10, 10))];
  expect(await fitToolImages(plain, dir)).toEqual(plain);
  expect(await fitToolImages("text", dir)).toBe("text");
});

test("a request carries a scaled copy of an oversized image in the history, the same bytes each time, and the history is not rewritten", async () => {
  const { fitForWire, imageKeys, LEFT_OUT } = await import("./image-fit.ts");
  const { imageLimits } = await import("../providers/image-limits.ts");
  const big = block(png(2000, 6000)), ok = block(png(800, 600)), cut = block(png(4000, 4000).subarray(0, 4000));
  const history = (): Message[] => [
    { role: "user", content: [big, { type: "text", text: "look" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "shot" }, big, ok, cut] }] },
  ];
  const stored = history(), before = JSON.stringify(stored);
  const claude = imageLimits("claude");
  const a = await fitForWire(stored, claude);
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
  expect(await fitForWire(fine, claude)).toBe(fine);
  // GPT's limit is patches, not an edge: 2000 x 6000 passes whole. Gemini reads no GIF.
  expect(imagesOf(await fitForWire(stored.slice(0, 1), imageLimits("gpt")))[0]).toBe(big);
  const gif = block(Buffer.from("R0lGODlhAQABAIAAAP8AAP///ywAAAAAAQABAAACAkQBADs=", "base64"), "image/gif");
  expect(imagesOf(await fitForWire([{ role: "user", content: [gif] }], imageLimits("gemini")))[0].media_type).toBe("image/png");
  expect(imagesOf(await fitForWire([{ role: "user", content: [gif] }], claude))[0]).toBe(gif);
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

// ---- the engine: a tool's image, a history that holds one, a refusal ----

async function engineWith(stream: (req: any, n: number) => any, family = "claude") {
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine } = await import("./turn.ts");
  const dir = scratch("fit-engine-");
  const store = new Store(dir);
  const s = store.createSession({ model: "p:m", workspace: dir });
  const asked: any[] = [];
  const info = { id: "p:m", provider: "p", model: "m", name: "M", family, context: 200_000, output: 1_000, efforts: [], billing: "per_token", images: true };
  const usage = { input: 1, output: 1, cache_read: 0, cache_write: 0 };
  const provider = {
    id: "p", wire: "anthropic_messages", available: () => true, list: async () => [],
    stream: async (req: any) => {
      asked.push(req);
      const r = stream(req, asked.length);
      return { blocks: r ?? [{ type: "text", text: "ok" }], usage, stop: r?.some((b: any) => b.type === "tool_use") ? "tool_use" : "end_turn", model: "m" };
    },
  };
  const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] };
  const captured: any[] = [];
  const engine = new Engine(store, new Bus(), providers as any, { capture: (_s: string, e: unknown, c: unknown) => (captured.push(c), { message: String(e) }) } as any, join(dir, "spill"));
  const turn = async (text: string) => { engine.send(s.id, text); await engine.idle(s.id); };
  return { dir, store, s, asked, engine, turn, captured };
}
const refuse = async (message: string) => { const { ProviderError } = await import("../providers/http.ts"); return new ProviderError("invalid", message, 400); };
const over = (messages: any[], edge: number) => imagesOf(messages).some((b) => { const z = imageSize(b.data)!; return z.w > edge || z.h > edge; });

test("a tool returns a 2000x6000 image: it is stored within the bound and the next request carries that", async () => {
  const dir = scratch("fit-read-");
  const path = join(dir, "page.png");
  writeFileSync(path, png(2000, 6000));
  const tool = (await import("../tools/registry.ts")).toolsFor("claude", false, "x").find((t: any) => /read/i.test(t.name))!;
  const e = await engineWith((_req, n) => (n === 1 ? [{ type: "tool_use", id: "t1", name: tool.name, input: { file_path: path, path } }] : undefined));
  await e.turn("look at the page");
  expect(e.asked).toHaveLength(2);
  const result = e.asked[1].messages.at(-1).content.find((b: any) => b.type === "tool_result");
  expect(result.is_error).toBeFalsy();
  expect(imageSize(result.content[0].data)).toEqual({ w: 667, h: 2000 });
  expect(result.content[1].text).toBe(`[Image scaled from 2000x6000 to 667x2000 to fit the providers' image limits; the original is at ${path}.]`);
  // Stored that way: the history never holds the oversized image.
  const stored = e.store.events(e.s.id).find((x) => x.kind === "tool_result")!.data.results[0];
  expect(stored.content[0]).toEqual(result.content[0]);
  expect(stored.content[0].path).toBeUndefined();
});

test("a history that already holds an oversized image sends a valid request, the same bytes on the next one", async () => {
  const e = await engineWith(() => undefined);
  const legacy = block(png(1000, 4000));
  e.store.append(e.s.id, "user", { text: "see this", images: [legacy] });
  e.store.append(e.s.id, "assistant", { blocks: [{ type: "tool_use", id: "t1", name: "Read", input: {} }], model: "p:m", stop: "tool_use", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 } });
  e.store.append(e.s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: "t1", content: [legacy] }] });
  await e.turn("go on");
  await e.turn("and again");
  expect(e.asked).toHaveLength(2);
  for (const req of e.asked) expect(over(req.messages, 3000)).toBe(false);
  expect(imagesOf(e.asked[0].messages).map((b) => imageSize(b.data))).toEqual([{ w: 750, h: 3000 }, { w: 750, h: 3000 }]);
  const n = e.asked[0].messages.length;
  expect(JSON.stringify(e.asked[1].messages.slice(0, n - 1))).toBe(JSON.stringify(e.asked[0].messages.slice(0, n - 1)));
  // The stored history is as it was.
  expect(e.store.events(e.s.id)[0]!.data.images[0]).toEqual(legacy);
});

test("a provider that states a lower limit: the images are scaled to it, the turn goes on and the session keeps the limit", async () => {
  const no = await refuse("p: HTTP 400: messages.0.content.0.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 1500 pixels");
  const e = await engineWith((req) => { if (over(req.messages, 1500)) throw no; return undefined; });
  e.store.append(e.s.id, "user", { text: "see this", images: [block(png(1000, 2800))] });
  e.store.append(e.s.id, "assistant", { blocks: [{ type: "text", text: "seen" }], model: "p:m", stop: "end_turn", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 } });
  await e.turn("go on");
  expect(e.asked).toHaveLength(2); // refused once, then passed
  expect(imagesOf(e.asked[1].messages).map((b) => imageSize(b.data))).toEqual([{ w: 536, h: 1500 }]);
  expect(e.store.session(e.s.id)!.settings.image_edge).toBe(1500);
  const events = e.store.events(e.s.id);
  expect(events.at(-1)!.data.reason).toBe("end_turn");
  expect(events.find((x) => x.kind === "note" && x.data.kind === "images")!.data.text).toContain("at most 1500 px");
  expect(e.captured.some((c) => String(c?.then).includes("1500"))).toBe(true);
  // The next turn is not refused at all, and its prefix is the same bytes.
  await e.turn("more");
  expect(e.asked).toHaveLength(3);
  expect(JSON.stringify(e.asked[2].messages[0])).toBe(JSON.stringify(e.asked[1].messages[0]));
});

test("a provider that refuses an image for a reason scaling cannot fix: the images are left out and the session goes on", async () => {
  const no = await refuse("p: HTTP 400: messages.0.content.0.image.source.base64.data: Could not process image");
  const e = await engineWith((req) => { if (imagesOf(req.messages).length) throw no; return undefined; });
  const img = block(png(300, 200));
  e.store.append(e.s.id, "user", { text: "see this", images: [img] });
  e.store.append(e.s.id, "assistant", { blocks: [{ type: "text", text: "seen" }], model: "p:m", stop: "end_turn", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 } });
  await e.turn("go on");
  expect(e.asked).toHaveLength(2);
  expect(JSON.stringify(e.asked[1].messages[0])).toContain("Image left out: the provider refused a request over this session's images");
  const events = e.store.events(e.s.id);
  expect(events.at(-1)!.data.reason).toBe("end_turn");
  expect(events.some((x) => x.kind === "error")).toBe(false);
  expect(events.find((x) => x.kind === "note" && x.data.kind === "images")!.data.text).toMatch(/^The provider refused a request over this session's images \(.*Could not process image\)\. The image sent so far is left out/);
  expect(e.store.session(e.s.id)!.settings.images_out).toHaveLength(1);
  expect(events[0]!.data.images[0]).toEqual(img); // stored as it was
  await e.turn("more");
  expect(e.asked).toHaveLength(3);
  expect(JSON.stringify(e.asked[2].messages[0])).toBe(JSON.stringify(e.asked[1].messages[0]));
});

test("a request refused over an image with none left to leave out ends the turn with what to do", async () => {
  const no = await refuse("p: HTTP 400: Could not process image");
  const e = await engineWith(() => { throw no; });
  e.store.append(e.s.id, "user", { text: "see this", images: [block(png(300, 200))] });
  e.store.append(e.s.id, "assistant", { blocks: [{ type: "text", text: "seen" }], model: "p:m", stop: "end_turn", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 } });
  await e.turn("go on");
  expect(e.asked).toHaveLength(2); // with the image, then without
  const error = e.store.events(e.s.id).find((x) => x.kind === "error")!;
  expect(error.data.message).toContain("compact the session or go on in a new one");
  // Nothing was learned from a refusal that leaving the images out did not cure.
  expect(e.store.session(e.s.id)!.settings.images_out).toBeUndefined();
});

test("a request refused as too large in bytes while it holds images goes on without them; without images the refusal stands", async () => {
  const { classify } = await import("../providers/http.ts");
  const no = classify("p", 413, new Headers(), JSON.stringify({ type: "error", error: { type: "request_too_large", message: "Request exceeds the maximum size" } }));
  const e = await engineWith((req) => { if (JSON.stringify(req.messages).length > 200_000) throw no; return undefined; });
  const shot = block(png(500, 500, true)); // about 330 KB of base64
  e.store.append(e.s.id, "user", { text: "see this", images: [shot] });
  e.store.append(e.s.id, "assistant", { blocks: [{ type: "text", text: "seen" }], model: "p:m", stop: "end_turn", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 } });
  await e.turn("go on");
  expect(e.asked).toHaveLength(2);
  expect(imagesOf(e.asked[1].messages)).toEqual([]);
  expect(e.store.events(e.s.id).at(-1)!.data.reason).toBe("end_turn");
  expect(e.store.session(e.s.id)!.settings.images_out).toHaveLength(1);
  // No image in the request: nothing of this applies, the provider's refusal is the turn's error.
  const plain = await engineWith(() => { throw no; });
  await plain.turn("hello");
  expect(plain.asked).toHaveLength(1);
  expect(plain.store.events(plain.s.id).find((x) => x.kind === "error")!.data.message).toContain("Request exceeds the maximum size");
});
