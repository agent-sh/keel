// What WebFetch returns for a long page read for a request: the readers'
// answer with where the whole page is, also when a part went unread, and the
// page itself only when there is no answer (the fetch is a stand-in).
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetched, fetchFor, MARKUP_MAX, plainFetch, webFetch } from "./web.ts";
import { pdf, png } from "../../test/e2e/fixtures/files.ts";

test("a partial reader answer is kept, names the unread part and the saved page; no answer gives the page", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "webfetch-"));
  const page = "A line of the page that goes on for a while.\n".repeat(400);
  const fetch = async () => ({ text: page });
  const ctx = (read: any) => ({ spillDir: dir, signal: new AbortController().signal, read });
  try {
    const unread = ["https://docs.example/page:201-400 (every reader failed; last: throttled)"];
    const partial = await fetchFor("https://docs.example/page", "which header?", ctx(async () => ({ text: "The header is compact-2026-09-04.", model: "small", compiled: true, unread })), fetch as any);
    expect(partial.text).toStartWith("The header is compact-2026-09-04.\n\n[small read part of the page");
    expect(partial.text).toContain(`Not read, so not covered by this answer:\n- ${unread[0]}\n`);
    expect(partial.text).not.toContain("A line of the page");
    const saved = /The whole page is saved to (\S+);/.exec(partial.text)![1]!;
    expect(readFileSync(saved, "utf8")).toBe(page);
    // Every part read: the note says so plainly, as before.
    const whole = await fetchFor("https://docs.example/page", "which header?", ctx(async () => ({ text: "The header.", model: "small", compiled: true, unread: [] })), fetch as any);
    expect(whole.text).toMatch(/^The header\.\n\n\[small read the page \(\d+ chars\) for this request\. The whole page is saved to \S+; Read or Grep it when this does not answer\.\]$/);
    // No answer at all: the page follows as it is.
    const none = await fetchFor("https://docs.example/page", "which header?", ctx(async () => { throw new Error("no reader read it: throttled"); }), fetch as any);
    expect(none.text).toStartWith("[No reader could read the page for this request (no reader read it: throttled); the page follows as it is.]");
    expect(none.text).toContain("A line of the page");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The fetch CLI answers a page that is not there with its request echo and the
// raw markup: the model gets the status first and the page as text, and the
// failure reads as its status, not as the echo's first tag.
test("a page the fetch CLI got with an error status starts with the status and reads as text", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "webfetch-"));
  const html = `<!DOCTYPE html><html><head><title>Missing</title><script>var big = 1;</script></head><body><h1>Page not found</h1><p>Try the index.</p></body></html>`;
  const answer = {
    id: 1,
    result: {
      kind: "http_error",
      body_raw: html,
      output: `<request>\n  <url>https://docs.example/missing</url>\n  <status>404</status>\n</request>\n<body>\n${html}\n</body>\n(HTTP 404. Not Found. Retry or adjust the request per the body.)`,
      meta: { status: 404, content_type: "text/html; charset=utf-8", final_url: "https://docs.example/missing" },
    },
  };
  const bin = join(dir, "fetch-cli");
  writeFileSync(join(dir, "answer.json"), JSON.stringify(answer));
  writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\ncat ${JSON.stringify(join(dir, "answer.json"))}\n`);
  chmodSync(bin, 0o755);
  const before = process.env.KEEL_WEBFETCH_BIN;
  process.env.KEEL_WEBFETCH_BIN = bin;
  try {
    const r = await webFetch("https://docs.example/missing", { spillDir: dir, whole: true });
    expect(r.error).toBe(true);
    expect(r.text).toStartWith("HTTP 404\n\n");
    expect(r.text).toContain("# Page not found");
    expect(r.text).toContain("Try the index.");
    expect(r.text).not.toContain("<request>");
    expect(r.text).not.toContain("<script");
  } finally {
    if (before === undefined) delete process.env.KEEL_WEBFETCH_BIN; else process.env.KEEL_WEBFETCH_BIN = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

// A page is what its Content-Type and bytes say, not what its address ends in: a PDF served with no .pdf in its
// path is read as a PDF, an image comes as an image (its bytes never as text), any other binary is saved and named
// in one line, and a .pdf address that serves a web page is a page.
const PDF_TEXT = test.skipIf(!Bun.which("pdftotext"));
const body = (b: Uint8Array | string, type?: string, status = 200) => new Response(b as BodyInit, { status, headers: type ? { "content-type": type } : {} });
function files() {
  return Bun.serve({
    port: 0,
    fetch(req) {
      switch (new URL(req.url).pathname) {
        case "/doc": return body(pdf, "application/pdf");
        case "/blob": return body(pdf, "application/octet-stream");
        case "/notes.txt": return body(pdf, "text/plain");
        case "/report.pdf": return body("<html><body><h1>Not found</h1><p>No such report.</p></body></html>", "text/html; charset=utf-8", 404);
        case "/img": return body(png, "image/png");
        case "/file": return body(zip, "application/zip");
        case "/anon": return body(zip);
        case "/big": return body(new Uint8Array(MARKUP_MAX + 10), "application/octet-stream");
        default: return body("# A page\n\nSome words.\n", "text/markdown");
      }
    },
  });
}
const zip = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7) % 256))]);

PDF_TEXT("a PDF with no .pdf in its address, or a wrong type, is read as a PDF; a .pdf address that serves a page is a page", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "webfetch-"));
  const srv = files();
  const at = (p: string) => new URL(p, srv.url);
  try {
    for (const p of ["/doc", "/blob", "/notes.txt"]) {
      const r = await plainFetch(at(p), { spillDir: dir });
      expect(r.text, p).toContain("Quarterly page one");
      expect(r.text, p).toContain("Quarterly page two");
      const saved = /^PDF saved to (\S+\/files\/\S+\.pdf)\n/.exec(r.text)?.[1];
      expect(saved, p).toBeTruthy();
      expect(readFileSync(saved!).subarray(0, 5).toString()).toBe("%PDF-");
      expect(r.files?.[0]?.path).toBe(saved!);
      expect(r.images).toBeUndefined();
    }
    // The reader's whole-page mode gives the same text and counts it against the budget.
    const budget = { left: 1_000_000 };
    const whole = await plainFetch(at("/doc"), { spillDir: dir, whole: true, budget });
    expect(whole.text).toContain("Quarterly page two");
    expect(budget.left).toBeLessThan(1_000_000);
    // The address says PDF, the server says a page: it is a page.
    const page = await plainFetch(at("/report.pdf"), { spillDir: dir });
    expect(page.error).toBe(true);
    expect(page.text).toContain("HTTP 404");
    expect(page.text).toContain("# Not found");
    expect(page.files).toBeUndefined();
  } finally {
    srv.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an image comes as an image with its file, any other binary is saved and named in one line", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "webfetch-"));
  const srv = files();
  const at = (p: string) => new URL(p, srv.url);
  try {
    const img = await plainFetch(at("/img"), { spillDir: dir });
    expect(img.text).toMatch(/^\[image\/png, \d+ (bytes|KB), saved to \S+\/files\/\S+\.png\]$/);
    expect(img.images).toHaveLength(1);
    expect(img.images![0]).toMatchObject({ type: "image", media_type: "image/png", path: img.files![0]!.path });
    expect(Buffer.from(img.images![0]!.data, "base64").equals(png)).toBe(true);
    expect(readFileSync(img.files![0]!.path).equals(png)).toBe(true);
    expect(img.text).not.toContain("PNG");
    for (const p of ["/file", "/anon"]) {
      const r = await plainFetch(at(p), { spillDir: dir });
      expect(r.text, p).toMatch(new RegExp(`^\\[application/zip, ${zip.length} bytes, saved to \\S+/files/\\S+\\.zip\\]$`));
      expect(r.images).toBeUndefined();
      expect(readFileSync(r.files![0]!.path).equals(zip)).toBe(true);
    }
    // The tool's output carries the image beside its line, and the file for the transcript.
    const out = fetched(img);
    expect((out.content as any[]).map((b) => b.type)).toEqual(["text", "image"]);
    expect((out as any).shown.files[0].path).toBe(img.files![0]!.path);
    // Past the fetch program's own cap, nothing is kept.
    const big = await plainFetch(at("/big"), { spillDir: dir });
    expect(big.text).toBe("[application/octet-stream, larger than 10.0 MB, not saved; download it with curl in the shell]");
    expect(big.files).toBeUndefined();
    // A page stays a page.
    expect((await plainFetch(at("/"), { spillDir: dir })).text).toContain("# A page");
  } finally {
    srv.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file the fetch program refuses by its type is fetched here by its type and bytes", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "webfetch-"));
  const srv = files();
  const bin = join(dir, "fetch-cli");
  writeFileSync(join(dir, "answer.json"), JSON.stringify({ id: 1, result: { kind: "error", error: { code: "UNSUPPORTED_CONTENT_TYPE", message: "Content-type 'image/png' is not supported." } } }));
  writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\ncat ${JSON.stringify(join(dir, "answer.json"))}\n`);
  chmodSync(bin, 0o755);
  const before = process.env.KEEL_WEBFETCH_BIN, real = globalThis.fetch;
  process.env.KEEL_WEBFETCH_BIN = bin;
  // Names for the local server: the tool refuses a local address.
  globalThis.fetch = ((u: any, init?: any) => real(String(u).replace("https://files.example.test", srv.url.origin), init)) as typeof fetch;
  try {
    const r = await webFetch("https://files.example.test/img", { spillDir: dir });
    expect(r.text).toMatch(/^\[image\/png, \d+ (bytes|KB), saved to /);
    expect(r.images).toHaveLength(1);
  } finally {
    globalThis.fetch = real;
    if (before === undefined) delete process.env.KEEL_WEBFETCH_BIN; else process.env.KEEL_WEBFETCH_BIN = before;
    srv.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
