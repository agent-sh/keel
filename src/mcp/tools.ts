// search_tools and mcp_call: the two eager tools that reach every deferred
// tool (MCP servers' tools, built-ins under "web" and "mcp"). A search returns
// one line per hit and the schema only for the hits shown, so finding a tool
// costs a few hundred tokens instead of every server's schemas on every request.
import { registerHooks } from "../engine/hooks.ts";
import { catalogSources, catalogTools, judgedOf, registerCatalog, score, stale, surfaced, turnedOff, unavailableNote, type CatalogTool, type Judged } from "../tools/catalog.ts";
export { score };
import { registerShared } from "../tools/registry.ts";
import { fail, ok, type Tool } from "../tools/types.ts";
import { resourceText, type McpManager } from "./manager.ts";

const oneLine = (s: string, n = 160) => {
  const l = s.replace(/\s+/g, " ").trim();
  return l.length > n ? l.slice(0, n - 1) + "…" : l;
};

function compactSchema(s: Record<string, unknown>) {
  const { $schema, ...rest } = s as any;
  return JSON.stringify(rest);
}

const SearchTools: Tool = {
  name: "search_tools",
  readOnly: true,
  description:
    "Find tools that are not loaded yet: MCP servers' tools and built-ins (web fetch and search, MCP resources and prompts). " +
    'Returns matching tool names with their input schemas; run one with mcp_call. Query by words ("github issue", "browser click"), ' +
    'or "select:name1,name2" for exact names. An empty query lists the servers.',
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to match against tool names and descriptions, or select:<names>" },
      limit: { type: "number", description: "Hits to return (default 5, max 20)" },
      offset: { type: "number", description: "Skip this many hits (for the next page)" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const query = String(input.query ?? "");
    const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 20);
    const offset = Math.max(Number(input.offset) || 0, 0);
    const all = (await catalogTools(ctx?.sessionId)).filter((t) => !t.hidden);
    const pending = catalogSources(ctx?.sessionId).flatMap((s) => s.pending?.() ?? []);
    const down = unavailableNote(ctx?.sessionId);
    const note = (pending.length ? `\nStill connecting: ${pending.join(", ")}; search again shortly for their tools.` : "") + (down ? `\n${down}` : "");
    if (!query.trim()) {
      const by = new Map<string, number>();
      for (const t of all) by.set(t.server, (by.get(t.server) ?? 0) + 1);
      const lines = [...by].sort().map(([s, n]) => `${s}: ${n} tool${n > 1 ? "s" : ""}`);
      return ok(`${all.length} tools on ${by.size} servers:\n${lines.join("\n")}${note}\nSearch with words to see tools and schemas.`);
    }
    let hits: CatalogTool[];
    if (query.startsWith("select:")) {
      const want = query.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
      hits = want.map((w) => byName(all, w)).filter(Boolean) as CatalogTool[];
    } else {
      hits = all
        .map((t) => ({ t, s: score(t, query) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.t.qualified.localeCompare(b.t.qualified))
        .map((x) => x.t);
    }
    const page = hits.slice(offset, offset + limit);
    surfaced(page, ctx?.sessionId);
    if (!page.length) return ok(`No tool matches "${query}"${offset ? ` at offset ${offset}` : ""} among ${all.length}.${note}`);
    const more = hits.length > offset + limit ? `\n${hits.length - offset - limit} more: search again with offset ${offset + limit}.` : "";
    const body = page.map((t) => `${t.qualified}: ${oneLine(t.description)}\n  input: ${compactSchema(t.input_schema)}`).join("\n");
    return ok(`${page.length} of ${hits.length} matching tools. Run one with mcp_call {"tool": "<name>", "arguments": {...}}.\n\n${body}${more}${note}`);
  },
};

// A tool by the name a call gives: its full name (server__tool), the name it
// loads by where tools load natively (mcp__server__tool, which instructions and
// hooks name), or its own name on its server.
const byName = (all: CatalogTool[], name: string) =>
  all.find((x) => x.qualified === name) ?? all.find((x) => x.mcp && `mcp__${x.qualified}` === name) ?? all.find((x) => x.name === name);

function unknownTool(name: string, all: CatalogTool[], session?: string): string {
  const off = turnedOff(name, session);
  if (off) return `${name} is not available: ${off}.`;
  const near = all.map((x) => ({ x, s: score(x, name.replace(/__/g, " ")) })).filter((h) => h.s > 0).sort((a, b) => b.s - a.s).slice(0, 3);
  const pending = catalogSources(session).flatMap((s) => s.pending?.() ?? []);
  const down = unavailableNote(session);
  return `No tool named ${name}.${near.length ? ` Closest: ${near.map((h) => h.x.qualified).join(", ")}.` : ""}${pending.length ? ` Still connecting: ${pending.join(", ")}; search again shortly.` : ""}${down ? ` ${down}` : ""} Find tools with search_tools.`;
}

// What the gate judged for a call: if the server is reloaded while the card
// waits and the tool changes, the owner's answer was for another tool.
const judged = new WeakMap<object, Judged>();

const McpCall: Tool = {
  name: "mcp_call",
  readOnly: false,
  async target(input, session) {
    const name = String(input?.tool ?? "");
    const all = await catalogTools(session);
    const t = byName(all, name);
    const args = input?.arguments ?? {};
    const j = t && judgedOf(t);
    if (j && input && typeof input === "object") judged.set(input, j);
    if (t) return { name: t.qualified, readOnly: !!t.readOnly, input: args, source: t.source, shape: j!.shape, cls: t.judge ? await t.judge(args) : undefined, ...(t.read_hint ? { read_hint: true as const } : {}) };
    // A name not known yet (its server still starting, after the catalog
    // waited on it) is refused, never judged as a read: by the time it would
    // run, the server may know it.
    return { name, readOnly: false, input: args, cls: { kind: "refused" as const, why: unknownTool(name, all, session) } };
  },
  description: "Run a tool found with search_tools, by its full name (server__tool), with its arguments as an object.",
  input_schema: {
    type: "object",
    properties: {
      tool: { type: "string", description: "Full tool name from search_tools, e.g. github__create_issue" },
      arguments: { type: "object", description: "The tool's arguments, per its input schema" },
    },
    required: ["tool"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const name = String(input.tool ?? "");
    const all = await catalogTools(ctx?.sessionId);
    const t = byName(all, name);
    if (!t) return fail(unknownTool(name, all, ctx?.sessionId));
    const why = stale(judged.get(input), t, t.qualified, "Search for it again");
    if (why) return fail(why);
    const args = input.arguments ?? {};
    if (typeof args !== "object" || Array.isArray(args)) return fail("arguments must be an object.");
    const required: string[] = (t.input_schema as any).required ?? [];
    const missing = required.filter((k) => (args as any)[k] === undefined);
    if (missing.length) return fail(`${t.qualified} needs ${missing.join(", ")}. Input schema: ${compactSchema(t.input_schema)}`);
    const deny = ctx.authorizationError?.();
    if (deny) return fail(deny);
    return t.run(args, ctx);
  },
};

// Resources and prompts as deferred built-ins under the server name "mcp".
function builtins(m: McpManager): CatalogTool[] {
  const t = (name: string, description: string, properties: Record<string, unknown>, required: string[], run: CatalogTool["run"]): CatalogTool => ({
    server: "mcp", name, qualified: `mcp__${name}`, description, readOnly: true,
    input_schema: { type: "object", properties, required, additionalProperties: false }, run,
  });
  const offering = async (cap: "resources" | "prompts") => {
    return m.capable(cap);
  };
  // A server a session may not reach (memory off, for the store's) is refused before it is asked.
  const guard = async (f: () => Promise<string>, server?: unknown, ctx?: { sessionId?: string }) => {
    const no = typeof server === "string" ? m.refusal(server, ctx?.sessionId) : undefined;
    if (no) return fail(no);
    try { return ok(await f()); } catch (e) { return fail((e as Error).message); }
  };
  return [
    t("list_resources", "List the resources an MCP server exposes (by URI), or which servers offer resources when no server is given.",
      { server: { type: "string" } }, [], (i, ctx) => guard(async () => {
        if (!i.server) {
          const s = await offering("resources");
          return s.length ? `Servers with resources: ${s.join(", ")}` : "No connected server offers resources.";
        }
        const r = await m.resources(i.server);
        const all = [...r.resources.items, ...r.templates.items];
        const lines = all.map((x: any) => `${x.uri ?? x.uriTemplate}  ${x.name ?? ""}${x.description ? `: ${oneLine(x.description, 100)}` : ""}`);
        // A page that failed after others says so; only a list the bound stopped was cut.
        for (const [what, h] of [["resources", r.resources], ["templates", r.templates]] as const) {
          if (h.error) lines.push(h.items.length ? `(listing more ${what} failed after ${h.items.length}: ${h.error})` : `(listing the ${what} failed: ${h.error})`);
          else if (h.next !== undefined) lines.push(`(the ${what} were cut at 50 pages: more may exist)`);
        }
        return lines.length ? lines.join("\n") : `${i.server} lists no resources.`;
      }, i.server, ctx)),
    t("read_resource", "Read one resource of an MCP server as text.", { server: { type: "string" }, uri: { type: "string" } }, ["server", "uri"],
      (i, ctx) => guard(async () => resourceText(await m.readResource(i.server, i.uri)), i.server, ctx)),
    t("list_prompts", "List the prompt templates an MCP server publishes, or which servers offer prompts when no server is given.",
      { server: { type: "string" } }, [], (i, ctx) => guard(async () => {
        if (!i.server) {
          const s = await offering("prompts");
          return s.length ? `Servers with prompts: ${s.join(", ")}` : "No connected server offers prompts.";
        }
        const p = await m.prompts(i.server);
        return p.length ? p.map((x: any) => `${x.name}${x.arguments?.length ? `(${x.arguments.map((a: any) => a.name + (a.required ? "" : "?")).join(", ")})` : ""}${x.description ? `: ${oneLine(x.description, 100)}` : ""}`).join("\n") : `${i.server} publishes no prompts.`;
      }, i.server, ctx)),
    t("get_prompt", "Get one prompt of an MCP server with its arguments filled in.",
      { server: { type: "string" }, name: { type: "string" }, arguments: { type: "object" } }, ["server", "name"],
      (i, ctx) => guard(() => m.getPrompt(i.server, i.name, i.arguments ?? {}), i.server, ctx)),
  ];
}

// How long a session's first request waits for a server that has never
// connected under its config (its instructions are not known yet): Codex's
// default startup wait for an MCP server. A server seen before is not waited
// for: its last published instructions are used.
const FIRST_CONNECT_WAIT_MS = 10_000;

export function installMcpTools(m: McpManager) {
  registerShared(SearchTools, McpCall);
  registerCatalog({ name: "mcp", tools: async () => builtins(m) });
  // One frozen line per session so the model knows the servers exist.
  registerHooks({
    // The servers and what they published are the owner's side of the block (hooks.ts SystemBlock).
    system: async () => {
      const s = await m.configured(FIRST_CONNECT_WAIT_MS);
      const lines = s.map((x) => `- ${x.name}${x.same_as ? `: same as ${x.same_as}` : x.instructions ? `: ${oneLine(x.instructions, 200)}` : ""}`);
      return {
        name: "MCP servers are connected", data: lines.join("\n"),
        text: s.length ? `MCP servers are connected; their tools are deferred: load them with your tool search tool (ToolSearch, or search_tools and mcp_call):\n${lines.join("\n")}` : "",
      };
    },
  });
}
