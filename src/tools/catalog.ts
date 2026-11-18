// The deferred tool catalog: tools whose schemas are not sent with every
// request. The model finds them with search_tools and runs them with mcp_call,
// so the eager tool list (and the cached request prefix) never changes when an
// MCP server connects, reloads or goes away.
import type { ToolContext, ToolOutput } from "./types.ts";

export type CatalogTool = {
  server: string;          // "web", "mcp", or an MCP server's name
  name: string;            // the tool's own name on that server
  qualified: string;       // `${server}__${name}`: what mcp_call takes
  description: string;
  input_schema: Record<string, unknown>;
  readOnly?: boolean;
  run(input: any, ctx: ToolContext): Promise<ToolOutput>;
};

// One source per server (or per built-in group). `tools()` may connect lazily;
// `pending` names servers still connecting so search can say so.
export type CatalogSource = {
  name: string;
  tools(): Promise<CatalogTool[]>;
  pending?(): string[];
};

const sources = new Map<string, CatalogSource>();

export const registerCatalog = (s: CatalogSource) => void sources.set(s.name, s);
export const unregisterCatalog = (name: string) => void sources.delete(name);
export const catalogSources = () => [...sources.values()];

export async function catalogTools(): Promise<CatalogTool[]> {
  const lists = await Promise.allSettled([...sources.values()].map((s) => s.tools()));
  return lists.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}
