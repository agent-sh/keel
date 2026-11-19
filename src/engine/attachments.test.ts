// What an attached file becomes in the request: UTF-16 text reads as the same
// characters as UTF-8, a binary file stays out, a PDF's note says what is known.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "../core/types.ts";
import { resolveAttachments, saveAttachment, setAttachmentsRoot } from "./attachments.ts";

setAttachmentsRoot(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "keel-att-")));
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
