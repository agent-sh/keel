#!/usr/bin/env bun
// A stdio MCP server for the token benchmark's "catalog" task: one of three
// business servers (crm, billing, ops), 40 tools each with real-sized schemas,
// so finding the right two or three tools among 120 is the work. Answers are
// deterministic: ids are hashes of what was asked, so a reply proves the calls.
//   bun catalog-mcp.ts <crm|billing|ops>
const server = ["crm", "billing", "ops"].includes(Bun.argv[2] ?? "") ? Bun.argv[2]! : "crm";
const h = (s: string) => Bun.hash(s).toString(36).slice(0, 6).toUpperCase();

const CUSTOMERS = [
  { id: "C-1001", name: "Ada Lovelace", email: "ada@example.com" },
  { id: "C-1002", name: "Grace Hopper", email: "grace@example.com" },
  { id: "C-1003", name: "Alan Turing", email: "alan@example.com" },
];
// Ada's last invoice holds the same charge twice.
const INVOICES: Record<string, any[]> = {
  "C-1001": [
    { id: "INV-77", date: "2026-10-01", charges: [{ id: "CH-501", amount: 49, item: "Pro plan" }] },
    { id: "INV-91", date: "2026-11-01", charges: [{ id: "CH-610", amount: 49, item: "Pro plan" }, { id: "CH-611", amount: 49, item: "Pro plan" }, { id: "CH-612", amount: 12, item: "Extra seat" }] },
  ],
  "C-1002": [{ id: "INV-92", date: "2026-11-01", charges: [{ id: "CH-620", amount: 49, item: "Pro plan" }] }],
  "C-1003": [{ id: "INV-93", date: "2026-11-01", charges: [{ id: "CH-630", amount: 99, item: "Team plan" }] }],
};

const str = (description: string) => ({ type: "string", description });
const filler = {
  page_size: { type: "integer", description: "Results per page (1-200, default 50)." },
  page_token: str("Opaque token from a previous page to continue the listing."),
  fields: { type: "array", items: { type: "string" }, description: "Fields to include in each result; all fields when omitted." },
};
type Def = { name: string; description: string; props: Record<string, unknown>; required: string[]; run?: (a: any) => string };

const VERBS = ["list", "get", "create", "update", "archive", "export", "search", "count", "merge", "tag"];
const pad = (domain: string, nouns: string[], have: string[]): Def[] => {
  const out: Def[] = [];
  for (const noun of nouns) for (const v of VERBS) {
    const name = `${v}_${noun}`;
    if (have.includes(name) || out.length + have.length >= 40) continue;
    out.push({
      name,
      description: `${v[0]!.toUpperCase()}${v.slice(1)} ${noun.replace(/_/g, " ")} records in the ${domain} system. Returns JSON. Use the filters to narrow the result; large results are paged.`,
      props: { id: str(`The ${noun.replace(/_/g, " ")} id, when the action targets one record.`), query: str("Free-text filter."), ...filler },
      required: v === "list" || v === "search" || v === "count" || v === "export" ? [] : ["id"],
    });
  }
  return out;
};

const real: Record<string, Def[]> = {
  crm: [
    { name: "find_customer", description: "Find customers by name or email. Returns [{id, name, email}].", props: { query: str("Name or email, or part of one."), ...filler }, required: ["query"],
      run: (a) => JSON.stringify(CUSTOMERS.filter((c) => `${c.name} ${c.email}`.toLowerCase().includes(String(a.query ?? "").toLowerCase()))) },
    { name: "add_customer_note", description: "Add a note to a customer's record. Returns the note id.", props: { customer_id: str("The customer id (C-...)."), text: str("The note text."), pinned: { type: "boolean", description: "Pin the note at the top." } }, required: ["customer_id", "text"],
      run: (a) => CUSTOMERS.some((c) => c.id === a.customer_id) ? JSON.stringify({ note_id: `N-${h(`${a.customer_id}|${String(a.text).trim().toLowerCase()}`)}` }) : `no customer ${a.customer_id}` },
  ],
  billing: [
    { name: "list_invoices", description: "List a customer's invoices with their charges, newest last.", props: { customer_id: str("The customer id (C-...)."), status: { type: "string", enum: ["open", "paid", "void"] }, ...filler }, required: ["customer_id"],
      run: (a) => JSON.stringify(INVOICES[a.customer_id] ?? []) },
    { name: "refund_charge", description: "Refund one charge of an invoice in full. Returns the refund id.", props: { charge_id: str("The charge id (CH-...)."), reason: { type: "string", enum: ["duplicate", "fraudulent", "requested_by_customer"] } }, required: ["charge_id", "reason"],
      run: (a) => Object.values(INVOICES).flat().some((i) => i.charges.some((c: any) => c.id === a.charge_id)) ? JSON.stringify({ refund_id: `RF-${h(`${a.charge_id}|${a.reason}`)}` }) : `no charge ${a.charge_id}` },
  ],
  ops: [],
};
const nouns: Record<string, string[]> = {
  crm: ["contact", "account", "deal", "lead", "activity", "segment"],
  billing: ["subscription", "coupon", "payment_method", "tax_rate", "credit_note", "payout"],
  ops: ["deployment", "incident", "alert_rule", "runbook", "service", "on_call_shift"],
};
const defs = [...real[server]!, ...pad(server, nouns[server]!, real[server]!.map((d) => d.name))];
const tools = defs.map((d) => ({ name: d.name, description: d.description, inputSchema: { type: "object", properties: d.props, required: d.required } }));

export const want = () => ({
  refund: `RF-${h("CH-611|duplicate")}`,
  refundAlt: `RF-${h("CH-610|duplicate")}`,
  note: (text: string) => `N-${h(`C-1001|${text.trim().toLowerCase()}`)}`,
});

if (import.meta.main) {
  const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
  const handle = (m: any) => {
    if (m.id === undefined) return;
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
    const text = (t: string, isError = false) => reply({ content: [{ type: "text", text: t }], isError });
    switch (m.method) {
      case "initialize":
        return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: server, version: "1.0.0" } });
      case "tools/list":
        return reply({ tools });
      case "tools/call": {
        const d = defs.find((x) => x.name === m.params?.name);
        if (!d) return text(`unknown tool ${m.params?.name}`, true);
        return text(d.run ? d.run(m.params?.arguments ?? {}) : JSON.stringify({ items: [], next_page_token: null }));
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
