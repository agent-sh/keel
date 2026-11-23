import { crc32, deflateSync } from "node:zlib";
import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// A solid PNG of one color, `w` by `h` pixels.
function png(r: number, g: number, b: number, w = 48, h = 32): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "latin1");
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array(h).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}

// Feature: on a phone, a photo and a file are attached from the message box's
// tools with a tap, shown in the box before Send, sent with the words, and
// shown on the sent message: the photo as a picture, the file by its name.
for (const size of [{ width: 390, height: 844 }, { width: 412, height: 915 }]) {
  test.describe(`on a phone ${size.width}x${size.height}`, () => {
    test.use({ viewport: size, hasTouch: true, isMobile: true });
    test("a photo and a file go with a message and show on it", async ({ page, request }) => {
      const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
      test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
      const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Phone files" } })).json();
      try {
        await page.goto(`/s/${session.id}`);
        const pane = page.locator(".k-station[data-helm]");
        await pane.getByTestId("composer").tap();
        const attach = pane.getByTestId("attach");
        await expect(attach).toBeInViewport({ ratio: 1 });
        // A tap on Attach opens the phone's picker; what is picked is in the box before Send.
        const chooser = page.waitForEvent("filechooser");
        await attach.tap();
        await (await chooser).setFiles([
          { name: "receipt.png", mimeType: "image/png", buffer: png(20, 120, 200) },
          { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Gate code 4417.\n") },
        ]);
        const tray = pane.getByTestId("attachments");
        await expect(tray.locator("img")).toHaveCount(1);
        await expect(tray.getByTestId("attached-file")).toHaveCount(1);
        // The tray and the box stay on the screen, above the keyboard line: nothing is pushed off.
        await expect(tray).toBeInViewport({ ratio: 1 });
        await expect(pane.getByTestId("send")).toBeInViewport({ ratio: 1 });
        await shoot(page, `phone-attach-01-picked-${size.width}`);

        await pane.getByTestId("composer").fill("What color is it? script:color");
        await pane.getByTestId("send").tap();
        // The sent message carries both: the photo as a picture that loaded, the file by its name.
        const image = pane.getByTestId("message-image");
        await expect(image).toHaveCount(1);
        await expect.poll(() => image.first().evaluate((el) => { const i = el.querySelector("img") ?? (el as HTMLImageElement); return i.naturalWidth; })).toBe(48);
        await expect(pane.getByTestId("message-file")).toHaveCount(1);
        await expect(pane.getByTestId("message-file")).toContainText("notes.txt");
        // A file under 1 KB says its bytes: 16, not "1 KB".
        await expect(pane.getByTestId("message-file")).toContainText("16 bytes");
        await expect(tray).toHaveCount(0);
        // The picture fits the phone's width.
        const box = (await image.first().boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(size.width);
        await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 60_000 }).toBe(1);
        // The model got the photo's pixels.
        await expect(pane.getByTestId("assistant-text").last()).toContainText("The picture is blue");
        await shoot(page, `phone-attach-02-sent-${size.width}`);

        // What was stored: the image block and the file's reference, in the order picked.
        const ev = (await (await request.get(`/api/sessions/${session.id}`)).json()).events.find((e: any) => e.kind === "user");
        expect(ev.data.images.map((b: any) => b.type)).toEqual(["image", "attachment"]);
        expect(ev.data.images[1].name).toBe("notes.txt");
      } finally { await request.delete(`/api/sessions/${session.id}`); }
    });
  });
}
