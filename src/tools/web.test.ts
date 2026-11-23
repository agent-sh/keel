// What WebFetch returns for a long page read for a request: the readers'
// answer with where the whole page is, also when a part went unread, and the
// page itself only when there is no answer (the fetch is a stand-in).
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchFor, webFetch } from "./web.ts";

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
