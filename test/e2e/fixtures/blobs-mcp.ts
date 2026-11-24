#!/usr/bin/env bun
// A stdio MCP server whose one tool, `fetch`, returns what servers return that is not text: a two-page
// PDF as an embedded resource labelled application/octet-stream, a PNG image and a WAV audio clip. The
// MCP spec's content types: resource (with blob), image, audio.
import { pdf, png } from "./files.ts";

// 0.05 s of a 440 Hz tone, 8 kHz, 16-bit mono.
const wav = (() => {
  const n = 400, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 8000) * 8000), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVEfmt ", 8); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(8000, 24); head.writeUInt32LE(16000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
})();

const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");

function handle(m: any) {
  if (m.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize":
      return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "blobs-mcp", version: "1.0.0" } });
    case "tools/list":
      return reply({ tools: [{ name: "fetch", description: "Returns a report (PDF), a chart (PNG) and a voice note (WAV).", inputSchema: { type: "object", properties: {} } }] });
    case "tools/call":
      return reply({
        content: [
          { type: "text", text: "Three files." },
          { type: "resource", resource: { uri: "file:///reports/quarterly", mimeType: "application/octet-stream", blob: pdf.toString("base64") } },
          { type: "image", mimeType: "image/png", data: png.toString("base64") },
          { type: "audio", mimeType: "audio/wav", data: wav.toString("base64") },
        ],
      });
    default:
      return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
}

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
}
