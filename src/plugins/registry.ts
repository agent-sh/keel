// The plugins Keel installed: one record each in <config>/plugins.json (the
// list Keel keeps of them, written whole through core/ownfile.ts), and each
// plugin's files under <config>/plugins/<id>/: `versions/<version>/` its copy,
// `data/` what it keeps across updates (${CLAUDE_PLUGIN_DATA}).
// A record holds what the plugin brought as it was installed: the skills,
// commands and agents it gives, its hooks and MCP servers with their paths
// filled in, and the lines of what it runs the owner agreed to. Nothing of
// a plugin runs but what its record says, and only while it is enabled.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeOwnFile } from "../core/ownfile.ts";
import { configDir } from "../providers/config.ts";
import type { HookGroups, NotTaken } from "./manifest.ts";

// Where it came from: a folder, or a git repository (`ref` a branch, tag or
// commit; `sub` the plugin's folder in it); `entry` the marketplace entry
// when the source is a marketplace.
export type UnitSource = { path?: string; git?: string; ref?: string; sub?: string; entry?: string; input: string };
export type Unit = {
  id: string; // its key, and the prefix of its skills, commands and agents
  name: string; // the name the plugin gives itself
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  source: UnitSource;
  commit?: string;
  dir: string;
  data: string;
  enabled: boolean;
  installed: number;
  updated: number;
  skills: { name: string; dir: string }[];
  commands: { name: string; file: string }[];
  agents: { name: string; file: string }[];
  hooks: HookGroups;
  mcp: { name: string; label: string; config: Record<string, unknown> }[];
  notTaken: NotTaken[];
  notes: string[];
  // What the owner agreed to run, line by line (empty when it runs nothing).
  consent: { at: number; lines: string[] };
  // The repository folder that offered it, when it came from one.
  offeredBy?: string;
};
export type Registry = { plugins: Unit[] };

export const pluginsHome = () => join(configDir(), "plugins");
export const registryPath = () => join(configDir(), "plugins.json");

// Read again only when the file changed on disk: every hook event and skill listing asks.
let kept: { path: string; mark: string; reg: Registry } | null = null;
const markOf = (p: string) => { try { const s = statSync(p); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch { return "missing"; } };

export function readRegistry(): Registry {
  const path = registryPath();
  const mark = markOf(path);
  if (kept?.path === path && kept.mark === mark) return kept.reg;
  let reg: Registry = { plugins: [] };
  if (mark !== "missing") {
    try {
      const v = JSON.parse(readFileSync(path, "utf8"));
      if (v && Array.isArray(v.plugins)) reg = { plugins: v.plugins.filter((u: any) => u && typeof u.id === "string" && typeof u.dir === "string") };
    } catch { /* a file that does not parse holds no plugin: nothing of one runs */ }
  }
  kept = { path, mark, reg };
  return reg;
}

export function writeRegistry(reg: Registry) {
  writeOwnFile(registryPath(), JSON.stringify({ plugins: [...reg.plugins].sort((a, b) => a.id.localeCompare(b.id)) }, null, 2) + "\n");
  kept = null;
}

export const installedUnits = () => readRegistry().plugins;
export const enabledUnits = () => readRegistry().plugins.filter((u) => u.enabled);
export const unitOf = (id: string) => readRegistry().plugins.find((u) => u.id === id);
