import { testBuild } from "../core/build.ts";
import type { ModelInfo } from "../providers/types.ts";
import type { MarkTool } from "../safety/marks.ts";
import { claudeTools } from "./claude.ts";
import { geminiTools } from "./gemini.ts";
import { gptTools } from "./gpt.ts";
import { DEFERRED_BUILTINS, gptToolSearch, toolSearch } from "./defer.ts";
import { webFetchTool, webSearchTool } from "./web.ts";
import type { WebUse } from "../safety/addresses.ts";
import { AskReaders, ask_readers } from "./readers.ts";
import type { Tool } from "./types.ts";

// Tools by model family: each family gets the names and shapes it was trained
// on. Shared tools (MCP search, web, agents) register for every family.
const byFamily = new Map<ModelInfo["family"], Tool[]>([["claude", claudeTools], ["gpt", gptTools], ["gemini", geminiTools]]);
const shared: Tool[] = [];

export function registerFamily(family: ModelInfo["family"], tools: Tool[]) {
  byFamily.set(family, tools);
}

// The names of the tools the model families were trained on (their own set, no shared or catalog tool).
export const familyToolNames = (): Set<string> => new Set([...byFamily.values()].flat().map((t) => t.name));

export function registerShared(...tools: Tool[]) {
  for (const t of tools) if (!shared.some((s) => s.name === t.name)) shared.push(t);
}
registerShared(AskReaders, ask_readers);
// A shared tool by its name (what an external agent is offered runs through it).
export const sharedTool = (name: string): Tool | undefined => shared.find((t) => t.name === name);

// Tools only some sessions get (the helper's): asked per session, appended in
// name order after the shared ones, so a session's tool prefix stays stable.
const perSession = new Map<string, (sessionId: string, family: ModelInfo["family"]) => Tool[]>();
export const registerSessionTools = (id: string, f: (sessionId: string, family: ModelInfo["family"]) => Tool[]) => void perSession.set(id, f);
const sessionTools = (id: string | undefined, family: ModelInfo["family"]) =>
  id ? [...perSession.values()].flatMap((f) => f(id, family)).sort((a, b) => a.name.localeCompare(b.name)) : [];

// Tools a session is not offered (an experiment arm without a tool): asked
// per session, the same answer for the session's life, so its prefix holds.
const offFilters = new Map<string, (sessionId: string) => string[]>();
export const registerToolsOff = (id: string, f: (sessionId: string) => string[]) => void offFilters.set(id, f);
const toolsOff = (id: string | undefined) => new Set(id ? [...offFilters.values()].flatMap((f) => f(id)) : []);

// The part of a session's tool list that is the session's own, not the
// build's: the tools only it gets and the ones it is not offered. A session
// keeps the definitions it was last sent across a daemon upgrade
// (src/engine/build-pin.ts); a change of this part is taken at once.
export const sessionToolsKey = (family: ModelInfo["family"], sessionId: string) =>
  JSON.stringify([sessionTools(sessionId, family).map((t) => t.name), [...toolsOff(sessionId)].sort()]);

// For a measurement without a shared tool (the token benchmark's --without).
export function unregisterShared(name: string) {
  const i = shared.findIndex((t) => t.name === name);
  if (i >= 0) shared.splice(i, 1);
}

// Every tool of every family as plain facts, for judging a stored call off
// the loop (src/safety/marks.ts): its session may have changed models since.
let facts: { n: number; list: MarkTool[] } | undefined;
export function toolFacts(): MarkTool[] {
  const all = [...byFamily.values(), shared].flat();
  if (facts?.n === all.length) return facts.list;
  const by = new Map<string, MarkTool>();
  for (const t of all) {
    if (by.has(t.name)) continue;
    by.set(t.name, { name: t.name, readOnly: t.readOnly, kind: t.kind, props: Object.keys((t.built ?? (t.input_schema as any))?.properties ?? {}), ...(t.appliesPatch ? { appliesPatch: true as const } : {}), ...(t.interpreter ? { shellInput: true as const } : {}) });
  }
  facts = { n: all.length, list: [...by.values()] };
  return facts.list;
}

// What a tool does on the web, by the name a call gives it. The web catalog's tools go by their full name
// (`web__webfetch`), called directly where the family loads them natively or through `mcp_call`. A tool of a family goes
// by its own name, called directly only: `mcp_call` also takes a server's tool by the name that tool has on its
// server, so `WebFetch` through it can be a server's tool and is not the built-in (`dispatched`).
export function webUse(name: string, dispatched = false): WebUse | undefined {
  if (!dispatched) for (const t of [...byFamily.values(), shared].flat()) if (t.name === name && t.web) return t.web;
  for (const t of [webSearchTool, webFetchTool]) if (t.qualified === name) return t.web;
  return undefined;
}

// A tool of any family that only waits on the owner's answer.
// A tool that only waits on the owner, named before the tool itself is
// registered: a route module registers its tools at its turn, and the start
// closes the turns a crash cut before the later modules had theirs. A call
// of such a tool is asked again after a restart, never closed as cut.
const ownerAsking = new Set<string>();
export const declareAsksOwner = (...names: string[]) => { for (const n of names) ownerAsking.add(n); };
export const asksOwner = (name: string) => ownerAsking.has(name) || [...byFamily.values(), shared].some((l) => l.some((t) => t.name === name && t.asksOwner));

// The provider-neutral way to deferred tools, replaced by ToolSearch where tools load natively.
const SEARCH_PAIR = new Set(["search_tools", "mcp_call"]);

// The stand-in build of the upgrade e2e (src/core/build.ts): its tools as that build would have them.
const asBuilt = (list: Tool[]): Tool[] => {
  const as = testBuild?.tools;
  if (!as) return list;
  return list.filter((t) => !as[t.name]?.remove).map((t) => {
    const c = as[t.name];
    return c ? { ...t, ...(c.description !== undefined && { description: c.description }), ...(c.input_schema && { input_schema: c.input_schema }) } : t;
  });
};

// Stable order (family tools, then shared sorted by name) so the tools prefix
// of the request never changes between turns and stays cached.
// `native`: the request can carry deferred tools (src/tools/defer.ts): the
// rarely used built-ins are deferred and ToolSearch replaces the search pair;
// the catalog's tools are added per request by withCatalog.
export function toolsFor(family: ModelInfo["family"], native = false, sessionId?: string): Tool[] {
  const base = byFamily.get(family) ?? byFamily.get("claude")!;
  const extra = shared.filter((t) => !t.families || t.families.includes(family));
  const off = toolsOff(sessionId);
  const all = asBuilt([...base, ...extra.sort((a, b) => a.name.localeCompare(b.name)), ...sessionTools(sessionId, family)]).filter((t) => !off.has(t.name));
  if (!native) return all;
  const kept = all.filter((t) => !SEARCH_PAIR.has(t.name));
  const deferred = kept.filter((t) => DEFERRED_BUILTINS.has(t.name)).map((t) => ({ ...t, defer: true }));
  return [...kept.filter((t) => !DEFERRED_BUILTINS.has(t.name)), searchFor(family), ...deferred];
}

const searches = new Map<string, Tool>();
function searchFor(family: ModelInfo["family"]): Tool {
  let s = searches.get(family);
  // Each family searches with the tool it was trained on: ToolSearch for Claude, tool_search for GPT.
  if (!s) searches.set(family, (s = (family === "gpt" ? gptToolSearch : toolSearch)((sessionId) => deferredOf(family, sessionId))));
  return s;
}
// The built-ins a search finds: the ones this build defers, or for a session
// whose pinned list defers others (an older build's list, src/engine/build-pin.ts)
// the ones that list defers, so every tool the request declares as deferred
// loads, and none it declares in the prompt is loaded a second time.
let pinnedDeferred: (sessionId: string) => string[] | undefined = () => undefined;
export const registerPinnedDeferred = (f: typeof pinnedDeferred) => void (pinnedDeferred = f);
function deferredOf(family: ModelInfo["family"], sessionId?: string): Tool[] {
  const names = sessionId ? pinnedDeferred(sessionId) : undefined;
  const set = names ? new Set(names) : DEFERRED_BUILTINS;
  return toolsFor(family, false).filter((t) => set.has(t.name));
}
