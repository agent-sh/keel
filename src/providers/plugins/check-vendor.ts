// The fake vendor `keel plugin check` points a plugin at (protocol v1,
// "Conformance"): HTTP/1.1 with keep-alive on loopback. It finds the fixture of
// each request by the marker `[keel-check <fixture> <nonce>]` in the body,
// answers only a request that carries the fake credential in a header value,
// writes every answer in pieces of 7 bytes with no delay, and compresses it with
// gzip when the request accepts gzip.
import type { Socket } from "bun";

export const PIECE = 7;

export type Answer =
  | { kind: "bytes"; status: number; headers: [string, string][]; body: Uint8Array }
  // `first`, then `keepalive` each second until the connection closes or `release()`.
  | { kind: "hold"; first: Uint8Array; keepalive: Uint8Array; contentType: string; release: Promise<void> }
  // Held until `barrier.n` requests of the barrier are open (at most 20 s).
  | { kind: "barrier"; barrier: Barrier; answer: Answer };

export class Barrier {
  open = 0;
  maxOpen = 0;
  private waiters: (() => void)[] = [];
  constructor(readonly n: number) {}
  arrive(): Promise<void> {
    this.open++;
    this.maxOpen = Math.max(this.maxOpen, this.open);
    if (this.open >= this.n) { this.waiters.splice(0).forEach((w) => w()); return Promise.resolve(); }
    return new Promise((res) => {
      this.waiters.push(res);
      setTimeout(res, 20_000);
    });
  }
}

export type Recorded = {
  marker?: string;
  target: string;
  headers: [string, string][];
  body: Uint8Array; // after decoding a gzip request body
  credentialInHeader: boolean;
  credentialInUrl: boolean;
  credentialInBody: boolean;
  closed: boolean; // the plugin closed the connection while the answer was held
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function find(h: Uint8Array, n: Uint8Array, from = 0): number {
  outer: for (let i = from; i + n.length <= h.length; i++) {
    for (let j = 0; j < n.length; j++) if (h[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

export function markerIn(body: Uint8Array): string | undefined {
  const s = find(body, enc.encode("[keel-check "));
  if (s < 0) return undefined;
  const e = body.indexOf(0x5d, s);
  return e < 0 ? undefined : dec.decode(body.slice(s, e + 1));
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

const REASON: Record<number, string> = { 200: "OK", 401: "Unauthorized", 404: "Not Found", 429: "Too Many Requests", 500: "Internal Server Error" };
const chunk = (b: Uint8Array) => concat([enc.encode(`${b.length.toString(16)}\r\n`), b, enc.encode("\r\n")]);

// One connection: its read buffer, a write queue that sends 7-byte pieces one
// event-loop turn apart, and whether the peer closed.
type Conn = { buf: Uint8Array; wake?: () => void; closed: boolean; out: Promise<void>; onClose: (() => void)[] };

export class FakeVendor {
  private answers = new Map<string, Answer>();
  readonly requests: Recorded[] = [];
  connections = 0;
  private server!: import("bun").TCPSocketListener<Conn>;

  constructor(private credential: string) {}

  start() {
    this.server = Bun.listen<Conn>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (s) => {
          this.connections++;
          s.data = { buf: new Uint8Array(0), closed: false, out: Promise.resolve(), onClose: [] };
          s.setNoDelay?.(true);
          void this.serve(s).catch(() => s.end());
        },
        data: (s, d) => {
          s.data.buf = concat([s.data.buf, new Uint8Array(d)]);
          s.data.wake?.();
        },
        close: (s) => {
          s.data.closed = true;
          s.data.wake?.();
          s.data.onClose.splice(0).forEach((f) => f());
        },
        error: (s) => { s.data.closed = true; s.data.wake?.(); },
      },
    });
    return this;
  }

  get baseUrl() { return `http://127.0.0.1:${this.server.port}`; }
  stop() { this.server.stop(true); }
  answer(marker: string, a: Answer) { this.answers.set(marker, a); }
  requestsFor(marker: string) { return this.requests.filter((r) => r.marker === marker); }

  private async more(s: Socket<Conn>): Promise<boolean> {
    if (s.data.closed) return false;
    await new Promise<void>((res) => (s.data.wake = res));
    s.data.wake = undefined;
    return !s.data.closed || s.data.buf.length > 0;
  }

  private async write(s: Socket<Conn>, bytes: Uint8Array): Promise<boolean> {
    for (let i = 0; i < bytes.length; i += PIECE) {
      if (s.data.closed) return false;
      let piece = bytes.slice(i, i + PIECE);
      while (piece.length) {
        const n = s.write(piece);
        if (n < 0) return false;
        piece = piece.slice(n);
        if (piece.length) await Bun.sleep(1);
      }
      s.flush();
      await new Promise((r) => setImmediate(r));
    }
    return !s.data.closed;
  }

  private async serve(s: Socket<Conn>) {
    for (;;) {
      let end: number;
      while ((end = find(s.data.buf, enc.encode("\r\n\r\n"))) < 0) if (!(await this.more(s))) return;
      const head = dec.decode(s.data.buf.slice(0, end));
      s.data.buf = s.data.buf.slice(end + 4);
      const [line, ...rest] = head.split("\r\n");
      const target = line!.split(" ")[1] ?? "";
      const headers = rest.map((l) => l.split(/:(.*)/s)).filter((p) => p.length > 1).map(([n, v]) => [n!.trim().toLowerCase(), v!.trim()] as [string, string]);
      const h = (n: string) => headers.find(([k]) => k === n)?.[1];
      let raw: Uint8Array;
      if (h("transfer-encoding")?.toLowerCase().includes("chunked")) {
        const parts: Uint8Array[] = [];
        for (;;) {
          let le: number;
          while ((le = find(s.data.buf, enc.encode("\r\n"))) < 0) if (!(await this.more(s))) return;
          const size = parseInt(dec.decode(s.data.buf.slice(0, le)).split(";")[0]!.trim(), 16) || 0;
          s.data.buf = s.data.buf.slice(le + 2);
          while (s.data.buf.length < size + 2) if (!(await this.more(s))) return;
          parts.push(s.data.buf.slice(0, size));
          s.data.buf = s.data.buf.slice(size + 2);
          if (!size) break;
        }
        raw = concat(parts);
      } else {
        const len = Number(h("content-length") ?? 0);
        while (s.data.buf.length < len) if (!(await this.more(s))) return;
        raw = s.data.buf.slice(0, len);
        s.data.buf = s.data.buf.slice(len);
      }
      let body = raw;
      if (h("content-encoding")?.toLowerCase() === "gzip") try { body = Bun.gunzipSync(raw as Uint8Array<ArrayBuffer>); } catch {}
      const cred = enc.encode(this.credential);
      const rec: Recorded = {
        marker: markerIn(body), target, headers,
        body, credentialInHeader: headers.some(([, v]) => v.includes(this.credential)), credentialInUrl: target.includes(this.credential),
        credentialInBody: find(body, cred) >= 0 || find(raw, cred) >= 0, closed: false,
      };
      this.requests.push(rec);
      const gzip = !!h("accept-encoding")?.toLowerCase().includes("gzip");
      const json = (status: number, message: string): Answer => ({ kind: "bytes", status, headers: [["content-type", "application/json"]], body: enc.encode(JSON.stringify({ error: { message } })) });
      const a = !rec.credentialInHeader ? json(401, "the fake credential was not in a header")
        : !rec.marker ? json(404, "no fixture marker: in test mode a plugin sends model calls only")
        : this.answers.get(rec.marker) ?? json(404, "unknown fixture");
      const kept = await this.send(s, a, gzip, rec);
      if (!kept || h("connection")?.toLowerCase() === "close") { s.end(); return; }
    }
  }

  private async send(s: Socket<Conn>, a: Answer, gzip: boolean, rec: Recorded): Promise<boolean> {
    if (a.kind === "barrier") {
      await a.barrier.arrive();
      return this.send(s, a.answer, gzip, rec);
    }
    if (a.kind === "bytes") {
      const body = gzip ? Bun.gzipSync(a.body as Uint8Array<ArrayBuffer>) : a.body;
      let head = `HTTP/1.1 ${a.status} ${REASON[a.status] ?? "Status"}\r\n`;
      for (const [n, v] of a.headers) head += `${n}: ${v}\r\n`;
      if (gzip) head += "content-encoding: gzip\r\n";
      head += `content-length: ${body.length}\r\n\r\n`;
      return this.write(s, concat([enc.encode(head), body]));
    }
    // Held: chunked, gzip as one stream flushed per write.
    const closed = () => { rec.closed = true; return false; };
    let head = `HTTP/1.1 200 OK\r\ncontent-type: ${a.contentType}\r\ntransfer-encoding: chunked\r\n`;
    if (gzip) head += "content-encoding: gzip\r\n";
    head += "\r\n";
    const z = gzip ? createGzip() : null;
    const encode = (b: Uint8Array) => (z ? z.push(b) : b);
    if (!(await this.write(s, concat([enc.encode(head), chunk(encode(a.first))])))) return closed();
    let released = false;
    a.release.then(() => { released = true; s.data.wake?.(); });
    const gone = new Promise<void>((res) => (s.data.closed ? res() : s.data.onClose.push(res)));
    for (;;) {
      const tick = await Promise.race([Bun.sleep(1000).then(() => "tick"), gone.then(() => "gone"), a.release.then(() => "release")]);
      if (tick === "gone" || s.data.closed) return closed();
      if (tick === "release" || released) break;
      if (!(await this.write(s, chunk(encode(a.keepalive))))) return closed();
    }
    const tail = [chunk(encode(new Uint8Array(0)))];
    if (z) tail.push(chunk(z.end()));
    tail.push(enc.encode("0\r\n\r\n"));
    return (await this.write(s, concat(tail))) || closed();
  }
}

// A gzip member written as it goes: each piece is raw deflate ended by a sync
// flush (independent segments concatenate into one valid deflate stream), then
// an empty final block and the CRC-32 and length trailer.
function createGzip() {
  const zlib = require("node:zlib") as typeof import("node:zlib");
  let crc = 0;
  let size = 0;
  let started = false;
  const header = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);
  return {
    push(b: Uint8Array): Uint8Array {
      const parts: Uint8Array[] = [];
      if (!started) { started = true; parts.push(header); }
      if (b.length) {
        crc = Bun.hash.crc32(b, crc);
        size = (size + b.length) >>> 0;
        parts.push(new Uint8Array(zlib.deflateRawSync(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH })));
      }
      return concat(parts);
    },
    end(): Uint8Array {
      const t = new Uint8Array(8);
      new DataView(t.buffer).setUint32(0, crc >>> 0, true);
      new DataView(t.buffer).setUint32(4, size, true);
      return concat([started ? new Uint8Array(0) : header, new Uint8Array([0x03, 0x00]), t]);
    },
  };
}
