// MCP server config: keel's own mcp.json, plus the entries other agents'
// configs hold (sources.ts reads them) that the owner imports in one step.
// Import copies and keeps the copy in step with its source; the source file
// is never written.
import { configRefused } from "../core/named-config.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeOwnFile } from "../core/ownfile.ts";
import { configDir } from "../providers/config.ts";
import type { OAuthConfig } from "./oauth.ts";
import { endpoint, identity, readSources, type SourceServer } from "./sources.ts";

export type McpServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  env_vars?: string[];                 // names passed through from keel's env
  owner_env_vars?: string[];           // of a synced copy: the names the owner added in Keel (the rest of env_vars is the source's, taken fresh at each sync)
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  headers_env?: Record<string, string>; // header -> env var holding its value
  bearer_env?: string;
  enabled?: boolean;
  timeout_secs?: number;               // connect
  tool_timeout_secs?: number;          // one tools/call without a word from its server (progress that grew starts it again)
  tool_max_secs?: number;              // one tools/call at most, whatever it reports, a call the server runs as a task included (client.ts TOOL_CEILING_MS by default)
  oauth?: OAuthConfig;
  // Tools of this server the owner marked as reads: they run without asking.
  // A server's own readOnlyHint does not count; it is the server's word.
  read_tools?: string[];
  transport?: "sse";                   // the deprecated HTTP+SSE transport (the default is Streamable HTTP)
  headers_helper?: string;             // a command printing a JSON object of headers, run at each connect
  // Imported from another agent and kept in step with it: the source and its name for the server there.
  sync?: { source: string; name: string };
  // Its events may be pushed into the sessions that take them (src/mcp/channel.ts). The owner's, off by default.
  channel?: boolean;
  // The owner's: this server's browser is closed, through its own `browser_close` tool, once no call has used it
  // for `mcp_idle.close_browser_min` minutes. Off by default; only for a server Keel starts (a command), never a
  // remote one (src/mcp/manager.ts closeIdle).
  close_idle_browser?: boolean;
  // The owner's: this server is offered to the model although an earlier entry of the owner's list is the same program
  // (the same command, arguments and environment, or the same address). By default only the first by name is offered and
  // the others are listed as "same as <name>" (src/mcp/manager.ts twinOf).
  offer_twin?: boolean;
  // The owner's: this command server runs from the daemon's start and is never ended for idleness. Off by default:
  // a command server is started by its first call, from the tool list kept of its last run, and ended after
  // `mcp_idle.stop_min` minutes with no call (src/mcp/manager.ts). For one that holds state in memory between calls.
  keep_running?: boolean;
  // `false`: a server a session owns (its editor's, its project's .mcp.json, an agent file's) is not shared with the
  // other sessions given the same one: it runs for this session alone. By default sessions given an identical server
  // (command, arguments, environment, folder, sandbox; or address and headers) use one connection. Also read from an
  // editor's entry and an agent file's or project's.
  share?: boolean;
  // The owner's answers of what kind of server it is (src/mcp/class.ts); one not given is read from the config.
  class?: Partial<Record<"outside" | "sends" | "account", boolean>>;
};

export type McpConfigFile = { servers: Record<string, McpServerConfig>; [k: string]: unknown };

// Built-in groups and catalogs, and the servers Keel brings itself (bundled).
export const RESERVED = new Set(["web", "mcp", "chrome", "keel", "keel-import", "phone", "parlar", "tacit", "chatgpt-apps"]);

// The owner's file. Named by whoever starts a manager or a command (the
// daemon's route, keel port); nothing below them falls back to it.
export const configPath = () => process.env.KEEL_MCP_CONFIG ?? join(configDir(), "mcp.json");

// Throws with the parser's reason; the caller keeps the old config then.
export function readConfig(path: string): McpConfigFile {
  // (A file a variable puts inside a folder a session works in is not loaded: src/core/named-config.ts.)
  if (configRefused("KEEL_MCP_CONFIG", path)) return { servers: {} };
  if (!existsSync(path)) return { servers: {} };
  return parseConfig(readFileSync(path, "utf8"));
}

export function parseConfig(text: string): McpConfigFile {
  const raw = JSON.parse(text);
  // Accept Claude Code's key too, so a copied .mcp.json just works.
  const servers = raw.servers ?? raw.mcpServers ?? {};
  if (typeof servers !== "object" || Array.isArray(servers)) throw new Error("servers must be an object");
  const out: Record<string, McpServerConfig> = {};
  for (const [name, c] of Object.entries<any>(servers)) out[name] = normalize(c);
  return { ...raw, servers: out };
}

// Write back the servers, with every other top-level key as the file has it
// now and in the file's order: the servers are all a writer changes, and its
// own copy of the other keys may be older than a hand edit. A file that is
// gone gets the writer's keys. Whole or not at all, and what the file held
// before stays as mcp.json.prev (core/ownfile.ts). Returns the text now in
// the file.
export function writeConfig(cfg: McpConfigFile, path: string): string {
  let file: Record<string, unknown> | null = null;
  try { file = JSON.parse(readFileSync(path, "utf8")); } catch {}
  const from: Record<string, unknown> = file && typeof file === "object" && !Array.isArray(file) ? file : cfg;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(from)) {
    if (k === "servers" || k === "mcpServers") out.servers = cfg.servers; // where the file keeps them
    else out[k] = v;
  }
  out.servers = cfg.servers;
  const text = JSON.stringify(out, null, 2) + "\n";
  writeOwnFile(path, text);
  return text;
}

// Key order is the writer's: compare with keys sorted.
export const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => [k, x[k]])) : x));

// The file changed under a writer: by a hand edit, or another process. What
// goes back is a merge by server name of three maps: `base` (the servers as
// this writer last read or wrote them), `mine` (its own now) and `disk` (the
// file now). A server this writer changed since `base`, removed included, is
// its own; every other one is the file's, so an entry it never read is kept
// and one taken out of the file by hand stays out. `theirs` names what the
// file changed that this writer did not.
export function mergeServers(base: Record<string, McpServerConfig>, mine: Record<string, McpServerConfig>, disk: Record<string, McpServerConfig>) {
  const servers: Record<string, McpServerConfig> = {};
  const theirs: string[] = [];
  const same = (a?: McpServerConfig, b?: McpServerConfig) => (a === undefined || b === undefined ? a === b : canon(a) === canon(b));
  for (const name of new Set([...Object.keys(disk), ...Object.keys(mine), ...Object.keys(base)])) {
    const changedHere = !same(mine[name], base[name]);
    const kept = changedHere ? mine[name] : disk[name];
    if (kept) servers[name] = kept;
    if (!changedHere && !same(disk[name], base[name])) theirs.push(name);
  }
  return { servers, theirs };
}

export function validate(name: string, c: McpServerConfig): string | null {
  if (!name || !/^[\w.-]{1,64}$/.test(name)) return "a server name is letters, digits, dot, dash or underscore";
  // A tool's full name is <server>__<tool>: a server name with "__" in it, or
  // one that ends in "_", could name another server's tool.
  if (name.includes("__") || name.endsWith("_")) return "a server name has no double underscore and does not end in one";
  if (RESERVED.has(name.toLowerCase())) return `${name} is a built-in server name`;
  if (!!c.command === !!c.url) return "give either command or url";
  if (c.url && !/^https?:\/\//.test(c.url)) return "url must be http(s)";
  return null;
}

// The keys one server's JSON may hold, Claude Code's (`type`, `headersHelper`, `disabled`) and Keel's own.
const SERVER_KEYS = new Set(["type", "command", "args", "env", "env_vars", "owner_env_vars", "cwd", "url", "headers", "headers_env", "bearer_env", "enabled", "disabled",
  "timeout_secs", "tool_timeout_secs", "tool_max_secs", "oauth", "read_tools", "transport", "headers_helper", "headersHelper", "sync", "channel", "close_idle_browser", "offer_twin", "keep_running", "share", "class"]);

// One server's JSON as a person gives it (`keel mcp add NAME --json -`: from stdin, so a token stays off the
// command line). An unknown key is refused by name, never dropped: a misspelled `headers` would otherwise
// save a server with no sign-in. The reasons name keys, never values, so a token is not echoed back.
export function serverFromJson(raw: unknown): { config: McpServerConfig } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "the server's JSON is one object, like {\"command\": \"npx\", \"args\": [\"-y\", \"some-server\"]} or {\"url\": \"https://host/mcp\"}" };
  const c = raw as Record<string, unknown>;
  const unknown = Object.keys(c).filter((k) => !SERVER_KEYS.has(k));
  if (unknown.length) return { error: `unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Known: ${[...SERVER_KEYS].filter((k) => k !== "headersHelper" && k !== "disabled").join(", ")}` };
  if (c.type !== undefined && !["stdio", "http", "sse", "streamable-http"].includes(String(c.type))) return { error: `type is stdio, http or sse, not ${JSON.stringify(c.type).slice(0, 40)}` };
  if (c.args !== undefined && !Array.isArray(c.args)) return { error: "args is a list of words" };
  for (const k of ["env", "headers", "headers_env"]) if (c[k] !== undefined && (!c[k] || typeof c[k] !== "object" || Array.isArray(c[k]))) return { error: `${k} is an object of names and values` };
  return { config: normalize(c) };
}

// One shape from Claude Code's (type/command/args/env/url/headers) and keel's own.
function normalize(c: any): McpServerConfig {
  const out: McpServerConfig = {};
  if (c.command) out.command = String(c.command);
  if (Array.isArray(c.args)) out.args = c.args.map(String);
  if (c.env && typeof c.env === "object") out.env = c.env;
  if (Array.isArray(c.env_vars)) out.env_vars = c.env_vars.map(String);
  if (Array.isArray(c.owner_env_vars)) out.owner_env_vars = c.owner_env_vars.map(String);
  if (c.cwd) out.cwd = String(c.cwd);
  if (c.url) out.url = String(c.url);
  if (c.headers && typeof c.headers === "object") out.headers = c.headers;
  if (c.headers_env && typeof c.headers_env === "object") out.headers_env = c.headers_env;
  if (c.bearer_env) out.bearer_env = String(c.bearer_env);
  if (c.enabled === false || c.disabled === true) out.enabled = false;
  if (c.timeout_secs) out.timeout_secs = Number(c.timeout_secs);
  if (c.tool_timeout_secs) out.tool_timeout_secs = Number(c.tool_timeout_secs);
  if (c.tool_max_secs) out.tool_max_secs = Number(c.tool_max_secs);
  if (c.oauth && typeof c.oauth === "object") out.oauth = c.oauth;
  if (Array.isArray(c.read_tools)) out.read_tools = c.read_tools.map(String);
  if (c.transport === "sse" || c.type === "sse") out.transport = "sse";
  if (typeof c.headers_helper === "string") out.headers_helper = c.headers_helper;
  else if (typeof c.headersHelper === "string") out.headers_helper = c.headersHelper;
  if (c.sync && typeof c.sync.source === "string" && typeof c.sync.name === "string") out.sync = { source: c.sync.source, name: c.sync.name };
  if (c.channel === true) out.channel = true;
  if (c.close_idle_browser === true) out.close_idle_browser = true;
  if (c.offer_twin === true) out.offer_twin = true;
  if (c.keep_running === true) out.keep_running = true;
  if (c.share === false) out.share = false;
  if (c.class && typeof c.class === "object") {
    const k = Object.fromEntries(["outside", "sends", "account"].filter((x) => typeof c.class[x] === "boolean").map((x) => [x, c.class[x]]));
    if (Object.keys(k).length) out.class = k;
  }
  return out;
}

// `${VAR}` and `${VAR:-default}`, as Claude Code expands them in .mcp.json.
export function expand(s: string, env: Record<string, string | undefined> = process.env): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k, d) => env[k] ?? d ?? "");
}

// `group`: the endpoint and account as one opaque key (the same server set up
// in several agents is one row). `other_account`: a Keel server at the same
// endpoint under another account (its name).
export type ImportableServer = SourceServer & { endpoint: string; group: string; configured: boolean; other_account?: string };

// The same server is often set up in several agents (under one name or
// another): configured means Keel already has a server at that endpoint with
// the same account (environment and headers).
export function importable(cwd: string, configured: Record<string, McpServerConfig>, failed?: { file: string; error: string }[]): ImportableServer[] {
  const have = new Set(Object.values(configured).map(identity));
  const byEndpoint = new Map(Object.entries(configured).map(([n, c]) => [endpoint(c), n]));
  return readSources(cwd, failed).flatMap((s) => {
    if (RESERVED.has(s.name.toLowerCase())) return [];
    const config = s.config;
    // The Chrome bridge is built in: another agent's entry for it is already here.
    const bundled = /agent-chrome-bridge|chrome-bridge/.test([config.command, ...(config.args ?? [])].join(" "));
    const ep = endpoint(config);
    const id = identity(config);
    const done = bundled || have.has(id) || (s.name in configured && identity(configured[s.name]!) === id);
    const other = !done ? byEndpoint.get(ep) : undefined;
    return [{ ...s, endpoint: ep, group: createHash("sha256").update(id).digest("hex").slice(0, 16), configured: done, ...(other ? { other_account: other } : {}) }];
  });
}
