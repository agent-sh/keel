#!/usr/bin/env bun
// A stdio MCP server whose tools answer wrongly: noresult sends an id and nothing else, baderror an error that
// is not an object, stringid the right result with the id as a string. Tool ok answers as it should.
const names = ["ok", "noresult", "baderror", "stringid"];
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
function handle(m: any) {
  if (m.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "initialize") return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "malformed-mcp", version: "1.0.0" } });
  if (m.method === "tools/list") return reply({ tools: names.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })) });
  if (m.method !== "tools/call") return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
  const text = { content: [{ type: "text", text: "fine" }] };
  switch (m.params?.name) {
    case "noresult": return send({ id: m.id });
    case "baderror": return send({ jsonrpc: "2.0", id: m.id, error: "boom" });
    case "stringid": return send({ jsonrpc: "2.0", id: String(m.id), result: text });
    default: return reply(text);
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
