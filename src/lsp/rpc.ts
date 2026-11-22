// The base protocol of the Language Server Protocol: JSON-RPC 2.0 messages,
// each behind a header part (`Content-Length: N`, then an empty line), over a
// server's stdio. Parsed a chunk at a time, so a large message never holds
// the loop for more than the one JSON.parse of its body, and bounded: a
// header or a body over its limit is a server that speaks something else or
// floods, and the reader says so instead of growing.
export type RpcMessage = {
  jsonrpc?: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

// A header part is a few short lines; a body is one file's diagnostics or an
// answer to a request this client made, never a workspace's worth of symbols.
export const HEADER_MAX = 64 * 1024;
export const BODY_MAX = 8 * 1024 * 1024;

export class FrameError extends Error {}

const SEP = new Uint8Array([13, 10, 13, 10]);
function indexOfSep(b: Uint8Array, from: number): number {
  for (let i = Math.max(0, from); i + 3 < b.length; i++) if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  return -1;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// One message as the bytes that go on the wire.
export function encode(msg: RpcMessage): Uint8Array {
  const body = enc.encode(JSON.stringify({ jsonrpc: "2.0", ...msg }));
  const head = enc.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

// Bytes in, whole messages out. `push` returns the messages a chunk
// completed; what is left of it waits for the next chunk. It throws a
// FrameError once, at the first thing that is not the protocol: the caller
// ends the server.
export class Framer {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private need = -1;   // the body length the current header named, or -1 while the header is read
  private scanned = 0; // bytes of the header part already searched for its end

  constructor(private headerMax = HEADER_MAX, private bodyMax = BODY_MAX) {}

  // Bytes held that no message has claimed yet.
  get pending(): number { return this.size; }

  private flat(): Uint8Array {
    if (this.chunks.length === 1) return this.chunks[0]!;
    const all = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) { all.set(c, at); at += c.length; }
    this.chunks = [all];
    return all;
  }

  private drop(n: number) {
    const all = this.flat();
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.size = rest.length;
  }

  push(chunk: Uint8Array): RpcMessage[] {
    const out: RpcMessage[] = [];
    if (chunk.length) { this.chunks.push(chunk); this.size += chunk.length; }
    for (;;) {
      if (this.need < 0) {
        if (this.size < SEP.length) break;
        const all = this.flat();
        const end = indexOfSep(all, this.scanned - 3);
        if (end < 0) {
          if (all.length > this.headerMax) throw new FrameError(`a header part over ${this.headerMax} bytes`);
          this.scanned = all.length;
          break;
        }
        if (end > this.headerMax) throw new FrameError(`a header part over ${this.headerMax} bytes`);
        const head = dec.decode(all.subarray(0, end));
        const m = /(?:^|\r\n)content-length:[ \t]*(\d+)[ \t]*(?:\r\n|$)/i.exec(head);
        if (!m) throw new FrameError(`a header part without Content-Length: ${JSON.stringify(head.slice(0, 120))}`);
        const n = Number(m[1]);
        if (n > this.bodyMax) throw new FrameError(`a message of ${n} bytes, over the limit of ${this.bodyMax}`);
        this.need = n;
        this.scanned = 0;
        this.drop(end + SEP.length);
      }
      if (this.size < this.need) break;
      const all = this.flat();
      const text = dec.decode(all.subarray(0, this.need));
      this.drop(this.need);
      this.need = -1;
      let msg: unknown;
      try { msg = JSON.parse(text); } catch { throw new FrameError(`a message that is not JSON: ${JSON.stringify(text.slice(0, 120))}`); }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) throw new FrameError("a message that is not a JSON object");
      out.push(msg as RpcMessage);
    }
    return out;
  }
}
