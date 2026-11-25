#!/usr/bin/env bun
// A stdio MCP server (2025-11-25) that sends notifications when it is told to: each line appended to the file named
// by EVENTS_MCP_CONTROL is `{"method": "...", "params": {...}}`, sent as a notification at once. It offers resource
// subscriptions and logs each one (EVENTS_MCP_LOG), so a test sees what the daemon subscribed to.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const log = (line: string) => { if (process.env.EVENTS_MCP_LOG) appendFileSync(process.env.EVENTS_MCP_LOG, `${line}\n`); };
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");

function handle(m: any) {
  if (m.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize":
      return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {}, resources: { subscribe: true } }, serverInfo: { name: "events-mcp", version: "1.0.0" } });
    case "tools/list":
      return reply({ tools: [{ name: "ping", description: "Answers at once.", inputSchema: { type: "object", properties: {} } }] });
    case "tools/call":
      return reply({ content: [{ type: "text", text: "pong" }] });
    case "resources/list":
      return reply({ resources: [] });
    case "resources/subscribe":
      log(`subscribe ${m.params?.uri}`);
      return reply({});
    default:
      return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
}

// The control file: lines read as they are appended.
const control = process.env.EVENTS_MCP_CONTROL;
let taken = 0;
if (control) setInterval(() => {
  if (!existsSync(control)) return;
  const text = readFileSync(control, "utf8");
  const lines = text.split("\n");
  lines.pop(); // (an unfinished line waits)
  for (const line of lines.slice(taken)) {
    taken++;
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    send({ jsonrpc: "2.0", method: e.method, params: e.params });
    log(`sent ${e.method}`);
  }
}, 50);

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += Buffer.from(chunk).toString();
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
}
