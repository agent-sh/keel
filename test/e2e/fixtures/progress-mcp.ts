#!/usr/bin/env bun
// A stdio MCP server whose `work` tool takes longer than the client's timeout
// and says so: given a progressToken, it reports progress every 150 ms, five
// times, then answers (with `stuck`, the same progress each time). Without a
// token it reports nothing (as the spec says).
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
async function handle(m: any) {
  if (m.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "initialize") return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "progress-mcp", version: "1" } });
  if (m.method === "tools/list") return reply({ tools: [{ name: "work", inputSchema: { type: "object" } }] });
  if (m.method === "tools/call") {
    const token = m.params?._meta?.progressToken;
    for (let i = 1; i <= 5; i++) {
      await Bun.sleep(150);
      // `stuck`: the same progress each time, as a server that reports without moving on.
      if (token !== undefined) send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: m.params?.arguments?.stuck ? 1 : i, total: 5 } });
    }
    return reply({ content: [{ type: "text", text: "worked" }] });
  }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no ${m.method}` } });
}
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  for (let nl; (nl = buf.indexOf("\n")) >= 0; ) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) void handle(JSON.parse(line));
  }
}
