// The deferred tool catalog: tools whose schemas are not sent with every
// request. The model finds them with search_tools and runs them with mcp_call,
// so the eager tool list (and the cached request prefix) never changes when an
// MCP server connects, reloads or goes away.
import type { WebUse } from "../safety/addresses.ts";
import type { CallClass, ToolHints } from "../safety/policy.ts";
import type { ToolContext, ToolOutput } from "./types.ts";

export type CatalogTool = {
  server: string;          // "web", "mcp", or an MCP server's name
  name: string;            // the tool's own name on that server
  qualified: string;       // `${server}__${name}`: what mcp_call takes
  description: string;
  input_schema: Record<string, unknown>;
  readOnly?: boolean;
  // What its MCP server says it does, for the gate (policy.ts ToolHints) and for a failure's words (`idempotent`).
  hints?: ToolHints & { idempotent?: boolean };
  hidden?: boolean;        // not offered by search, still answered by mcp_call (a server turned off says so)
  mcp?: boolean;           // a tool of an MCP server (named mcp__<server>__<tool> where tools load natively)
  // Which source runs it (an MCP server's endpoint or program and a private
  // fingerprint of its credentials): an answer the owner gave is for this one.
  source?: string;
  // What a call does, for the permission gate, when the read flag alone does not say.
  judge?(input: any): Promise<CallClass>;
  // What it does on the web (src/safety/addresses.ts), as a built-in tool says it.
  web?: WebUse;
  run(input: any, ctx: ToolContext): Promise<ToolOutput>;
};

// One source per server (or per built-in group). `tools()` may connect lazily;
// `pending` names servers still connecting so search can say so.
export type CatalogSource = {
  name: string;
  tools(): Promise<CatalogTool[]>;
  pending?(): string[];
  // Servers that should offer tools and cannot now (failed to start, need a
  // sign-in): a search says so with the reason, so a missing tool is never silent.
  failed?(): { name: string; why: string }[];
  // The tools listed right now, without connecting anything (an MCP server's
  // last listing while it is ready). A source without it is asked with tools().
  known?(): CatalogTool[];
  // A search found a tool of this source: start what a call would need (a server with no process).
  warm?(): void;
  // Families that have these tools among their own (the web pair for Claude):
  // where tools load natively they are left out for those families.
  except?: string[];
  // The one session these tools are for (a server an editor passed with its
  // session): no other session, and no list of the owner's, is offered them.
  session?: string;
};

const sources = new Map<string, CatalogSource>();

// What the gate judged a call as, kept until it runs: the tool's shape and its
// source. A call whose tool changed while its card waited does not run.
export type Judged = { shape: string; source?: string };
// (A tool whose hints changed is another tool: they decide how it is judged.)
export const judgedOf = (t: CatalogTool): Judged => ({ shape: JSON.stringify([t.qualified, t.description, t.input_schema, !!t.readOnly, ...(t.hints ? [t.hints] : [])]), source: t.source });
// Why the answer given no longer fits the tool found now, or null when it does.
export function stale(was: Judged | undefined, now: CatalogTool, name: string, again: string): string | null {
  if (!was) return null;
  const n = judgedOf(now);
  if (was.source !== n.source) return `${name} now runs from another source than the one the owner answered for (its server's endpoint, program or credentials changed), so it was not run. ${again} to ask anew.`;
  if (was.shape !== n.shape) return `${name} changed while this call waited (its server was reloaded): the answer given was for the old tool. ${again} and call it anew.`;
  return null;
}

export const registerCatalog = (s: CatalogSource) => void sources.set(s.name, s);
export const unregisterCatalog = (name: string) => void sources.delete(name);
// The sources a session is offered: every shared one and its own. With no
// session named (the owner's lists), the shared ones.
// The shared ones come first: a name both have is the shared server's.
const offered = (session?: string) => {
  const all = [...sources.values()];
  return [...all.filter((s) => !s.session), ...(session ? all.filter((s) => s.session === session) : [])];
};
export const catalogSources = (session?: string) => offered(session);

// One line naming the servers whose tools are missing now and why, or "".
export function unavailableNote(session?: string): string {
  const down = offered(session).flatMap((s) => s.failed?.() ?? []);
  if (!down.length) return "";
  const why = (w: string) => w.replace(/\s+/g, " ").trim().slice(0, 200);
  return `Not available now: ${down.map((d) => `${d.name} (${why(d.why)})`).join("; ")}. Their tools are missing from this list; the owner sees the same in Settings > MCP servers.`;
}

// What every source offers now, without waiting on a connection: the deferred
// tools a request declares (src/tools/defer.ts).
export async function catalogReady(family?: string, session?: string): Promise<CatalogTool[]> {
  const use = offered(session).filter((s) => !family || !s.except?.includes(family));
  const lists = await Promise.allSettled(use.map((s) => (s.known ? s.known() : s.tools())));
  return lists.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

// How many servers a search starts: those of its first results. A broad query lists up to twenty tools across many
// servers, and the model calls from the top of the list, so starting every server it names would bring back the
// processes the sleep saves; one the model calls later out of the rest starts at that call.
export const SURFACED_STARTS = 3;

// Tools a search showed the model: the sources of its first results are told, so a server asleep is starting when the call comes.
export function surfaced(tools: { server: string }[], session?: string) {
  const first = [...new Set(tools.map((t) => t.server))].slice(0, SURFACED_STARTS);
  const by = new Set(first);
  for (const s of offered(session)) if (by.has(s.name)) try { s.warm?.(); } catch { /* a start that fails shows when the tool is called */ }
}

export async function catalogTools(session?: string): Promise<CatalogTool[]> {
  const lists = await Promise.allSettled(offered(session).map((s) => s.tools()));
  return lists.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

const words = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// Name hits weigh more than description hits; an exact name wins outright.
export function score(t: Pick<CatalogTool, "qualified" | "name" | "description">, query: string): number {
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
