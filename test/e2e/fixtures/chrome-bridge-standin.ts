#!/usr/bin/env bun
// A stand-in for the Chrome bridge's MCP server: its shipped tool list with no
// browser behind it. Start it with KEEL_CHROME_BRIDGE pointing here and
// KEEL_CHROME_BRIDGE_NODE at bun. Each tools/call is appended as a line
// "name arguments" to $CHROME_STANDIN_LOG when set.
import { appendFileSync } from "node:fs";
import shipped from "../../../src/integrations/chrome_bridge_tools.json" with { type: "json" };

const log = process.env.CHROME_STANDIN_LOG;
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const text = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
let next = 100;

function call(name: string, a: any) {
  if (log) appendFileSync(log, `${name} ${JSON.stringify(a)}\n`);
  if (name === "chrome_tabs") return text({ tabs: [{ id: 1, active: true, title: "Stand-in page", url: "https://example.test/" }, { id: 2, title: "Second", url: "https://example.test/2" }] });
  if (name === "chrome_active_tab") return text({ tab: { id: 1, url: "https://example.test/", title: "Stand-in page" } });
  if (name === "chrome_new_tab") return text({ tab: { id: ++next, url: a.url ?? "about:blank" } });
  return text({ ok: true, tool: name, tabId: a.tabId });
}

function handle(m: any) {
  if (m.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "initialize")
    return reply({ protocolVersion: m.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "chrome-bridge-standin", version: "1" }, instructions: shipped.instructions });
  if (m.method === "tools/list") return reply({ tools: shipped.tools });
  if (m.method === "tools/call") return reply(call(m.params?.name, m.params?.arguments ?? {}));
  if (m.method === "ping") return reply({});
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Unknown method: ${m.method}` } });
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
