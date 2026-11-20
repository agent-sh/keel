#!/usr/bin/env bun
// A stdio MCP server that answers initialize late (SLOW_MCP_MS) and publishes
// instructions: the server a daemon start is still connecting when a session
// already sends a request.
const delay = Number(process.env.SLOW_MCP_MS ?? 3000);
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");

async function handle(m: any) {
  if (m.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize":
      await Bun.sleep(delay);
      return reply({
        protocolVersion: m.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "slow-mcp", version: "1.0.0" },
        instructions: "Slow server guidance: ask it for the tide tables.",
      });
    case "tools/list":
      return reply({ tools: [{ name: "tide", description: "The tide table of a port.", inputSchema: { type: "object", properties: { port: { type: "string" } } } }] });
    default:
      return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
}

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += Buffer.from(chunk).toString();
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) void handle(JSON.parse(line));
  }
}
