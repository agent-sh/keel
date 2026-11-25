#!/usr/bin/env bun
// A stdio MCP server that writes more than a line can hold. Tool big answers with one line of 5 MB (with its
// newline); tool flood writes 64 MB with no newline at all; tool ok answers as it should.
const names = ["ok", "big", "flood"];
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
async function handle(m: any) {
  if (m.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "initialize") return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "flood-mcp", version: "1.0.0" } });
  if (m.method === "tools/list") return reply({ tools: names.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })) });
  if (m.method !== "tools/call") return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
  switch (m.params?.name) {
    case "big": return reply({ content: [{ type: "text", text: "z".repeat(5 * 1024 * 1024) }] });
    case "flood": {
      const piece = "x".repeat(1024 * 1024);
      for (let i = 0; i < 64; i++) { process.stdout.write(piece); await Bun.sleep(2); }
      return;
    }
    default: return reply({ content: [{ type: "text", text: "fine" }] });
  }
}
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) await handle(JSON.parse(line));
  }
}
