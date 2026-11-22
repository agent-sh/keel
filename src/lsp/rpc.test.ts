import { expect, test } from "bun:test";
import { encode, FrameError, Framer } from "./rpc.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const join = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };

test("a message survives being cut anywhere, one byte at a time included", () => {
  const a = encode({ id: 1, method: "initialize", params: { text: "héllo ✓ \r\n\r\n inside" } });
  const b = encode({ method: "textDocument/publishDiagnostics", params: { uri: "file:///x.ts", diagnostics: [] } });
  const wire = join(a, b);
  for (const step of [1, 2, 7, 64, wire.length]) {
    const f = new Framer();
    const got = [];
    for (let i = 0; i < wire.length; i += step) got.push(...f.push(wire.subarray(i, i + step)));
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({ jsonrpc: "2.0", id: 1, method: "initialize", params: { text: "héllo ✓ \r\n\r\n inside" } });
    expect(got[1]!.method).toBe("textDocument/publishDiagnostics");
    expect(f.pending).toBe(0);
  }
});

test("Content-Length counts bytes, and other header fields are passed over", () => {
  const body = bytes(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "✓✓" }));
  const f = new Framer();
  const got = f.push(join(bytes(`Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: ${body.length}\r\n\r\n`), body, bytes("Content-Le")));
  expect(got).toEqual([{ jsonrpc: "2.0", id: 2, result: "✓✓" }]);
  expect(f.pending).toBe(10); // the start of the next header waits
});

test("what is not the protocol is refused, not grown", () => {
  // A server that prints a log line on its output.
  expect(() => new Framer().push(bytes("starting server...\r\n\r\n{}"))).toThrow(FrameError);
  // A header part that never ends.
  const f = new Framer(1024, 4096);
  expect(() => { for (let i = 0; i < 100; i++) f.push(bytes("x".repeat(64))); }).toThrow(/header part over 1024/);
  // A body over the limit is refused at its header, before a byte of it is kept.
  expect(() => new Framer(1024, 4096).push(bytes("Content-Length: 5000\r\n\r\n"))).toThrow(/5000 bytes, over the limit of 4096/);
  expect(() => new Framer().push(bytes("Content-Length: 4\r\n\r\nnope"))).toThrow(/not JSON/);
  expect(() => new Framer().push(bytes("Content-Length: 2\r\n\r\n[]"))).toThrow(/not a JSON object/);
});

test("a large body arriving in small pieces is held without being copied each time", () => {
  const big = encode({ id: 3, result: "y".repeat(2_000_000) });
  const f = new Framer();
  const t0 = performance.now();
  let got = 0;
  for (let i = 0; i < big.length; i += 4096) got += f.push(big.subarray(i, i + 4096)).length;
  expect(got).toBe(1);
  expect(performance.now() - t0).toBeLessThan(1000);
});

test("many small messages in one chunk, and one message in many chunks, are read in linear time", () => {
  const one = encode({ method: "window/logMessage", params: { type: 3, message: "x".repeat(100) } });
  const n = 60_000;
  const wire = new Uint8Array(one.length * n);
  for (let i = 0; i < n; i++) wire.set(one, i * one.length);
  const t0 = performance.now();
  expect(new Framer().push(wire)).toHaveLength(n);
  // The same bytes a few at a time: every push finds the next message without reading the rest again.
  const f = new Framer();
  let got = 0;
  for (let i = 0; i < wire.length; i += 997) got += f.push(wire.subarray(i, i + 997)).length;
  expect(got).toBe(n);
  expect(performance.now() - t0).toBeLessThan(3000);
});
