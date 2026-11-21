import { expect, test } from "./isolate.ts";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { HAIKU, ask, shoot, tabInto } from "./shots.ts";

// A one-page PDF with one line of text, offsets computed so readers accept it.
function pdf(line: string): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${`BT /F1 18 Tf 72 700 Td (${line}) Tj ET`.length} >>\nstream\nBT /F1 18 Tf 72 700 Td (${line}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const at: number[] = [];
  objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// A solid square PNG of one color, 32 pixels a side unless told.
function png(r: number, g: number, b: number, side = 32): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "latin1");
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(side, 0); ihdr.writeUInt32BE(side, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: side }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array(side).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}

// Feature: files other than images attach to a prompt: a text file goes
// inline, a PDF as a document to a model that reads PDFs, anything else as a
// note with the saved path. They show on the prompt and can be downloaded.
test("text, PDF and other files attached to a prompt", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);

  await page.getByTestId("attach-input").setInputFiles([
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("The meeting room is Orchid-7.\n") },
    { name: "budget.pdf", mimeType: "application/pdf", buffer: pdf("Budget code: KX-913") },
    { name: "blob.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 1, 2, 3, 0, 255]) },
  ]);
  await expect(page.getByTestId("attached-file")).toHaveCount(3);
  await shoot(page, "attach-01-composer");

  const composer = page.getByTestId("composer");
  await composer.fill(ask("From my attached files: what is the meeting room, what is the budget code, and where is blob.bin saved? One short line each, no tools.", "script:find Orchid-7 KX-913 attachments/"));
  await composer.press("Enter");
  await expect(page.getByTestId("message-file")).toHaveCount(3);
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 90_000 });
  const reply = page.getByTestId("assistant-text").last();
  await expect(reply).toContainText("Orchid-7");
  await expect(reply).toContainText("KX-913");
  await expect(reply).toContainText("attachments/");
  await shoot(page, "attach-02-answered");

  // The prompt keeps only references; the file comes back from the store.
  const ev = (await (await request.get(`/api/sessions/${session.id}`)).json()).events.find((e: any) => e.kind === "user");
  const refs = ev.data.images.filter((b: any) => b.type === "attachment");
  expect(refs.map((r: any) => r.name)).toEqual(["notes.txt", "budget.pdf", "blob.bin"]);
  const got = await request.get(`/api/attachments/${refs[0].id}`);
  expect(await got.text()).toContain("Orchid-7");
  expect(got.headers()["content-disposition"]).toContain("notes.txt");
  expect((await request.post("/api/attachments?name=empty.txt", { data: Buffer.alloc(0) })).status()).toBe(400);

  // A picture and the files stay with their message through a compaction:
  // the checkpoint keeps them, so the next request still carries the pixels.
  await page.getByTestId("attach-input").setInputFiles([{ name: "swatch.png", mimeType: "image/png", buffer: png(0, 170, 60) }]);
  await composer.fill("Keep this picture in mind. Reply with only the word kept.");
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 90_000 });
  await composer.fill("/compact");
  await composer.press("Enter");
  await expect(page.getByTestId("compacted")).toBeVisible({ timeout: 90_000 });
  const cp = (await (await request.get(`/api/sessions/${session.id}`)).json()).events.find((e: any) => e.kind === "compaction");
  expect(cp.data.owner_media.flat().map((b: any) => b.type)).toEqual(["attachment", "attachment", "attachment", "image"]);
  await composer.fill(ask("What single color fills the picture I sent? One word.", "script:color"));
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(3, { timeout: 90_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText(/green/i);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// What the chosen model does with an attachment is said before Send: a model
// that reads no images holds a new screenshot (nothing starts, the draft
// stays); one whose listing says nothing sends it and says that is unverified.
test("attachments: the model's image and PDF support before Send", async ({ page, request }) => {
  const ids = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!ids.includes("scripted:stand-in-text"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in-text", title: "Text-only model" } })).json();
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("attach-input").setInputFiles([
    { name: "shot.png", mimeType: "image/png", buffer: png(200, 40, 40) },
    { name: "brief.pdf", mimeType: "application/pdf", buffer: pdf("Brief") },
  ]);
  const line = page.getByTestId("attach-capability");
  await expect(line).toContainText("Screenshot will not be sent: Scripted text only does not read images");
  await expect(line).toContainText("PDF support unverified; the file goes as a saved path, not inline");
  const composer = page.getByTestId("composer");
  await composer.fill("What does this show?");
  await composer.press("Enter");
  await expect(page.getByTestId("composer-notice")).toContainText("remove the screenshot to send the text alone");
  await expect(composer).toHaveValue("What does this show?");
  await expect(page.getByTestId("attachments").locator("img")).toHaveCount(1);
  await shoot(page, "attach-03-text-only-held");
  expect((await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "user")).toHaveLength(0);

  // On a model whose listing says nothing about images: sent, and said to be unverified.
  await page.getByTestId("model-picker").click();
  await page.getByPlaceholder("Search models").fill("scripted:stand-in");
  await page.locator('[data-group="exact"] [data-testid="model-option"]').click();
  await expect(line).toContainText("Image support unverified; the screenshot will be sent");
  await expect(page.getByTestId("attachments").locator("img")).toHaveCount(1);
  await request.delete(`/api/sessions/${session.id}`);
});

// Files and images keep the order they were attached in, on the prompt as in
// what the model reads, and a prompt sent without words has no made-up words.
test("mixed attachments keep their order and need no caption", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in" } })).json();
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("attach-input").setInputFiles([
    { name: "a.png", mimeType: "image/png", buffer: png(200, 40, 40, 400) },
    { name: "b.txt", mimeType: "text/plain", buffer: Buffer.from("file b\n") },
    { name: "c.png", mimeType: "image/png", buffer: png(40, 40, 200) },
    { name: "d.txt", mimeType: "text/plain", buffer: Buffer.from("file d\n") },
  ]);
  await expect(page.getByTestId("attachments").locator(":scope > div")).toHaveCount(4);
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
  const ev = (await (await request.get(`/api/sessions/${session.id}`)).json()).events.find((e: any) => e.kind === "user");
  expect(ev.data.text).toBe("");
  const stored = ev.data.images.map((b: any) => (b.type === "attachment" ? b.name : "image"));
  expect(stored).toEqual(["image", "b.txt", "image", "d.txt"]);
  const row = page.getByTestId("user-message").first();
  const shown = await row.locator('[data-testid="message-file"], [data-testid="message-image"]').evaluateAll((els) => els.map((el) => (el.tagName === "IMG" ? "image" : el.textContent!.replace(/\d+ KB$/, "").trim())));
  expect(shown).toEqual(stored);
  // A sent image is a control of its own: Tab reaches it by name, Enter and
  // Space change its size and say so, the focus stays, the order is the same.
  const preview = row.getByRole("button", { name: "Attached image 1" });
  const height = async () => (await preview.locator("img").boundingBox())!.height;
  await expect(preview).toBeVisible();
  await tabInto(page, preview);
  await expect(preview).toBeFocused();
  await expect(preview).toHaveAttribute("aria-expanded", "false");
  const small = await height();
  await page.keyboard.press("Enter");
  await expect(preview).toHaveAttribute("aria-expanded", "true");
  await expect(preview).toBeFocused();
  await expect.poll(height).toBeGreaterThan(small + 200);
  // Its ring is outside the image, like any other control's, and whole: the
  // strip above the image changes with the focus. The pointer says which way the size goes.
  await expect(preview).toHaveCSS("outline-offset", "2px");
  await expect(preview).toHaveCSS("cursor", "zoom-out");
  const above = async () => { const r = (await preview.boundingBox())!; return (await page.screenshot({ clip: { x: r.x + 20, y: r.y - 4, width: r.width - 40, height: 3 } })).toString("base64"); };
  const ringed = await above();
  await preview.evaluate((b: HTMLElement) => b.blur());
  expect(await above()).not.toBe(ringed);
  await preview.focus();
  expect(await above()).toBe(ringed);
  await shoot(page, "attach-06-image-larger-by-keyboard");
  await page.keyboard.press("Space");
  await expect(preview).toHaveAttribute("aria-expanded", "false");
  await expect(preview).toBeFocused();
  await expect.poll(height).toBe(small);
  await expect(preview).toHaveCSS("cursor", "zoom-in");
  expect(await row.locator('[data-testid="message-file"], [data-testid="message-image"]').evaluateAll((els) => els.map((el) => (el.tagName === "IMG" ? "image" : el.textContent!.replace(/\d+ KB$/, "").trim())))).toEqual(stored);
  // No caption, no bubble; a caption that reads like a placeholder is the owner's and shows.
  await expect(row.locator(".bg-accent-soft")).toHaveCount(0);
  await page.getByTestId("attach-input").setInputFiles([{ name: "e.png", mimeType: "image/png", buffer: png(40, 200, 40) }]);
  await page.getByTestId("composer").fill("(image)");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("user-message").last()).toContainText("(image)");
  await shoot(page, "attach-05-mixed-order");
  await request.delete(`/api/sessions/${session.id}`);
});

// A file keeps its own name in any script, on the prompt and as a download;
// the same bytes under two names download under the name each prompt gave;
// a plain-text file without an extension downloads as text.
test("attachment names and types survive upload and download", async ({ request }) => {
  const up = async (name: string, body: string, type = "text/plain") =>
    (await (await request.post(`/api/attachments?name=${encodeURIComponent(name)}`, { headers: { "content-type": type }, data: Buffer.from(body) })).json());
  const contract = await up("חוזה.txt", "a");
  const flat = await up("דירה.txt", "b");
  expect([contract.name, flat.name]).toEqual(["חוזה.txt", "דירה.txt"]);
  const dl = (ref: any) => request.get(`/api/attachments/${ref.id}?name=${encodeURIComponent(ref.name)}&type=${encodeURIComponent(ref.media_type)}`);
  const c = await dl(contract);
  expect(await c.text()).toBe("a");
  expect(c.headers()["content-disposition"]).toContain(`filename*=UTF-8''${encodeURIComponent("חוזה.txt")}`);
  const stamp = Date.now().toString(36);
  const budget = await up(`budget-${stamp}.txt`, `same bytes ${stamp}`);
  const release = await up(`release-${stamp}.txt`, `same bytes ${stamp}`);
  expect(budget.id).toBe(release.id);
  expect((await dl(budget)).headers()["content-disposition"]).toContain(`budget-${stamp}.txt`);
  expect((await dl(release)).headers()["content-disposition"]).toContain(`release-${stamp}.txt`);
  const runbook = await up(`RUNBOOK${stamp}`, "step one\n");
  expect((await dl(runbook)).headers()["content-type"]).toBe("text/plain;charset=utf-8");
  const blob = await up(`blob${stamp}`, "\u0000\u0001binary", "application/octet-stream");
  expect((await dl(blob)).headers()["content-type"]).toBe("application/octet-stream");

  // A large file whose name gives its type comes back byte for byte, with the
  // same headers as a small one, sent from the disk: a range of it is answered
  // with that range alone (only a file-backed answer is).
  const bytes = Buffer.alloc(12 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i += 4) bytes.writeUInt32LE((i * 2654435761 + stamp.length) >>> 0, i);
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const big = await (await request.post(`/api/attachments?name=${encodeURIComponent(`scan ${stamp}.pdf`)}`, { headers: { "content-type": "application/pdf" }, data: bytes })).json();
  expect([big.id, big.size]).toEqual([sha(bytes), bytes.length]);
  const whole = await dl(big);
  expect(whole.status()).toBe(200);
  expect(sha(await whole.body())).toBe(big.id);
  const { date: _, ...headers } = whole.headers();
  expect(headers).toEqual({
    "content-type": "application/pdf",
    "content-length": String(bytes.length),
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "content-disposition": `attachment; filename="scan ${stamp}.pdf"; filename*=UTF-8''${encodeURIComponent(`scan ${stamp}.pdf`)}`,
  });
  const part = await request.get(`/api/attachments/${big.id}?name=x.pdf`, { headers: { range: "bytes=5000000-5000099" } });
  expect(part.status()).toBe(206);
  expect(part.headers()["content-range"]).toBe(`bytes 5000000-5000099/${bytes.length}`);
  expect((await part.body()).equals(bytes.subarray(5_000_000, 5_000_100))).toBe(true);
  // An image is shown in place: no download name, as before.
  const pic = await (await request.post(`/api/attachments?name=${encodeURIComponent(`dot ${stamp}.png`)}`, { headers: { "content-type": "image/png" }, data: png(1, 2, 3) })).json();
  const shown = await dl(pic);
  expect(shown.headers()["content-type"]).toBe("image/png");
  expect(shown.headers()["content-disposition"]).toBeUndefined();
  expect((await shown.body()).equals(png(1, 2, 3))).toBe(true);
});

// Feature: an upload goes to the disk as it arrives, hashed on the way, and is
// put in place whole. A body sent in chunks with no declared length is stored
// like any other; one past the cap is refused where it passes it, and one cut
// off on its way is dropped, both with no part and no file left behind. The
// same bytes sent at once under two names are one stored file, each reference
// with its own name and type.
test("uploads stream to the store: the cap, a cut upload and the same bytes at once", async ({ request, baseURL }) => {
  const { state_dir } = await (await request.get("/api/daemon")).json();
  const root = join(state_dir, "attachments");
  const parts = () => (existsSync(join(root, ".tmp")) ? readdirSync(join(root, ".tmp")) : []);
  const stored = () => readdirSync(root).filter((d) => d !== ".tmp").sort();
  const MB = 1024 * 1024;
  const block = Buffer.alloc(MB);
  const stamp = Date.now();
  for (let i = 0; i < MB; i += 4) block.writeUInt32LE((i * 2654435761 + stamp) >>> 0, i);
  // `n` megabytes in chunks, with no content-length; `cut`: the connection is dropped after that many.
  const chunked = (n: number, name: string, cut?: number) => {
    let sent = 0;
    const ac = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (sent === cut) return ac.abort();
        if (sent++ === n) return c.close();
        c.enqueue(block);
      },
    });
    return fetch(`${baseURL}/api/attachments?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body, duplex: "half", signal: ac.signal } as RequestInit);
  };
  const sha = createHash("sha256");
  for (let i = 0; i < 6; i++) sha.update(block);
  const six = await chunked(6, `six-${stamp}.bin`);
  expect(six.status).toBe(201);
  const ref = await six.json();
  expect([ref.id, ref.size, ref.name]).toEqual([sha.digest("hex"), 6 * MB, `six-${stamp}.bin`]);
  expect(statSync(join(root, ref.id, `six-${stamp}.bin`)).size).toBe(6 * MB);
  const before = stored();

  // Past the cap with no length declared: refused there, the rest not read.
  const over = await chunked(40, `over-${stamp}.bin`);
  expect(over.status).toBe(413);
  expect((await over.json()).error).toBe("a file can be at most 20 MiB");
  // A length declared past the cap is refused before a byte is read.
  expect((await request.post("/api/attachments?name=declared.bin", { headers: { "content-type": "application/octet-stream" }, data: Buffer.alloc(21 * MB) })).status()).toBe(413);
  expect((await request.post("/api/attachments?name=none.txt", { headers: { "content-type": "text/plain" }, data: Buffer.alloc(0) })).status()).toBe(400);
  // Cut off after three megabytes.
  await expect(chunked(8, `cut-${stamp}.bin`, 3)).rejects.toThrow();
  await expect.poll(parts, { timeout: 15_000 }).toEqual([]);
  expect(stored()).toEqual(before);

  // The same bytes at once, under two names and types.
  const same = Buffer.from(`the same bytes ${stamp}`);
  const up = (name: string, type: string) => request.post(`/api/attachments?name=${encodeURIComponent(name)}`, { headers: { "content-type": type }, data: same }).then((r) => r.json());
  const [a, b, c] = await Promise.all([up(`budget-${stamp}.txt`, "text/plain; charset=utf-8"), up(`release-${stamp}.md`, "text/markdown"), up(`budget-${stamp}.txt`, "text/plain")]);
  expect([a.id, b.id, c.id]).toEqual([a.id, a.id, a.id]);
  expect([a, b, c].map((r) => [r.name, r.media_type, r.size, r.charset])).toEqual([
    [`budget-${stamp}.txt`, "text/plain", same.length, "utf-8"], [`release-${stamp}.md`, "text/markdown", same.length, undefined], [`budget-${stamp}.txt`, "text/plain", same.length, undefined],
  ]);
  expect(readdirSync(join(root, a.id))).toHaveLength(1);
  for (const r of [a, b]) {
    const dl = await request.get(`/api/attachments/${r.id}?name=${encodeURIComponent(r.name)}&type=${encodeURIComponent(r.media_type)}`);
    expect((await dl.body()).equals(same)).toBe(true);
    expect(dl.headers()["content-disposition"]).toContain(r.name);
  }
  expect(parts()).toEqual([]);
  const errs = (await (await request.get("/api/errors?resolved=0")).json()).errors as { message: string; ts?: number; last_ms?: number }[];
  expect(errs.filter((e) => (e.last_ms ?? e.ts ?? 0) >= stamp).map((e) => e.message)).toEqual([]);
});
