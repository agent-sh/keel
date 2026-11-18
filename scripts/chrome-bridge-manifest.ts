// Writes src/integrations/chrome_bridge_tools.json from an installed Chrome
// bridge: its own tool list and instructions (asked over MCP stdio, which needs
// no browser) and its set of tools that act (from its tool registry).
// Usage: bun scripts/chrome-bridge-manifest.ts [path/to/bridge]
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { discoverChromeBridge } from "../src/integrations/chrome.ts";

const given = process.argv[2];
const found = given
  ? { node: process.execPath, entry: join(resolve(given), "bin/mcp-server.js") }
  : discoverChromeBridge(process.env.HOME!, (k) => process.env[k]);
if ("error" in found) throw new Error(found.error);
const root = resolve(found.entry, "../..");

const proc = Bun.spawn([found.node, found.entry], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
const send = (m: unknown) => proc.stdin.write(JSON.stringify(m) + "\n");
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "keel", version: "0" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
const answers = new Map<number, any>();
let buf = "";
for await (const chunk of proc.stdout) {
  buf += new TextDecoder().decode(chunk);
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id) answers.set(m.id, m.result);
  }
  if (answers.has(1) && answers.has(2)) break;
}
proc.kill();
const init = answers.get(1);
const registry = createRequire(import.meta.url)(join(root, "lib/tool-registry.js"));
const out = {
  source: `agent-chrome-bridge ${init.serverInfo?.version ?? ""}`.trim(),
  instructions: init.instructions ?? "",
  tools: answers.get(2).tools,
  mutating: [...registry.MUTATING_TOOLS].sort(),
};
const path = join(import.meta.dir, "../src/integrations/chrome_bridge_tools.json");
await Bun.write(path, JSON.stringify(out, null, 1) + "\n");
console.log(`${out.source}: ${out.tools.length} tools, ${out.mutating.length} act -> ${path}`);
