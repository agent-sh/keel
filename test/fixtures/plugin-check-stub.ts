#!/usr/bin/env bun
// A minimal protocol v1 plugin (chat_completions wire) for the conformance
// runner's own test. Its first argument makes it misbehave: leak (the
// credential on stderr), body (changes the body), nocancel, noretry, refuse
// (it does not take this host).
const BAD = process.argv[2] ?? "";
const base = process.env.KEEL_PLUGIN_TEST_BASE_URL!;
const cred = process.env.KEEL_PLUGIN_TEST_CREDENTIAL!;
const out = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const reqs = new Map<string, AbortController>();
if (BAD === "leak") console.error(`token ${cred}`);
let buf = "";
for await (const c of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(c);
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    handle(m);
  }
}
for (const [, a] of reqs) a.abort();
process.exit(0);

function handle(m: any) {
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize":
      if (BAD === "refuse") return out({ id: m.id, error: { code: -32003, message: "this host is not supported" } });
      if (!p.protocol_versions.includes(1)) return out({ id: m.id, error: { code: -32000, message: "no common version", data: { supported: [1] } } });
      return out({ id: m.id, result: { protocol_version: 1, plugin: { id: p.plugin_id, name: "Stub", version: "0.0.1" }, providers: [{ id: "stub", label: "Stub", wire: "chat_completions", stream_format: "sse", response_headers: BAD === "noretry" ? ["content-type"] : ["content-type", "retry-after"] }], capabilities: { cancel: BAD !== "nocancel", max_concurrent: 8, status: true, ping: true } } });
    case "models/list":
      return out({ id: m.id, result: { providers: [{ provider: "stub", models: [{ id: "stub-1", label: "Stub 1", family: "other", context_window: 1000, max_output: 100, capabilities: { tools: true }, billing: { kind: "unknown" } }] }] } });
    case "status":
      return out({ id: m.id, result: { providers: [{ provider: "stub", state: "ready" }] } });
    case "ping":
      return out({ id: m.id, result: {} });
    case "shutdown":
      for (const [id, a] of reqs) { a.abort(); out({ method: "response/error", params: { request_id: id, kind: "cancelled", message: "shutdown" } }); reqs.delete(id); }
      return out({ id: m.id, result: {} });
    case "request/cancel": {
      if (BAD === "nocancel") return;
      const a = reqs.get(p.request_id);
      if (a) { a.abort(); reqs.delete(p.request_id); out({ method: "response/error", params: { request_id: p.request_id, kind: "cancelled", message: "cancelled" } }); }
      return;
    }
    case "request/start":
      out({ id: m.id, result: {} });
      return void send(p);
    default:
      if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: "method not found" } });
  }
}

async function send(p: any) {
  const a = new AbortController();
  reqs.set(p.request_id, a);
  let body = Buffer.from(p.body, "base64");
  if (BAD === "body") body = Buffer.from(body.toString().replace("List the files", "List  the files"));
  try {
    const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { ...p.headers, authorization: `Bearer ${cred}` }, body, signal: a.signal });
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { if (k === "content-type" || (k === "retry-after" && BAD !== "noretry")) headers[k] = v; });
    out({ method: "response/head", params: { request_id: p.request_id, status: r.status, headers } });
    for await (const c of r.body as any) {
      if (!reqs.has(p.request_id)) return;
      out({ method: "response/chunk", params: { request_id: p.request_id, data: Buffer.from(c).toString("base64") } });
    }
    if (reqs.delete(p.request_id)) out({ method: "response/end", params: { request_id: p.request_id } });
  } catch (e) {
    if (reqs.delete(p.request_id)) out({ method: "response/error", params: { request_id: p.request_id, kind: "network", message: String(e) } });
  }
}
