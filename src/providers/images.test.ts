import { expect, test } from "bun:test";
import { cartoon } from "./scripted-art.ts";
import { chatImagesFrom, fromDataUrl, geminiImagesFrom, imagesFrom, several, sniff, toolImageBody, toolImagesFrom } from "./images.ts";
import { ProviderError } from "./http.ts";

const png = Buffer.from(cartoon("t")).toString("base64");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]).toString("base64");

test("pictures are told by their first bytes, and what is not a picture Keel keeps is left out", () => {
  expect(sniff(png)).toBe("image/png");
  expect(sniff(jpeg)).toBe("image/jpeg");
  expect(sniff(Buffer.from("<html>not a picture</html>").toString("base64"))).toBeUndefined();
  expect(fromDataUrl(`data:image/png;base64,${png}`)).toEqual({ media_type: "image/png", data: png });
  expect(fromDataUrl("data:text/plain;base64,aGk=")).toBeUndefined();
});

test("each route's answer gives its pictures", () => {
  expect(imagesFrom({ data: [{ b64_json: png }, { url: "https://x/y.png" }, {}] })).toEqual([{ data: png }, { url: "https://x/y.png" }]);
  expect(chatImagesFrom({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${png}` } }, { image_url: { url: "https://x/y" } }] } }] })).toEqual([{ media_type: "image/png", data: png }]);
  expect(geminiImagesFrom({ candidates: [{ content: { parts: [{ text: "here" }, { inlineData: { mimeType: "image/png", data: png } }] } }] })).toEqual([{ media_type: "image/png", data: png }]);
  // The Responses route: the finished item of the stream, and the same picture in the completed response once.
  const item = { type: "image_generation_call", id: "ig_1", result: png };
  expect(toolImagesFrom([{ type: "response.output_item.done", item }, { type: "response.completed", response: { output: [item] } }])).toEqual([{ media_type: "image/png", data: png }]);
  expect(toolImagesFrom([{ type: "response.output_item.done", item: { type: "message" } }])).toEqual([]);
});

test("the Responses request forces the image tool of the model it names", () => {
  const b = toolImageBody("host-model", "a fox");
  expect(b).toMatchObject({ model: "host-model", tools: [{ type: "image_generation" }], tool_choice: { type: "image_generation" }, stream: true, store: false });
  expect(JSON.stringify(b.input)).toContain("a fox");
});

test("n pictures are n requests, a few at once; a failed one is left out unless none came", async () => {
  let at = 0, peak = 0, calls = 0;
  const one = async () => { calls++; at++; peak = Math.max(peak, at); await Bun.sleep(5); at--; return [{ media_type: "image/png", data: png }]; };
  expect((await several(5, one)).length).toBe(5);
  expect(calls).toBe(5);
  expect(peak).toBeLessThanOrEqual(3);
  let k = 0;
  const flaky = async () => { if (k++ % 2) throw new ProviderError("server", "boom"); return [{ media_type: "image/png", data: png }]; };
  expect((await several(4, flaky)).length).toBe(2);
  await expect(several(2, async () => { throw new ProviderError("auth", "no key"); })).rejects.toThrow("no key");
  expect((await several(99, one)).length).toBe(6);
});
