import type { ModelInfo } from "../providers/types.ts";
import { claudeTools } from "./claude.ts";
import { geminiTools } from "./gemini.ts";
import { gptTools } from "./gpt.ts";
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

// Stable order (family tools, then shared sorted by name) so the tools prefix
// of the request never changes between turns and stays cached.
export function toolsFor(family: ModelInfo["family"]): Tool[] {
  const base = byFamily.get(family) ?? byFamily.get("claude")!;
  const extra = shared.filter((t) => !t.families || t.families.includes(family));
  return [...base, ...extra.sort((a, b) => a.name.localeCompare(b.name))];
}
