#!/usr/bin/env bun
// A legacy (2025-11-25) HTTP MCP server whose tool `job` runs as a task that ends when it is told to (POST /control
// {"finish": true}), and that lives outside the daemon: a daemon restarted meanwhile finds the task where it left it.
// Run as a script it prints its port on the first line. GET /stats says what it saw: the task requests in order.
const seen: { method: string; taskId?: string }[] = [];
const tasks = new Map<string, { status: string }>();
let n = 0, finish = false;
const shape = (id: string) => ({ taskId: id, status: finish && tasks.get(id)!.status === "working" ? "completed" : tasks.get(id)!.status, createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttl: 600_000, pollInterval: 200 });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.TASK_MCP_PORT ?? 0),
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/stats") return Response.json({ seen });
    if (url.pathname === "/control") {
      const b = (await req.json()) as any;
      if ("finish" in b) finish = !!b.finish;
      if (finish) for (const t of tasks.values()) if (t.status === "working") t.status = "completed";
      return Response.json({ ok: true });
    }
    if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
    if (req.method === "GET") return new Response(null, { status: 405, headers: { allow: "POST" } });
    if (req.method === "DELETE") return new Response(null, { status: 200 });
    const m = (await req.json()) as any;
    if (m.id === undefined || !m.method) return new Response(null, { status: 202 });
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: m.id, result });
    const fail = (code: number, message: string) => Response.json({ jsonrpc: "2.0", id: m.id, error: { code, message } });
    switch (m.method) {
      case "initialize":
        return reply({ protocolVersion: "2025-11-25", capabilities: { tools: {}, tasks: { cancel: {}, requests: { tools: { call: {} } } } }, serverInfo: { name: "task-http-mcp", version: "1.0.0" } });
      case "tools/list":
        return reply({ tools: [{ name: "job", description: "Runs as a task until it is told to end.", inputSchema: { type: "object", properties: {} }, execution: { taskSupport: "required" } }] });
      case "tools/call": {
        if (!m.params?.task) return fail(-32601, "job runs only as a task");
        const id = `job-${++n}`;
        tasks.set(id, { status: "working" });
        seen.push({ method: "tools/call", taskId: id });
        return reply({ task: shape(id) });
      }
      case "tasks/get": case "tasks/result": case "tasks/cancel": {
        const id = String(m.params?.taskId);
        seen.push({ method: m.method, taskId: id });
        const t = tasks.get(id);
        if (!t) return fail(-32602, "no such task");
        if (finish && t.status === "working") t.status = "completed";
        if (m.method === "tasks/cancel") { t.status = "cancelled"; return reply(shape(id)); }
        if (m.method === "tasks/get") return reply(shape(id));
        return t.status === "completed" ? reply({ content: [{ type: "text", text: `task ${id} result` }], _meta: { "io.modelcontextprotocol/related-task": { taskId: id } } }) : fail(-32603, `the task was ${t.status}`);
      }
      default:
        return fail(-32601, `Method not found: ${m.method}`);
    }
  },
});
console.log(server.port);
