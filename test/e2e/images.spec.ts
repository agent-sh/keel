import { expect, test } from "./isolate.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { shoot } from "./shots.ts";

// Feature: an image never breaks a session. One over the bound is stored
// scaled down, from a tool and from a prompt; a provider that refuses a
// request over an image gets the images at the limit it states, else without
// the damaged ones, else without any, and the turn goes on; what was left out
// can be sent again. The scripted provider plays the provider's refusals.
const MODEL = "scripted:stand-in";

// A grey PNG of w x h.
function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "latin1"), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8; // 8 bits, greyscale
  const raw = Buffer.alloc(h * (w + 1), 128);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const block = (b: Buffer) => ({ type: "image", media_type: "image/png", data: b.toString("base64") });
// The pixel size a stored PNG block says it has.
const size = (b: { data: string }) => { const h = Buffer.from(b.data.slice(0, 64), "base64"); return `${h.readUInt32BE(16)}x${h.readUInt32BE(20)}`; };

type Api = import("@playwright/test").APIRequestContext;
const create = async (request: Api) => (await (await request.post("/api/sessions", { data: { model: MODEL } })).json()).session;
const events = async (request: Api, id: string): Promise<any[]> => (await (await request.get(`/api/sessions/${id}/events`)).json()).events;
const settings = async (request: Api, id: string) => (await (await request.get("/api/sessions")).json()).sessions.find((s: any) => s.id === id).settings;
// A prompt and its whole turn; the reply's text.
async function turn(request: Api, id: string, text: string, images: unknown[] = []): Promise<string> {
  const ends = async () => (await events(request, id)).filter((e) => e.kind === "turn_end").length;
  const before = await ends();
  expect((await request.post(`/api/sessions/${id}/messages`, { data: { text, images } })).ok()).toBe(true);
  await expect.poll(ends, { timeout: 30_000 }).toBe(before + 1);
  const said = (await events(request, id)).findLast((e) => e.kind === "assistant");
  return said?.data.blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") ?? "";
}

test("an image over the bound is stored scaled, from a tool and from a prompt", async ({ page, request }) => {
  const s = await create(request);
  const tall = join(s.workspace, `tall-${s.id}.png`);
  writeFileSync(tall, png(100, 2400));
  await turn(request, s.id, `script:calls ${JSON.stringify([{ name: "Read", input: { file_path: tall } }])}`);
  const result = (await events(request, s.id)).find((e) => e.kind === "tool_result")!.data.results[0];
  expect(result.is_error).toBeFalsy();
  expect(size(result.content[0])).toBe("83x2000");
  expect(result.content[0].path).toBeUndefined();
  expect(result.content[1].text).toBe(`[Image scaled from 100x2400 to 83x2000 to fit the providers' image limits; the original is at ${tall}.]`);

  // A prompt's image (from the command line or the phone; the page scales its
  // own before it sends them): stored scaled, with its original as a file.
  // The provider answers 413 once: the same request goes again and nothing is left out.
  expect(await turn(request, s.id, "What is on this page? script:image-large", [block(png(120, 3000))])).toBe("Images: 83x2000, 80x2000. Left out: 0. Attempt 2.");
  await page.goto(`/s/${s.id}`);
  await expect(page.getByTestId("assistant-text").last()).toHaveText("Images: 83x2000, 80x2000. Left out: 0. Attempt 2.");
  await expect(page.getByTestId("message-file")).toContainText("original-120x3000.png");
  const prompt = (await events(request, s.id)).findLast((e) => e.kind === "user")!;
  expect(prompt.data.images.map((b: any) => b.type)).toEqual(["image", "attachment"]);
  expect(size(prompt.data.images[0])).toBe("80x2000");
  expect(prompt.data.images[1]).toMatchObject({ name: "original-120x3000.png", scaled: { from: [120, 3000], to: [80, 2000] } });
  expect((await settings(request, s.id)).images_out).toBeUndefined();
  await expect(page.getByTestId("images-note")).toHaveCount(0);
  await shoot(page, "images-01-scaled");
  await request.delete(`/api/sessions/${s.id}`);
});

test("a provider that states a lower limit gets the images scaled to it, in a turn or in a compaction", async ({ request }) => {
  // In a turn: refused once, sent again at the stated limit, and the session keeps it.
  const a = await create(request);
  expect(await turn(request, a.id, "script:images", [block(png(300, 900))])).toBe("Images: 300x900. Left out: 0. Attempt 1.");
  expect(await turn(request, a.id, "script:image-limit 600")).toBe("Images: 200x600. Left out: 0. Attempt 1.");
  expect((await settings(request, a.id)).image_edge).toBe(600);
  let line = await events(request, a.id);
  expect(line.filter((e) => e.kind === "note" && e.data.kind === "images").map((e) => e.data.text)).toEqual(["Images over 600 px a side are sent scaled down: the provider stated that limit."]);
  expect(size(line.find((e) => e.kind === "user")!.data.images[0])).toBe("300x900"); // the history is as it was
  expect(line.filter((e) => e.kind === "error")).toEqual([]);
  // The next turn is not refused: the limit is used from its first request.
  expect(await turn(request, a.id, "script:image-limit 600")).toBe("Images: 200x600. Left out: 0. Attempt 1.");

  // The owner's compaction is the first request to meet the limit: the summary is kept.
  const b = await create(request);
  await turn(request, b.id, "script:images", [block(png(300, 900))]);
  const compacted = await request.post(`/api/sessions/${b.id}/compact`, { data: { focus: "script:image-limit 600" } });
  expect(compacted.status(), await compacted.text()).toBe(200);
  line = await events(request, b.id);
  expect(line.filter((e) => e.kind === "compaction")).toHaveLength(1);
  expect((await settings(request, b.id)).image_edge).toBe(600);
  // The transcript's line about it comes with the next turn, not during the summary.
  expect(line.filter((e) => e.kind === "note" && e.data.kind === "images")).toEqual([]);
  expect(await turn(request, b.id, "script:images")).toBe("Images: 200x600. Left out: 0. Attempt 1.");
  expect((await events(request, b.id)).filter((e) => e.kind === "note" && e.data.kind === "images")).toHaveLength(1);

  // Refused whatever is sent: the turn ends with the provider's own error and nothing is kept.
  const c = await create(request);
  await turn(request, c.id, "script:image-always", [block(png(300, 900))]);
  line = await events(request, c.id);
  expect(line.find((e) => e.kind === "error")!.data.message).toContain("Could not process image");
  expect(await settings(request, c.id)).not.toHaveProperty("images_out");
  expect(await settings(request, c.id)).not.toHaveProperty("image_edge");
  for (const s of [a, b, c]) await request.delete(`/api/sessions/${s.id}`);
});

test("a refusal that names no image leaves out the damaged one, then all, and the owner can send them again", async ({ page, request }) => {
  const s = await create(request);
  const good = join(s.workspace, `good-${s.id}.png`), cut = join(s.workspace, `cut-${s.id}.png`);
  writeFileSync(good, png(300, 200));
  const whole = png(600, 400);
  writeFileSync(cut, whole.subarray(0, Math.floor(whole.length * 0.7))); // read while it was being written
  await turn(request, s.id, `script:calls ${JSON.stringify([{ name: "Read", input: { file_path: good } }, { name: "Read", input: { file_path: cut } }])}`);
  // Both are in the history: the cut one passes a read of its header.
  expect((await events(request, s.id)).filter((e) => e.kind === "tool_result").map((e) => size(e.data.results[0].content[0]))).toEqual(["300x200", "600x400"]);

  await page.goto(`/s/${s.id}`);
  const composer = page.getByTestId("composer"), reply = page.getByTestId("assistant-text").last(), notes = page.getByTestId("images-note");
  const ask = async (text: string, said: string) => {
    await composer.fill(text);
    await composer.press("Enter");
    await expect(reply).toHaveText(said, { timeout: 30_000 });
  };
  // The provider cannot process the cut one and does not say which: only it is left out.
  await ask("script:image-bad", "Images: 300x200. Left out: 1. Attempt 1.");
  await expect(notes).toHaveCount(1);
  await expect(notes).toContainText("One image left out of what the model reads: the provider refused a request over this session's images.");
  expect((await settings(request, s.id)).images_out).toHaveLength(1);
  // It refuses the good one too: with none damaged, all are left out.
  await ask("script:image-none", "Images: none. Left out: 2. Attempt 1.");
  await expect(notes).toHaveCount(2);
  expect((await settings(request, s.id)).images_out).toHaveLength(2);
  // Only the newest note offers to send them again.
  await expect(page.getByTestId("images-restore")).toHaveCount(1);
  await expect(notes.last().getByTestId("images-restore")).toBeVisible();
  await shoot(page, "images-02-left-out");

  await page.getByTestId("images-restore").click();
  await expect(page.getByTestId("images-restored")).toBeVisible();
  await expect(page.getByTestId("images-restore")).toHaveCount(0);
  await expect.poll(async () => (await settings(request, s.id)).images_out).toBeUndefined();
  await shoot(page, "images-03-sent-again");
  await ask("script:images", "Images: 300x200, 600x400. Left out: 0. Attempt 1.");
  await request.delete(`/api/sessions/${s.id}`);
});

test("a request over the provider's byte cap leaves out the oldest images and keeps the newest", async ({ request }) => {
  const s = await create(request);
  const sizes = [[500, 500], [400, 400], [300, 300], [200, 200], [100, 100]];
  const calls = sizes.map(([w, h], i) => {
    const file = join(s.workspace, `cap-${i}-${s.id}.png`);
    writeFileSync(file, png(w!, h!));
    return { name: "Read", input: { file_path: file } };
  });
  await turn(request, s.id, `script:calls ${JSON.stringify(calls)}`);
  // The provider answers 413 while the request holds more than three images.
  const said = await turn(request, s.id, "What is on these pages? script:image-cap 3");
  const kept = /^Images: (.+)\. Left out: (\d+)\./.exec(said);
  expect(kept, said).not.toBeNull();
  const shown = kept![1]!.split(", "), out = Number(kept![2]);
  // The newest are still sent, in order; only the oldest are notes.
  expect(shown).toEqual(sizes.slice(-shown.length).map(([w, h]) => `${w}x${h}`));
  expect(shown.length).toBeGreaterThanOrEqual(1);
  expect(shown.length).toBeLessThanOrEqual(3);
  expect(out).toBe(sizes.length - shown.length);
  const note = (await events(request, s.id)).findLast((e) => e.kind === "note" && e.data.kind === "images");
  expect(note.data.left_out).toBe(out);
  expect((await settings(request, s.id)).images_out).toHaveLength(out);
  await request.delete(`/api/sessions/${s.id}`);
});

// A request over the provider's byte cap with no image in it: the long tool results are sent shortened,
// oldest first, the turn completes, and what is stored does not change.
test("a request over the byte cap with no image is sent with its long tool results shortened", async ({ request }) => {
  const s = await create(request);
  const files = [0, 1, 2, 3, 4].map((i) => {
    const file = join(s.workspace, `long-${i}-${s.id}.txt`);
    writeFileSync(file, Array.from({ length: 90 }, (_, n) => `file ${i} line ${n} ${"abcdefghij".repeat(8)}`).join("\n"));
    return { name: "Read", input: { file_path: file } };
  });
  await turn(request, s.id, `script:calls ${JSON.stringify(files)}`);
  const stored = async () => JSON.stringify((await events(request, s.id)).filter((e) => e.kind === "tool_result").map((e) => e.data));
  const before = await stored();
  const said = await turn(request, s.id, "How big was that request? script:byte-cap 30000");
  const m = /^Request: (\d+) bytes\. Shortened: (\d+)\./.exec(said);
  expect(m, said).not.toBeNull();
  const cut = Number(m![2]);
  expect(cut).toBeGreaterThanOrEqual(1);
  expect(cut).toBeLessThan(files.length); // the newest keep their words
  expect(Number(m![1])).toBeLessThanOrEqual(30000);
  // What is stored is unchanged; the session says what it did and keeps which results.
  expect(await stored()).toBe(before);
  const note = (await events(request, s.id)).findLast((e) => e.kind === "note" && e.data.kind === "results_short");
  expect(note.data.shortened).toBe(cut);
  expect((await settings(request, s.id)).results_short).toHaveLength(cut);
  // The next request carries the same shortened results from the start: no refusal, the same count.
  const again = await turn(request, s.id, "And now? script:byte-cap 30000");
  expect(/Shortened: (\d+)\. Attempt 1\./.exec(again)?.[1], again).toBe(String(cut));
  await request.delete(`/api/sessions/${s.id}`);
});
