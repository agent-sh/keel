#!/usr/bin/env bun
// A tiny stdio MCP server (legacy, initialize-based, like most servers today)
// for the MCP e2e: tools echo and add, one resource, a few prompts. With
// --extras it says when its prompt list changes, and its tool learn adds the
// prompt farewell and says so; it sends its log (logging, at the level it is
// asked for: learn logs a line at info and one at error) and suggests who to
// greet (completions).
const tools: { name: string; description: string; annotations?: object; inputSchema: object }[] = [
  { name: "echo", description: "Echo the given text back, prefixed with 'echo:'.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "add", description: "Add two numbers.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
];
const learns = process.argv.includes("--extras");
const LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];
let level = "warning";
const log = (at: string, data: unknown) => { if (LEVELS.indexOf(at) >= LEVELS.indexOf(level)) send({ jsonrpc: "2.0", method: "notifications/message", params: { level: at, logger: "echo", data } }); };
const WHO = ["alice", "alfred", "bob"];
// (What its server says of it is marked in the MCP panel.)
if (learns) tools.push({ name: "learn", description: "Add the prompt farewell.", annotations: { destructiveHint: true, openWorldHint: true, idempotentHint: true }, inputSchema: { type: "object", properties: {}, required: [] } });
// --browser: it lists the pair of tools of a server that keeps a browser open (browser_navigate, browser_close).
if (process.argv.includes("--browser")) for (const name of ["browser_navigate", "browser_close"]) tools.push({ name, description: `A browser tool: ${name}.`, inputSchema: { type: "object", properties: {} } });
let learned = false;

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
        capabilities: { tools: {}, resources: {}, prompts: learns ? { listChanged: true } : {}, ...(learns ? { logging: {}, completions: {} } : {}) },
        serverInfo: { name: "echo-mcp", version: "1.0.0" },
        instructions: "Echo and add, for tests.",
      });
    case "tools/list":
      return reply({ tools });
    case "tools/call": {
      const a = m.params?.arguments ?? {};
      if (m.params?.name === "echo") return reply({ content: [{ type: "text", text: `echo: ${a.text}` }] });
      if (m.params?.name === "add") return reply({ content: [{ type: "text", text: String(Number(a.a) + Number(a.b)) }] });
      if (m.params?.name === "browser_navigate" || m.params?.name === "browser_close") return reply({ content: [{ type: "text", text: "ok" }] });
      if (m.params?.name === "learn" && learns) {
        learned = true;
        log("info", "added the prompt farewell");
        log("error", { problem: "farewell has no translation", languages: 0 });
        send({ jsonrpc: "2.0", method: "notifications/prompts/list_changed" });
        return reply({ content: [{ type: "text", text: "learned farewell" }] });
      }
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
        ...(learned ? [{ name: "farewell", description: "Say goodbye." }] : []),
      ] });
    case "prompts/get": {
      if (m.params?.name === "dialog")
        return reply({ messages: [{ role: "user", content: { type: "text", text: "Hi there" } }, { role: "assistant", content: { type: "text", text: "Hello back" } }] });
      const a = m.params?.arguments ?? {};
      if (m.params?.name === "summarize") return reply({ messages: [{ role: "user", content: { type: "text", text: `Summarize.${"tone" in a ? ` Tone: ${a.tone}.` : ""}` } }] });
      return reply({ messages: [{ role: "user", content: { type: "text", text: `Say hello to ${a.who ?? "you"}.` } }] });
    }
    case "logging/setLevel":
      if (!learns) return error(-32601, "Method not found: logging/setLevel");
      if (!LEVELS.includes(m.params?.level)) return error(-32602, "unknown level");
      level = m.params.level;
      reply({});
      return log("info", `level set to ${level}`);
    case "completion/complete": {
      if (!learns) return error(-32601, "Method not found: completion/complete");
      const p = m.params ?? {};
      const values = p.ref?.type === "ref/prompt" && p.ref.name === "greet" && p.argument?.name === "who" ? WHO.filter((w) => w.startsWith(String(p.argument.value ?? ""))) : [];
      return reply({ completion: { values, total: values.length, hasMore: false } });
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
