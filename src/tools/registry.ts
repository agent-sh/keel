import { testBuild } from "../core/build.ts";
import type { ModelInfo } from "../providers/types.ts";
import { claudeTools } from "./claude.ts";
import { geminiTools } from "./gemini.ts";
import { gptTools } from "./gpt.ts";
import { DEFERRED_BUILTINS, gptToolSearch, toolSearch } from "./defer.ts";
import "./web.ts";
import { AskReaders, ask_readers } from "./readers.ts";
import type { Tool } from "./types.ts";

// Tools by model family: each family gets the names and shapes it was trained
// on. Shared tools (MCP search, web, agents) register for every family.
const byFamily = new Map<ModelInfo["family"], Tool[]>([["claude", claudeTools], ["gpt", gptTools], ["gemini", geminiTools]]);
const shared: Tool[] = [];

export function registerFamily(family: ModelInfo["family"], tools: Tool[]) {
  byFamily.set(family, tools);
}

export function registerShared(...tools: Tool[]) {
  for (const t of tools) if (!shared.some((s) => s.name === t.name)) shared.push(t);
}
registerShared(AskReaders, ask_readers);

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

// A tool of any family that only waits on the owner's answer.
export const asksOwner = (name: string) => [...byFamily.values(), shared].some((l) => l.some((t) => t.name === name && t.asksOwner));

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
