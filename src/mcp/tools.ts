// search_tools and mcp_call: the two eager tools that reach every deferred
// tool (MCP servers' tools, built-ins under "web" and "mcp"). A search returns
// one line per hit and the schema only for the hits shown, so finding a tool
// costs a few hundred tokens instead of every server's schemas on every request.
import { registerHooks } from "../engine/hooks.ts";
import { catalogSources, catalogTools, registerCatalog, type CatalogTool } from "../tools/catalog.ts";
import { registerShared } from "../tools/registry.ts";
import { fail, ok, type Tool } from "../tools/types.ts";
import type { McpManager } from "./manager.ts";

const words = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// Name hits weigh more than description hits; an exact name wins outright.
export function score(t: CatalogTool, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  if (t.qualified.toLowerCase() === q || t.name.toLowerCase() === q) return 1000;
  const name = new Set([...words(t.qualified), ...words(t.name)]);
  const desc = words(t.description);
  let s = 0;
  for (const w of words(q)) {
    if (name.has(w)) s += 10;
    else if ([...name].some((n) => n.startsWith(w) || w.startsWith(n))) s += 5;
    const d = desc.filter((x) => x === w || (w.length > 3 && x.startsWith(w))).length;
    s += Math.min(d, 3) * 2;
  }
  if (t.qualified.toLowerCase().includes(q)) s += 15;
  return s;
}

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
  async run(input) {
    const query = String(input.query ?? "");
    const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 20);
    const offset = Math.max(Number(input.offset) || 0, 0);
    const all = await catalogTools();
    const pending = catalogSources().flatMap((s) => s.pending?.() ?? []);
    const note = pending.length ? `\nStill connecting: ${pending.join(", ")}; search again shortly for their tools.` : "";
    if (!query.trim()) {
      const by = new Map<string, number>();
      for (const t of all) by.set(t.server, (by.get(t.server) ?? 0) + 1);
      const lines = [...by].sort().map(([s, n]) => `${s}: ${n} tool${n > 1 ? "s" : ""}`);
      return ok(`${all.length} tools on ${by.size} servers:\n${lines.join("\n")}${note}\nSearch with words to see tools and schemas.`);
    }
    let hits: CatalogTool[];
    if (query.startsWith("select:")) {
      const want = query.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
      hits = want.map((w) => all.find((t) => t.qualified === w || t.name === w)).filter(Boolean) as CatalogTool[];
    } else {
      hits = all
        .map((t) => ({ t, s: score(t, query) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.t.qualified.localeCompare(b.t.qualified))
        .map((x) => x.t);
    }
    const page = hits.slice(offset, offset + limit);
    if (!page.length) return ok(`No tool matches "${query}"${offset ? ` at offset ${offset}` : ""} among ${all.length}.${note}`);
    const more = hits.length > offset + limit ? `\n${hits.length - offset - limit} more: search again with offset ${offset + limit}.` : "";
    const body = page.map((t) => `${t.qualified}: ${oneLine(t.description)}\n  input: ${compactSchema(t.input_schema)}`).join("\n");
    return ok(`${page.length} of ${hits.length} matching tools. Run one with mcp_call {"tool": "<name>", "arguments": {...}}.\n\n${body}${more}${note}`);
  },
};

const McpCall: Tool = {
  name: "mcp_call",
  readOnly: false,
  async target(input) {
    const name = String(input?.tool ?? "");
    const all = await catalogTools();
    const t = all.find((x) => x.qualified === name) ?? all.find((x) => x.name === name);
    // A name that matches nothing runs nothing: the call only says so.
    const args = input?.arguments ?? {};
    return t ? { name: t.qualified, readOnly: !!t.readOnly, input: args, cls: t.judge ? await t.judge(args) : undefined } : { name, readOnly: true, input: {} };
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
    const all = await catalogTools();
    const t = all.find((x) => x.qualified === name) ?? all.find((x) => x.name === name);
    if (!t) {
      const near = all.map((x) => ({ x, s: score(x, name.replace(/__/g, " ")) })).filter((h) => h.s > 0).sort((a, b) => b.s - a.s).slice(0, 3);
      return fail(`No tool named ${name}.${near.length ? ` Closest: ${near.map((h) => h.x.qualified).join(", ")}.` : ""} Find tools with search_tools.`);
    }
    const args = input.arguments ?? {};
    if (typeof args !== "object" || Array.isArray(args)) return fail("arguments must be an object.");
    const required: string[] = (t.input_schema as any).required ?? [];
    const missing = required.filter((k) => (args as any)[k] === undefined);
    if (missing.length) return fail(`${t.qualified} needs ${missing.join(", ")}. Input schema: ${compactSchema(t.input_schema)}`);
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
    const names: string[] = [];
    for (const s of m.ready()) {
      try {
        const c = await m.ensure(s, 3000);
        if (c.capabilities[cap]) names.push(s);
      } catch {}
    }
    return names;
  };
  const guard = async (f: () => Promise<string>) => {
    try { return ok(await f()); } catch (e) { return fail((e as Error).message); }
  };
  return [
    t("list_resources", "List the resources an MCP server exposes (by URI), or which servers offer resources when no server is given.",
      { server: { type: "string" } }, [], (i) => guard(async () => {
        if (!i.server) {
          const s = await offering("resources");
          return s.length ? `Servers with resources: ${s.join(", ")}` : "No connected server offers resources.";
        }
        const r = await m.resources(i.server);
        return r.length ? r.map((x: any) => `${x.uri ?? x.uriTemplate}  ${x.name ?? ""}${x.description ? `: ${oneLine(x.description, 100)}` : ""}`).join("\n") : `${i.server} lists no resources.`;
      })),
    t("read_resource", "Read one resource of an MCP server as text.", { server: { type: "string" }, uri: { type: "string" } }, ["server", "uri"],
      (i) => guard(() => m.readResource(i.server, i.uri))),
    t("list_prompts", "List the prompt templates an MCP server publishes, or which servers offer prompts when no server is given.",
      { server: { type: "string" } }, [], (i) => guard(async () => {
        if (!i.server) {
          const s = await offering("prompts");
          return s.length ? `Servers with prompts: ${s.join(", ")}` : "No connected server offers prompts.";
        }
        const p = await m.prompts(i.server);
        return p.length ? p.map((x: any) => `${x.name}${x.arguments?.length ? `(${x.arguments.map((a: any) => a.name + (a.required ? "" : "?")).join(", ")})` : ""}${x.description ? `: ${oneLine(x.description, 100)}` : ""}`).join("\n") : `${i.server} publishes no prompts.`;
      })),
    t("get_prompt", "Get one prompt of an MCP server with its arguments filled in.",
      { server: { type: "string" }, name: { type: "string" }, arguments: { type: "object" } }, ["server", "name"],
      (i) => guard(() => m.getPrompt(i.server, i.name, i.arguments ?? {}))),
  ];
}

export function installMcpTools(m: McpManager) {
  registerShared(SearchTools, McpCall);
  registerCatalog({ name: "mcp", tools: async () => builtins(m) });
  // One frozen line per session so the model knows the servers exist.
  registerHooks({
    system: () => {
      const s = m.configured();
      if (!s.length) return "";
      const lines = s.map((x) => `- ${x.name}${x.instructions ? `: ${oneLine(x.instructions, 200)}` : ""}`);
      return `MCP servers are connected; their tools are not loaded. Find them with search_tools and run them with mcp_call:\n${lines.join("\n")}`;
    },
  });
}
