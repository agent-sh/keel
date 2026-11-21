#!/usr/bin/env bun
// A modern (2026-07-28) stdio MCP server, stateless: no initialize, every
// request carries its version in _meta. Its `hang` tool never answers, and
// `cancelled` answers with the notifications/cancelled it was sent, so a
// test can see whether a request given up was said to be.
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const cancelled: unknown[] = [];

function handle(m: any) {
  if (m.id === undefined) {
    if (m.method === "notifications/cancelled") cancelled.push(m.params);
    return;
  }
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  if (m.params?._meta?.["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28") return send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "no protocol version" } });
  switch (m.method) {
    case "server/discover":
      return reply({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "modern-stdio-mcp", version: "1.0.0" } } });
    case "tools/list":
      return reply({ tools: [{ name: "hang", inputSchema: { type: "object" } }, { name: "cancelled", inputSchema: { type: "object" } }] });
    case "tools/call":
      if (m.params?.name === "hang") return;
      return reply({ content: [{ type: "text", text: JSON.stringify(cancelled) }] });
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
