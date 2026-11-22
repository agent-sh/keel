// HTTP compression for the built daemon: the UI's bundles are compressed once
// and kept, JSON answers above a size threshold are compressed per request.
// Streams (SSE), WebSocket frames and already encoded bodies pass untouched.
//
// Measured on a 1.37 MB session GET (200 rounds of tool reads): zstd 3 gives
// 24% of the bytes in 3 ms, brotli 4 24% in 9 ms, gzip 4 26% in 15 ms, so a
// request gets the cheapest codec it accepts. Bundles take brotli 11 (29% of
// the main chunk, about 1 s of background work for all of them, once) and
// gzip 9 for the clients that send only gzip (browsers over plain http).
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { brotliCompress, brotliCompressSync, constants } from "node:zlib";

export type Enc = "zstd" | "br" | "gzip";

// A body under one TCP segment (about 1.4 KB) arrives in one packet either way:
// compressing it saves no round trip and costs CPU, so the floor sits below that.
export const MIN_BYTES = 1024;

// The first of `offered` (in server preference) that the Accept-Encoding header
// allows. `q=0` refuses a coding; `*` stands for every coding not named.
export function pick(accept: string | null, offered: readonly Enc[]): Enc | null {
  if (!accept) return null;
  const q = new Map<string, number>();
  for (const part of accept.toLowerCase().split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (!name) continue;
    const qp = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    q.set(name.trim(), qp ? Number(qp.slice(2)) || 0 : 1);
  }
  return offered.find((e) => (q.get(e) ?? q.get("*") ?? 0) > 0) ?? null;
}

const vary = (h: Headers) => {
  const v = h.get("vary");
  if (!v) h.set("vary", "Accept-Encoding");
  else if (!/accept-encoding|\*/i.test(v)) h.set("vary", `${v}, Accept-Encoding`);
};

const DYNAMIC: readonly Enc[] = ["zstd", "br", "gzip"];
// The coding a JSON answer to this request is compressed with, null for none.
export const codingOf = (req: Request): Enc | null => (req.method === "HEAD" ? null : pick(req.headers.get("accept-encoding"), DYNAMIC));
export const encode = (raw: Uint8Array<ArrayBuffer>, e: Enc) =>
  (e === "zstd" ? Bun.zstdCompressSync(raw, { level: 3 })
  : e === "br" ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
  : Bun.gzipSync(raw, { level: 4 })) as Uint8Array<ArrayBuffer>;

// A JSON answer at or above MIN_BYTES, compressed with the cheapest coding the
// request accepts. Anything else comes back as it was.
export async function compressJson(req: Request, res: Response): Promise<Response> {
  // A handler that upgraded the request to a WebSocket answers nothing.
  if (!res?.body || req.method === "HEAD" || res.headers.has("content-encoding")) return res;
  if (!(res.headers.get("content-type") ?? "").startsWith("application/json")) return res;
  const e = pick(req.headers.get("accept-encoding"), DYNAMIC);
  const headers = new Headers(res.headers);
  const init = () => ({ status: res.status, statusText: res.statusText, headers });
  if (!e) {
    // No coding to compress with: the answer goes as it is, its body unread
    // here. It still says that another request may get it encoded.
    try { vary(res.headers); return res; } catch {}
    // Headers that cannot be changed (an answer passed on from a fetch): the same body under a copy of them.
    vary(headers);
    return new Response(res.body, init());
  }
  const raw = new Uint8Array(await res.arrayBuffer());
  if (raw.length < MIN_BYTES) return new Response(raw, init());
  vary(headers);
  headers.set("content-encoding", e);
  headers.delete("content-length");
  return new Response(encode(raw, e), init());
}

// Types worth compressing; images and fonts come compressed already.
const TEXT = /^(text\/|application\/(javascript|json|manifest\+json|wasm)|image\/svg\+xml)/;

type Asset = { type: string; etag: string; cache: string; raw: Uint8Array<ArrayBuffer>; gzip?: Uint8Array<ArrayBuffer>; br?: Uint8Array<ArrayBuffer> };

// Every output file but the page is named by its content hash (/_ui/index-<hash>.js,
// /_ui/index-<hash>.css, at the address scripts/build.ts gives each file of the binary's
// page): it never changes under its name. The page is asked again each load (its etag
// makes that a 304), so a new build is picked up at once.
const IMMUTABLE = "public, max-age=31536000, immutable";
const PAGE = "no-cache";

function assetHandler(a: Asset) {
  return (req: Request) => {
    const e = a.gzip ? pick(req.headers.get("accept-encoding"), a.br ? ["br", "gzip"] : ["gzip"]) : null;
    const etag = `"${a.etag}${e ? `-${e}` : ""}"`;
    const headers: Record<string, string> = { "content-type": a.type, etag, "cache-control": a.cache };
    if (a.gzip) headers.vary = "Accept-Encoding";
    const inm = req.headers.get("if-none-match");
    if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return new Response(null, { status: 304, headers });
    if (e) headers["content-encoding"] = e;
    return new Response(e === "br" ? a.br! : e === "gzip" ? a.gzip! : a.raw, { headers });
  };
}

// Routes serving a bundle built ahead of time (the compiled binary): the HTML at
// each of `pages`, every output file at its path under the bundle's root. Gzip
// is made at once (tens of ms for all files); brotli runs in the background and
// is served once ready (a failure is reported and gzip stays). `undefined` when the bundle was not built ahead (the dev
// server bundles on request, with HMR, and serves the files itself).
// One file served from memory: gzip made at once, brotli in the background (a
// failure is reported and gzip stays). `src` is a path or the bytes themselves.
export function fileRoute(src: string | Uint8Array, type: string, etag: string, cache = IMMUTABLE, onError: (e: Error) => void = () => {}) {
  const raw = typeof src === "string" ? new Uint8Array(readFileSync(src)) : new Uint8Array(src);
  const a: Asset = { type, etag, cache, raw };
  if (TEXT.test(type) && raw.length >= MIN_BYTES) {
    a.gzip = Bun.gzipSync(raw, { level: 9 });
    brotliCompress(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }, (err, out) => {
      if (err) onError(err);
      else a.br = new Uint8Array(out);
    });
  }
  return assetHandler(a);
}

// Routes serving a bundle built ahead of time (the compiled binary): the HTML at
// each of `pages` (with `stampPage` applied), every output file at its path under the bundle's root.
// `undefined` when the bundle was not built ahead (the dev
// server bundles on request, with HMR, and serves the files itself).
export function bundleRoutes(bundle: Bun.HTMLBundle, pages: string[], onError: (e: Error) => void, stampPage: (html: string) => string = (h) => h): Record<string, (req: Request) => Response> | undefined {
  if (!bundle.files?.length) return undefined;
  const root = dirname(bundle.index);
  const routes: Record<string, (req: Request) => Response> = {};
  for (const f of bundle.files) {
    if (f.path === bundle.index) continue;
    // The binary's page names the address of each file (scripts/build.ts); Bun's own bundle serves it at its path.
    routes[(f as { route?: string }).route ?? f.path.slice(root.length)] = fileRoute(f.path, f.headers["content-type"], f.headers.etag, IMMUTABLE, onError);
  }
  const html = bundle.files.find((f) => f.path === bundle.index);
  const text = stampPage(readFileSync(bundle.index, "utf8"));
  const page = fileRoute(new TextEncoder().encode(text), html?.headers["content-type"] ?? "text/html;charset=utf-8", String(Bun.hash(text)), PAGE, onError);
  for (const p of pages) routes[p] = page;
  return routes;
}
