// MCP server config: keel's own mcp.json, plus the entries other agents'
// configs hold (sources.ts reads them) that the owner imports in one step.
// Import copies and keeps the copy in step with its source; the source file
// is never written.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../providers/config.ts";
import type { OAuthConfig } from "./oauth.ts";
import { endpoint, identity, readSources, type SourceServer } from "./sources.ts";

export type McpServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  env_vars?: string[];                 // names passed through from keel's env
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  headers_env?: Record<string, string>; // header -> env var holding its value
  bearer_env?: string;
  enabled?: boolean;
  timeout_secs?: number;               // connect
  tool_timeout_secs?: number;          // one tools/call
  oauth?: OAuthConfig;
  // Tools of this server the owner marked as reads: they run without asking.
  // A server's own readOnlyHint does not count; it is the server's word.
  read_tools?: string[];
  transport?: "sse";                   // the deprecated HTTP+SSE transport (the default is Streamable HTTP)
  headers_helper?: string;             // a command printing a JSON object of headers, run at each connect
  // Imported from another agent and kept in step with it: the source and its name for the server there.
  sync?: { source: string; name: string };
};

export type McpConfigFile = { servers: Record<string, McpServerConfig>; [k: string]: unknown };

// Built-in groups and catalogs, and the servers Keel brings itself (bundled).
export const RESERVED = new Set(["web", "mcp", "chrome", "keel", "keel-import", "phone", "parlar"]);

export const configPath = () => process.env.KEEL_MCP_CONFIG ?? join(configDir(), "mcp.json");

// Throws with the parser's reason; the caller keeps the old config then.
export function readConfig(path = configPath()): McpConfigFile {
  if (!existsSync(path)) return { servers: {} };
  const raw = JSON.parse(readFileSync(path, "utf8"));
  // Accept Claude Code's key too, so a copied .mcp.json just works.
  const servers = raw.servers ?? raw.mcpServers ?? {};
  if (typeof servers !== "object" || Array.isArray(servers)) throw new Error("servers must be an object");
  const out: Record<string, McpServerConfig> = {};
  for (const [name, c] of Object.entries<any>(servers)) out[name] = normalize(c);
  return { ...raw, servers: out };
}

// Write back keeping every other top-level key the file had.
export function writeConfig(cfg: McpConfigFile, path = configPath()) {
  mkdirSync(dirname(path), { recursive: true });
  let keep: Record<string, unknown> = {};
  try { keep = JSON.parse(readFileSync(path, "utf8")); } catch {}
  delete keep.mcpServers;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...keep, ...cfg, servers: cfg.servers }, null, 2) + "\n");
  renameSync(tmp, path);
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

// One shape from Claude Code's (type/command/args/env/url/headers) and keel's own.
function normalize(c: any): McpServerConfig {
  const out: McpServerConfig = {};
  if (c.command) out.command = String(c.command);
  if (Array.isArray(c.args)) out.args = c.args.map(String);
  if (c.env && typeof c.env === "object") out.env = c.env;
  if (Array.isArray(c.env_vars)) out.env_vars = c.env_vars.map(String);
  if (c.cwd) out.cwd = String(c.cwd);
  if (c.url) out.url = String(c.url);
  if (c.headers && typeof c.headers === "object") out.headers = c.headers;
  if (c.headers_env && typeof c.headers_env === "object") out.headers_env = c.headers_env;
  if (c.bearer_env) out.bearer_env = String(c.bearer_env);
  if (c.enabled === false || c.disabled === true) out.enabled = false;
  if (c.timeout_secs) out.timeout_secs = Number(c.timeout_secs);
  if (c.tool_timeout_secs) out.tool_timeout_secs = Number(c.tool_timeout_secs);
  if (c.oauth && typeof c.oauth === "object") out.oauth = c.oauth;
  if (Array.isArray(c.read_tools)) out.read_tools = c.read_tools.map(String);
  if (c.transport === "sse" || c.type === "sse") out.transport = "sse";
  if (typeof c.headers_helper === "string") out.headers_helper = c.headers_helper;
  else if (typeof c.headersHelper === "string") out.headers_helper = c.headersHelper;
  if (c.sync && typeof c.sync.source === "string" && typeof c.sync.name === "string") out.sync = { source: c.sync.source, name: c.sync.name };
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
