// What a Codex agent file turns on beside its instructions (developers.openai.com/codex/subagents: an agent file
// takes any config key, so `mcp_servers`, `plugins` and `apps` tables scope its integrations), read for Keel:
// - `mcp_servers`: the servers it names, by name (Keel gives every agent the owner's servers; a missing one is told).
// - `plugins`: Codex plugins from Codex's plugin cache (<codex home>/plugins/cache/<marketplace>/<plugin>/<version>).
//   Their skills are told in the agent's task (name, description, file), as Codex lists a plugin's skills; their MCP
//   servers are Codex's own and are told as not carried.
// - `apps`: ChatGPT app connectors (Gmail, Calendar, Drive...), by connector id, and the ones a plugin names in its
//   `.app.json`. Keel reaches them through the server it brings for them (src/mcp/chatgpt-apps.ts) once the owner
//   turned it on: the agent is then offered those connectors' tools. Until then an agent whose `apps` table turns
//   one on cannot do its work here: it is unavailable, with why.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { codexPluginDir } from "../integrations/codex-plugins.ts";
import { join } from "node:path";
import { frontmatter } from "../tools/skill-text.ts";
import { appsMissing, appsNow, type AppsNow } from "../mcp/chatgpt-apps.ts";

export type PluginSkill = { name: string; description: string; file: string; plugin: string };
// `apps`: the connectors it turns on that Keel reaches now, by id.
export type CodexIntegrations = { mcpServers?: string[]; pluginSkills?: PluginSkill[]; notTaken?: string[]; unavailable?: string; apps?: string[] };

// The connectors a Codex plugin names (`.app.json`: apps.<name>.id).
function pluginApps(dir: string): string[] {
  try {
    const apps = JSON.parse(readFileSync(join(dir, ".app.json"), "utf8"))?.apps;
    return apps && typeof apps === "object" ? Object.values(apps as Record<string, { id?: unknown }>).map((a) => a?.id).filter((id): id is string => typeof id === "string" && !!id.trim()) : [];
  } catch { return []; }
}

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

// The integrations of a parsed Codex agent file. `codexHome` is where Codex keeps its plugins; `now`: what is
// known of ChatGPT's app connectors in Keel; `owners`: the file is one of the owner's own (his Codex or Keel
// folder). A repository's file turns no connector on: it would give itself the owner's mail to read.
export function codexIntegrations(t: Record<string, unknown>, codexHome: string, now: AppsNow | undefined = appsNow.of?.(), owners = true): CodexIntegrations {
  const out: CodexIntegrations = {};
  const servers = turnedOn(t.mcp_servers);
  if (servers.length) out.mcpServers = servers;
  const notTaken: string[] = [];
  const skills: PluginSkill[] = [];
  const withApps: string[] = [];
  const pluginIds: string[] = [];
  for (const id of turnedOn(t.plugins)) {
    const dir = codexPluginDir(codexHome, id);
    if (!dir) { notTaken.push(`the Codex plugin ${id}: it is not in Codex's plugin cache`); continue; }
    skills.push(...skillsOf(dir, id));
    if (existsSync(join(dir, ".mcp.json"))) notTaken.push(`the MCP servers of the Codex plugin ${id}: they are Codex's own and Keel does not run them`);
    if (existsSync(join(dir, ".app.json"))) { withApps.push(id); pluginIds.push(...pluginApps(dir)); }
  }
  // `apps._default` holds the defaults of apps with no entry, not an app. An app with an entry is on unless that
  // entry says `enabled = false`: Codex reads the app's own entry first, and its `enabled` defaults to true.
  const appTable = t.apps && typeof t.apps === "object" && !Array.isArray(t.apps) ? (t.apps as Record<string, unknown>) : {};
  const apps = Object.entries(appTable).filter(([k, v]) => {
    if (k === "_default") return false;
    return !(v && typeof v === "object" && (v as { enabled?: unknown }).enabled === false);
  }).map(([k]) => k);
  const all = [...new Set([...apps, ...pluginIds])];
  const missing = !all.length ? undefined : owners ? appsMissing(all, now) : "only an agent definition of the owner's own turns one on (a file in his own agents folder, not a repository's)";
  // Its own `apps` table is what its work needs: without those connectors it cannot run. A plugin's alone are told.
  if (apps.length && missing) out.unavailable = `it turns on ${apps.length === 1 ? "a ChatGPT app connector" : "ChatGPT app connectors"}, and ${missing}`;
  else if (all.length && !missing) out.apps = all;
  if (withApps.length && missing) notTaken.push(`the app connectors of the Codex ${withApps.length === 1 ? "plugin" : "plugins"} ${listOf(withApps)}: ${missing}`);
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
