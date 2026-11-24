// The MCP servers other agents on this machine are set up with, read from
// their own files: Claude Code (user, this folder, .mcp.json, enabled
// plugins), Claude Desktop, Codex, Gemini CLI, Antigravity, Cursor, OpenCode,
// Hermes and Zed. Each reader maps its harness's shape onto Keel's one shape;
// nothing here writes to another agent's file.
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { McpServerConfig } from "./config.ts";
import { homeDir } from "../core/paths";

export type SourceServer = { source: string; label: string; file: string; name: string; config: McpServerConfig; project?: boolean };

// KEEL_IMPORT_HOME points the readers at a scratch home (the e2e writes its
// fixtures there); the real home otherwise.
export const importHome = () => process.env.KEEL_IMPORT_HOME ?? homeDir();

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const json = (path: string): any => { const t = read(path); return t === null ? null : JSON.parse(t); };
const jsonc = (path: string): any => { const t = read(path); return t === null ? null : Bun.JSONC.parse(t); };
const toml = (path: string): any => { const t = read(path); return t === null ? null : Bun.TOML.parse(t); };
const yaml = (path: string): any => { const t = read(path); return t === null ? null : Bun.YAML.parse(t); };

const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : undefined);
const clean = (c: McpServerConfig): McpServerConfig => {
  for (const k of Object.keys(c) as (keyof McpServerConfig)[]) if (c[k] === undefined || (typeof c[k] === "object" && !Array.isArray(c[k]) && !Object.keys(c[k] as object).length)) delete c[k];
  return c;
};
const secs = (ms: unknown) => (typeof ms === "number" && ms > 0 ? Math.ceil(ms / 1000) : undefined);

// Claude Code, Claude Desktop and Cursor share one entry shape; `type` says
// the transport ("http", "sse", "ws", "stdio"). Antigravity calls the URL serverUrl.
export function claudeShape(c: any): McpServerConfig {
  const url = c.url ?? c.serverUrl;
  return clean({
    command: url ? undefined : c.command ? String(c.command) : undefined,
    args: url ? undefined : strs(c.args),
    env: url ? undefined : obj(c.env),
    cwd: c.cwd ? String(c.cwd) : undefined,
    url: url ? String(url) : undefined,
    transport: c.type === "sse" ? "sse" : undefined,
    headers: url ? obj(c.headers) : undefined,
    headers_helper: typeof c.headersHelper === "string" ? c.headersHelper : undefined,
    enabled: c.disabled === true || c.enabled === false ? false : undefined,
    oauth: c.oauth?.clientId ? { client_id: String(c.oauth.clientId) } : undefined,
    // Claude Code's `timeout` (ms) is a call's wall-clock limit, and no less than its idle window; under 1000 it is ignored.
    tool_max_secs: secs(c.timeout >= 1000 ? c.timeout : undefined),
    tool_timeout_secs: secs(c.timeout >= 1000 ? c.timeout : undefined),
  });
}

// Codex's [mcp_servers.<name>] table.
function codexShape(c: any): McpServerConfig {
  return clean({
    command: c.command ? String(c.command) : undefined,
    args: strs(c.args),
    env: obj(c.env),
    env_vars: Array.isArray(c.env_vars) ? c.env_vars.map((v: any) => String(typeof v === "string" ? v : v?.name)).filter((v: string) => v && v !== "undefined") : undefined,
    cwd: c.cwd ? String(c.cwd) : undefined,
    url: c.url ? String(c.url) : undefined,
    headers: obj(c.http_headers),
    headers_env: obj(c.env_http_headers),
    headers_helper: typeof c.http_headers_helper === "string" ? c.http_headers_helper : Array.isArray(c.http_headers_helper) ? c.http_headers_helper.join(" ") : undefined,
    bearer_env: c.bearer_token_env_var ? String(c.bearer_token_env_var) : undefined,
    enabled: c.enabled === false ? false : undefined,
    timeout_secs: typeof c.startup_timeout_sec === "number" ? c.startup_timeout_sec : undefined,
    tool_timeout_secs: typeof c.tool_timeout_sec === "number" ? c.tool_timeout_sec : undefined,
    oauth: c.oauth?.client_id ? { client_id: String(c.oauth.client_id) } : undefined,
  });
}

// Gemini CLI: `httpUrl` is Streamable HTTP, `url` is SSE; timeouts in ms.
function geminiShape(c: any): McpServerConfig {
  const url = c.httpUrl ?? c.url;
  return clean({
    command: url ? undefined : c.command ? String(c.command) : undefined,
    args: url ? undefined : strs(c.args),
    env: url ? undefined : obj(c.env),
    cwd: c.cwd ? String(c.cwd) : undefined,
    url: url ? String(url) : undefined,
    transport: !c.httpUrl && c.url && c.type !== "http" ? "sse" : undefined,
    headers: url ? obj(c.headers) : undefined,
    tool_timeout_secs: secs(c.timeout),
    enabled: c.disabled === true ? false : undefined,
  });
}

// OpenCode: `type: local` with the command as one array, `type: remote` with a url.
function opencodeShape(c: any): McpServerConfig {
  const cmd = Array.isArray(c.command) ? c.command.map(String) : c.command ? [String(c.command)] : [];
  return clean({
    command: c.type === "remote" ? undefined : cmd[0],
    args: c.type === "remote" ? undefined : cmd.slice(1).length ? cmd.slice(1) : undefined,
    env: obj(c.environment),
    url: c.type === "remote" && c.url ? String(c.url) : undefined,
    headers: c.type === "remote" ? obj(c.headers) : undefined,
    enabled: c.enabled === false ? false : undefined,
    tool_timeout_secs: secs(c.timeout),
  });
}

// Hermes: config.yaml `mcp_servers`; `auth: oauth` is what Keel does for HTTP anyway.
function hermesShape(c: any): McpServerConfig {
  return clean({
    command: c.url ? undefined : c.command ? String(c.command) : undefined,
    args: c.url ? undefined : strs(c.args),
    env: c.url ? undefined : obj(c.env),
    url: c.url ? String(c.url) : undefined,
    headers: c.url ? obj(c.headers) : undefined,
    enabled: c.enabled === false ? false : undefined,
    tool_timeout_secs: typeof c.timeout === "number" ? c.timeout : undefined,
    timeout_secs: typeof c.connect_timeout === "number" ? c.connect_timeout : undefined,
  });
}

// Zed: settings.json `context_servers`; an extension-provided one has no command here.
function zedShape(c: any): McpServerConfig {
  const cmd = c.command && typeof c.command === "object" ? c.command : c;
  return clean({
    command: c.url ? undefined : cmd.path ?? cmd.command,
    args: c.url ? undefined : strs(cmd.args),
    env: c.url ? undefined : obj(cmd.env),
    url: c.url ? String(c.url) : undefined,
    headers: c.url ? obj(c.headers) : undefined,
    enabled: c.enabled === false ? false : undefined,
  });
}

// Every reader is guarded on its own: one unreadable file never hides the others.
// `failed` collects the files that exist and could not be read (shown, not thrown).
export function readSources(cwd: string, failed: { file: string; error: string }[] = []): SourceServer[] {
  const home = importHome();
  const out: SourceServer[] = [];
  const add = (source: string, label: string, file: string, servers: unknown, shape: (c: any) => McpServerConfig, project = false, expand?: (s: string) => string) => {
    if (!servers || typeof servers !== "object") return;
    for (const [name, c] of Object.entries(servers as Record<string, any>)) {
      if (!c || typeof c !== "object") continue;
      let config = shape(c);
      if (expand) config = JSON.parse(expand(JSON.stringify(config)));
      if (!config.command && !config.url) continue;
      out.push({ source, label, file, name, config, project: project || undefined });
    }
  };
  const guard = (file: string, f: () => void) => {
    try { f(); } catch (e) { failed.push({ file, error: (e as Error).message }); }
  };

  const claudeJson = join(home, ".claude.json");
  guard(claudeJson, () => {
    const cj = json(claudeJson);
    add("claude:user", "Claude Code", claudeJson, cj?.mcpServers, claudeShape);
    add("claude:local", "Claude Code (this folder)", claudeJson, cj?.projects?.[cwd]?.mcpServers, claudeShape, true);
  });
  const dotMcp = join(cwd, ".mcp.json");
  guard(dotMcp, () => add("claude:project", "Claude Code (.mcp.json)", dotMcp, json(dotMcp)?.mcpServers, claudeShape, true));
  // Servers of the Claude Code plugins that are turned on, with the plugin's own folder filled in.
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const installed = join(claudeDir, "plugins", "installed_plugins.json");
  guard(installed, () => {
    const plugins = json(installed)?.plugins;
    if (!plugins) return;
    const on = json(join(claudeDir, "settings.json"))?.enabledPlugins ?? {};
    for (const [id, list] of Object.entries<any>(plugins)) {
      if (on[id] !== true) continue;
      const inst = Array.isArray(list) ? list[list.length - 1] : null;
      const root = inst?.installPath;
      if (!root || !existsSync(root)) continue;
      const expand = (s: string) => s.replaceAll("${CLAUDE_PLUGIN_ROOT}", root.replace(/["\\]/g, "\\$&"));
      const manifest = json(join(root, ".claude-plugin", "plugin.json"));
      const inline = manifest?.mcpServers && typeof manifest.mcpServers === "object" ? manifest.mcpServers : null;
      const file = inline ? join(root, ".claude-plugin", "plugin.json") : join(root, ".mcp.json");
      const servers = inline ?? (() => { const m = json(join(root, typeof manifest?.mcpServers === "string" ? manifest.mcpServers : ".mcp.json")); return m?.mcpServers ?? m; })();
      add(`claude:plugin:${id}`, `Claude Code plugin ${id.split("@")[0]}`, file, servers, claudeShape, false, expand);
    }
  });
  const desktop = join(process.env.XDG_CONFIG_HOME?.startsWith("/") && !process.env.KEEL_IMPORT_HOME ? process.env.XDG_CONFIG_HOME : join(home, ".config"), "Claude", "claude_desktop_config.json");
  guard(desktop, () => add("claude-desktop", "Claude Desktop", desktop, json(desktop)?.mcpServers, claudeShape));

  const codexHome = process.env.KEEL_IMPORT_HOME ? join(home, ".codex") : process.env.CODEX_HOME ?? join(home, ".codex");
  const codexToml = join(codexHome, "config.toml");
  guard(codexToml, () => add("codex", "Codex", codexToml, toml(codexToml)?.mcp_servers, codexShape));
  const codexProject = join(cwd, ".codex", "config.toml");
  guard(codexProject, () => add("codex:project", "Codex (this folder)", codexProject, toml(codexProject)?.mcp_servers, codexShape, true));

  const gemini = join(home, ".gemini", "settings.json");
  guard(gemini, () => add("gemini", "Gemini CLI", gemini, jsonc(gemini)?.mcpServers, geminiShape));
  const geminiProject = join(cwd, ".gemini", "settings.json");
  guard(geminiProject, () => add("gemini:project", "Gemini CLI (this folder)", geminiProject, jsonc(geminiProject)?.mcpServers, geminiShape, true));
  // Antigravity has kept its file in two places.
  for (const f of [join(home, ".gemini", "antigravity", "mcp_config.json"), join(home, ".gemini", "config", "mcp_config.json")]) {
    guard(f, () => add("antigravity", "Antigravity", f, jsonc(f)?.mcpServers, claudeShape));
  }

  const cursor = join(home, ".cursor", "mcp.json");
  guard(cursor, () => add("cursor", "Cursor", cursor, json(cursor)?.mcpServers, claudeShape));
  const cursorProject = join(cwd, ".cursor", "mcp.json");
  guard(cursorProject, () => add("cursor:project", "Cursor (this folder)", cursorProject, json(cursorProject)?.mcpServers, claudeShape, true));

  for (const f of [join(home, ".config", "opencode", "opencode.json"), join(home, ".config", "opencode", "opencode.jsonc")]) {
    guard(f, () => add("opencode", "OpenCode", f, jsonc(f)?.mcp, opencodeShape));
  }
  const hermes = join(process.env.KEEL_IMPORT_HOME ? join(home, ".hermes") : process.env.HERMES_HOME ?? join(home, ".hermes"), "config.yaml");
  guard(hermes, () => add("hermes", "Hermes", hermes, yaml(hermes)?.mcp_servers, hermesShape));
  const zed = join(home, ".config", "zed", "settings.json");
  guard(zed, () => add("zed", "Zed", zed, jsonc(zed)?.context_servers, zedShape));
  return out;
}

// The files the readers look at, for a watcher (folders, since agents replace files by rename).
export function sourceFiles(cwd: string): string[] {
  const home = importHome();
  return [
    join(home, ".claude.json"), join(cwd, ".mcp.json"), join(home, ".claude", "settings.json"), join(home, ".claude", "plugins", "installed_plugins.json"),
    join(home, ".config", "Claude", "claude_desktop_config.json"), join(home, ".codex", "config.toml"),
    join(home, ".gemini", "settings.json"), join(home, ".gemini", "antigravity", "mcp_config.json"), join(home, ".gemini", "config", "mcp_config.json"),
    join(home, ".cursor", "mcp.json"), join(home, ".config", "opencode", "opencode.json"), join(home, ".hermes", "config.yaml"), join(home, ".config", "zed", "settings.json"),
  ];
}

// Where a server is, whatever it is called: the URL, or the program's file
// name and its arguments (one agent names /usr/bin/node, another node). A URL
// is compared as RFC 3986 says: scheme and host in any case and the default
// port left out; the path and query stay exact, a trailing slash included.
export function endpoint(c: McpServerConfig): string {
  if (c.url) {
    try {
      const u = new URL(c.url.trim());
      const auth = u.username ? `${u.username}${u.password ? `:${u.password}` : ""}@` : "";
      return `${u.protocol}//${auth}${u.host}${u.pathname}${u.search}${u.hash}`;
    } catch {
      return c.url.trim();
    }
  }
  return [basename(c.command ?? ""), ...(c.args ?? [])].join(" ");
}

// A server as the API shows it: what it is, with the values that make it someone's left out. A password in the
// address, a query value that is a key or a token, an argument that is a key, a token or a name's value
// (`--api-key KEY`, `TOKEN=value`). The file itself is the owner's alone (credentials.ts, Keel's own files).
const SENSITIVE = /(?:key|token|secret|pass(?:word|wd)?|auth|sig(?:nature)?|credential|bearer|cookie|session)/i;
const KEPT = "***";
// A value the owner has not filled in (`${user_config.token}`, `$TOKEN`) is a name, not a secret.
const placeholder = (v: string) => /^\$\{?[A-Za-z_][\w.]*\}?$/.test(v);
// A value that looks like a token whatever it is called: long, letters and digits mixed in one run, no spaces, and
// not a path or a file's name (`configs/server-v2.production.json` is made of words, a token of one long run).
const tokenLike = (v: string) => v.length >= 20 && !pathLike(v) && /^[A-Za-z0-9+/=_~.:-]+$/.test(v) && /[A-Za-z]/.test(v) && /\d/.test(v)
  && v.split(/[-_./]/).some((run) => run.length >= 16 && /[A-Za-z]/.test(run) && /\d/.test(run));
// A value that names a place on a disk: an absolute or relative path, or a file name with an extension in a folder.
const pathLike = (v: string) => /^(?:\/|\.{1,2}\/|~\/?|[A-Za-z]:[\\/])/.test(v) || /^[\w.@-]+(?:\/[\w.@ -]+)+\.[A-Za-z0-9]{1,8}$/.test(v);
// An option whose value is a place (`--password-file`, `--session-dir`, `--keyfile`): the name of a secret's file is not the secret.
const placeOption = (name: string) => /(?:file|dir|path|folder|directory)$/i.test(name.replace(/^-+/, ""));
// A header line whose value is a credential: `Authorization: Bearer X`, `X-Api-Key: X`.
const headerLine = (w: string) => /^([A-Za-z][\w-]*)\s*:\s*(\S.*)$/s.exec(w);
const secretHeader = (name: string, value: string) => !placeholder(value) && (SENSITIVE.test(name) || /^(?:bearer|basic|token|digest)\s/i.test(value));
// The path of an address: a segment that is a token, or comes right after the word `token` or `key`.
const KEY_WORD = /^(?:token|key|apikey|api-key|api_key|secret|access[-_]?token|bearer|password)$/i;
function maskedPath(path: string): string {
  const segs = path.split("/");
  let prev = "";
  const out = segs.map((seg) => {
    let value = seg;
    try { value = decodeURIComponent(seg); } catch {}
    const hide = seg !== "" && !placeholder(value) && (tokenLike(value) || (KEY_WORD.test(prev) && value.length >= 6));
    prev = seg;
    return hide ? KEPT : seg;
  });
  return out.join("/");
}
export function maskedUrl(url: string): string {
  const text = url.trim();
  try {
    const u = new URL(text);
    if (u.password) u.password = KEPT;
    for (const [k, v] of [...u.searchParams]) if (!placeholder(v) && (SENSITIVE.test(k) || tokenLike(v))) u.searchParams.set(k, KEPT);
    const path = maskedPath(u.pathname);
    if (path !== u.pathname) u.pathname = path;
    // The fragment: `#access_token=X&state=Y` is read as parameters, anything else as one value.
    if (u.hash.length > 1) {
      const frag = u.hash.slice(1);
      if (frag.includes("=")) {
        const params = new URLSearchParams(frag);
        for (const [k, v] of [...params]) if (!placeholder(v) && (SENSITIVE.test(k) || tokenLike(v))) params.set(k, KEPT);
        u.hash = params.toString();
      } else if (tokenLike(frag)) u.hash = KEPT;
    }
    return u.toString();
  } catch {
    return text.replace(/(:\/\/[^:/@\s]+:)[^@\s]+@/, `$1${KEPT}@`).replace(/([?&#][^=&\s]*(?:key|token|secret|pass|auth|sig)[^=&\s]*=)[^&\s]+/gi, `$1${KEPT}`);
  }
}
// A connection string, `Server=db;User Id=app;Password=X;`: the values whose names say they are secret are left out.
const pairsMasked = (v: string): string | null => {
  if (!v.includes(";") || !v.includes("=")) return null;
  const segs = v.split(";");
  const used = segs.filter((g) => g.trim() !== "");
  if (used.length < 2 || !used.every((g) => /^\s*[A-Za-z][\w .-]*=/.test(g))) return null;
  let changed = false;
  const out = segs.map((g) => {
    const at = g.indexOf("=");
    if (at < 0) return g;
    const key = g.slice(0, at), val = g.slice(at + 1);
    if (val.trim() === "" || placeholder(val.trim()) || !(SENSITIVE.test(key) || /^\s*pwd\s*$/i.test(key))) return g;
    changed = true;
    return `${key}=${KEPT}`;
  });
  return changed ? out.join(";") : null;
};
const isUrl = (w: string) => /^[a-z][a-z0-9+.-]*:\/\/\S/i.test(w);
export function maskedArgs(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const eq = /^(-{0,2}[A-Za-z_][\w.-]*)=(.*)$/s.exec(w);
    const next = words[i + 1];
    if (isUrl(w)) out.push(maskedUrl(w));
    else if (eq && isUrl(eq[2]!)) out.push(`${eq[1]}=${maskedUrl(eq[2]!)}`);
    else if (eq && /^-{0,2}(?:H|headers?)$/.test(eq[1]!) && headerLine(eq[2]!)) { const h = headerLine(eq[2]!)!; out.push(secretHeader(h[1]!, h[2]!) ? `${eq[1]}=${h[1]}: ${KEPT}` : w); }
    else if (eq && pairsMasked(eq[2]!)) out.push(`${eq[1]}=${pairsMasked(eq[2]!)}`);
    else if (pairsMasked(w)) out.push(pairsMasked(w)!);
    else if (eq) out.push(!placeholder(eq[2]!) && !pathLike(eq[2]!) && !placeOption(eq[1]!) && (SENSITIVE.test(eq[1]!) || tokenLike(eq[2]!)) ? `${eq[1]}=${KEPT}` : w);
    else if (/^(?:-H|--header|--headers|-header)$/.test(w) && next !== undefined) {
      const h = headerLine(next);
      out.push(w, h && secretHeader(h[1]!, h[2]!) ? `${h[1]}: ${KEPT}` : isUrl(next) ? maskedUrl(next) : next);
      i++;
    }
    else if (headerLine(w) && secretHeader(headerLine(w)![1]!, headerLine(w)![2]!) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(w)) out.push(`${headerLine(w)![1]}: ${KEPT}`);
    else if (/^--?[A-Za-z][\w-]*$/.test(w) && next !== undefined && !next.startsWith("-") && !placeholder(next) && !placeOption(w) && !pathLike(next) && SENSITIVE.test(w)) { out.push(w, KEPT); i++; }
    else if (/^--?[A-Za-z][\w-]*$/.test(w) && next !== undefined && isUrl(next)) { out.push(w, maskedUrl(next)); i++; }
    else out.push(pairsMasked(w) ?? w);
  }
  return out;
}
export const maskedServer = (c: McpServerConfig): McpServerConfig => ({ ...c, ...(c.url ? { url: maskedUrl(c.url) } : {}), ...(c.args ? { args: maskedArgs(c.args) } : {}) });
// What a list of servers shows of one: where it is, written as it is called.
export const maskedTarget = (c: McpServerConfig): string => (c.url ? maskedUrl(c.url) : maskedArgs([c.command ?? "", ...(c.args ?? [])]).join(" "));

// Who the server acts as: its environment, headers and the credentials it
// names. Kept private: a keyed hash (the key lives only in this process), so
// a low-entropy value such as an account letter cannot be read back from it.
const KEY = randomBytes(32);
export function account(c: McpServerConfig, key: Uint8Array = KEY): string {
  const lower = (h?: Record<string, string>) => h && Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  const sorted = (o: Record<string, unknown>) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  const parts = {
    env: c.env && sorted(c.env), env_vars: c.env_vars && [...c.env_vars].sort(), headers: c.headers && sorted(lower(c.headers)!),
    headers_env: c.headers_env && sorted(lower(c.headers_env)!), bearer_env: c.bearer_env, headers_helper: c.headers_helper, oauth: c.oauth?.client_id,
  };
  return createHmac("sha256", key).update(sorted(parts)).digest("hex").slice(0, 16);
}

// What makes two configs the same server: the endpoint and the account. The
// same endpoint under another account is another server.
export const identity = (c: McpServerConfig) => `${endpoint(c)}\u0000${account(c)}`;

// Which source a tool runs on, for the permission gate: an answer given for one
// source never runs on another under the same name. Stricter than identity:
// the program's full path, its folder and the transport count too. The key is
// the daemon's own (kept in its state), so a grant outlives a restart.
export function binding(c: McpServerConfig, key: Uint8Array): string {
  const where = c.url ? [endpoint(c), c.transport ?? ""] : [c.command ?? "", c.args ?? [], c.cwd ?? ""];
  return createHmac("sha256", key).update(JSON.stringify([where, account(c, key)])).digest("hex").slice(0, 24);
}

// The part of a config the source decides. The owner's own choices in Keel
// (on or off, which tools are reads, what it follows) are not the source's.
export function sourced(c: McpServerConfig): McpServerConfig {
  const { enabled: _e, read_tools: _r, sync: _s, channel: _c, class: _k, ...rest } = c;
  return rest;
}
