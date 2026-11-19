// The portal's proxy: a dev server's answers made to stay inside the portal,
// and its WebSockets (hot reload) passed through both ways. The same pieces
// serve a session of this daemon and, over a paired link, one of another.
import { timingSafeEqual } from "node:crypto";
import { registerSocket } from "../server/app.ts";
import { redirectTo, rewriteCode, rewriteHtml } from "./portal.ts";

const OPEN_MS = 10_000; // a dev server that does not take the socket in 10 s is down

// Headers a dev server never gets from the portal: the owner's credentials for
// keel, where the page came from, and what only the hop itself means.
const DROP_UP = ["authorization", "origin", "referer", "host", "accept-encoding", "connection", "x-keel-link", "x-keel-nonce"];
const DROP_DOWN = ["x-frame-options", "content-security-policy", "content-length", "content-encoding", "transfer-encoding", "location", "access-control-allow-origin"];

export function upHeaders(req: Request): Headers {
  const h = new Headers(req.headers);
  for (const k of DROP_UP) h.delete(k);
  // Sec-Fetch-* describe the browser's hop to this daemon; carried over a link
  // they make the far daemon's request guard refuse the page's own assets.
  for (const k of [...h.keys()]) if (k.startsWith("sec-websocket") || k.startsWith("sec-fetch-") || k === "upgrade") h.delete(k);
  return h;
}

// What the dev server on this machine answers, as it is. Throws when it does not answer.
export async function upstream(req: Request, port: number, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/${path}`, {
    method: req.method, headers: upHeaders(req), redirect: "manual",
    body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer(),
  });
}

// The answer the page gets: sandboxed, never framed elsewhere, redirects and
// root-relative URLs kept inside the portal.
export async function present(r: Response, port: number, prefix: string, point: boolean): Promise<Response> {
  const out = new Headers();
  r.headers.forEach((v, k) => { if (!DROP_DOWN.includes(k) && !k.startsWith("x-keel-")) out.append(k, v); });
  out.set("content-security-policy", "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads; frame-ancestors 'self'");
  out.set("x-content-type-options", "nosniff");
  out.set("access-control-allow-origin", "*"); // the sandboxed page's own origin is opaque
  const loc = r.headers.get("location");
  if (loc) { const to = redirectTo(loc, port, prefix); if (to) out.set("location", to); }
  const type = r.headers.get("content-type") ?? "";
  if (/text\/html/.test(type)) {
    out.set("cache-control", "no-store"); // the injected scripts depend on the picker being on
    return new Response(rewriteHtml(await r.text(), prefix, point), { status: r.status, headers: out });
  }
  if (/javascript|ecmascript|text\/css/.test(type)) return new Response(rewriteCode(await r.text(), prefix), { status: r.status, headers: out });
  return new Response(r.body, { status: r.status, headers: out });
}

export const isUpgrade = (req: Request) => req.headers.get("upgrade")?.toLowerCase() === "websocket";

// ---- WebSocket passthrough

type Data = { kind: "portal"; up: WebSocket; pending: (string | ArrayBuffer)[]; hello?: string; client?: Bun.ServerWebSocket<Data> };

// A close code a socket may send: what the other side closed with when it is
// one, else a normal close.
const sendable = (code: number) => (code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000);

registerSocket("portal", {
  open(ws: Bun.ServerWebSocket<Data>) {
    const d = ws.data;
    d.client = ws;
    if (d.hello) ws.send(d.hello);
    for (const m of d.pending.splice(0)) ws.send(m);
    if (d.up.readyState >= WebSocket.CLOSING) ws.close(1000, "the dev server closed the socket");
  },
  message(ws: Bun.ServerWebSocket<Data>, m) {
    const up = ws.data.up;
    if (up.readyState === WebSocket.OPEN) up.send(m as any);
  },
  close(ws: Bun.ServerWebSocket<Data>, code, reason) {
    const up = ws.data.up;
    if (up.readyState <= WebSocket.OPEN) up.close(sendable(code), reason);
  },
});

// Opens the socket to `target` first (so the page gets the protocol the dev
// server chose, and a refused socket is a refused upgrade), then upgrades the
// page's request. `verify` checks the first frame before anything passes (a
// paired daemon's proof); `hello` is a frame the page side gets first.
export async function bridge(
  req: Request,
  srv: Bun.Server<unknown>,
  target: string,
  opts: { headers?: Record<string, string>; verify?: (first: string) => boolean; hello?: string } = {},
): Promise<Response | undefined> {
  const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const headers: Record<string, string> = { ...opts.headers };
  for (const k of ["cookie", "user-agent"]) { const v = req.headers.get(k); if (v) headers[k] = v; }
  const up = new WebSocket(target, { protocols, headers } as any);
  up.binaryType = "arraybuffer";
  const data: Data = { kind: "portal", up, pending: [], hello: opts.hello };
  let verified = !opts.verify;
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no socket within ${OPEN_MS / 1000} s`)), OPEN_MS);
    up.onopen = () => { if (verified) { clearTimeout(timer); resolve(); } };
    up.onerror = () => { clearTimeout(timer); reject(new Error("the socket was refused")); };
    up.onclose = (e) => {
      clearTimeout(timer);
      reject(new Error(`the socket closed (${e.code})`));
      data.client?.close(sendable(e.code), e.reason);
    };
    up.onmessage = (e) => {
      if (!verified) {
        if (typeof e.data === "string" && opts.verify!(e.data)) { verified = true; clearTimeout(timer); resolve(); }
        else { clearTimeout(timer); reject(new Error("the far daemon did not prove the pairing")); up.close(); }
        return;
      }
      if (data.client) data.client.send(e.data);
      else data.pending.push(e.data);
    };
  });
  try {
    await ready;
  } catch (e) {
    try { up.close(); } catch {}
    return Response.json({ error: `the dev server's socket: ${(e as Error).message}` }, { status: 502 });
  }
  if (srv.upgrade(req, { data, headers: up.protocol ? { "sec-websocket-protocol": up.protocol } : undefined })) return undefined;
  up.close();
  return Response.json({ error: "websocket upgrade failed" }, { status: 400 });
}

export const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
