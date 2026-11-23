#!/usr/bin/env bun
// The stand-in tacit's MCP server (`tacit-standin.sh mcp --harness H`): the
// store's tool names, a search that finds the stand-in's code word, and every
// call logged as "mcp <harness> <tool> <arguments>" to $TACIT_STANDIN_LOG.
import { appendFileSync } from "node:fs";

const harness = process.argv[process.argv.indexOf("--harness") + 1] ?? "";
const log = (line: string) => { if (process.env.TACIT_STANDIN_LOG) appendFileSync(process.env.TACIT_STANDIN_LOG, line + "\n"); };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const tools = [
  { name: "tacit_search", description: "Find this owner's rules for what you are about to do.", inputSchema: obj({ query: { type: "string" } }) },
  { name: "tacit_fact", description: "Read one fact in full.", inputSchema: obj({ name: { type: "string" } }, ["name"]) },
  { name: "tacit_add", description: "Record a durable fact.", inputSchema: obj({ name: { type: "string" }, desc: { type: "string" } }, ["name", "desc"]) },
];
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");

function handle(m: any) {
  if (m.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize":
      return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "tacit", version: "0.0.0-standin" }, instructions: "The stand-in store." });
    case "tools/list":
      return reply({ tools });
    case "tools/call": {
      log(`mcp ${harness} ${m.params?.name} ${JSON.stringify(m.params?.arguments ?? {})}`);
      if (m.params?.name === "tacit_search") return reply({ content: [{ type: "text", text: "- code-word: the code word for this test is heron" }] });
      return reply({ content: [{ type: "text", text: `${m.params?.name} done as ${harness}` }] });
    }
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
