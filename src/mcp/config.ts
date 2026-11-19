// MCP server config: keel's own mcp.json, plus entries other agents' configs
// hold (Claude Code's ~/.claude.json and .mcp.json, Codex's config.toml) that
// the owner can import with one click. Import copies; the source stays as is.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configDir } from "../providers/config.ts";
import type { OAuthConfig } from "./oauth.ts";

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
};

export type McpConfigFile = { servers: Record<string, McpServerConfig>; [k: string]: unknown };

// Built-in groups and the servers Keel brings itself (bundled).
export const RESERVED = new Set(["web", "mcp", "chrome"]);

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
  if (RESERVED.has(name)) return `${name} is a built-in server name`;
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
  return out;
}

// Codex's [mcp_servers.<name>] table.
function fromCodex(c: any): McpServerConfig {
  return normalize({
    command: c.command,
    args: c.args,
    env: c.env,
    env_vars: c.env_vars,
    cwd: c.cwd,
    url: c.url,
    headers: c.http_headers,
    headers_env: c.env_http_headers,
    bearer_env: c.bearer_token_env_var,
    enabled: c.enabled,
    timeout_secs: c.startup_timeout_sec,
    tool_timeout_secs: c.tool_timeout_sec,
  });
}

// `${VAR}` and `${VAR:-default}`, as Claude Code expands them in .mcp.json.
export function expand(s: string, env: Record<string, string | undefined> = process.env): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k, d) => env[k] ?? d ?? "");
}

export type ImportableServer = { source: string; label: string; name: string; config: McpServerConfig; configured: boolean };

export function importable(cwd: string, configured: Record<string, McpServerConfig>): ImportableServer[] {
  const out: ImportableServer[] = [];
  const add = (source: string, label: string, servers: Record<string, any> | undefined, conv = normalize) => {
    for (const [name, c] of Object.entries(servers ?? {})) {
      if (!c || typeof c !== "object") continue;
      const config = conv(c);
      if (!config.command && !config.url) continue;
      // The Chrome bridge is built in: another agent's entry for it is already here.
      const bundled = /agent-chrome-bridge|chrome-bridge/.test([config.command, ...(config.args ?? [])].join(" "));
      out.push({ source, label, name, config, configured: name in configured || bundled });
    }
  };
  const home = homedir();
  try {
    const cj = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    add("claude:user", "Claude Code (user)", cj.mcpServers);
    add("claude:local", "Claude Code (this folder)", cj.projects?.[cwd]?.mcpServers);
  } catch {}
  try {
    const mj = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
    add("claude:project", "Claude Code (.mcp.json)", mj.mcpServers);
  } catch {}
  try {
    const ct = Bun.TOML.parse(readFileSync(join(process.env.CODEX_HOME ?? join(home, ".codex"), "config.toml"), "utf8")) as any;
    add("codex", "Codex", ct.mcp_servers, fromCodex);
  } catch {}
  return out;
}
