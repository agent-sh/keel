// What a Codex agent file turns on beside its instructions (developers.openai.com/codex/subagents: an agent file
// takes any config key, so `mcp_servers`, `plugins` and `apps` tables scope its integrations), read for Keel:
// - `mcp_servers`: the servers it names, by name (Keel gives every agent the owner's servers; a missing one is told).
// - `plugins`: Codex plugins from Codex's plugin cache (<codex home>/plugins/cache/<marketplace>/<plugin>/<version>).
//   Their skills are told in the agent's task (name, description, file), as Codex lists a plugin's skills; their MCP
//   servers and app connectors are Codex's own and are told as not carried.
// - `apps`: ChatGPT app connectors (Gmail, Calendar, Drive...), which Codex reaches through its ChatGPT sign-in.
//   Keel has none, so an agent that turns one on cannot do its work here: it is unavailable, with why.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { codexPluginDir } from "../integrations/codex-plugins.ts";
import { join } from "node:path";
import { frontmatter } from "../tools/skill-text.ts";

export type PluginSkill = { name: string; description: string; file: string; plugin: string };
export type CodexIntegrations = { mcpServers?: string[]; pluginSkills?: PluginSkill[]; notTaken?: string[]; unavailable?: string };

const on = (v: unknown) => !(v && typeof v === "object" && (v as { enabled?: unknown }).enabled === false);
const turnedOn = (table: unknown): string[] => (table && typeof table === "object" && !Array.isArray(table) ? Object.entries(table as Record<string, unknown>).filter(([, v]) => on(v)).map(([k]) => k) : []);

function skillsOf(dir: string, plugin: string): PluginSkill[] {
  const root = join(dir, "skills");
  let names: string[] = [];
  try { names = readdirSync(root).sort(); } catch { return []; }
  const out: PluginSkill[] = [];
  for (const n of names) {
    const file = join(root, n, "SKILL.md");
    if (!existsSync(file)) continue;
    try {
      const data = frontmatter(readFileSync(file, "utf8")).data as Record<string, unknown>;
      const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : n;
      const description = typeof data.description === "string" ? data.description.trim().replace(/\s+/g, " ") : "";
      out.push({ name, description, file, plugin });
    } catch { /* a skill that does not read is left out */ }
  }
  return out;
}

const listOf = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// The integrations of a parsed Codex agent file. `codexHome` is where Codex keeps its plugins.
export function codexIntegrations(t: Record<string, unknown>, codexHome: string): CodexIntegrations {
  const out: CodexIntegrations = {};
  const servers = turnedOn(t.mcp_servers);
  if (servers.length) out.mcpServers = servers;
  const notTaken: string[] = [];
  const skills: PluginSkill[] = [];
  const codexOnly: string[] = [];
  for (const id of turnedOn(t.plugins)) {
    const dir = codexPluginDir(codexHome, id);
    if (!dir) { notTaken.push(`the Codex plugin ${id}: it is not in Codex's plugin cache`); continue; }
    skills.push(...skillsOf(dir, id));
    const parts = [existsSync(join(dir, ".mcp.json")) ? "MCP servers" : "", existsSync(join(dir, ".app.json")) ? "app connectors" : ""].filter(Boolean);
    if (parts.length) { codexOnly.push(id); notTaken.push(`the ${parts.join(" and ")} of the Codex plugin ${id}: they are Codex's own and Keel does not run them`); }
  }
  // `apps._default` holds the defaults of every app, not an app: an app is on when its own `enabled` is true, or
  // unset while the defaults do not turn apps off.
  const appTable = t.apps && typeof t.apps === "object" && !Array.isArray(t.apps) ? (t.apps as Record<string, unknown>) : {};
  const byDefault = (appTable._default as { enabled?: unknown } | undefined)?.enabled !== false;
  const apps = Object.entries(appTable).filter(([k, v]) => {
    if (k === "_default") return false;
    const set = v && typeof v === "object" ? (v as { enabled?: unknown }).enabled : undefined;
    return set === true || (set === undefined && byDefault);
  }).map(([k]) => k);
  if (apps.length) {
    const named = codexOnly.length ? ` (${listOf(codexOnly)})` : "";
    out.unavailable = `it turns on ChatGPT app ${apps.length === 1 ? "connector" : "connectors"}${named}, which Codex reaches through its ChatGPT sign-in and Keel does not`;
  }
  if (skills.length) out.pluginSkills = skills;
  if (notTaken.length) out.notTaken = notTaken;
  return out;
}

// The part of an agent's task that names its plugins' skills: read when the task needs one, as Codex offers them.
export function pluginSkillsBlock(skills: readonly PluginSkill[]): string {
  if (!skills.length) return "";
  const lines = skills.map((s) => `- ${s.name} (Codex plugin ${s.plugin}): ${s.description || "no description"} Read ${s.file} before you use it; its other files are beside it.`);
  return `Skills of the Codex plugins your definition turns on:\n${lines.join("\n")}`;
}
