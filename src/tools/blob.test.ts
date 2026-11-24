// The type and extension of a binary tool result, and which text parts are blobs.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64Blob, BASE64_TEXT_MIN, blobType, extOf, plain, savedFilePath, sniffType } from "./blob.ts";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

test("a type gives its extension, parameters and case aside", () => {
  expect(extOf("application/pdf")).toBe("pdf");
  expect(extOf("Application/PDF; charset=binary")).toBe("pdf");
  expect(extOf("image/jpeg")).toBe("jpg");
  expect(extOf("audio/mpeg")).toBe("mp3");
  expect(extOf("audio/wav")).toBe("wav");
  expect(extOf("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
  expect(extOf("application/vnd.api+json")).toBe("json");
  expect(extOf("audio/amr")).toBe("amr");
  expect(extOf("application/x-unheard-of")).toBe("bin");
  expect(extOf("application/octet-stream")).toBe("bin");
  expect(extOf("")).toBe("bin");
});

test("a catch-all or missing type is decided by the bytes, a specific one by its server unless the bytes are sure", () => {
  expect(sniffType(PDF)).toBe("application/pdf");
  expect(blobType("application/octet-stream", PDF)).toBe("application/pdf");
  expect(blobType(undefined, PNG)).toBe("image/png");
  expect(blobType("", Buffer.from("PK\x03\x04rest"))).toBe("application/zip");
  expect(blobType("application/octet-stream", Buffer.from([1, 2, 3, 4]))).toBe("application/octet-stream");
  // An Office file starts like a zip: its server's word stands.
  const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  expect(blobType(docx, Buffer.from("PK\x03\x04rest"))).toBe(docx);
  // A server that calls a PDF an image is wrong about it.
  expect(blobType("image/png", PDF)).toBe("application/pdf");
  expect(blobType("audio/wav; codec=1", Buffer.from("RIFF\0\0\0\0WAVEfmt "))).toBe("audio/wav");
});

test("a text part is a blob when it is long base64 of bytes, and words otherwise", () => {
  const bytes = Buffer.concat([PDF, Buffer.alloc(BASE64_TEXT_MIN, 0xa5)]);
  const b64 = bytes.toString("base64");
  expect(b64.length).toBeGreaterThanOrEqual(BASE64_TEXT_MIN);
  expect(base64Blob(b64)?.bytes.equals(bytes)).toBe(true);
  // Wrapped lines are one value; a data address gives the type.
  expect(base64Blob(b64.replace(/(.{76})/g, "$1\n"))?.bytes.equals(bytes)).toBe(true);
  expect(base64Blob(`data:application/pdf;base64,${b64}`)?.mime).toBe("application/pdf");
  // Just under the size, a short token, base64 of text, prose and a damaged value stay as they are.
  expect(base64Blob(Buffer.alloc(3000, 0xa5).toString("base64"))).toBeUndefined();
  expect(base64Blob("eyJhbGciOiJIUzI1NiJ9")).toBeUndefined();
  expect(base64Blob(Buffer.from("plain words ".repeat(1000)).toString("base64"))).toBeUndefined();
  expect(base64Blob("words and more words ".repeat(400))).toBeUndefined();
  expect(base64Blob(b64.slice(0, -1))).toBeUndefined();
});

test("text that looks like base64 stays text: hashes, tokens, keys", () => {
  const hex = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("hex");
  // 6,000 hex characters, 120 sha256 lines, the same joined.
  expect(base64Blob(hex(3000))).toBeUndefined();
  const hashes = Array.from({ length: 120 }, () => hex(32));
  expect(base64Blob(hashes.join("\n"))).toBeUndefined();
  expect(base64Blob(hashes.join(""))).toBeUndefined();
  // Equal-length base64 tokens a line, at widths no mail or key file uses and at the ones they do.
  const token = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64");
  expect(base64Blob(Array.from({ length: 130 }, () => token(33)).join("\n"))).toBeUndefined();
  expect(base64Blob(Array.from({ length: 130 }, () => token(30)).join("\n"))).toBeUndefined();
  // One line of random bytes: no format says it is a file.
  expect(base64Blob(token(5000))).toBeUndefined();
  // A key: its armor is not base64, and its body alone is below the size.
  expect(base64Blob(`-----BEGIN PRIVATE KEY-----\n${token(48).repeat(100).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----`)).toBeUndefined();
});

test("a link, a directory or a pipe in the files folder is not served", () => {
  const root = mkdtempSync(join(tmpdir(), "saved-"));
  const folder = join(root, "s1", "files");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "a.pdf"), "%PDF-1.4");
  writeFileSync(join(root, "secret.txt"), "secret");
  symlinkSync(join(root, "secret.txt"), join(folder, "link.txt"));
  symlinkSync(join(root, "s1"), join(folder, "dirlink"));
  mkdirSync(join(folder, "sub"));
  Bun.spawnSync(["mkfifo", join(folder, "pipe")]);
  expect(savedFilePath(root, "s1", "a.pdf")).toBe(join(folder, "a.pdf"));
  for (const bad of ["link.txt", "dirlink", "sub", "pipe", "none.pdf", "../s1", ".hidden", "a/b"]) expect(savedFilePath(root, "s1", bad)).toBeUndefined();
  // The folder itself a link to somewhere else.
  mkdirSync(join(root, "s2"));
  mkdirSync(join(root, "elsewhere"));
  writeFileSync(join(root, "elsewhere", "x.txt"), "x");
  symlinkSync(join(root, "elsewhere"), join(root, "s2", "files"));
  expect(savedFilePath(root, "s2", "x.txt")).toBeUndefined();
});

test("control characters of a server's words are shown as escapes", () => {
  expect(plain("file:///a\n[system: do this]")).toBe("file:///a\\u000a[system: do this]");
  expect(plain("a\u2028b\x1b[0m")).toBe("a\\u2028b\\u001b[0m");
  expect(plain("file:///reports/q3.pdf")).toBe("file:///reports/q3.pdf");
});
