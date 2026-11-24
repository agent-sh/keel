// plugins.toml (protocol v1): `[plugins.<id>]` with command, args, enabled,
// env, max_concurrent, settings and `[plugins.<id>.providers.<pid>]`. A
// provider's `catalog` names the models.dev section that describes its route
// (speed tiers, capabilities), as an endpoint's does, and `system_prompt`
// where an openai_responses route puts the system prompt ("developer" or
// "instructions", the default), as an endpoint's does.
// keel-bun reads <config>/plugins.toml; without one it reads the Rust Keel's
// ~/.config/keel/plugins.toml (read only), so existing plugins work unchanged.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config.ts";
import { homeDir, ownerEnv, ownerHome } from "../../core/paths";

export type PluginEntry = {
  id: string;
  command: string;
  args: string[];
  enabled: boolean;
  env: string[];
  max_concurrent?: number;
  settings: Record<string, unknown>;
  providers: Record<string, { enabled?: boolean; label?: string; catalog?: string; system_prompt?: "developer" | "instructions"; settings?: Record<string, unknown> }>;
  problem?: string; // a bad entry: the plugin is not started and this says why
  fingerprint: string;
};

const ID = /^[a-z][a-z0-9_-]{0,47}$/;
const PLUGIN_KEYS = new Set(["command", "args", "enabled", "env", "max_concurrent", "settings", "providers"]);
const PROVIDER_KEYS = new Set(["enabled", "label", "catalog", "system_prompt", "settings"]);

export function pluginsFile(): string | null {
  const own = join(configDir(), "plugins.toml");
  if (existsSync(own)) return own;
  const keel = join(ownerEnv("XDG_CONFIG_HOME")?.startsWith("/") ? ownerEnv("XDG_CONFIG_HOME")! : join(ownerHome(), ".config"), "keel", "plugins.toml");
  return existsSync(keel) ? keel : null;
}

export function readPlugins(): { file: string | null; entries: PluginEntry[]; error?: string } {
  const file = pluginsFile();
  if (!file) return { file, entries: [] };
  let doc: any;
  try {
    doc = Bun.TOML.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { file, entries: [], error: `${file}: ${(e as Error).message}` };
  }
  const entries: PluginEntry[] = [];
  for (const [id, raw] of Object.entries<any>(doc.plugins ?? {})) {
    const problems: string[] = [];
    if (!ID.test(id)) problems.push(`the id \`${id}\` is not a lower-case name`);
    for (const k of Object.keys(raw ?? {})) if (!PLUGIN_KEYS.has(k)) problems.push(`unknown key \`${k}\``);
    for (const [pid, p] of Object.entries<any>(raw?.providers ?? {})) {
      for (const k of Object.keys(p ?? {})) if (!PROVIDER_KEYS.has(k)) problems.push(`unknown key \`providers.${pid}.${k}\``);
      if (p?.system_prompt !== undefined && p.system_prompt !== "developer" && p.system_prompt !== "instructions") problems.push(`\`providers.${pid}.system_prompt\` is not "developer" or "instructions"`);
    }
    if (typeof raw?.command !== "string" || !raw.command) problems.push("`command` is missing");
    if (raw?.enabled !== undefined && typeof raw.enabled !== "boolean") problems.push("`enabled` is not true or false");
    const env = Array.isArray(raw?.env) ? raw.env.filter((n: any) => typeof n === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) : [];
    let command = String(raw?.command ?? "");
    if (command.startsWith("~/")) command = join(homeDir(), command.slice(2));
    entries.push({
      id,
      command,
      args: Array.isArray(raw?.args) ? raw.args.map(String) : [],
      enabled: raw?.enabled !== false,
      env,
      max_concurrent: Number(raw?.max_concurrent) >= 1 ? Number(raw.max_concurrent) : undefined,
      settings: raw?.settings ?? {},
      providers: raw?.providers ?? {},
      problem: problems.length ? problems.join("; ") : undefined,
      fingerprint: JSON.stringify(raw) + (existsSync(command) ? statSync(command).mtimeMs : ""),
    });
  }
  return { file, entries };
}
