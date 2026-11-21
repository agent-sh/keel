#!/usr/bin/env bun
// A stdio MCP stand-in that asks the client while it works on a call, in
// both protocol eras. Legacy (2025-11-25, the default): `initialize`, and what
// it asks is a request of its own sent while the call is open. Modern
// (2026-07-28, with --modern): stateless, and what it asks is an
// input_required result the client answers by calling again.
//
// Tools: `roots` asks for the client's folders (roots/list) and returns
// them; `caps` returns the client capabilities it was told; `start` returns
// the roots a legacy server asked for as soon as it was connected, outside
// any call.
// ASK_MCP_LOG: a file that gets one JSON line per answer the server received.
import { appendFileSync } from "node:fs";

const modern = process.argv.includes("--modern");
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const log = (row: unknown) => { if (process.env.ASK_MCP_LOG) appendFileSync(process.env.ASK_MCP_LOG, JSON.stringify(row) + "\n"); };
const text = (t: string) => ({ content: [{ type: "text", text: t }] });

const TOOLS = [
  { name: "roots", description: "Returns the folders the client offers", inputSchema: { type: "object" } },
  { name: "caps", description: "Returns the client capabilities", inputSchema: { type: "object" } },
  { name: "start", description: "Returns the roots it was given when it connected", inputSchema: { type: "object" } },
];

let caps: unknown = null;
let atStart: unknown = null;
let nextId = 1;
const waiting = new Map<string, (m: any) => void>();
// A legacy server's own request to the client; resolves to the whole response.
const request = (method: string, params?: unknown) => new Promise<any>((resolve) => {
  const id = `srv-${nextId++}`;
  waiting.set(id, resolve);
  send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
});

async function handle(m: any) {
  if (m.id !== undefined && !m.method) {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    return w?.(m);
  }
  if (m.method === "notifications/initialized") {
    const r = await request("roots/list");
    atStart = r.result ?? r.error;
    return;
  }
  if (m.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  const fail = (code: number, message: string) => send({ jsonrpc: "2.0", id: m.id, error: { code, message } });
  const meta = m.params?._meta ?? {};
  if (modern) {
    if (meta["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28") return fail(-32602, "no protocol version");
    caps = meta["io.modelcontextprotocol/clientCapabilities"] ?? null;
  }
  switch (m.method) {
    case "server/discover":
      return modern ? reply({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "ask-mcp", version: "1.0.0" } } }) : fail(-32601, "Method not found");
    case "initialize":
      if (modern) return fail(-32601, "Method not found");
      caps = m.params?.capabilities ?? null;
      return reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "ask-mcp", version: "1.0.0" } });
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const tool = m.params?.name;
      if (tool === "caps") return reply(text(JSON.stringify(caps)));
      if (tool === "start") return reply(text(`start: ${JSON.stringify(atStart)}`));
      const ask: { method: string; params?: unknown } | null = tool === "roots" ? { method: "roots/list" } : null;
      if (!ask) return fail(-32602, `no tool ${tool}`);
      if (modern) {
        const got = m.params?.inputResponses?.q;
        if (got === undefined) return reply({ resultType: "input_required", inputRequests: { q: ask }, requestState: "state-1" });
        log({ tool, era: "modern", answer: got, requestState: m.params?.requestState });
        return reply(text(`${tool}: ${JSON.stringify(got)}`));
      }
      const r = await request(ask.method, ask.params);
      log({ tool, era: "legacy", answer: r.result, error: r.error });
      return reply(text(`${tool}: ${JSON.stringify(r.result ?? r.error)}`));
    }
    default:
      return fail(-32601, `Method not found: ${m.method}`);
  }
}

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) void handle(JSON.parse(line));
  }
}
