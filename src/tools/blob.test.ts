// The type and extension of a binary tool result, and which text parts are blobs.
import { expect, test } from "bun:test";
import { base64Blob, BASE64_TEXT_MIN, blobType, extOf, sniffType } from "./blob.ts";

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
