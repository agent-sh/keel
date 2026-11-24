#!/usr/bin/env bun
// A stdio MCP server with an MCP App (the ui extension, 2026-01-26) for the
// MCP Apps e2e. Its tool `board` names the app `ui://board/app.html`; the app
// draws the board's result, calls `tally` (a tool only apps see) when its
// button is pressed, and tries `secret` (a tool only the model sees) and a tool
// of another server, which the host refuses. It also asks to open a link and
// sends a message, which wait for the owner. `--domains` declares a connect
// origin, so the frame's policy names it.
const APP = "ui://board/app.html";
const tools = [
  { name: "board", description: "Show the score board as an app.", inputSchema: { type: "object", properties: { team: { type: "string" } } }, _meta: { ui: { resourceUri: APP } } },
  { name: "tally", description: "Add a point (for the app).", inputSchema: { type: "object", properties: { team: { type: "string" } } }, _meta: { ui: { resourceUri: APP, visibility: ["app"] } } },
  { name: "secret", description: "Read the secret (for the model only).", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model"] } } },
];
let points = 0;

// The app: a page that speaks the host's JSON-RPC over postMessage by hand.
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; padding: 12px 14px; font: 14px/1.4 var(--font-sans, system-ui); color: var(--color-text-primary, #222); background: var(--color-background-primary, transparent); }
h1 { font-size: 15px; margin: 0 0 8px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
button { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--color-border-primary, #999); background: var(--color-background-secondary, #eee); color: inherit; cursor: pointer; }
output { display: block; font-family: var(--font-mono, monospace); }
</style></head><body>
<h1>Score board</h1>
<output id="first">waiting for the result</output>
<div class="row">
  <button id="tally">Add a point</button>
  <button id="secret">Read the secret</button>
  <button id="other">Call echo</button>
  <button id="link">Open the rules</button>
  <button id="say">Tell the model</button>
</div>
<output id="out"></output>
<output id="theme"></output>
<script>
let next = 1; const waiting = new Map();
const send = (m) => window.parent.postMessage(m, "*");
const ask = (method, params) => new Promise((ok, no) => { const id = next++; waiting.set(id, { ok, no }); send({ jsonrpc: "2.0", id, method, params }); });
const text = (r) => (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
const out = (s) => { document.getElementById("out").textContent = s; size(); };
window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return;
  const m = e.data || {};
  if (m.id !== undefined && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); return m.error ? w.no(m.error) : w.ok(m.result); }
  if (m.method === "ui/notifications/tool-result") { document.getElementById("first").textContent = "first: " + text(m.params); size(); }
  if (m.method === "ui/notifications/host-context-changed") look(m.params);
  if (m.method === "ui/resource-teardown" && m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
// The host's look, as the SDK's applyHostStyleVariables does it: its variables on the root, its theme as the color scheme.
const look = (c) => {
  if (!c) return;
  for (const [k, v] of Object.entries((c.styles && c.styles.variables) || {})) document.documentElement.style.setProperty(k, v);
  if (c.theme) { document.documentElement.style.colorScheme = c.theme; document.getElementById("theme").textContent = "theme: " + c.theme; }
};
const size = () => send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: document.documentElement.scrollWidth, height: Math.ceil(document.body.getBoundingClientRect().bottom) } });
const call = (name, args) => ask("tools/call", { name, arguments: args }).then((r) => out(name + ": " + text(r) + (r.isError ? " (error)" : "")), (e) => out(name + " refused: " + e.message));
document.getElementById("tally").onclick = () => call("tally", { team: "blue" });
document.getElementById("secret").onclick = () => call("secret", {});
document.getElementById("other").onclick = () => call("echo__echo", { text: "x" });
document.getElementById("link").onclick = () => ask("ui/open-link", { url: "https://example.com/rules" }).then(() => out("link: opened"), (e) => out("link refused: " + e.message));
document.getElementById("say").onclick = () => ask("ui/message", { role: "user", content: [{ type: "text", text: "The board says blue leads." }] }).then(() => out("message: sent"), (e) => out("message refused: " + e.message));
ask("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "board", version: "1.0.0" }, appCapabilities: {} }).then((r) => {
  document.getElementById("theme").textContent = "theme: none";
  look(r.hostContext);
  send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  size();
});
</script></body></html>`;

const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const domains = process.argv.includes("--domains");

function handle(m: any) {
  if (m.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  const error = (code: number, message: string) => send({ jsonrpc: "2.0", id: m.id, error: { code, message } });
  switch (m.method) {
    case "initialize":
      return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "app-mcp", version: "1.0.0" } });
    case "tools/list":
      return reply({ tools });
    case "tools/call": {
      const a = m.params?.arguments ?? {};
      if (m.params?.name === "board") return reply({ content: [{ type: "text", text: `${a.team ?? "blue"} has ${points} points` }], structuredContent: { team: a.team ?? "blue", points } });
      if (m.params?.name === "tally") { points++; return reply({ content: [{ type: "text", text: `${a.team ?? "blue"} has ${points} points` }] }); }
      if (m.params?.name === "secret") return reply({ content: [{ type: "text", text: "the secret is 42" }] });
      return reply({ content: [{ type: "text", text: `unknown tool ${m.params?.name}` }], isError: true });
    }
    case "resources/list":
      return reply({ resources: [{ uri: APP, name: "board app", mimeType: "text/html;profile=mcp-app" }] });
    case "resources/read":
      if (m.params?.uri === APP) return reply({ contents: [{ uri: APP, mimeType: "text/html;profile=mcp-app", text: HTML, _meta: { ui: { prefersBorder: true, csp: domains ? { connectDomains: ["https://api.example.com"], resourceDomains: ["https://cdn.example.com"] } : {} } } }] });
      return error(-32002, `no resource ${m.params?.uri}`);
    default:
      return error(-32601, `Method not found: ${m.method}`);
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
