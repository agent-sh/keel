#!/usr/bin/env bun
// A stdio MCP server with forty tools of the size real servers list: a
// sentence of description and a few typed properties each.
const tools = Array.from({ length: 40 }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  return {
    name: `item_${n}`,
    description: `Reads record set ${n} of the inventory and returns the rows that match the filter, newest first, with the fields the caller names.`,
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Only rows whose name contains this text." },
        limit: { type: "number", description: "The most rows to return." },
        fields: { type: "array", items: { type: "string" }, description: "The fields to return." },
      },
      required: ["filter"],
    },
  };
});

const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");

function handle(m: any) {
  if (m.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize":
      return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "bulk-mcp", version: "1.0.0" } });
    case "tools/list":
      return reply({ tools });
    case "tools/call":
      return reply({ content: [{ type: "text", text: `${m.params?.name} got ${JSON.stringify(m.params?.arguments ?? {})}` }] });
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
