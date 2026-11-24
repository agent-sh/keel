#!/usr/bin/env bun
// A stdio MCP server whose tools' input schemas are of shapes servers list and
// providers refuse as they are: `pick` takes one of two ways to name a thing
// (a root oneOf), `cells` is keyed by a column title with a space in it,
// `textual` takes a string instead of an object (no wire takes that), and
// `echo` is a plain schema every wire takes. Each says what it was called with.
const tools = [
  {
    name: "pick",
    description: "Picks a thing by its id or its name.",
    inputSchema: {
      oneOf: [
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      ],
    },
  },
  { name: "cells", description: "Writes a cell under its column title.", inputSchema: { type: "object", properties: { "unit price": { type: "string" } }, required: ["unit price"] } },
  { name: "textual", description: "Takes a line of text.", inputSchema: { type: "string" } },
  { name: "echo", description: "Says the text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
];

const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");

function handle(m: any) {
  if (m.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize":
      return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "shapes-mcp", version: "1.0.0" } });
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
