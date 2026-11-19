#!/usr/bin/env bun
// A tiny stdio MCP server (legacy, initialize-based, like most servers today)
// for the MCP e2e: tools echo and add, one resource, one prompt.
const tools = [
  { name: "echo", description: "Echo the given text back, prefixed with 'echo:'.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "add", description: "Add two numbers.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
];

const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
let ready = false;

function handle(m: any) {
  if (m.id === undefined) {
    if (m.method === "notifications/initialized") ready = true;
    return;
  }
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  const error = (code: number, message: string) => send({ jsonrpc: "2.0", id: m.id, error: { code, message } });
  switch (m.method) {
    case "initialize":
      return reply({
        protocolVersion: m.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "echo-mcp", version: "1.0.0" },
        instructions: "Echo and add, for tests.",
      });
    case "tools/list":
      return reply({ tools });
    case "tools/call": {
      const a = m.params?.arguments ?? {};
      if (m.params?.name === "echo") return reply({ content: [{ type: "text", text: `echo: ${a.text}` }] });
      if (m.params?.name === "add") return reply({ content: [{ type: "text", text: String(Number(a.a) + Number(a.b)) }] });
      return reply({ content: [{ type: "text", text: `unknown tool ${m.params?.name}` }], isError: true });
    }
    case "resources/list":
      return reply({ resources: [{ uri: "echo://readme", name: "readme", mimeType: "text/plain" }] });
    case "resources/templates/list":
      return reply({ resourceTemplates: [] });
    case "resources/read":
      return reply({ contents: [{ uri: m.params?.uri, mimeType: "text/plain", text: "The echo server repeats what it is given." }] });
    case "prompts/list":
      return reply({ prompts: [{ name: "greet", description: "Greet someone.", arguments: [{ name: "who", required: true }] }] });
    case "prompts/get":
      return reply({ messages: [{ role: "user", content: { type: "text", text: `Say hello to ${m.params?.arguments?.who ?? "you"}.` } }] });
    default:
      return error(-32601, `Method not found: ${m.method}${ready ? "" : " (not initialized)"}`);
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
