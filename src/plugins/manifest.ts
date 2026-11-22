// A plugin in the Claude Code format, read as it is
// (code.claude.com/docs/en/plugins-reference and plugins/marketplace-reference,
// read 2026-11-21): `.claude-plugin/plugin.json` (optional; `name` is its one
// required key) and the standard layout. What a part of it is in Keel:
//   skills/<name>/SKILL.md, commands/*.md, agents/*.md  -> <plugin>:<name>
//   hooks/hooks.json and the manifest's `hooks`        -> hooks that run
//   .mcp.json and the manifest's `mcpServers`          -> MCP servers
// and every other part is named as not taken, with why. Component paths are
// relative to the plugin's root, start with "./" and stay inside it;
// `commands` and `agents` replace their default folder, `skills` adds to its
// own, `hooks` and `mcpServers` merge into the default file.
// Nothing here runs anything: it reads files and says what they hold.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { contains } from "../core/paths.ts";

export type HookGroups = Record<string, { matcher?: string; hooks: any[] }[]>;
export type NotTaken = { part: string; why: string };
export type Plugin = {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  homepage?: string;
  root: string;
  skills: { name: string; dir: string }[];
  commands: { name: string; file: string }[];
  agents: { name: string; file: string }[];
  hooks: HookGroups;
  mcp: Record<string, Record<string, unknown>>;
  notTaken: NotTaken[];
  // What keeps it from being installed (a bad name, a path out of its folder, a file that is not JSON).
  problems: string[];
};

// A marketplace: a list of plugins (`.claude-plugin/marketplace.json`).
export type MarketEntry = { name: string; source: unknown; version?: string; description?: string; strict?: boolean; fields: Record<string, unknown> };
export type Marketplace = { name: string; owner?: string; description?: string; pluginRoot?: string; plugins: MarketEntry[] };

// The plugin name rule of plugins-reference: non-empty, no spaces, "@", ":",
// path separators, control or bidirectional-formatting characters.
const NAME_BAD = /[\s@:/\\\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
export const nameProblem = (n: unknown): string | null =>
  typeof n !== "string" || !n ? "a plugin needs a name" : n.length > 64 ? `the name ${n.slice(0, 64)}... is longer than 64 characters` : NAME_BAD.test(n) || n.startsWith(".") ? `${JSON.stringify(n)} is not a plugin name: no spaces, @, :, slashes or control characters, and no dot first` : null;

// A version names a folder of the plugin's copies: never one that is no folder of its own.
export const versionProblem = (v: string): string | null =>
  !v || v.length > 80 || v.startsWith(".") || /[\/\\\u0000-\u001f]/.test(v) ? `${JSON.stringify(v.slice(0, 80))} is not a version Keel can keep: no dot first, no slashes or control characters, at most 80 characters` : null;

const readJson = (p: string): { value?: any; error?: string } => {
  try { return { value: JSON.parse(readFileSync(p, "utf8")) }; } catch (e) { return { error: (e as Error).message }; }
};
const list = (d: string) => { try { return readdirSync(d).filter((n) => !n.startsWith(".")).sort(); } catch { return []; } };
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

// A name a SKILL.md or agent file gives itself in its frontmatter, else the fallback.
function ownName(file: string, fallback: string): string {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return fallback; }
  if (!text.startsWith("---")) return fallback;
  const end = text.indexOf("\n---", 3);
  const m = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(text.slice(0, end < 0 ? 0 : end));
  return m?.[1]?.trim() || fallback;
}

// The manifest's fields that Keel takes, and what each of the others is.
const TAKEN_KEYS = new Set(["$schema", "name", "displayName", "version", "description", "author", "homepage", "repository", "license", "keywords", "metadata", "icon", "documentationUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl", "defaultEnabled", "engines", "network", "types", "skills", "commands", "agents", "hooks", "mcpServers", "strict", "source", "category", "tags", "relevance", "headers", "headersHelper"]);
const NOT_TAKEN: Record<string, string> = {
  outputStyles: "Keel has no output style setting: a style's text belongs in an instructions file",
  lspServers: "Keel finds and starts language servers itself (Settings > Language servers)",
  userConfig: "Keel has no prompt for a plugin's settings: what reads them gets nothing",
  channels: "Keel has no message channels from plugins",
  dependencies: "Keel does not install other plugins for one: install each yourself",
  workflows: "Keel has no plugin workflows",
  mods: "a mod runs inside Claude Code's own process",
};
const FOLDERS: [string, string, string][] = [
  ["output-styles", "outputStyles", NOT_TAKEN.outputStyles!],
  [".lsp.json", "lspServers", NOT_TAKEN.lspServers!],
  ["monitors", "monitors", "Keel has no plugin monitors"],
  ["themes", "themes", "Keel's themes are its own"],
  ["workflows", "workflows", NOT_TAKEN.workflows!],
  ["bin", "bin", "Keel's shell does not put a plugin's programs on its PATH: a hook or server names them by ${CLAUDE_PLUGIN_ROOT}"],
  ["mods", "mods", NOT_TAKEN.mods!],
];

// Reads the plugin at `root`. `entry`: the marketplace entry it was listed
// under, which names it and, without a plugin.json, is its manifest.
export function readPlugin(root: string, entry?: MarketEntry): Plugin {
  root = resolve(root);
  const problems: string[] = [];
  const notTaken: NotTaken[] = [];
  const mf = join(root, ".claude-plugin", "plugin.json");
  let manifest: Record<string, any> = {};
  const has = existsSync(mf);
  if (has) {
    const r = readJson(mf);
    if (r.error) problems.push(`.claude-plugin/plugin.json is not JSON: ${r.error}`);
    else if (!r.value || typeof r.value !== "object" || Array.isArray(r.value)) problems.push(".claude-plugin/plugin.json is not an object");
    else manifest = r.value;
  }
  // The entry's own component fields: the manifest when there is no plugin.json, added to it when
  // strict (the default), a conflict when not.
  const COMPONENTS = ["skills", "commands", "agents", "hooks", "mcpServers"];
  const fromEntry = entry ? Object.fromEntries(Object.entries(entry.fields).filter(([k]) => COMPONENTS.includes(k) || NOT_TAKEN[k] || k === "experimental")) : {};
  if (entry && has && entry.strict === false && Object.keys(fromEntry).length) problems.push(`the marketplace entry declares ${Object.keys(fromEntry).join(", ")} beside a plugin.json while strict is false, which Claude Code refuses as a conflict`);
  const m: Record<string, any> = { ...(has ? {} : entry?.fields ?? {}), ...manifest };
  if (has && entry && entry.strict !== false) for (const [k, v] of Object.entries(fromEntry)) m[k] = m[k] === undefined ? v : k === "hooks" || k === "mcpServers" ? [...asList(m[k]), ...asList(v)] : [...asList(m[k]), ...asList(v)];

  const name = str(m.name) ?? entry?.name ?? basename(root);
  const bad = nameProblem(name);
  if (bad) problems.push(bad);
  const ver = str(m.version) ?? entry?.version;
  const vbad = ver === undefined ? null : versionProblem(ver);
  if (vbad) problems.push(vbad);

  // A component path: "./" and inside the plugin (skills may be ".").
  const at = (p: unknown, what: string, dot = false): string | null => {
    if (typeof p !== "string" || !(p.startsWith("./") || (dot && p === "."))) { problems.push(`${what}: ${JSON.stringify(p)} is not a path starting with ./`); return null; }
    const abs = resolve(root, p);
    if (!contains(root, abs)) { problems.push(`${what}: ${p} is outside the plugin's folder`); return null; }
    if (!existsSync(abs)) { problems.push(`${what}: ${p} does not exist`); return null; }
    return abs;
  };

  // Skills: the default folder, and the manifest's add to it.
  const skills: Plugin["skills"] = [];
  const addSkill = (dir: string) => {
    if (skills.some((s) => s.dir === dir) || !isFile(join(dir, "SKILL.md"))) return false;
    skills.push({ name: ownName(join(dir, "SKILL.md"), basename(dir)), dir });
    return true;
  };
  const skillFolder = (d: string) => { if (!addSkill(d)) for (const n of list(d)) addSkill(join(d, n)); };
  skillFolder(join(root, "skills"));
  for (const p of asList(m.skills)) { const d = at(p, "skills", true); if (d) skillFolder(d); }

  // Commands and agents: the manifest's paths replace the default folder.
  const mdFiles = (p: string) => (isDir(p) ? list(p).filter((n) => n.endsWith(".md")).map((n) => join(p, n)) : p.endsWith(".md") && isFile(p) ? [p] : []);
  const commands: Plugin["commands"] = [];
  if (m.commands === undefined) for (const f of mdFiles(join(root, "commands"))) commands.push({ name: basename(f, ".md"), file: f });
  else if (m.commands && typeof m.commands === "object" && !Array.isArray(m.commands)) {
    // The object map: { "<name>": "./file.md" | { "source": "./file.md", ... } }.
    for (const [n, v] of Object.entries<any>(m.commands)) {
      const f = at(typeof v === "string" ? v : v?.source, `commands.${n}`);
      if (f && isFile(f)) commands.push({ name: n, file: f });
      else if (f) problems.push(`commands.${n}: names a folder, not a command file`);
    }
  } else for (const p of asList(m.commands)) { const d = at(p, "commands"); if (d) for (const f of mdFiles(d)) commands.push({ name: basename(f, ".md"), file: f }); }
  const agents: Plugin["agents"] = [];
  for (const p of m.agents === undefined ? [join(root, "agents")] : asList(m.agents).map((p) => at(p, "agents")).filter((x): x is string => !!x)) {
    for (const f of mdFiles(p)) agents.push({ name: ownName(f, basename(f, ".md")), file: f });
  }

  // Hooks: hooks/hooks.json, then each of the manifest's (a file, an object, a list of either).
  const hooks: HookGroups = {};
  const mergeHooks = (v: any, what: string) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) { problems.push(`${what} is not an object of hook events`); return; }
    if (Array.isArray(v.modules) && v.modules.length) notTaken.push({ part: "hooks", why: `${what} holds modules, which run inside Claude Code's own process` });
    const events = v.hooks && typeof v.hooks === "object" ? v.hooks : Object.fromEntries(Object.entries(v).filter(([k]) => /^[A-Z]/.test(k)));
    for (const [event, groups] of Object.entries<any>(events)) {
      if (!Array.isArray(groups)) { problems.push(`${what}: ${event} must be a list`); continue; }
      (hooks[event] ??= []).push(...groups);
    }
  };
  const hookFile = (p: string, what: string) => { const r = readJson(p); if (r.error) problems.push(`${what} is not JSON: ${r.error}`); else mergeHooks(r.value, what); };
  if (isFile(join(root, "hooks", "hooks.json"))) hookFile(join(root, "hooks", "hooks.json"), "hooks/hooks.json");
  for (const v of asList(m.hooks)) {
    if (typeof v === "string") { const f = at(v, "hooks"); if (f && f !== join(root, "hooks", "hooks.json")) hookFile(f, v); }
    else mergeHooks(v, "the manifest's hooks");
  }

  // MCP servers: .mcp.json, then each of the manifest's; a later name replaces an earlier one.
  const mcp: Plugin["mcp"] = {};
  const mergeMcp = (v: any, what: string) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) { problems.push(`${what} is not an object of MCP servers`); return; }
    const servers = v.mcpServers && typeof v.mcpServers === "object" ? v.mcpServers : v;
    for (const [n, c] of Object.entries<any>(servers)) {
      if (!c || typeof c !== "object" || Array.isArray(c)) { problems.push(`${what}: server ${n} is not an object`); continue; }
      mcp[n] = c;
    }
  };
  const mcpFile = (p: string, what: string) => { const r = readJson(p); if (r.error) problems.push(`${what} is not JSON: ${r.error}`); else mergeMcp(r.value, what); };
  if (isFile(join(root, ".mcp.json"))) mcpFile(join(root, ".mcp.json"), ".mcp.json");
  for (const v of asList(m.mcpServers)) {
    if (typeof v === "string" && /\.(mcpb|dxt)$/i.test(v)) notTaken.push({ part: "mcpServers", why: `${v}: an MCP bundle, which Keel does not unpack` });
    else if (typeof v === "string") { const f = at(v, "mcpServers"); if (f && f !== join(root, ".mcp.json")) mcpFile(f, v); }
    else mergeMcp(v, "the manifest's mcpServers");
  }

  // What it holds that Keel has no part for: named, never dropped in silence.
  for (const [k, why] of Object.entries(NOT_TAKEN)) if (m[k] !== undefined) notTaken.push({ part: k, why });
  if (m.experimental && typeof m.experimental === "object") for (const k of Object.keys(m.experimental)) notTaken.push({ part: `experimental.${k}`, why: "an experimental Claude Code part Keel has no equivalent of" });
  for (const [f, part, why] of FOLDERS) {
    if (notTaken.some((n) => n.part === part)) continue;
    const p = join(root, f);
    if (isFile(p) || list(p).length) notTaken.push({ part: part === "lspServers" ? ".lsp.json" : `${f}/`, why });
  }
  for (const k of Object.keys(m)) if (!TAKEN_KEYS.has(k) && !NOT_TAKEN[k] && k !== "experimental") notTaken.push({ part: k, why: "a manifest field Keel does not know" });

  const author = typeof m.author === "string" ? m.author : str(m.author?.name);
  return {
    name, root, skills, commands, agents, hooks, mcp, notTaken, problems,
    ...(str(m.version) ? { version: str(m.version) } : entry?.version ? { version: entry.version } : {}),
    ...(str(m.description) ?? entry?.description ? { description: str(m.description) ?? entry?.description } : {}),
    ...(author ? { author } : {}),
    ...(str(m.homepage) ? { homepage: str(m.homepage) } : {}),
  };
}

// `.claude-plugin/marketplace.json` at `root`, or null when there is none.
export function readMarketplace(root: string): { market?: Marketplace; error?: string } | null {
  const f = join(root, ".claude-plugin", "marketplace.json");
  if (!existsSync(f)) return null;
  const r = readJson(f);
  if (r.error) return { error: `.claude-plugin/marketplace.json is not JSON: ${r.error}` };
  return parseMarketplace(r.value);
}

export function parseMarketplace(v: any): { market?: Marketplace; error?: string } {
  if (!v || typeof v !== "object" || !Array.isArray(v.plugins)) return { error: "a marketplace lists its plugins in plugins[]" };
  const plugins: MarketEntry[] = [];
  for (const p of v.plugins) {
    if (!p || typeof p !== "object" || typeof p.name !== "string" || p.source === undefined) continue;
    const { name, source, version, description, strict, ...rest } = p;
    plugins.push({ name, source, fields: rest, ...(typeof version === "string" ? { version } : {}), ...(typeof description === "string" ? { description } : {}), ...(typeof strict === "boolean" ? { strict } : {}) });
  }
  return {
    market: {
      name: str(v.name) ?? "marketplace", plugins,
      ...(typeof v.owner === "string" ? { owner: v.owner } : str(v.owner?.name) ? { owner: str(v.owner?.name) } : {}),
      ...(str(v.description ?? v.metadata?.description) ? { description: str(v.description ?? v.metadata?.description) } : {}),
      ...(str(v.metadata?.pluginRoot) ? { pluginRoot: str(v.metadata?.pluginRoot) } : {}),
    },
  };
}

// Where an entry's plugin is: a folder of the marketplace, or a git repository.
export type EntrySource = { dir: string } | { git: string; ref?: string; sub?: string } | { unsupported: string };
export function entrySource(e: MarketEntry, marketRoot: string, pluginRoot?: string): EntrySource {
  const s = e.source as any;
  if (typeof s === "string") {
    const rel = !s.startsWith("./") && s !== "." && pluginRoot ? join(pluginRoot, s) : s;
    const abs = resolve(marketRoot, rel);
    if (rel.split(/[\\/]/).includes("..") || !contains(resolve(marketRoot), abs)) return { unsupported: `${s} leaves the marketplace's folder` };
    return { dir: abs };
  }
  if (!s || typeof s !== "object") return { unsupported: "the entry has no source" };
  const ref = str(s.sha) ?? str(s.ref);
  if (s.source === "github" && str(s.repo)) return { git: `https://github.com/${s.repo}.git`, ...(ref ? { ref } : {}) };
  if (s.source === "url" && str(s.url)) return { git: s.url, ...(ref ? { ref } : {}) };
  if (s.source === "git-subdir" && str(s.url) && str(s.path)) {
    const url = /^[\w.-]+\/[\w.-]+$/.test(s.url) ? `https://github.com/${s.url}.git` : s.url;
    return { git: url, sub: s.path, ...(ref ? { ref } : {}) };
  }
  return { unsupported: `a ${String(s.source ?? "unknown")} source, which Keel cannot fetch (it takes folders and git repositories)` };
}

// What a plugin runs on the machine, one line each, as the owner is asked
// about it. Every part of a hook or a server that decides what runs or what
// it is given is its own line, as written: a hook's command and arguments,
// the address an http hook posts to with each header and each variable it
// may read; a server's command and arguments, its folder, each variable it
// is set or passed, its address, each header (a ${VAR} shown as the
// variable's name, never its value) and a headers helper, a command of its
// own run at each connect. The same lines are the same consent.
export type Run = { kind: "hook"; event: string; matcher?: string; what: string } | { kind: "mcp"; name: string; what: string };
const words = (c: string, a?: unknown) => [c, ...(Array.isArray(a) ? a.map(String) : [])].join(" ");
const entries = (v: unknown): [string, string][] => (v && typeof v === "object" && !Array.isArray(v) ? Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, typeof x === "string" ? x : JSON.stringify(x)]) : []);
const names = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
export function serverRuns(c: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof c.command === "string") out.push(words(c.command, c.args));
  else if (typeof c.url === "string") out.push(`connects to ${c.url}${c.transport === "sse" ? " (HTTP with SSE)" : ""}`);
  if (typeof c.cwd === "string") out.push(`starts in ${c.cwd}`);
  for (const [k, v] of entries(c.env)) out.push(`sets ${k}=${v}`);
  for (const n of names(c.env_vars)) out.push(`gets ${n} from Keel's environment`);
  for (const [k, v] of entries(c.headers)) out.push(`sends the header ${k}: ${v}`);
  for (const [k, n] of entries(c.headers_env)) out.push(`sends the header ${k} from ${n} in Keel's environment`);
  if (typeof c.bearer_env === "string") out.push(`sends ${c.bearer_env} from Keel's environment as its bearer token`);
  if (typeof c.headers_helper === "string") out.push(`runs ${c.headers_helper} at each connect`);
  if (c.oauth && typeof c.oauth === "object") out.push(`signs in with OAuth: ${JSON.stringify(c.oauth)}`);
  return out;
}
export function hookRuns(h: any): string[] {
  if (h?.type === "command") return [words(String(h.command ?? ""), h.args)];
  if (h?.type === "http") return [`sends each event to ${h.url}`, ...entries(h.headers).map(([k, v]) => `with the header ${k}: ${v}`), ...names(h.allowedEnvVars).map((n) => `with ${n} from Keel's environment`)];
  if (h?.type === "mcp_tool") return [`calls the tool ${h.tool} of the MCP server ${h.server}${h.input !== undefined ? ` with ${JSON.stringify(h.input)}` : ""}`];
  return [];
}
export function runsOf(hooks: HookGroups, mcp: Record<string, Record<string, unknown>>): Run[] {
  const out: Run[] = [];
  for (const [event, groups] of Object.entries(hooks)) for (const g of groups) for (const h of g.hooks ?? []) {
    for (const what of hookRuns(h)) out.push({ kind: "hook", event, ...(g.matcher ? { matcher: g.matcher } : {}), what });
  }
  for (const [name, c] of Object.entries(mcp)) for (const what of serverRuns(c)) out.push({ kind: "mcp", name, what });
  return out;
}
export const runLine = (r: Run) => (r.kind === "hook" ? `hook on ${r.event}${r.matcher ? ` (${r.matcher})` : ""}: ${r.what}` : `MCP server ${r.name}: ${r.what}`);
// A line as the owner reads it: the plugin's folders filled in (the key is of the lines as written).
export const fillLine = (line: string, vars: { root: string; data: string }) => fill(line, vars) as string;
// What the owner agreed to: the lines, in order. The same lines are the same consent.
export const consentKey = (lines: string[]) => createHash("sha256").update(lines.join("\n")).digest("hex");

// ${CLAUDE_PLUGIN_ROOT} and ${CLAUDE_PLUGIN_DATA} (and Keel's names for them)
// filled in, in every string of a value.
export function fill(v: any, vars: { root: string; data: string }): any {
  if (typeof v === "string") return v.replace(/\$\{(CLAUDE|KEEL)_PLUGIN_(ROOT|DATA)\}/g, (_, _k, w) => (w === "ROOT" ? vars.root : vars.data));
  if (Array.isArray(v)) return v.map((x) => fill(x, vars));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]));
  return v;
}

// --- names ----------------------------------------------------------------------

// An id for a plugin: its name, or with a number when another installed
// plugin (from another source) has the name.
export function chooseId(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name}-${n}`)) return `${name}-${n}`;
}

// A name an MCP server can have in Keel: letters, digits, dot, dash, underscore; no "__", no trailing "_".
export const serverName = (s: string) => s.replace(/[^\w.-]+/g, "-").replace(/_{2,}/g, "_").replace(/^[-_.]+|[-_.]+$/g, "").slice(0, 64) || "server";

export type Taken = { skills: Set<string>; agents: Set<string>; mcp: Set<string> };
// How a plugin's names stand beside the ones already there. Skills, commands
// and agents are always `<id>:<name>` (as Claude Code names them), so they
// never take one of the owner's; when a short name is also the owner's, that
// is said. An MCP server keeps its name when it is free, and takes the
// plugin's id as a prefix when one of the owner's servers, a built-in one or
// another plugin's has it.
export function resolveNames(p: { id: string; skills: string[]; commands: string[]; agents: string[]; mcp: string[] }, taken: Taken): { mcp: Record<string, string>; notes: string[] } {
  const notes: string[] = [];
  for (const s of p.skills) if (taken.skills.has(s)) notes.push(`The skill ${s} is also yours: yours keeps the name, this plugin's is ${p.id}:${s}.`);
  for (const c of p.commands) {
    if (p.skills.includes(c)) notes.push(`The command ${c} has the name of this plugin's skill ${c}: ${p.id}:${c} is the skill, as in Claude Code.`);
    else if (taken.skills.has(c)) notes.push(`The command ${c} is also yours: yours keeps the name, this plugin's is ${p.id}:${c}.`);
  }
  for (const a of p.agents) if (taken.agents.has(a)) notes.push(`The agent ${a} is also yours: yours keeps the name, this plugin's is ${p.id}:${a}.`);
  const mcp: Record<string, string> = {};
  const used = new Set([...taken.mcp].map((x) => x.toLowerCase()));
  for (const s of p.mcp) {
    const plain = serverName(s);
    let label = plain;
    if (used.has(label.toLowerCase())) {
      label = serverName(`${p.id}-${plain}`);
      for (let n = 2; used.has(label.toLowerCase()); n++) label = serverName(`${p.id}-${plain}-${n}`);
      notes.push(`The MCP server ${s} has the name of a server you have already: this plugin's is ${label}, and yours is left as it is.`);
    } else if (label !== s) notes.push(`The MCP server ${s} is named ${label} here: a server name is letters, digits, dot, dash and underscore.`);
    used.add(label.toLowerCase());
    mcp[s] = label;
  }
  return { mcp, notes };
}

// --- what an update changes --------------------------------------------------

export type Summary = { version: string; skills: string[]; commands: string[]; agents: string[]; mcp: string[]; runs: string[]; notTaken: string[] };
export function changes(a: Summary, b: Summary): { lines: string[]; runsChanged: boolean } {
  const lines: string[] = [];
  if (a.version !== b.version) lines.push(`version ${a.version} to ${b.version}`);
  const diff = (what: string, x: string[], y: string[]) => {
    const add = y.filter((n) => !x.includes(n)), gone = x.filter((n) => !y.includes(n));
    if (add.length) lines.push(`adds ${what}: ${add.join(", ")}`);
    if (gone.length) lines.push(`removes ${what}: ${gone.join(", ")}`);
  };
  diff("skills", a.skills, b.skills);
  diff("commands", a.commands, b.commands);
  diff("agents", a.agents, b.agents);
  diff("MCP servers", a.mcp, b.mcp);
  const newRuns = b.runs.filter((r) => !a.runs.includes(r)), oldRuns = a.runs.filter((r) => !b.runs.includes(r));
  for (const r of newRuns) lines.push(`will run ${r}`);
  for (const r of oldRuns) lines.push(`no longer runs ${r}`);
  diff("parts not taken", a.notTaken, b.notTaken);
  return { lines, runsChanged: newRuns.length > 0 || oldRuns.length > 0 || a.runs.join("\n") !== b.runs.join("\n") };
}
