// Request and approval signatures of the phone app (Hermes Mobile API v1,
// signature_replay 2). Pure logic over WebCrypto, so it is unit tested.
//
// A request is signed over `METHOD\n<path?query>\n<ts>\n<sha256 hex of body>`
// with the device's request key; an approval or a revoke is signed with its
// separate approval key (biometric-bound on the phone). Signatures are ECDSA
// P-256 SHA-256 in DER, the Base64 must be canonical, the timestamp within five
// minutes, and each signature is claimed once: the claim identity hashes the
// scope, the verified key and the low-S form of the signature, so the (r, n-s)
// twin of a used signature is a replay too.

export const SKEW_SECS = 300;
export const REPLAY_VERSION = 2;

// P-256 group order.
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const HALF_N = N >> 1n;

export type ReplayStore = {
  // Claims `identity` until `expiresSecs`; true only for a fresh claim. May throw.
  claim(identity: string, expiresSecs: number): boolean;
};

export type SigCheck = "valid" | "rejected" | "store_unavailable";

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

// Standard Base64, refused unless re-encoding gives the same text (no
// whitespace, no URL-safe alphabet, no excess padding, no stray pad bits).
export function canonicalB64(value: string): Uint8Array<ArrayBuffer> | null {
  if (!value || value.length % 4 !== 0 || !B64.test(value)) return null;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.fromBase64(value);
  } catch {
    return null;
  }
  return bytes.toBase64() === value ? bytes : null;
}

export const sha256Hex = (data: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

export function canonicalMessage(method: string, rawPath: string, ts: string, body: Uint8Array | string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${method.toUpperCase()}\n${rawPath}\n${ts}\n${sha256Hex(body)}`);
}

// The approval message. Version 2 binds the answer text of a question.
export function approvalMessage(aid: string, choice: string, ts: string, v2: boolean, answer = ""): string {
  return v2 ? `approve2\n${aid}\n${choice}\n${sha256Hex(answer.trim())}\n${ts}` : `approve\n${aid}\n${choice}\n${ts}`;
}

// The answer text of a question card answered by question id: the [id, value]
// pairs in id order, as JSON. The approval signature covers its hash.
export const answersText = (byId: Record<string, unknown>) => JSON.stringify(Object.keys(byId).sort().map((k) => [k, byId[k]]));

export const revokeMessage = (deviceId: string, ts: string) => `revoke\n${deviceId}\n${ts}`;

export function tsWithinSkew(ts: string, nowSecs: number): number | null {
  if (!/^-?\d{1,15}$/.test(ts)) return null;
  const t = Number(ts);
  return Math.abs(nowSecs - t) <= SKEW_SECS ? t : null;
}

export type PublicKey = { key: CryptoKey; spki: Uint8Array };

// A P-256 SubjectPublicKeyInfo from canonical Base64. `spki` is the key's own
// re-encoding, so two spellings of one key are one principal.
export async function loadSpki(b64: string): Promise<PublicKey | null> {
  const der = canonicalB64(b64);
  if (!der) return null;
  try {
    const key = await crypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
    return { key, spki: new Uint8Array(await crypto.subtle.exportKey("spki", key)) };
  } catch {
    return null;
  }
}

// --- DER ECDSA signatures --------------------------------------------------------

function readInt(b: Uint8Array, at: number): { v: bigint; next: number } | null {
  if (b[at] !== 0x02) return null;
  const len = b[at + 1]!;
  if (len === undefined || len < 1 || len > 33 || at + 2 + len > b.length) return null;
  const body = b.subarray(at + 2, at + 2 + len);
  if (body[0]! & 0x80) return null; // negative
  if (len > 1 && body[0] === 0 && !(body[1]! & 0x80)) return null; // not minimal
  let v = 0n;
  for (const x of body) v = (v << 8n) | BigInt(x);
  return { v, next: at + 2 + len };
}

// Strict DER `SEQUENCE { INTEGER r, INTEGER s }` with both in [1, n-1].
export function parseDerSig(b: Uint8Array): { r: bigint; s: bigint } | null {
  if (b.length < 8 || b[0] !== 0x30 || b[1]! >= 0x80 || b[1]! + 2 !== b.length) return null;
  const r = readInt(b, 2);
  if (!r) return null;
  const s = readInt(b, r.next);
  if (!s || s.next !== b.length) return null;
  if (r.v < 1n || r.v >= N || s.v < 1n || s.v >= N) return null;
  return { r: r.v, s: s.v };
}

function intBytes(v: bigint): number[] {
  const out: number[] = [];
  while (v > 0n) { out.unshift(Number(v & 0xffn)); v >>= 8n; }
  if (out.length === 0 || out[0]! & 0x80) out.unshift(0);
  return out;
}

export function encodeDerSig(r: bigint, s: bigint): Uint8Array {
  const ri = intBytes(r), si = intBytes(s);
  const body = [0x02, ri.length, ...ri, 0x02, si.length, ...si];
  return new Uint8Array([0x30, body.length, ...body]);
}

const fixed32 = (v: bigint) => {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
};

export const lowS = (s: bigint) => (s > HALF_N ? N - s : s);

// Android keystores may sign with a high S; both forms verify, and both map to
// the one low-S identity.
export async function checkAndClaim(
  sigB64: string, pubB64: string, msg: Uint8Array<ArrayBuffer>, ts: string, scope: string, nowSecs: number, store: ReplayStore,
): Promise<SigCheck> {
  const t = tsWithinSkew(ts, nowSecs);
  if (t === null) return "rejected";
  const pub = await loadSpki(pubB64);
  if (!pub) return "rejected";
  const der = canonicalB64(sigB64);
  const sig = der && parseDerSig(der);
  if (!sig) return "rejected";
  const s = lowS(sig.s);
  const raw = new Uint8Array(64);
  raw.set(fixed32(sig.r), 0);
  raw.set(fixed32(s), 32);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub.key, raw, msg).catch(() => false);
  if (!ok) return "rejected";
  const id = new Bun.CryptoHasher("sha256")
    .update(scope).update(new Uint8Array([0])).update(pub.spki).update(encodeDerSig(sig.r, s))
    .digest("hex");
  try {
    return store.claim(id, t + SKEW_SECS) ? "valid" : "rejected";
  } catch {
    return "store_unavailable";
  }
}

// --- pairing rate limit -----------------------------------------------------------

export const PAIR_FAILURES_PER_SOURCE = 10;
export const PAIR_FAILURES_TOTAL = 200;
export const PAIR_WINDOW_SECS = 300;
const PAIR_SOURCES_MAX = 4096;

const isLoopback = (ip: string) => ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.");

// Who is asking. The socket peer is the only thing a caller cannot choose; only
// when the peer is this machine (a local tunnel) does the reported address count,
// and of X-Forwarded-For the last entry, the one the nearest proxy added.
export function requestSource(headers: Headers, peer: string | null): string {
  if (!peer) return "unknown";
  if (!isLoopback(peer)) return peer;
  for (const name of ["cf-connecting-ip", "x-real-ip"]) {
    const v = headers.get(name)?.trim();
    if (v) return v;
  }
  const last = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return last || peer;
}

// Failed pair codes per source and in total within the window.
export class PairLimiter {
  private hits = new Map<string, number[]>();

  blocked(source: string, now: number): boolean {
    let total = 0;
    for (const h of this.hits.values()) total += h.filter((t) => now - t < PAIR_WINDOW_SECS).length;
    if (total >= PAIR_FAILURES_TOTAL) return true;
    const mine = this.hits.get(source)?.filter((t) => now - t < PAIR_WINDOW_SECS);
    if (mine) this.hits.set(source, mine);
    return (mine?.length ?? 0) >= PAIR_FAILURES_PER_SOURCE;
  }

  fail(source: string, now: number) {
    for (const [k, h] of this.hits) {
      const live = h.filter((t) => now - t < PAIR_WINDOW_SECS);
      if (live.length) this.hits.set(k, live);
      else this.hits.delete(k);
    }
    if (this.hits.size >= PAIR_SOURCES_MAX && !this.hits.has(source)) {
      let oldest: string | undefined, at = Infinity;
      for (const [k, h] of this.hits) if ((h.at(-1) ?? 0) < at) { at = h.at(-1) ?? 0; oldest = k; }
      if (oldest) this.hits.delete(oldest);
    }
    this.hits.set(source, [...(this.hits.get(source) ?? []), now]);
  }
}
