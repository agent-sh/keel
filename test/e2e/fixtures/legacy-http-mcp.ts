#!/usr/bin/env bun
// A legacy (2025-11-25) Streamable HTTP MCP server with a session, for the
// paths only such a server has: a session it ends (404 from then on), the
// standalone GET stream it sends list and resource updates on, a response it
// never finishes, and a resource page that fails once.
//
// Run as a script it prints its port on the first line. POST /control changes
// what it does; GET /stats says what it saw.
export type LegacyStats = {
  initializes: number;
  sessions: string[];                                             // every session ID given out, in order
  calls: { tool: string; session: string | null; status: number }[]; // every tools/call POST that arrived
  cursors: (string | null)[];                                     // the cursor of every resources/list
  streams_opened: number;
  streams_closed: number;                                         // GET streams the client closed
  last_event_ids: (string | null)[];                              // the Last-Event-ID of every GET
  gets_declined: number;
  aborted: number;                                                // responses the client gave up on
  cancelled: number[];                                            // request IDs of notifications/cancelled
  deletes: number;
};

export function startLegacyMcp(opt: { declineGet?: boolean } = {}) {
  const stats: LegacyStats = { initializes: 0, sessions: [], calls: [], cursors: [], streams_opened: 0, streams_closed: 0, last_event_ids: [], gets_declined: 0, aborted: 0, cancelled: [], deletes: 0 };
  const live = new Set<string>();
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  let declineGet = !!opt.declineGet;
  let failPage = false;
  let extra = false;   // a third resource, there after a list change
  let version = 1;     // the body of legacy://one
  let eventId = 0;
  const enc = new TextEncoder();
  const tools = () => [
    { name: "echo", description: "Echo the given text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "hang", description: "Never answers.", inputSchema: { type: "object", properties: {} } },
    ...(extra ? [{ name: "late", description: "A tool added later.", inputSchema: { type: "object", properties: {} } }] : []),
  ];
  const rpcError = (id: unknown, code: number, message: string, status = 200) => Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });
  const end = (sid: string) => {
    const c = streams.get(sid);
    streams.delete(sid);
    try { c?.close(); } catch {} // the client closed it first
  };
  const emit = (method: string, params?: unknown) => {
    let sent = 0;
    for (const c of streams.values()) {
      c.enqueue(enc.encode(`id: ${++eventId}\ndata: ${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n\n`));
      sent++;
    }
    return sent;
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0, // the GET stream and the hung response stay open
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/stats") return Response.json({ ...stats, streams_open: streams.size, live: [...live] });
      if (url.pathname === "/control") {
        const b = (await req.json()) as any;
        if (b.expire) { for (const sid of [...live]) end(sid); live.clear(); }
        if (b.decline_get !== undefined) declineGet = !!b.decline_get;
        if (b.fail_page) failPage = true;
        if (b.drop_stream) for (const sid of [...streams.keys()]) end(sid);
        let sent = 0;
        if (b.emit === "resources/updated") { version++; sent = emit("notifications/resources/updated", { uri: b.uri ?? "legacy://one" }); }
        else if (b.emit === "resources/list_changed") { extra = true; sent = emit("notifications/resources/list_changed"); }
        else if (b.emit === "tools/list_changed") { extra = true; sent = emit("notifications/tools/list_changed"); }
        return Response.json({ ok: true, sent });
      }
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
      const sid = req.headers.get("mcp-session-id");

      if (req.method === "GET") {
        stats.last_event_ids.push(req.headers.get("last-event-id"));
        if (declineGet) { stats.gets_declined++; return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } }); }
        if (!sid) return rpcError(null, -32000, "Bad Request: no session", 400);
        if (!live.has(sid)) return rpcError(null, -32001, "Session not found", 404);
        stats.streams_opened++;
        let mine: ReadableStreamDefaultController<Uint8Array>;
        const gone = () => { if (streams.get(sid) === mine) streams.delete(sid); stats.streams_closed++; };
        req.signal.addEventListener("abort", gone, { once: true });
        return new Response(new ReadableStream<Uint8Array>({
          start(c) {
            mine = c;
            end(sid); // one stream per session: a new one replaces the old
            streams.set(sid, c);
            c.enqueue(enc.encode(`id: ${++eventId}\nretry: 50\ndata:\n\n`)); // the priming event: come back 50 ms after a cut
          },
        }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }
      if (req.method === "DELETE") {
        stats.deletes++;
        if (sid) live.delete(sid); // its stream is left for the client to close
        return new Response(null, { status: 200 });
      }

      const m = (await req.json()) as any;
      if (m.method === "initialize") {
        stats.initializes++;
        const id = crypto.randomUUID();
        stats.sessions.push(id);
        live.add(id);
        return Response.json({ jsonrpc: "2.0", id: m.id, result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: true }, resources: { listChanged: true, subscribe: true } },
          serverInfo: { name: "legacy-http-mcp", version: "1.0.0" },
        } }, { headers: { "mcp-session-id": id } });
      }
      const known = !!sid && live.has(sid);
      if (m.method === "tools/call") stats.calls.push({ tool: String(m.params?.name), session: sid, status: !sid ? 400 : known ? 200 : 404 });
      if (!sid) return rpcError(m.id, -32000, "Bad Request: no session", 400);
      if (!known) return rpcError(null, -32001, "Session not found", 404);
      if (m.id === undefined) {
        if (m.method === "notifications/cancelled") stats.cancelled.push(m.params?.requestId);
        return new Response(null, { status: 202 });
      }
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: m.id, result });
      switch (m.method) {
        case "tools/list":
          return reply({ tools: tools() });
        case "tools/call":
          if (m.params?.name === "hang") {
            // Headers and a first event go out; the answer never does.
            req.signal.addEventListener("abort", () => { stats.aborted++; }, { once: true });
            return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(": working\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
          }
          return reply({ content: [{ type: "text", text: `echo: ${m.params?.arguments?.text}` }] });
        case "resources/list": {
          const cursor = m.params?.cursor ?? null;
          stats.cursors.push(cursor);
          if (cursor === null) return reply({ resources: [{ uri: "legacy://one", name: "one" }], nextCursor: "p2" });
          if (cursor !== "p2") return rpcError(m.id, -32602, "Invalid cursor");
          if (failPage) { failPage = false; return rpcError(m.id, -32603, "the second page is not ready"); }
          return reply({ resources: [{ uri: "legacy://two", name: "two" }, ...(extra ? [{ uri: "legacy://three", name: "three" }] : [])] });
        }
        case "resources/templates/list":
          return reply({ resourceTemplates: [{ uriTemplate: "legacy://item/{id}", name: "item" }] });
        case "resources/read":
          return reply({ contents: [{ uri: m.params?.uri, mimeType: "text/plain", text: `${m.params?.uri} version ${version}` }] });
        case "resources/subscribe":
          return reply({});
        default:
          return rpcError(m.id, -32601, `Method not found: ${m.method}`);
      }
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    port: server.port,
    url: `${base}/mcp`,
    stats: async () => (await (await fetch(`${base}/stats`)).json()) as LegacyStats & { streams_open: number; live: string[] },
    control: async (b: Record<string, unknown>) => (await (await fetch(`${base}/control`, { method: "POST", body: JSON.stringify(b) })).json()) as { ok: boolean; sent: number },
    stop: () => server.stop(true),
  };
}

if (import.meta.main) console.log(String(startLegacyMcp({ declineGet: process.argv.includes("--decline-get") }).port));
