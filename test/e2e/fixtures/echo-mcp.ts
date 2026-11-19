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
    // Two pages, the first ending in an empty cursor (a cursor is any string, "" included).
    case "resources/list":
      return m.params?.cursor === ""
        ? reply({ resources: [{ uri: "echo://bundle", name: "bundle", description: "Two texts and a byte" }] })
        : reply({ resources: [{ uri: "echo://readme", name: "readme", mimeType: "text/plain" }], nextCursor: "" });
    case "resources/templates/list":
      return error(-32601, "Method not found: resources/templates/list");
    case "resources/read":
      if (m.params?.uri === "echo://bundle")
        return reply({ contents: [
          { uri: "echo://bundle/a", mimeType: "text/plain", text: "alpha" },
          { uri: "echo://bundle/b", mimeType: "text/plain", text: "beta\nsecond line" },
          { uri: "echo://bundle/c", mimeType: "application/octet-stream", blob: "AQ==" },
        ] });
      return reply({ contents: [{ uri: m.params?.uri, mimeType: "text/plain", text: "The echo server repeats what it is given." }] });
    case "prompts/list":
      return reply({ prompts: [
        { name: "greet", description: "Greet someone.", arguments: [{ name: "who", description: "Whom to greet", required: true }] },
        { name: "summarize", description: "Summarize the session.", arguments: [{ name: "tone", description: "How it sounds" }] },
        { name: "dialog", description: "A short exchange." },
      ] });
    case "prompts/get": {
      if (m.params?.name === "dialog")
        return reply({ messages: [{ role: "user", content: { type: "text", text: "Hi there" } }, { role: "assistant", content: { type: "text", text: "Hello back" } }] });
      const a = m.params?.arguments ?? {};
      if (m.params?.name === "summarize") return reply({ messages: [{ role: "user", content: { type: "text", text: `Summarize.${"tone" in a ? ` Tone: ${a.tone}.` : ""}` } }] });
      return reply({ messages: [{ role: "user", content: { type: "text", text: `Say hello to ${a.who ?? "you"}.` } }] });
    }
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
