// What WebFetch returns for a long page read for a request: the readers'
// answer with where the whole page is, also when a part went unread, and the
// page itself only when there is no answer (the fetch is a stand-in).
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinnedFetch } from "./pinned.ts";
import { setEgressSink } from "../safety/egress.ts";
import { fetched, fetchFor, MARKUP_MAX, plainFetch, webFetch } from "./web.ts";
import { pdf, png } from "../../test/e2e/fixtures/files.ts";
import { nameLocal, PUBLIC } from "../../test/e2e/fixtures/local-names.ts";

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
const HOST = "files.example.test";
const PDF_TEXT = test.skipIf(!Bun.which("pdftotext"));
const body = (b: Uint8Array | string, type?: string, status = 200) => new Response(b as BodyInit, { status, headers: type ? { "content-type": type } : {} });
// What the server was asked: the method, the path and the address the tool connected to.
const seen: string[] = [];
function files() {
  return Bun.serve({
    port: 0,
    fetch(req) {
      seen.push(`${req.method} ${new URL(req.url).pathname} ${req.headers.get("x-pinned-to")}`);
      switch (new URL(req.url).pathname) {
        case "/lie": return body("<html><body>an admin page</body></html>", "image/png");
        case "/hop": return new Response(null, { status: 302, headers: { location: "/img" } });
        case "/away": return new Response(null, { status: 302, headers: { location: "https://other.example.test/file" } });
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
  // (The tool refuses a local address: the server has a public name.)
  const restore = nameLocal(HOST, srv.url.origin);
  const at = (p: string) => new URL(p, `https://${HOST}`);
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
    restore();
    srv.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an image comes as an image with its file, any other binary is saved and named in one line", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "webfetch-"));
  const srv = files();
  // (The tool refuses a local address: the server has a public name.)
  const restore = nameLocal(HOST, srv.url.origin);
  const at = (p: string) => new URL(p, `https://${HOST}`);
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
    restore();
    srv.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

// The fetch program refuses a file by its type; the second request is made here.
function refusing(dir: string, code = "UNSUPPORTED_CONTENT_TYPE") {
  const bin = join(dir, "fetch-cli");
  writeFileSync(join(dir, "answer.json"), JSON.stringify({ id: 1, result: { kind: "error", error: { code, message: "Content-type 'image/png' is not supported." } } }));
  writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\ncat ${JSON.stringify(join(dir, "answer.json"))}\n`);
  chmodSync(bin, 0o755);
  const before = process.env.KEEL_WEBFETCH_BIN;
  process.env.KEEL_WEBFETCH_BIN = bin;
  return () => { if (before === undefined) delete process.env.KEEL_WEBFETCH_BIN; else process.env.KEEL_WEBFETCH_BIN = before; };
}
// What the ledger was told: the rows of the requests the tool made.
function ledger() {
  const rows: any[] = [];
  setEgressSink((o) => rows.push(o));
  return { rows, stop: () => setEgressSink(undefined as any) };
}
async function scene(run: (c: { dir: string; srv: ReturnType<typeof files>; answers: string[]; led: ReturnType<typeof ledger> }) => Promise<void>) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "webfetch-"));
  const srv = files();
  const answers = [PUBLIC];
  const restore = nameLocal(HOST, srv.url.origin, () => answers);
  const unrefuse = refusing(dir);
  const led = ledger();
  seen.length = 0;
  try { await run({ dir, srv, answers, led }); } finally {
    led.stop();
    unrefuse();
    restore();
    srv.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a file the fetch program refuses by its type is fetched here by its type and bytes, to the address that was vetted, and the ledger has a row for it", () => scene(async ({ dir, led }) => {
  const r = await webFetch(`https://${HOST}/img`, { spillDir: dir });
  expect(r.text).toMatch(/^\[image\/png, \d+ (bytes|KB), saved to /);
  expect(r.images).toHaveLength(1);
  expect(seen).toEqual([`GET /img ${PUBLIC}`]);
  // The helper's row, and the row of the second request, under the name and not the address.
  expect(led.rows.filter((x) => x.via === "web fetch").map((x) => [x.host, x.port, x.outcome, x.status])).toEqual([[HOST, 443, "sent", 200]]);
  expect(led.rows.some((x) => x.via === "fetch helper")).toBe(true);
}));

test("a name that resolves inside is refused, whatever its other addresses are, and nothing is sent", () => scene(async ({ dir, answers, led }) => {
  for (const inside of ["127.0.0.1", "10.0.0.8", "169.254.169.254", "::1", "::ffff:192.168.1.5"]) {
    answers.splice(0, answers.length, PUBLIC, inside);
    const r = await webFetch(`https://${HOST}/img`, { spillDir: dir });
    expect(r.error, inside).toBe(true);
    expect(r.text, inside).toContain("resolves to a local or private address");
    expect(r.files, inside).toBeUndefined();
  }
  expect(seen).toEqual([]);
  expect(led.rows.filter((x) => x.via === "web fetch").map((x) => x.outcome)).toEqual(Array(5).fill("refused"));
}));

test("the name is looked up once for a request, and the request goes to the address that was vetted", () => scene(async ({ dir, answers }) => {
  // A name that answers differently the second time: the first answer is the one used.
  let asks = 0;
  const first = ["93.184.216.35"];
  answers.splice(0, answers.length, ...first);
  const lookup = (await import("node:dns/promises")).default.lookup;
  (await import("node:dns/promises")).default.lookup = (async (n: string, ...rest: any[]) => { if (n === HOST) asks++; const r = await (lookup as any)(n, ...rest); if (n === HOST && asks === 1) answers.splice(0, answers.length, "127.0.0.1"); return r; }) as any;
  try {
    const r = await webFetch(`https://${HOST}/img`, { spillDir: dir });
    expect(r.images).toHaveLength(1);
    expect(asks).toBe(1);
    expect(seen).toEqual([`GET /img ${first[0]}`]);
  } finally {
    (await import("node:dns/promises")).default.lookup = lookup;
  }
}));

test("a redirect on the same host is vetted as a request of its own", () => scene(async ({ dir, answers }) => {
  const r1 = await webFetch(`https://${HOST}/hop`, { spillDir: dir });
  expect(r1.text).toStartWith(`Final URL: https://${HOST}/img\n\n[image/png`);
  expect(seen).toEqual([`GET /hop ${PUBLIC}`, `GET /img ${PUBLIC}`]);
  // The name moves inside between the first answer and the hop.
  seen.length = 0;
  const dns = (await import("node:dns/promises")).default, lookup = dns.lookup;
  let asks = 0;
  dns.lookup = (async (n: string, ...rest: any[]) => (n === HOST && ++asks === 2 ? [{ address: "127.0.0.1", family: 4 }] : (lookup as any)(n, ...rest))) as any;
  try {
    const r2 = await webFetch(`https://${HOST}/hop`, { spillDir: dir });
    expect(r2.error).toBe(true);
    expect(r2.text).toContain("resolves to a local or private address");
    expect(seen).toEqual([`GET /hop ${PUBLIC}`]);
  } finally { dns.lookup = lookup; }
  void answers;
}));

test("the second request is made only for a read: a request with a method or a body is answered with the program's refusal", () => scene(async ({ dir }) => {
  for (const o of [{ method: "POST", body: "a=1" }, { method: "PUT" }, { method: "DELETE" }, { body: "a=1" }]) {
    const r = await webFetch(`https://${HOST}/img`, { spillDir: dir, ...o });
    expect(r.error, JSON.stringify(o)).toBe(true);
    expect(r.text).toContain("is not supported");
  }
  expect(seen).toEqual([]);
  const head = await webFetch(`https://${HOST}/img`, { spillDir: dir, method: "HEAD" });
  expect(seen).toEqual([`HEAD /img ${PUBLIC}`]);
  void head;
}));

test("a file behind a redirect to another host says where it is", () => scene(async ({ dir }) => {
  const r = await webFetch(`https://${HOST}/away`, { spillDir: dir });
  expect(r.text).toBe(`https://${HOST}/away is a file the fetch program does not read, and it is served after a redirect to another host: https://other.example.test/file\nFetch that address in a call of its own to read or save the file.`);
  expect(r.files).toBeUndefined();
}));

test("a page served as an image type that is not an image is saved as a file and named, never sent as an image", () => scene(async ({ dir }) => {
  const r = await webFetch(`https://${HOST}/lie`, { spillDir: dir });
  expect(r.images).toBeUndefined();
  expect(r.text).toMatch(/^\[application\/octet-stream, \d+ bytes, saved to \S+\/files\/\S+\.bin\]$/);
  expect(r.files).toHaveLength(1);
}));

// The transport itself: the request goes to the address it is given, the name is the Host header and the name the
// certificate is checked against, and the name is never looked up.
test.skipIf(!Bun.which("openssl"))("a pinned request connects to the given address and checks the certificate against the name", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "webfetch-"));
  const name = "pinned.example.test";
  const run = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name}`], { stderr: "ignore" });
  expect(run.exitCode).toBe(0);
  const cert = readFileSync(join(dir, "c.pem"), "utf8");
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { key: Bun.file(join(dir, "k.pem")), cert: Bun.file(join(dir, "c.pem")) }, fetch: (req) => new Response(`host=${req.headers.get("host")}`) });
  try {
    const ok = await pinnedFetch(new URL(`https://${name}:${srv.port}/x`), "127.0.0.1", {}, { ca: cert });
    expect(await ok.text()).toBe(`host=${name}:${srv.port}`);
    // A model's own Host header does not replace the name's.
    const own = await pinnedFetch(new URL(`https://${name}:${srv.port}/x`), "127.0.0.1", { headers: { Host: "elsewhere.test" } }, { ca: cert });
    expect(await own.text()).toBe(`host=${name}:${srv.port}`);
    // The address answers to a certificate for another name: refused.
    await expect(pinnedFetch(new URL(`https://other.example.test:${srv.port}/x`), "127.0.0.1", {}, { ca: cert })).rejects.toThrow();
  } finally {
    srv.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
