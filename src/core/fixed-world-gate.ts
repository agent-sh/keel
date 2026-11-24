// Whether a daemon may start in the fixed world of a pictures run (src/core/fixed-world.ts). Only a scratch
// daemon may: one whose state folder no daemon of the real world has used, and that no real provider would
// answer. A folder with a store and no fixed-world.json was a real daemon's; its ids and clock stay real.
// A folder whose fixed-world.json is there was fixed from its first start (the file is written only past
// this gate, before the store is made), so a restart of that daemon stays fixed. Real providers are
// asked as the registry would ask at its start, after the closed environment took the secrets out.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AcpProvider } from "../acp/agents.ts";
import { AnthropicProvider } from "../providers/anthropic.ts";
import { CodexProvider } from "../providers/codex.ts";
import { endpoints } from "../providers/config.ts";
import { EndpointProvider } from "../providers/endpoint.ts";
import { GeminiProvider, OpenAIProvider } from "../providers/keyed.ts";
import { readPlugins } from "../providers/plugins/config.ts";
import type { Provider } from "../providers/types.ts";
import { XaiProvider } from "../providers/xai.ts";

// Why the fixed world is refused, or null when it may start. `real` names the real providers that would list.
export async function fixedRefusal(stateDir: string, real: () => Promise<string[]>): Promise<string | null> {
  const born = existsSync(join(stateDir, "fixed-world.json"));
  if (!born && existsSync(join(stateDir, "store.db"))) return `${stateDir} already holds a store of a daemon that was not fixed`;
  const ids = await real();
  if (ids.length) return `a real provider would list (${ids.join(", ")})`;
  return null;
}

// The providers other than the scripted stand-in that would list in this daemon: each built-in and endpoint
// with a credential found, an installed ACP agent, an enabled plugin that declares a provider.
export async function realProviders(stateDir: string): Promise<string[]> {
  const ps: Provider[] = [
    new AnthropicProvider("bedrock"), new AnthropicProvider("anthropic"), new OpenAIProvider(), new CodexProvider(),
    new GeminiProvider(), new XaiProvider(), ...endpoints().map((e) => new EndpointProvider(e)),
  ];
  await Promise.all(ps.map((p) => p.look?.()));
  const ids = ps.filter((p) => p.available()).map((p) => p.id);
  const acp = new AcpProvider(stateDir).agents;
  await acp.refresh();
  if (acp.list().some((a) => a.run)) ids.push("acp");
  for (const e of readPlugins().entries) {
    if (e.enabled && !e.problem && Object.values(e.providers).some((p) => p.enabled !== false)) ids.push(`plugin ${e.id}`);
  }
  return ids;
}
