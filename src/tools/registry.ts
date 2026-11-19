import type { ModelInfo } from "../providers/types.ts";
import { claudeTools } from "./claude.ts";
import { geminiTools } from "./gemini.ts";
import { gptTools } from "./gpt.ts";
import { DEFERRED_BUILTINS, toolSearch } from "./defer.ts";
import "./web.ts";
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

// For a measurement without a shared tool (the token benchmark's --without).
export function unregisterShared(name: string) {
  const i = shared.findIndex((t) => t.name === name);
  if (i >= 0) shared.splice(i, 1);
}

// A tool of any family that only waits on the owner's answer.
export const asksOwner = (name: string) => [...byFamily.values(), shared].some((l) => l.some((t) => t.name === name && t.asksOwner));

// The provider-neutral way to deferred tools, replaced by ToolSearch where tools load natively.
const SEARCH_PAIR = new Set(["search_tools", "mcp_call"]);

// Stable order (family tools, then shared sorted by name) so the tools prefix
// of the request never changes between turns and stays cached.
// `native`: the request can carry deferred tools (src/tools/defer.ts): the
// rarely used built-ins are deferred and ToolSearch replaces the search pair;
// the catalog's tools are added per request by withCatalog.
export function toolsFor(family: ModelInfo["family"], native = false): Tool[] {
  const base = byFamily.get(family) ?? byFamily.get("claude")!;
  const extra = shared.filter((t) => !t.families || t.families.includes(family));
  const all = [...base, ...extra.sort((a, b) => a.name.localeCompare(b.name))];
  if (!native) return all;
  const kept = all.filter((t) => !SEARCH_PAIR.has(t.name));
  const deferred = kept.filter((t) => DEFERRED_BUILTINS.has(t.name)).map((t) => ({ ...t, defer: true }));
  return [...kept.filter((t) => !DEFERRED_BUILTINS.has(t.name)), searchFor(family), ...deferred];
}

const searches = new Map<string, Tool>();
function searchFor(family: ModelInfo["family"]): Tool {
  let s = searches.get(family);
  if (!s) searches.set(family, (s = toolSearch(() => deferredOf(family))));
  return s;
}
const deferredOf = (family: ModelInfo["family"]) => toolsFor(family, false).filter((t) => DEFERRED_BUILTINS.has(t.name));
