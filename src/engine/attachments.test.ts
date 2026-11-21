// What an attached file becomes in the request: UTF-16 text reads as the same
// characters as UTF-8, a binary file stays out, a PDF's note says what is known.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "../core/types.ts";
import { existsSync, readdirSync, readFileSync, statSync, utimesSync, mkdirSync } from "node:fs";
import { ATTACHMENT_MAX, attachmentPath, resolveAttachments, saveAttachment, saveAttachmentStream, setAttachmentsRoot } from "./attachments.ts";

const STATE = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "keel-att-"));
setAttachmentsRoot(STATE);
const LINE = "Status: מוכן 🌍";

const utf16 = (s: string, be: boolean) => {
  const out = new Uint8Array(2 + s.length * 2);
  out.set(be ? [0xfe, 0xff] : [0xff, 0xfe]);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + i * 2] = be ? c >> 8 : c & 0xff;
    out[3 + i * 2] = be ? c & 0xff : c >> 8;
  }
  return out;
};

const sent = (bytes: Uint8Array, type: string, info = { name: "M" } as { name: string; pdf?: boolean }, charset?: string) => {
  const a = saveAttachment(bytes, "status.txt", type, charset);
  const m: Message[] = [{ role: "user", content: [a] }];
  return (resolveAttachments(m, info)[0]!.content[0] as any).text as string;
};

test("UTF-16 text in either byte order is inlined as the same characters as UTF-8", () => {
  const want = sent(new TextEncoder().encode(LINE), "text/plain");
  expect(want).toContain(LINE);
  for (const be of [false, true]) {
    const got = sent(utf16(LINE, be), "text/plain");
    expect(got.replace(/path="[^"]+"/, "")).toBe(want.replace(/path="[^"]+"/, ""));
  }
  // A declared charset without a mark is read too.
  expect(sent(utf16(LINE, false).subarray(2), "text/plain", undefined, "UTF-16LE")).toContain(LINE);
  // A binary file stays out of the prompt.
  const bin = sent(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]), "application/octet-stream");
  expect(bin).toContain("it is not text");
});

test("a PDF the listing says nothing about is unverified, not unsupported", () => {
  const pdf = new TextEncoder().encode("%PDF-1.4 fixture");
  const a = saveAttachment(pdf, "B.pdf", "application/pdf");
  const note = (info: { name: string; pdf?: boolean }) => JSON.stringify(resolveAttachments([{ role: "user", content: [a] }], info));
  expect(note({ name: "M" })).toContain("PDF support of M is unverified");
  expect(note({ name: "M", pdf: false })).toContain("M does not read PDFs");
  expect(note({ name: "M", pdf: true })).toContain('"type":"document"');
});

// An upload as a stream of chunks, where a page cannot time it: what is on the
// disk when each chunk is asked for, and what is left after a refusal.
const ROOT = join(STATE, "attachments");
const parts = () => (existsSync(join(ROOT, ".tmp")) ? readdirSync(join(ROOT, ".tmp")) : []);
const published = () => readdirSync(ROOT).filter((d) => d !== ".tmp");
const partBytes = () => parts().reduce((n, d) => n + readdirSync(join(ROOT, ".tmp", d)).reduce((m, f) => m + statSync(join(ROOT, ".tmp", d, f)).size, 0), 0);

test("an upload is hashed and written chunk by chunk, never held whole", async () => {
  // One megabyte, sent again and again: the source allocates nothing more, and
  // every chunk before the one asked for is on the disk already.
  const chunk = new Uint8Array(1024 * 1024);
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31) & 0xff;
  const n = 12;
  const onDisk: number[] = [];
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      onDisk.push(partBytes());
      if (sent === n) return c.close();
      sent++;
      c.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  const ref = await saveAttachmentStream(body, "big.bin", "application/octet-stream");
  expect(onDisk).toEqual(Array.from({ length: n + 1 }, (_, i) => i * chunk.length));
  const whole = new Bun.CryptoHasher("sha256");
  for (let i = 0; i < n; i++) whole.update(chunk);
  expect(ref).toEqual({ type: "attachment", id: whole.digest("hex"), name: "big.bin", media_type: "application/octet-stream", size: n * chunk.length });
  expect(statSync(attachmentPath(ref.id)!).size).toBe(n * chunk.length);
  expect(parts()).toEqual([]);
});

test("a body past the cap, an empty one and one cut off leave nothing on the disk", async () => {
  const before = published();
  const chunk = new Uint8Array(1024 * 1024).fill(7);
  // No declared length: refused where it passes the cap, and not read further.
  let pulled = 0, cancelled = false;
  const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(chunk); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  await expect(saveAttachmentStream(endless, "huge.bin", "application/octet-stream")).rejects.toMatchObject({ status: 413, message: "a file can be at most 20 MiB" });
  expect([pulled, cancelled]).toEqual([ATTACHMENT_MAX / chunk.length + 1, true]);
  // A connection that drops after three chunks.
  let n = 0;
  const cut = new ReadableStream<Uint8Array>({ pull(c) { if (n++ < 3) c.enqueue(chunk); else c.error(new Error("socket closed")); } }, { highWaterMark: 0 });
  await expect(saveAttachmentStream(cut, "cut.bin", "application/octet-stream")).rejects.toMatchObject({ status: 400, message: "the upload was cut off before its end" });
  await expect(saveAttachmentStream(new ReadableStream({ start: (c) => c.close() }), "none.txt", "text/plain")).rejects.toMatchObject({ status: 400, message: "the file is empty" });
  expect(parts()).toEqual([]);
  expect(published()).toEqual(before);
});

test("the same bytes sent at once under two names are one stored file, each with its own name and type", async () => {
  const bytes = new TextEncoder().encode(`same bytes ${Date.now()}`);
  const stream = (step: number) => new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < bytes.length; i += step) c.enqueue(bytes.subarray(i, i + step)); c.close(); } });
  const [a, b, c] = await Promise.all([
    saveAttachmentStream(stream(3), "budget.txt", "text/plain", "utf-8"),
    saveAttachmentStream(stream(5), "release.md", "text/markdown"),
    Promise.resolve().then(() => saveAttachment(bytes, "חוזה.txt", "text/plain")),
  ]);
  expect([a.id, b.id, c.id]).toEqual([a.id, a.id, a.id]);
  expect([a, b, c].map((r) => [r.name, r.media_type, r.size, r.charset])).toEqual([["budget.txt", "text/plain", bytes.length, "utf-8"], ["release.md", "text/markdown", bytes.length, undefined], ["חוזה.txt", "text/plain", bytes.length, undefined]]);
  expect(readdirSync(join(ROOT, a.id))).toHaveLength(1);
  expect(readFileSync(attachmentPath(a.id)!).equals(Buffer.from(bytes))).toBe(true);
  expect(parts()).toEqual([]);
});

test("a part a daemon left behind goes at a later start, a young one stays", () => {
  const old = join(ROOT, ".tmp", "left-behind"), young = join(ROOT, ".tmp", "under-way");
  for (const d of [old, young]) mkdirSync(d, { recursive: true });
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
  utimesSync(old, twoHoursAgo, twoHoursAgo);
  setAttachmentsRoot(STATE);
  expect(parts()).toEqual(["under-way"]);
});
