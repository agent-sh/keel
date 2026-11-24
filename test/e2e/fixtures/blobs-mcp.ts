#!/usr/bin/env bun
// A stdio MCP server whose one tool, `fetch`, returns what servers return that is not text: a two-page
// PDF as an embedded resource labelled application/octet-stream, a PNG image and a WAV audio clip. The
// MCP spec's content types: resource (with blob), image, audio.
const pdf = (() => {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    "<< /Length 44 >>\nstream\nBT /F1 18 Tf 20 50 Td (Quarterly page one) Tj ET\nendstream",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    "<< /Length 44 >>\nstream\nBT /F1 18 Tf 20 50 Td (Quarterly page two) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const at: number[] = [];
  objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
})();

// A 48 x 48 gradient, written as a PNG by hand (signature, IHDR, IDAT, IEND).
const png = (() => {
  const w = 48, h = 48;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = x * 5; raw[o + 1] = y * 5; raw[o + 2] = 160; }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(Bun.hash.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", Buffer.from(Bun.deflateSync(raw))), chunk("IEND", Buffer.alloc(0))]);
})();

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
