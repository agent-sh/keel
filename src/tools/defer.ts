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
import { testBuild } from "../core/build.ts";
import type { Message } from "../core/types.ts";
import { catalogReady, catalogTools, judgedOf, score, stale, unavailableNote, type CatalogTool, type Judged } from "./catalog.ts";
import { fail, type Tool, type ToolOutput } from "./types.ts";

export const TOOL_SEARCH = "ToolSearch";

// Built-ins Claude Code defers today (Monitor, NotebookEdit, SendMessage,
// TaskStop, WebFetch, the schedule tools), Glob and Grep (Claude Code on Linux
// offers neither: its models search with the shell; 3 Grep and no Glob calls in
// 30 Claude bench runs), plus Keel's own rarely used ones.
// Every other tool of the family stays in the prompt.
export const DEFERRED_BUILTINS = new Set([
  "Glob", "Grep", "NotebookEdit", "TaskStop", "WebFetch", "WebSearch",
  "Monitor", "SendMessage", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "PushNotification",
  "request_secret", "advisor",
  "keel__machines_list", "keel__run_on", "keel__sessions_list", "keel__session_send", "keel__send_files",
  "keel__context_status", "keel__new_context", "keel__session_timeline", "keel__spawn_on_machine", "keel__agents_now",
  "keel__landing_queue",
]);

// A wire that answers deferred tools refused them (a model or gateway without
// tool search): that route keeps the search pair from then on.
const refused = new Set<string>();
export const deferRefused = (route: string) => refused.has(route);
// Whether a model's requests carry deferred tools: Claude on the Anthropic wire,
// unless that route refused them.
// GPT on the Responses wire too (its client tool_search, as Codex runs it).
// A route that refuses either answers once and keeps the search pair after.
export const loadsNatively = (wire: string | undefined, info: { id: string; family: string }) =>
  ((info.family === "claude" && wire === "anthropic_messages") || (info.family === "gpt" && wire === "openai_responses")) && !refused.has(info.id);
export function refuseDefer(route: string) { refused.add(route); }
// The provider's 400 for a request it cannot take with deferred tools.
export const isDeferError = (e: unknown) =>
  /defer_loading|tool_reference|tool[ _-]?search|deferred tool/i.test(String((e as any)?.message ?? e)) && !/rate|overloaded|timeout/i.test(String((e as any)?.message ?? e));

const NAME_OK = /^[A-Za-z0-9_-]{1,64}$/;
// The name a catalog tool is declared and called by: its own name when the
// wire takes it, else the name made fit plus a hash of the original. Two tools
// never share one (MCP names may hold dots: search.docs and search_docs are two
// tools), and the name depends on nothing else in the catalog, so it stays the
// same across a refresh or another order.
export function nativeName(t: Pick<CatalogTool, "qualified" | "mcp">): string {
  const raw = t.mcp ? `mcp__${t.qualified}` : t.qualified;
  if (NAME_OK.test(raw)) return raw;
  const h = Bun.hash(raw).toString(36).padStart(8, "0").slice(-8);
  return `${raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 55)}_${h}`;
}

// What a call to a tool the request does not declare is told besides its name:
// a catalog tool called by its own name where catalog tools run through the
// search pair is named with the call that runs it, and one where they load
// on demand with the search that loads it.
export async function unknownToolHint(name: string, tools: Tool[], session?: string): Promise<string> {
  const t = (await catalogTools(session)).find((c) => !c.hidden && (nativeName(c) === name || c.qualified === name));
  const call = tools.some((x) => x.name === "mcp_call");
  const search = tools.find((x) => x.search || x.name === TOOL_SEARCH)?.name;
  if (t && call) return ` It is ${t.mcp ? `the tool ${t.name} of the MCP server ${t.server}` : `the tool ${t.qualified}`}, which is not loaded as a tool of its own here: run it with mcp_call {"tool": "${t.qualified}", "arguments": {...}}.`;
  if (t && search) return ` Load it first with ${search} "select:${nativeName(t)}", then call it by that name.`;
  if (name.startsWith("mcp__")) return call ? " No connected MCP server offers it: find MCP tools with search_tools and run them with mcp_call." : search ? ` No connected MCP server offers it: find MCP tools with ${search}.` : "";
  return "";
}

// `left`: a stand-in for a tool the catalog no longer has.
type Deferred = Tool & { catalog?: string; left?: true };

// What the gate judged for a call, as mcp_call keeps it: a server reloaded
// while the card waited makes the answer one for another tool.
const judged = new WeakMap<object, Judged>();

// The namespace a tool loads under where the wire groups deferred tools: its
// server's (mcp__<server> for an MCP server, as Codex names them), when its
// native name is that prefix and a name of its own.
function namespaceOf(t: CatalogTool, name: string): string | undefined {
  const ns = t.mcp ? `mcp__${t.server}` : t.server;
  return name.startsWith(`${ns}__`) && name.length > ns.length + 2 ? ns : undefined;
}

function wrap(t: CatalogTool): Deferred {
  const name = nativeName(t);
  // The stand-in build of the upgrade e2e rewords catalog tools too (src/core/build.ts).
  const as = testBuild?.tools?.[name];
  return {
    name, description: as?.description ?? t.description, input_schema: as?.input_schema ?? t.input_schema, defer: true, readOnly: !!t.readOnly, catalog: t.qualified, namespace: namespaceOf(t, name),
    // Judged and granted as the catalog tool, the name mcp_call uses too.
    async target(input) {
      const j = judgedOf(t);
      if (input && typeof input === "object") judged.set(input, j);
      return { name: t.qualified, readOnly: !!t.readOnly, input, source: t.source, shape: j.shape, cls: t.judge ? await t.judge(input) : undefined };
    },
    async run(input, ctx): Promise<ToolOutput> {
      const now = (await catalogTools(ctx?.sessionId)).find((x) => x.qualified === t.qualified);
      if (!now) return fail(`${name} is no longer available (its server was removed or is not connected). ${unavailableNote(ctx?.sessionId)} Search with ${TOOL_SEARCH} again.`.replace("  ", " "));
      const why = stale(input && typeof input === "object" ? judged.get(input) : undefined, now, name, "Load it again");
      if (why) return fail(why);
      const deny = ctx.authorizationError?.();
      if (deny) return fail(deny);
      return now.run(input ?? {}, ctx);
    },
  };
}

// A tool named by a tool_reference earlier in the conversation that the
// catalog no longer has: still declared, so the request stays valid.
const gone = (name: string): Deferred => ({
  name, description: "No longer available.", input_schema: { type: "object", properties: {} }, defer: true, readOnly: true, catalog: name, left: true,
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
// Two catalog tools that still share a native name (a hash clash, or one
// server listing a name twice) are reported once each; the first one stays.
const clashes = new Set<string>();
export async function withCatalog(tools: Tool[], family: string, messages: Message[], report?: (e: Error, context: unknown) => void, session?: string): Promise<Tool[]> {
  const own = tools.filter((t) => !(t as Deferred).catalog);
  const names = new Set(own.map((t) => t.name));
  const cat: Deferred[] = [];
  // A hidden tool (its server turned off) stays declared: a call by name gets the plain reason.
  for (const t of await catalogReady(family, session)) {
    const w = wrap(t);
    if (names.has(w.name)) {
      const first = cat.find((c) => c.name === w.name);
      const key = `${w.name}\u0000${first?.catalog}\u0000${t.qualified}`;
      if (first && first.catalog !== t.qualified && !clashes.has(key)) {
        clashes.add(key);
        report?.(new Error(`two deferred tools share the name ${w.name}: ${first.catalog} is declared, ${t.qualified} is not`), { tool: t.qualified, kept: first.catalog });
      }
      continue;
    }
    names.add(w.name);
    cat.push(w);
  }
  for (const n of referenced(messages)) if (!names.has(n)) { names.add(n); cat.push(gone(n)); }
  return [...own, ...cat];
}

// Codex's tool_search for GPT on the Responses wire: the model sends a query,
// Keel ranks the deferred tools and answers with the ones that match, which
// the wire sends back as the loaded namespaces (tool_search_output). Same
// ranking as ToolSearch; Codex's name, words and arguments.
export function gptToolSearch(builtins: (sessionId?: string) => Tool[]): Tool {
  const inner = toolSearch(builtins);
  return {
    name: "tool_search",
    search: true,
    readOnly: true,
    description: "# Tool discovery\n\nSearches over deferred tool metadata and exposes matching tools for the next model call.\n\n" +
      "Some of the tools may not have been provided to you upfront, and you should use this tool (`tool_search`) to search for the required tools: " +
      "every MCP server's tools (each server is a namespace mcp__<server>) and other tools used less often. For MCP tool discovery, always use `tool_search` instead of listing MCP resources.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for deferred tools." },
        limit: { type: "number", description: "Maximum number of tools to return. Defaults to 8." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    run: (input, ctx) => inner.run({ query: String(input?.query ?? "").replace(/^select:/, ""), max_results: Number(input?.limit) || 8 }, ctx),
  };
}

// Claude Code's ToolSearch: `select:A,B` for exact names, `+word rest` to
// require a word in the name, else ranked keywords.
// `builtins`: the deferred built-ins, for a session the ones its own list defers.
export function toolSearch(builtins: (sessionId?: string) => Tool[]): Tool {
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
    async run(input, ctx): Promise<ToolOutput> {
      const query = String(input?.query ?? "").trim();
      const limit = Math.min(Math.max(Number(input?.max_results) || 5, 1), 20);
      const own = builtins(ctx?.sessionId).map((t) => ({ name: t.name, qualified: t.name, description: t.description, server: "built-in", hidden: false }));
      const cat = (await catalogTools(ctx?.sessionId)).map((t) => ({ name: nativeName(t), qualified: nativeName(t), description: t.description, server: t.server, hidden: !!t.hidden }));
      // A hidden tool answers an exact name only (its call says why it is off).
      const all = [...own, ...cat.filter((c) => !own.some((o) => o.name === c.name))];
      const pool = all.filter((t) => !t.hidden);
      if (!query) {
        const by = new Map<string, string[]>();
        for (const t of pool) by.set(t.server, [...(by.get(t.server) ?? []), t.name]);
        const down = unavailableNote(ctx?.sessionId);
        return { content: [[...by].map(([s, ns]) => `${s}: ${ns.join(", ")}`).join("\n") || "No deferred tools.", down].filter(Boolean).join("\n") };
      }
      let hits: typeof pool;
      if (query.startsWith("select:")) {
        const want = query.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
        hits = want.map((w) => all.find((t) => t.name === w) ?? all.find((t) => t.name.toLowerCase() === w.toLowerCase())).filter(Boolean) as typeof pool;
        const missing = want.filter((w) => !hits.some((h) => h.name.toLowerCase() === w.toLowerCase()));
        if (!hits.length) return fail(`No deferred tool named ${missing.join(", ")}. ${unavailableNote(ctx?.sessionId)} Search by keywords instead.`.replace("  ", " "));
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
        if (!hits.length) return { content: [`No deferred tool matches "${query}". An empty query lists them all.`, unavailableNote(ctx?.sessionId)].filter(Boolean).join("\n") };
      }
      // The provider takes tool_reference blocks alone in a result (mixed with text it answers 400).
      return { content: hits.slice(0, limit).map((t) => ({ type: "tool_reference" as const, tool_name: t.name })) };
    },
  };
}
