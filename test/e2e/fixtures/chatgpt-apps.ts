#!/usr/bin/env bun
// A stand-in of ChatGPT's apps server (the MCP server Codex reaches as codex_apps, src/mcp/chatgpt-apps.ts):
// three apps with tools of every kind, each with its connector in `_meta` as the real listing has it. One tool
// that sends is called read-only by its connector, as a connector that is wrong about itself would.
//
// Run as a script it prints its port on the first line. POST /ps/mcp is the server; GET /stats says what it was
// asked (every method, whether a sign-in came with it, and each tool call).
const tool = (name: string, app: [string, string], annotations: Record<string, boolean>, properties: Record<string, unknown> = { query: { type: "string" } }) => ({
  name, description: `${name.split(".")[1]!.replaceAll("_", " ")} in ${app[1]}`, inputSchema: { type: "object", properties }, annotations,
  _meta: { connector_id: app[0], connector_name: app[1], _codex_apps: { resource_uri: `/${app[0]}/link_1/${name.split(".")[1]}` } },
});
const GMAIL: [string, string] = ["connector_gmail_standin", "Gmail"];
const SLACK: [string, string] = ["asdk_app_slack_standin", "Slack"];
const CAL: [string, string] = ["connector_calendar_standin", "Google Calendar"];
const mail = { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } };
export const TOOLS = [
  tool("gmail.search_emails", GMAIL, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  tool("gmail.read_email", GMAIL, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, { id: { type: "string" } }),
  // Its connector calls it read-only. Its name says what it does.
  tool("gmail.send_email", GMAIL, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, mail),
  tool("gmail.create_draft", GMAIL, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, mail),
  tool("gmail.forward_emails", GMAIL, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, { ids: { type: "array", items: { type: "string" } }, to: { type: "string" } }),
  tool("gmail.delete_emails", GMAIL, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, { ids: { type: "array", items: { type: "string" } } }),
  tool("slack.slack_search_public", SLACK, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
  tool("slack.slack_send_message", SLACK, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, { channel: { type: "string" }, text: { type: "string" } }),
  tool("google_calendar.list_events", CAL, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, { day: { type: "string" } }),
  tool("google_calendar.create_event", CAL, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, { title: { type: "string" }, day: { type: "string" } }),
];

export function startChatgptApps(port = 0) {
  const stats = { methods: [] as string[], signed: 0, unsigned: 0, calls: [] as { tool: string; arguments: unknown; routed: boolean }[] };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/stats") return Response.json(stats);
      if (req.method !== "POST" || url.pathname !== "/ps/mcp") return new Response(null, { status: 405 });
      const m = (await req.json()) as any;
      stats.methods.push(String(m.method));
      if (req.headers.get("authorization")?.startsWith("Bearer ")) stats.signed++;
      else stats.unsigned++;
      if (m.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: m.id, result });
      if (m.method === "initialize") return reply({ protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "apps stand-in", version: "1" } });
      if (m.method === "tools/list") return reply({ tools: TOOLS, _meta: { "openai/apps": [] } });
      if (m.method === "resources/list") return reply({ resources: [{ uri: "gmail://inbox/latest", name: "latest" }] });
      if (m.method === "resources/read") return reply({ contents: [{ uri: m.params?.uri, text: "the text of a message" }] });
      if (m.method === "tools/call") {
        stats.calls.push({ tool: String(m.params?.name), arguments: m.params?.arguments, routed: !!m.params?._meta?._codex_apps?.call_id });
        return reply({ content: [{ type: "text", text: m.params?.name === "gmail.search_emails" ? "1 message: Invoice for November, from accounts@example.com" : `done: ${m.params?.name}` }] });
      }
      return Response.json({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
    },
  });
  return { port: server.port, stats, stop: () => server.stop(true) };
}

if (import.meta.main) console.log(String(startChatgptApps().port));
