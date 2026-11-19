// Deferred tools loaded on demand, the way Claude Code does it on the
// Anthropic wire: every MCP tool and the rarely used built-ins go in the
// request with defer_loading, which keeps them out of the prompt; ToolSearch
// answers with tool_reference blocks, and the provider puts each named tool's
// definition in place of its block. The model then calls the tool by its own
// name (mcp__<server>__<tool> for an MCP tool). The deferred set can change
// between requests without touching the cached prefix (measured on Bedrock:
// a different set of deferred tools read the whole prefix from cache).
//
// Families and wires without this (GPT on Responses, Gemini, Claude through a
// route that refuses it) keep the provider-neutral pair search_tools/mcp_call
// and every built-in eager.
import type { Message } from "../core/types.ts";
import { catalogReady, catalogTools, score, type CatalogTool } from "./catalog.ts";
import { fail, type Tool, type ToolOutput } from "./types.ts";

export const TOOL_SEARCH = "ToolSearch";

// Built-ins Claude Code defers today (Monitor, NotebookEdit, SendMessage,
// TaskStop, WebFetch, the schedule tools) plus Keel's own rarely used ones.
// Every other tool of the family stays in the prompt.
export const DEFERRED_BUILTINS = new Set([
  "NotebookEdit", "TaskStop", "WebFetch", "WebSearch",
  "Monitor", "SendMessage", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "PushNotification",
  "request_secret", "advisor",
  "keel__machines_list", "keel__run_on", "keel__sessions_list", "keel__session_send", "keel__send_files",
  "keel__context_status", "keel__new_context", "keel__spawn_on_machine",
]);

// A wire that answers deferred tools refused them (a model or gateway without
// tool search): that route keeps the search pair from then on.
const refused = new Set<string>();
export const deferRefused = (route: string) => refused.has(route);
// Whether a model's requests carry deferred tools: Claude on the Anthropic wire,
// unless that route refused them.
export const loadsNatively = (wire: string | undefined, info: { id: string; family: string }) =>
  info.family === "claude" && wire === "anthropic_messages" && !refused.has(info.id);
export function refuseDefer(route: string) { refused.add(route); }
// The provider's 400 for a request it cannot take with deferred tools.
export const isDeferError = (e: unknown) =>
  /defer_loading|tool_reference|tool[ _-]?search|deferred tool/i.test(String((e as any)?.message ?? e)) && !/rate|overloaded|timeout/i.test(String((e as any)?.message ?? e));

const NAME_OK = /^[A-Za-z0-9_-]{1,64}$/;
// The name a catalog tool is declared and called by.
export function nativeName(t: Pick<CatalogTool, "qualified" | "mcp">): string {
  const raw = t.mcp ? `mcp__${t.qualified}` : t.qualified;
  if (NAME_OK.test(raw)) return raw;
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  return clean.length <= 64 ? clean : `${clean.slice(0, 57)}_${Bun.hash(raw).toString(36).slice(0, 6)}`;
}

type Deferred = Tool & { catalog?: string };

// What the gate judged for a call, as mcp_call keeps it: a server reloaded
// while the card waited makes the answer one for another tool.
const judged = new WeakMap<object, string>();
const shape = (t: CatalogTool) => JSON.stringify([t.qualified, t.description, t.input_schema, !!t.readOnly]);

function wrap(t: CatalogTool): Deferred {
  const name = nativeName(t);
  return {
    name, description: t.description, input_schema: t.input_schema, defer: true, readOnly: !!t.readOnly, catalog: t.qualified,
    // Judged and granted as the catalog tool, the name mcp_call uses too.
    async target(input) {
      if (input && typeof input === "object") judged.set(input, shape(t));
      return { name: t.qualified, readOnly: !!t.readOnly, input, cls: t.judge ? await t.judge(input) : undefined };
    },
    async run(input, ctx): Promise<ToolOutput> {
      const now = (await catalogTools()).find((x) => x.qualified === t.qualified);
      if (!now) return fail(`${name} is no longer available (its server was removed or is not connected). Search with ${TOOL_SEARCH} again.`);
      const was = input && typeof input === "object" ? judged.get(input) : undefined;
      if (was !== undefined && was !== shape(now)) return fail(`${name} changed while this call waited (its server was reloaded): the answer given was for the old tool. Load it again and call it anew.`);
      return now.run(input ?? {}, ctx);
    },
  };
}

// A tool named by a tool_reference earlier in the conversation that the
// catalog no longer has: still declared, so the request stays valid.
const gone = (name: string): Deferred => ({
  name, description: "No longer available.", input_schema: { type: "object", properties: {} }, defer: true, readOnly: true, catalog: name,
  run: async () => fail(`${name} is no longer available (its server was removed or is not connected).`),
});

export function referenced(messages: Message[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const b of m.content) {
      if (b.type !== "tool_result" || typeof b.content === "string") continue;
      for (const c of b.content) if (c.type === "tool_reference") out.add(c.tool_name);
    }
  }
  return out;
}

// The tools of one request: the family's own (eager and deferred built-ins)
// plus every catalog tool known now, plus stand-ins for referenced tools that left.
export async function withCatalog(tools: Tool[], family: string, messages: Message[]): Promise<Tool[]> {
  const own = tools.filter((t) => !(t as Deferred).catalog);
  const names = new Set(own.map((t) => t.name));
  const cat: Deferred[] = [];
  // A hidden tool (its server turned off) stays declared: a call by name gets the plain reason.
  for (const t of await catalogReady(family)) {
    const w = wrap(t);
    if (names.has(w.name)) continue;
    names.add(w.name);
    cat.push(w);
  }
  for (const n of referenced(messages)) if (!names.has(n)) { names.add(n); cat.push(gone(n)); }
  return [...own, ...cat];
}

// Claude Code's ToolSearch: `select:A,B` for exact names, `+word rest` to
// require a word in the name, else ranked keywords.
export function toolSearch(builtins: () => Tool[]): Tool {
  return {
    name: TOOL_SEARCH,
    readOnly: true,
    get description() {
      const names = builtins().map((t) => t.name);
      return "Fetches full schema definitions for deferred tools so they can be called. Deferred tools are not loaded until " +
        "searched: every MCP server's tools (named mcp__<server>__<tool>) and these built-ins: " + names.join(", ") + ". " +
        "Once loaded, a tool is called directly by its name like any other tool. Query forms: \"select:Read,mcp__github__create_issue\" " +
        "loads exact names; \"+slack send\" requires \"slack\" in the name and ranks by the rest; other words are matched against " +
        "names and descriptions. An empty query lists the deferred tools by server.";
    },
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "select:<names>, or keywords to search for" },
        max_results: { type: "number", description: "Maximum number of tools to load (default 5)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async run(input): Promise<ToolOutput> {
      const query = String(input?.query ?? "").trim();
      const limit = Math.min(Math.max(Number(input?.max_results) || 5, 1), 20);
      const own = builtins().map((t) => ({ name: t.name, qualified: t.name, description: t.description, server: "built-in", hidden: false }));
      const cat = (await catalogTools()).map((t) => ({ name: nativeName(t), qualified: nativeName(t), description: t.description, server: t.server, hidden: !!t.hidden }));
      // A hidden tool answers an exact name only (its call says why it is off).
      const all = [...own, ...cat.filter((c) => !own.some((o) => o.name === c.name))];
      const pool = all.filter((t) => !t.hidden);
      if (!query) {
        const by = new Map<string, string[]>();
        for (const t of pool) by.set(t.server, [...(by.get(t.server) ?? []), t.name]);
        return { content: [...by].map(([s, ns]) => `${s}: ${ns.join(", ")}`).join("\n") || "No deferred tools." };
      }
      let hits: typeof pool;
      if (query.startsWith("select:")) {
        const want = query.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
        hits = want.map((w) => all.find((t) => t.name === w) ?? all.find((t) => t.name.toLowerCase() === w.toLowerCase())).filter(Boolean) as typeof pool;
        const missing = want.filter((w) => !hits.some((h) => h.name.toLowerCase() === w.toLowerCase()));
        if (!hits.length) return fail(`No deferred tool named ${missing.join(", ")}. Search by keywords instead.`);
      } else {
        const m = /^\+(\S+)\s*(.*)$/.exec(query);
        const need = m?.[1]?.toLowerCase();
        const rest = m ? m[2]! : query;
        hits = pool
          .filter((t) => !need || t.name.toLowerCase().includes(need))
          .map((t) => ({ t, s: score(t, rest || need!) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name))
          .map((x) => x.t);
        if (!hits.length) return { content: `No deferred tool matches "${query}". An empty query lists them all.` };
      }
      // The provider takes tool_reference blocks alone in a result (mixed with text it answers 400).
      return { content: hits.slice(0, limit).map((t) => ({ type: "tool_reference" as const, tool_name: t.name })) };
    },
  };
}
