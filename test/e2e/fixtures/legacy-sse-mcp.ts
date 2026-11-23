#!/usr/bin/env bun
// An MCP server of the older HTTP with SSE transport (2024-11-05), the kind
// that has no Streamable HTTP address at all: GET /sse opens an event stream
// whose first event names where messages are posted, a POST there is only
// accepted (202), and every answer comes back on the stream. A POST to /sse
// itself is refused with 405, as such servers do.
//
// Run as a script it prints its port on the first line. POST /control changes
// what it does; GET /stats says what it saw.
export type SseStats = { streams_opened: number; streams_closed: number; refused_posts: number; initializes: number; calls: string[]; pongs: unknown[]; authorization: (string | null)[] };

// `endpoint`: what the first event names ("elsewhere": an address of another
// origin; "never": the stream opens and names nothing). `accepted`: the body
// of an accepted POST (some servers say "Accepted" in text). `moved`: the
// address named for messages answers every POST with a redirect to this one.
export function startSseMcp(opt: { endpoint?: "path" | "elsewhere" | "never"; accepted?: string; moved?: string } = {}) {
  const stats: SseStats = { streams_opened: 0, streams_closed: 0, refused_posts: 0, initializes: 0, calls: [], pongs: [], authorization: [] };
  const enc = new TextEncoder();
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const send = (session: string, msg: unknown) => streams.get(session)?.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(msg)}\n\n`));
  const answer = (m: any): Record<string, unknown> => {
    switch (m.method) {
      case "initialize":
        stats.initializes++;
        return { result: { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "legacy-sse", version: "1" } } };
      case "tools/list":
        return { result: { tools: [{ name: "echo", description: "Echo the given text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } };
      case "tools/call":
        stats.calls.push(String(m.params?.arguments?.text ?? ""));
        return { result: { content: [{ type: "text", text: `echo: ${m.params?.arguments?.text ?? ""}` }] } };
      case "ping":
        return { result: {} };
      default:
        return { error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/stats") return Response.json({ ...stats, streams_open: streams.size });
      if (u.pathname === "/control" && req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as { changed?: boolean; ping?: boolean; close?: boolean; flood?: number };
        for (const session of [...streams.keys()]) {
          // Data lines of 64 KiB with no blank line after them: one event that never ends.
          for (let i = 0; i < (b.flood ?? 0); i++) streams.get(session)?.enqueue(enc.encode(`data: ${"x".repeat(64 * 1024)}\n`));
          if (b.changed) send(session, { jsonrpc: "2.0", method: "notifications/tools/list_changed" });
          if (b.ping) send(session, { jsonrpc: "2.0", id: "ping-1", method: "ping" });
          if (b.close) { streams.get(session)!.close(); streams.delete(session); stats.streams_closed++; }
        }
        return Response.json({ ok: true });
      }
      if (u.pathname === "/sse") {
        if (req.method !== "GET") { stats.refused_posts++; return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } }); }
        const session = crypto.randomUUID();
        stats.streams_opened++;
        stats.authorization.push(req.headers.get("authorization"));
        const named = opt.endpoint === "elsewhere" ? `http://127.0.0.1:9/messages?session=${session}` : `/messages?session=${session}`;
        return new Response(new ReadableStream<Uint8Array>({
          start(c) { streams.set(session, c); if (opt.endpoint !== "never") c.enqueue(enc.encode(`event: endpoint\ndata: ${named}\n\n`)); },
          cancel() { if (streams.delete(session)) stats.streams_closed++; },
        }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }
      if (u.pathname === "/messages" && req.method === "POST") {
        const session = u.searchParams.get("session") ?? "";
        if (!streams.has(session)) return new Response("no such session", { status: 404 });
        if (opt.moved) return Response.redirect(opt.moved, 307);
        const m = (await req.json()) as any;
        if (m.method && m.id !== undefined) queueMicrotask(() => send(session, { jsonrpc: "2.0", id: m.id, ...answer(m) }));
        else if (!m.method && m.id !== undefined) stats.pongs.push({ id: m.id, result: m.result });
        return opt.accepted === undefined ? new Response(null, { status: 202 }) : new Response(opt.accepted, { status: 200, headers: { "content-type": "text/plain" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    port: server.port,
    url: `${base}/sse`,
    stats: async () => (await (await fetch(`${base}/stats`)).json()) as SseStats & { streams_open: number },
    control: async (b: Record<string, unknown>) => (await (await fetch(`${base}/control`, { method: "POST", body: JSON.stringify(b) })).json()) as { ok: boolean },
    stop: () => server.stop(true),
  };
}

if (import.meta.main) console.log(String(startSseMcp().port));
