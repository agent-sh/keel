#!/usr/bin/env bun
// A stdio MCP server as an editor would pass one with its session: it says
// what it was started with (its arguments and environment) and writes a file
// where it is told, so a spec can see what such a server is given and where
// it may write. `--mark PATH` writes that file at start, before any call.
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const mark = argv.indexOf("--mark");
if (mark >= 0 && argv[mark + 1]) try { writeFileSync(argv[mark + 1]!, "started\n"); } catch {}

const tools = [
  { name: "echo", description: "Echo the given text back, prefixed with 'echo:'.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "started", description: "The arguments and the environment this server was started with, as JSON.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } },
  { name: "write", description: "Write a file at the given path.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
];

const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");

function handle(m: any) {
  if (m.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  const text = (t: string, isError = false) => reply({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });
  switch (m.method) {
    case "initialize":
      return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "editor-mcp", version: "1.0.0" } });
    case "tools/list":
      return reply({ tools });
    case "tools/call": {
      const a = m.params?.arguments ?? {};
      if (m.params?.name === "echo") return text(`echo: ${a.text}`);
      if (m.params?.name === "started") return text(JSON.stringify({ argv, env: process.env }));
      if (m.params?.name === "write") {
        try { writeFileSync(String(a.path), "written\n"); return text(`wrote ${a.path}`); } catch (e) { return text(`not written: ${(e as Error).message}`, true); }
      }
      return text(`unknown tool ${m.params?.name}`, true);
    }
    default:
      return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
}

let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) try { handle(JSON.parse(line)); } catch {}
  }
});
process.stdin.on("end", () => process.exit(0));
