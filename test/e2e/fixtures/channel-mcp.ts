#!/usr/bin/env bun
// A stand-in channel server for the channels e2e: a stdio MCP server that
// declares Claude Code's channel capability (and Keel's status one) and has a
// reply tool, as a chat bridge does. A local HTTP port stands in for the chat:
//   POST /push   { content, meta }  sends it to Keel as notifications/claude/channel
//   GET  /told   what Keel said became of each event (notifications/keel/channel/status)
//   GET  /replies what the model sent back with the reply tool
// It binds 127.0.0.1 on a free port and writes the port to CHANNEL_PORT_FILE.
import { writeFileSync } from "node:fs";

const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const told: unknown[] = [];
const replies: unknown[] = [];

function handle(m: any) {
  if (m.id === undefined) {
    if (m.method === "notifications/keel/channel/status") told.push(m.params);
    return;
  }
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize":
      return reply({
        protocolVersion: m.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {}, experimental: { "claude/channel": {}, "keel/channel/status": {} } },
        serverInfo: { name: "chat-standin", version: "1.0.0" },
        instructions: 'Messages arrive as <channel source="chat" chat_id="...">. Reply with the reply tool, passing the chat_id from the tag.',
      });
    case "tools/list":
      return reply({ tools: [{ name: "reply", description: "Send a message back over this channel", inputSchema: { type: "object", properties: { chat_id: { type: "string" }, text: { type: "string" } }, required: ["chat_id", "text"] } }] });
    case "tools/call":
      replies.push(m.params?.arguments ?? {});
      return reply({ content: [{ type: "text", text: "sent" }] });
    default:
      return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
}

let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) try { handle(JSON.parse(line)); } catch {}
  }
});
process.stdin.on("end", () => process.exit(0));

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/push") {
      const b = (await req.json()) as { content: string; meta?: Record<string, string> };
      send({ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: b.content, ...(b.meta ? { meta: b.meta } : {}) } });
      return new Response("ok");
    }
    if (url.pathname === "/told") return Response.json(told);
    if (url.pathname === "/replies") return Response.json(replies);
    return new Response("not found", { status: 404 });
  },
});
if (process.env.CHANNEL_PORT_FILE) writeFileSync(process.env.CHANNEL_PORT_FILE, String(server.port));
