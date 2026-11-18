// Links between daemons. A link is paired once (`POST /api/fleet/pair` hands the
// linking daemon a secret); every later request carries `x-keel-link: <id> <key>`
// and a fresh nonce, and every answer proves the pairing with
// `x-keel-proof: hex(HMAC-SHA256(key, "<nonce>|<answering daemon id>"))`.
// A daemon that answers without the right proof, or with another id, is not taken.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export const CONNECT_MS = 5_000; // a link that does not connect in 5 s is down
export const READ_MS = 10_000; // a stalled answer: the bound a machine gets to answer a ping

export const proof = (key: string, nonce: string, daemonId: string) =>
  createHmac("sha256", key).update(`${nonce}|${daemonId}`).digest("hex");

export const newKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export type Peer = { url: string; myId: string; key: string; daemonId: string };

export class LinkError extends Error {}

// One request over a paired link. Never follows a redirect; checks the proof.
export async function linkFetch(p: Peer, path: string, init: RequestInit & { timeout?: number } = {}): Promise<Response> {
  const nonce = Bun.randomUUIDv7();
  const headers = new Headers(init.headers);
  headers.set("x-keel-link", `${p.myId} ${p.key}`);
  headers.set("x-keel-nonce", nonce);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(init.timeout ?? READ_MS)]) : AbortSignal.timeout(init.timeout ?? READ_MS);
  let r: Response;
  try {
    r = await fetch(p.url.replace(/\/$/, "") + path, { ...init, headers, signal, redirect: "manual" });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? `no answer within ${(init.timeout ?? READ_MS) / 1000} s` : (e as Error).message;
    throw new LinkError(`cannot reach ${p.url}: ${msg}`);
  }
  const got = r.headers.get("x-keel-proof") ?? "";
  if (!same(got, proof(p.key, nonce, p.daemonId))) {
    throw new LinkError(r.headers.get("x-keel-daemon") && r.headers.get("x-keel-daemon") !== p.daemonId
      ? `another daemon answers at ${p.url} (${r.headers.get("x-keel-daemon")})`
      : `the daemon at ${p.url} did not prove the pairing (HTTP ${r.status})`);
  }
  return r;
}

export async function linkJson<T = any>(p: Peer, path: string, init: RequestInit & { timeout?: number } = {}): Promise<T> {
  const r = await linkFetch(p, path, init);
  const body = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new LinkError(body.error ?? `HTTP ${r.status}`);
  return body as T;
}

// The serving side: which paired daemon (if any) a request comes from, and the
// headers that prove the answer.
export type Caller = { daemonId: string; key: string; nonce: string };

export function callerOf(req: Request, keyOf: (daemonId: string) => string | undefined): Caller | null {
  const [id, key] = (req.headers.get("x-keel-link") ?? "").split(" ");
  const nonce = req.headers.get("x-keel-nonce") ?? "";
  if (!id || !key || !nonce) return null;
  const want = keyOf(id);
  return want && same(want, key) ? { daemonId: id, key: want, nonce } : null;
}

export function proven(res: Response, c: Caller | null, myId: string): Response {
  const h = new Headers(res.headers);
  h.set("x-keel-daemon", myId);
  if (c) h.set("x-keel-proof", proof(c.key, c.nonce, myId));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// The uids listening on a loopback TCP port, from /proc. Null where there is no /proc.
export function listenerUids(port: number): number[] | null {
  const want = `:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  let found = false;
  const out: number[] = [];
  for (const t of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try { text = readFileSync(t, "utf8"); } catch { continue; }
    found = true;
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[3] === "0A" && f[1]?.endsWith(want)) out.push(Number(f[7]));
    }
  }
  return found ? out : null;
}

// A daemon URL is taken only on a loopback address over http: the far daemon
// trusts loopback callers of its own user, and nothing leaves the machine.
export function loopbackUrl(u: string): URL | null {
  try {
    const url = new URL(u);
    if (url.protocol !== "http:") return null;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

export function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port!;
  s.stop(true);
  return p;
}
