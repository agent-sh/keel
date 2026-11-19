import { expect, test } from "bun:test";
import type { Message } from "../core/types.ts";
import { contextTokens } from "./compact.ts";
import { imageSize, imageTokens, withoutImages } from "./images.ts";

test("a text-only model gets a note in place of each image, in prompts and tool results", () => {
  const img = { type: "image", media_type: "image/png", data: "AA==" };
  const msgs = [
    { role: "user", content: [img, { type: "text", text: "look" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [img] }] },
  ] as unknown as Message[];
  const out = JSON.stringify(withoutImages(msgs, "m"));
  expect(out).not.toContain('"image"');
  expect(out.match(/image not sent: m does not read images/g)?.length).toBe(2);
  const plain = [{ role: "user", content: [{ type: "text", text: "hi" }] }] as Message[];
  expect(withoutImages(plain, "m")).toBe(plain);
});

// The context estimate counts an image by its pixels (one token per 28x28
// patch), not by its base64 length.
test("an image counts by its pixel size in the context estimate", () => {
  const png = Buffer.alloc(300_000);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(png);
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(800, 20);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x02, 0x58, 0x03, 0x20, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  expect(imageSize(jpeg.toString("base64"))).toEqual({ w: 800, h: 600 });
  const img = { type: "image", media_type: "image/png", data: png.toString("base64") };
  expect(imageTokens(img)).toBe(46 * 29);
  const line = [
    { id: "a", seq: 1, ts: 1, session_id: "s", kind: "user", data: { text: "hi" } },
    { id: "b", seq: 2, ts: 2, session_id: "s", kind: "assistant", data: { blocks: [{ type: "text", text: "ok" }], usage: { input: 10, output: 0, cache_read: 0, cache_write: 0 }, stop: "end_turn" } },
    { id: "c", seq: 3, ts: 3, session_id: "s", kind: "user", data: { text: "", images: [img] } },
  ] as any[];
  const est = contextTokens(line).estimated;
  expect(est).toBeGreaterThanOrEqual(46 * 29);
  expect(est).toBeLessThan(46 * 29 + 50);
});
