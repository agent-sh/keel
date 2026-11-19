import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleRoutes, compressJson, MIN_BYTES, pick } from "./compress.ts";

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

  expect(bundleRoutes({ index: join(dir, "index.html") }, ["/"], () => {})).toBeUndefined();
  rmSync(dir, { recursive: true });
});
