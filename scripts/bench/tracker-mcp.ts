#!/usr/bin/env bun
// A stdio MCP server for the token benchmark's "tracker" task: an issue tracker
// whose list gives ids and titles only, so finding tickets by assignee and
// priority takes one get_ticket per ticket. Deterministic data.
export const TICKETS = Array.from({ length: 40 }, (_, i) => {
  const n = i + 1;
  return {
    id: `T-${100 + n}`,
    title: `Ticket ${n}: ${["checkout fails", "slow search", "wrong tax", "missing email", "login loop"][i % 5]}`,
    status: i % 4 === 3 ? "closed" : "open",
    assignee: ["ada", "grace", "linus", "ada", "barbara"][i % 5]!,
    priority: ["high", "low", "medium"][(i * 7) % 3]!,
    description: `Reported by a customer. ${"Steps: open the page, add two items, go to checkout, apply a coupon, pay. Expected the order to go through; it did not. ".repeat(8)}`,
    comments: Array.from({ length: 4 }, (_, j) => ({ author: ["support", "qa", "dev"][j % 3], text: `Comment ${j + 1} on ticket ${n}: looked at the logs, nothing conclusive yet, will check again after the next deploy.` })),
  };
});

const tools = [
  { name: "list_tickets", description: "List tickets: [{id, title, status}]. Filter by status (open or closed).", inputSchema: { type: "object", properties: { status: { type: "string", enum: ["open", "closed"] } } } },
  { name: "get_ticket", description: "One ticket in full as JSON: id, title, status, assignee, priority, description, comments.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

if (import.meta.main) {
  const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
  const handle = (m: any) => {
    if (m.id === undefined) return;
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
    const text = (t: string, isError = false) => reply({ content: [{ type: "text", text: t }], isError });
    switch (m.method) {
      case "initialize":
        return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "tracker", version: "1.0.0" } });
      case "tools/list":
        return reply({ tools });
      case "tools/call": {
        const a = m.params?.arguments ?? {};
        if (m.params?.name === "list_tickets") return text(JSON.stringify(TICKETS.filter((t) => !a.status || t.status === a.status).map(({ id, title, status }) => ({ id, title, status }))));
        if (m.params?.name === "get_ticket") {
          const t = TICKETS.find((t) => t.id === a.id);
          return t ? text(JSON.stringify(t, null, 1)) : text(`no ticket ${a.id}`, true);
        }
        return text(`unknown tool ${m.params?.name}`, true);
      }
      default:
        return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
    }
  };
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handle(JSON.parse(line));
    }
  });
}
