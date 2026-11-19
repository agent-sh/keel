import { expect, test } from "@playwright/test";
import { HAIKU, shoot } from "./shots.ts";

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
  await composer.fill("From my attached files: what is the meeting room, what is the budget code, and where is blob.bin saved? One short line each, no tools.");
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

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
