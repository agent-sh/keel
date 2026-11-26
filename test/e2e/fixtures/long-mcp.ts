#!/usr/bin/env bun
// A stdio MCP server (2025-11-25) with a tool held until the spec writes LONG_MCP_RELEASE, and one that answers
// at once. LONG_MCP_LOG gets one line per call as it starts and ends.
import { appendFileSync, existsSync } from "node:fs";
const release = process.env.LONG_MCP_RELEASE;
const log = (line: string) => { if (process.env.LONG_MCP_LOG) appendFileSync(process.env.LONG_MCP_LOG, `${line}\n`); };
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const tool = (name: string, description: string, properties: Record<string, unknown> = {}) => ({ name, description, inputSchema: { type: "object", properties } });

async function handle(m: any) {
  if (m.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize":
      return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "long-mcp", version: "1.0.0" } });
    case "tools/list":
      return reply({ tools: [tool("nap", "Waits for the release signal.", {}), tool("quick", "Answers at once.")] });
    case "tools/call": {
      const name = m.params?.name;
      log(`start ${name}`);
      if (name === "nap") {
        const deadline = Date.now() + 60_000;
        while (release && !existsSync(release) && Date.now() < deadline) await Bun.sleep(25);
        if (!release || !existsSync(release)) return send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "No release signal" } });
      }
      log(`end ${name}`);
      return reply({ content: [{ type: "text", text: name === "nap" ? "nap: done" : "quick: done" }] });
    }
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
