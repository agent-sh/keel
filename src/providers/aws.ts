// The two AWS pieces Bedrock needs, without the AWS SDK: SigV4 request signing
// (for access-key credentials) and the binary event-stream framing of
// invoke-with-response-stream, turned into the Anthropic SSE events it carries.
import { createHash, createHmac } from "node:crypto";
import { ProviderError } from "./http.ts";
import type { SseEvent } from "./sse.ts";

export type AwsCreds = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const hmac = (k: string | Buffer, s: string) => createHmac("sha256", k).update(s).digest();
// RFC 3986 escaping, as SigV4 wants it.
const esc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Headers that sign one request. `url` is the final URL (its path already
// escaped once); SigV4 escapes each path segment again for every service but S3.
export function sigv4(o: {
  method: string; url: string; body: string; headers?: Record<string, string>;
  region: string; service: string; creds: AwsCreds; now?: Date;
}): Record<string, string> {
  const u = new URL(o.url);
  const amzDate = (o.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const h: Record<string, string> = { ...Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: u.host, "x-amz-date": amzDate };
  if (o.creds.sessionToken) h["x-amz-security-token"] = o.creds.sessionToken;
  const names = Object.keys(h).sort();
  const path = u.pathname.split("/").map((seg) => esc(seg)).join("/") || "/";
  const query = [...u.searchParams].map(([k, v]) => [esc(k), esc(v)]).sort(([a, x], [b, y]) => (a! < b! ? -1 : a! > b! ? 1 : x! < y! ? -1 : x! > y! ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [o.method, path, query, ...names.map((n) => `${n}:${h[n]}`), "", names.join(";"), sha256(o.body)].join("\n");
  const scope = `${day}/${o.region}/${o.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${o.creds.secretAccessKey}`, day), o.region), o.service), "aws4_request");
  const sig = createHmac("sha256", key).update(toSign).digest("hex");
  const out: Record<string, string> = { "x-amz-date": amzDate, authorization: `AWS4-HMAC-SHA256 Credential=${o.creds.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}` };
  if (o.creds.sessionToken) out["x-amz-security-token"] = o.creds.sessionToken;
  return out;
}

// What a passing Bedrock stream exception means for the retry logic.
function exceptionKind(type: string): ProviderError["kind"] {
  if (/throttl|toomanyrequests/i.test(type)) return "rate";
  if (/serviceunavailable/i.test(type)) return "overloaded";
  if (/internalserver|modelstreamerror|modeltimeout/i.test(type)) return "server";
  if (/accessdenied|unrecognizedclient|expiredtoken/i.test(type)) return "auth";
  return "invalid";
}

// application/vnd.amazon.eventstream: frames of
// [total u32][headers u32][prelude crc u32][headers][payload][crc u32].
// TLS already guards the bytes, so the CRCs are not checked.
export class EventStreamDecoder {
  private buf = new Uint8Array(0);
  private text = new TextDecoder();

  push(bytes: Uint8Array | string): SseEvent[] {
    const add = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    const next = new Uint8Array(this.buf.length + add.length);
    next.set(this.buf);
    next.set(add, this.buf.length);
    this.buf = next;
    const out: SseEvent[] = [];
    while (this.buf.length >= 12) {
      const v = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const total = v.getUint32(0);
      if (total < 16 || total > 24 * 1024 * 1024) throw new Error("event stream decode error: bad frame length");
      if (this.buf.length < total) break;
      const hlen = v.getUint32(4);
      const headers = this.headers(this.buf.subarray(12, 12 + hlen));
      const payload = this.text.decode(this.buf.subarray(12 + hlen, total - 4));
      this.buf = this.buf.slice(total);
      const ev = this.frame(headers, payload);
      if (ev) out.push(ev);
    }
    return out;
  }

  finish(): SseEvent[] {
    return [];
  }

  private headers(b: Uint8Array): Record<string, string> {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out: Record<string, string> = {};
    for (let i = 0; i < b.length; ) {
      const n = b[i]!;
      const name = this.text.decode(b.subarray(i + 1, i + 1 + n));
      i += 1 + n;
      const type = b[i++]!;
      // Only string values (7) matter here; the others are skipped by size.
      const fixed: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };
      if (type === 6 || type === 7) {
        const len = v.getUint16(i);
        if (type === 7) out[name] = this.text.decode(b.subarray(i + 2, i + 2 + len));
        i += 2 + len;
      } else if (type in fixed) i += fixed[type]!;
      else throw new Error("event stream decode error: bad header type");
    }
    return out;
  }

  private frame(h: Record<string, string>, payload: string): SseEvent | null {
    const kind = h[":message-type"] ?? "event";
    if (kind === "exception") {
      const type = h[":exception-type"] ?? "exception";
      let msg = payload;
      try { msg = JSON.parse(payload).message ?? payload; } catch {}
      throw new ProviderError(/too long|too many tokens|context/i.test(msg) && type === "validationException" ? "context" : exceptionKind(type), `Bedrock: ${type}: ${msg}`);
    }
    if (kind === "error") throw new ProviderError(exceptionKind(h[":error-code"] ?? ""), `Bedrock: ${h[":error-code"] ?? "error"}: ${h[":error-message"] ?? payload}`);
    if (h[":event-type"] !== "chunk") return null;
    const b64 = JSON.parse(payload).bytes;
    if (typeof b64 !== "string") return null;
    const data = Buffer.from(b64, "base64").toString("utf8");
    const type = JSON.parse(data)?.type;
    // A frame with no event type (a gateway keep-alive) carries nothing.
    return typeof type === "string" ? { event: type, data } : null;
  }
}
