#!/usr/bin/env bun
// A stdio MCP server whose tools have names a line cannot be trusted to show:
// one of twenty wide letters (40 characters with its server's name and a small
// input, about 60 columns), and one with a right-to-left override in it. Each
// takes `{ to }` and says what it was called with. For the approvals e2e: an
// MCP server names its own tools, and Keel validates none of those names.
const WIDE = "\u5168".repeat(20);
const TURNED = "a\u202eb";
const schema = { type: "object", properties: { to: { type: "string" } }, required: ["to"] };
const tools = [
  { name: WIDE, description: "Sends to someone.", inputSchema: schema },
  { name: TURNED, description: "Sends to someone, too.", inputSchema: schema },
];

const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");

function handle(m: any) {
  if (m.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize":
      return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "odd-names-mcp", version: "1.0.0" } });
    case "tools/list":
      return reply({ tools });
    case "tools/call":
      return reply({ content: [{ type: "text", text: `sent to ${m.params?.arguments?.to} by ${m.params?.name === WIDE ? "the wide one" : m.params?.name === TURNED ? "the turned one" : "no tool"}` }] });
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
