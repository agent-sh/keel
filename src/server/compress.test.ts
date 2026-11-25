import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { ASYNC_BYTES, bundleRoutes, compressJson, encodeAsync, MIN_BYTES, pick } from "./compress.ts";

const req = (ae: string | null, extra: Record<string, string> = {}) => new Request("http://x/", { headers: { ...(ae ? { "accept-encoding": ae } : {}), ...extra } });
const big = { events: Array.from({ length: 200 }, (_, i) => ({ i, text: "the handler records the failure once" })) };

test("pick follows server preference within what the request allows", () => {
  expect(pick("gzip, deflate, br, zstd", ["zstd", "br", "gzip"])).toBe("zstd");
  expect(pick("gzip, deflate", ["zstd", "br", "gzip"])).toBe("gzip");
  expect(pick("zstd;q=0, br;q=0.5, gzip", ["zstd", "br", "gzip"])).toBe("br");
  expect(pick("*", ["br", "gzip"])).toBe("br");
  expect(pick("identity", ["gzip"])).toBeNull();
  expect(pick(null, ["gzip"])).toBeNull();
});

test("JSON above the floor is compressed, small JSON and streams pass", async () => {
  const r = await compressJson(req("gzip, deflate"), Response.json(big));
  expect(r.headers.get("content-encoding")).toBe("gzip");
  expect(r.headers.get("vary")).toBe("Accept-Encoding");
  expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await r.arrayBuffer()))))).toEqual(big);

  const z = await compressJson(req("gzip, br, zstd"), Response.json(big));
  expect(z.headers.get("content-encoding")).toBe("zstd");

  const small = await compressJson(req("gzip"), Response.json({ ok: true }));
  expect(small.headers.get("content-encoding")).toBeNull();
  expect(await small.json()).toEqual({ ok: true });

  const sse = new Response("data: x\n\n", { headers: { "content-type": "text/event-stream" } });
  expect(await compressJson(req("gzip"), sse)).toBe(sse);
  const done = new Response(Bun.gzipSync(JSON.stringify(big)), { headers: { "content-type": "application/json", "content-encoding": "gzip" } });
  expect(await compressJson(req("zstd"), done)).toBe(done);
});

// A JSON body that counts how often it is read: nothing is pulled before a reader asks.
function counted(data: unknown, status = 200) {
  const body = new TextEncoder().encode(JSON.stringify(data));
  const read = { pulls: 0 };
  const stream = new ReadableStream<Uint8Array>({ pull(c) { read.pulls++; c.enqueue(body); c.close(); } }, { highWaterMark: 0 });
  return { read, res: new Response(stream, { status, headers: { "content-type": "application/json;charset=utf-8", "x-keel": "kept" } }) };
}

test("a request that accepts no coding the daemon has gets the answer unread", async () => {
  for (const ae of ["identity", "deflate, compress", "gzip;q=0, br;q=0, zstd;q=0", null]) {
    const { read, res } = counted(big, 201);
    const out = await compressJson(req(ae), res);
    // Not read inside the wrapper: the body goes to the client as the handler made it.
    expect([ae, read.pulls, res.bodyUsed]).toEqual([ae, 0, false]);
    expect(out.status).toBe(201);
    expect(out.headers.get("content-encoding")).toBeNull();
    expect(out.headers.get("vary")).toBe("Accept-Encoding");
    expect(out.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(out.headers.get("x-keel")).toBe("kept");
    expect(await out.json()).toEqual(big);
    expect(read.pulls).toBe(1);
  }
  // A Vary the handler set is kept and added to.
  const own = Response.json(big, { headers: { vary: "Cookie" } });
  expect((await compressJson(req("identity"), own)).headers.get("vary")).toBe("Cookie, Accept-Encoding");
  // The codings the daemon has still read and encode it.
  for (const [ae, coding] of [["gzip", "gzip"], ["br", "br"], ["zstd, br, gzip", "zstd"]] as const) {
    const { read, res } = counted(big, 201);
    const out = await compressJson(req(ae), res);
    expect([ae, read.pulls, out.status, out.headers.get("content-encoding"), out.headers.get("vary"), out.headers.get("x-keel")]).toEqual([ae, 1, 201, coding, "Accept-Encoding", "kept"]);
    const bytes = new Uint8Array(await out.arrayBuffer());
    const plain = coding === "gzip" ? Bun.gunzipSync(bytes) : coding === "br" ? brotliDecompressSync(bytes) : Bun.zstdDecompressSync(bytes);
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual(big);
  }
});

test("a built bundle is served precompressed, with per-coding ETags and 304s", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-compress-"));
  const js = "export const a = 1;\n".repeat(MIN_BYTES);
  writeFileSync(join(dir, "index.html"), "<!doctype html><script src=/chunk-a.js></script>");
  writeFileSync(join(dir, "chunk-a.js"), js);
  const file = (n: string, type: string) => ({ path: join(dir, n), loader: "js" as const, isEntry: false, headers: { etag: n, "content-type": type } });
  const routes = bundleRoutes({ index: join(dir, "index.html"), files: [file("index.html", "text/html"), file("chunk-a.js", "text/javascript")] }, ["/", "/s/:id"], (e) => { throw e; })!;
  expect(Object.keys(routes).sort()).toEqual(["/", "/chunk-a.js", "/s/:id"]);

  const r = routes["/chunk-a.js"]!(req("gzip, deflate"));
  expect(r.headers.get("content-encoding")).toBe("gzip");
  expect(r.headers.get("vary")).toBe("Accept-Encoding");
  expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await r.arrayBuffer())))).toBe(js);
  expect(routes["/chunk-a.js"]!(req("gzip", { "if-none-match": r.headers.get("etag")! })).status).toBe(304);
  expect(routes["/chunk-a.js"]!(req(null)).headers.get("content-encoding")).toBeNull();
  // The hashed file is cached for good, the page is asked again each load.
  expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(routes["/"]!(req("gzip")).headers.get("cache-control")).toBe("no-cache");
  // The tiny page is served as it is.
  expect(await routes["/s/:id"]!(req("gzip")).text()).toContain("<!doctype html>");

  // The binary's page names where each file is served (scripts/build.ts embeds them under other names).
  const named = bundleRoutes({ index: join(dir, "index.html"), files: [file("index.html", "text/html"), { ...file("chunk-a.js", "text/javascript"), route: "/_ui/chunk-a.js" }] } as any, ["/"], (e) => { throw e; })!;
  expect(Object.keys(named).sort()).toEqual(["/", "/_ui/chunk-a.js"]);

  expect(bundleRoutes({ index: join(dir, "index.html") }, ["/"], () => {})).toBeUndefined();
  rmSync(dir, { recursive: true });
});

// A big body is compressed on the thread pool: the loop runs other callbacks meanwhile, and the bytes are the same coding.
test("a big JSON answer is compressed off the loop under every coding", async () => {
  let seed = 7;
  const text = Array.from({ length: 120_000 }, () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 99_991).toString(36)).join(" ");
  const raw = new TextEncoder().encode(JSON.stringify({ text })) as Uint8Array<ArrayBuffer>;
  expect(raw.length).toBeGreaterThan(ASYNC_BYTES);
  const read = { gzip: Bun.gunzipSync, br: brotliDecompressSync, zstd: Bun.zstdDecompressSync } as const;
  for (const e of ["gzip", "br", "zstd"] as const) {
    let ran = false;
    const p = encodeAsync(raw, e);
    setImmediate(() => { ran = true; });
    const packed = await p;
    expect(ran).toBe(true);
    expect(new TextDecoder().decode(read[e](packed))).toBe(new TextDecoder().decode(raw));
  }
  // Under the floor it is made at once, as before.
  const small = new TextEncoder().encode(JSON.stringify(big)) as Uint8Array<ArrayBuffer>;
  expect(Bun.gunzipSync(await encodeAsync(small, "gzip")).length).toBe(small.length);
});
