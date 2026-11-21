// Connectors: the apps a session can reach through their vendors' own remote
// MCP servers, and the official MCP registry to find any other. What a
// server needs to sign in is read from the server itself (RFC 9728 resource
// metadata, then the authorization server's metadata), never assumed.
//
// The suggested list names vendor-run endpoints only, each from the vendor's
// documentation: GitHub (github.com/github/github-mcp-server), Google
// Workspace (developers.google.com/workspace/guides/configure-mcp-servers),
// Slack (docs.slack.dev/ai/mcp-server), Notion (developers.notion.com/docs/mcp),
// Linear (linear.app/docs/mcp).
import type { McpServerConfig } from "./config.ts";
import { gitEnv } from "../core/git.ts";

export type Connector = { id: string; name: string; what: string; url: string; docs: string; via?: "gh" };

export const SUGGESTED: Connector[] = [
  { id: "github", name: "GitHub", what: "Repositories, issues, pull requests, Actions", url: "https://api.githubcopilot.com/mcp/", docs: "https://github.com/github/github-mcp-server", via: "gh" },
  { id: "gmail", name: "Gmail", what: "Search, read and draft mail", url: "https://gmailmcp.googleapis.com/mcp/v1", docs: "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server" },
  { id: "google-calendar", name: "Google Calendar", what: "Calendars, events, free time", url: "https://calendarmcp.googleapis.com/mcp/v1", docs: "https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server" },
  { id: "google-drive", name: "Google Drive", what: "Find and read files", url: "https://drivemcp.googleapis.com/mcp/v1", docs: "https://developers.google.com/workspace/drive/api/guides/configure-mcp-server" },
  { id: "slack", name: "Slack", what: "Channels, messages, search", url: "https://mcp.slack.com/mcp", docs: "https://docs.slack.dev/ai/mcp-server" },
  { id: "notion", name: "Notion", what: "Pages and databases", url: "https://mcp.notion.com/mcp", docs: "https://developers.notion.com/docs/mcp" },
  { id: "linear", name: "Linear", what: "Issues, projects, cycles", url: "https://mcp.linear.app/mcp", docs: "https://linear.app/docs/mcp" },
];

// How a remote server lets Keel in:
// open: no sign-in; sign_in: OAuth with dynamic client registration (one click);
// client_id: OAuth, but the provider registers no clients on the fly, so the
// owner brings a client id from the provider's console; unreachable: no answer.
export type Access = { kind: "open" | "sign_in" | "client_id" | "unreachable"; issuer?: string; scopes?: string[]; error?: string };

const TIMEOUT = 8_000;
const get = async (url: string) => {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT) });
  return r.ok ? ((await r.json()) as any) : null;
};

// RFC 9728: /.well-known/oauth-protected-resource, path-suffixed first.
async function resourceMetadata(url: string, fromChallenge?: string | null): Promise<any | null> {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, "");
  const tries = [fromChallenge, `${u.origin}/.well-known/oauth-protected-resource${path}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean) as string[];
  for (const t of tries) {
    const m = await get(t).catch(() => null);
    if (m?.authorization_servers?.length) return m;
  }
  return null;
}

// RFC 8414, then OpenID discovery, path-inserted as the MCP spec orders them.
async function serverMetadata(issuer: string): Promise<any | null> {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  const tries = path
    ? [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`]
    : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  for (const t of tries) {
    const m = await get(t).catch(() => null);
    if (m?.authorization_endpoint) return m;
  }
  return null;
}

const cache = new Map<string, { at: number; access: Promise<Access> }>();

export function access(url: string): Promise<Access> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.access;
  const p = probe(url);
  cache.set(url, { at: Date.now(), access: p });
  p.catch(() => cache.delete(url));
  return p;
}

async function probe(url: string): Promise<Access> {
  let challenge: string | null = null;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "keel", version: "0.1.0" } } }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    await r.body?.cancel();
    if (r.status === 401) challenge = /resource_metadata="([^"]+)"/.exec(r.headers.get("www-authenticate") ?? "")?.[1] ?? null;
  } catch (e) {
    return { kind: "unreachable", error: (e as Error).message };
  }
  // Some servers answer initialize before sign-in and refuse the tools: the
  // resource metadata is what says a sign-in is needed.
  const prm = await resourceMetadata(url, challenge);
  if (!prm) return { kind: "open" };
  const issuer = String(prm.authorization_servers[0]);
  const as = await serverMetadata(issuer);
  const scopes = Array.isArray(prm.scopes_supported) ? prm.scopes_supported.map(String) : undefined;
  if (!as) return { kind: "unreachable", issuer, error: `${issuer} publishes no authorization server metadata` };
  return { kind: as.registration_endpoint ? "sign_in" : "client_id", issuer: String(as.issuer ?? issuer), scopes };
}

// The GitHub CLI's own sign-in as the bearer, read at each connect (never stored).
export const ghHelper = (gh = process.env.KEEL_GH_BIN ?? "gh") =>
  `t=$(${JSON.stringify(gh)} auth token) && printf '{"Authorization":"Bearer %s"}' "$t"`;

export async function ghSignedIn(gh = process.env.KEEL_GH_BIN ?? "gh"): Promise<boolean> {
  try {
    const p = Bun.spawn([gh, "auth", "token"], { cwd: "/", env: gitEnv("/"), stdout: "ignore", stderr: "ignore", stdin: "ignore" }); // (gh runs git by itself)
    const t = setTimeout(() => p.kill(), 5_000);
    const code = await p.exited;
    clearTimeout(t);
    return code === 0;
  } catch {
    return false;
  }
}

// ---- the official MCP registry ----

export const REGISTRY = process.env.KEEL_MCP_REGISTRY ?? "https://registry.modelcontextprotocol.io";

export type RegistryServer = {
  name: string; title?: string; description?: string; version?: string; repository?: string; website?: string;
  // What Keel can add from it: a remote URL, or a package it knows how to run.
  remote?: { url: string; headers: { name: string; secret: boolean; required: boolean; description?: string }[] };
  package?: { command: string; args: string[]; env: { name: string; secret: boolean; required: boolean; description?: string }[] };
};

const runner: Record<string, (id: string, version?: string) => { command: string; args: string[] }> = {
  npm: (id, v) => ({ command: "npx", args: ["-y", v ? `${id}@${v}` : id] }),
  pypi: (id, v) => ({ command: "uvx", args: [v ? `${id}==${v}` : id] }),
};

const vars = (list: any[] | undefined) =>
  (list ?? []).map((h) => ({ name: String(h.name), secret: !!h.isSecret, required: !!h.isRequired, description: h.description ? String(h.description) : undefined }));

export function fromRegistry(entry: any): RegistryServer | null {
  const s = entry?.server;
  if (!s?.name) return null;
  const remote = (s.remotes ?? []).find((r: any) => r.type === "streamable-http" && typeof r.url === "string" && !/\{/.test(r.url));
  const pkg = (s.packages ?? []).find((p: any) => runner[p.registryType] && (p.transport?.type ?? "stdio") === "stdio");
  const out: RegistryServer = {
    name: String(s.name),
    title: s.title ? String(s.title) : undefined,
    description: s.description ? String(s.description) : undefined,
    version: s.version ? String(s.version) : undefined,
    repository: s.repository?.url ? String(s.repository.url) : undefined,
    website: s.websiteUrl ? String(s.websiteUrl) : undefined,
  };
  if (remote) out.remote = { url: remote.url, headers: vars(remote.headers) };
  if (pkg) out.package = { ...runner[pkg.registryType]!(pkg.identifier, pkg.version), env: vars(pkg.environmentVariables) };
  return out.remote || out.package ? out : null;
}

// A file: registry is a saved listing (an offline mirror, or a scratch daemon's stand-in).
async function fileRegistry(path: string, q: string): Promise<any> {
  const d = JSON.parse(await Bun.file(path).text());
  const needle = q.toLowerCase();
  return { servers: (d.servers ?? []).filter((e: any) => !needle || String(e?.server?.name ?? "").toLowerCase().includes(needle)) };
}

export async function searchRegistry(q: string, cursor?: string): Promise<{ servers: RegistryServer[]; next?: string }> {
  const d = REGISTRY.startsWith("file://") ? await fileRegistry(new URL(REGISTRY).pathname, q) : await fetchRegistry(q, cursor);
  const servers = (d.servers ?? []).filter((e: any) => e?._meta?.["io.modelcontextprotocol.registry/official"]?.status !== "deleted").map(fromRegistry).filter(Boolean) as RegistryServer[];
  return { servers, next: d.metadata?.nextCursor || undefined };
}

async function fetchRegistry(q: string, cursor?: string): Promise<any> {
  const u = new URL("/v0.1/servers", REGISTRY);
  u.searchParams.set("version", "latest");
  u.searchParams.set("limit", "40");
  if (q) u.searchParams.set("search", q);
  if (cursor) u.searchParams.set("cursor", cursor);
  const r = await fetch(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`the MCP registry answered HTTP ${r.status}`);
  return r.json();
}

// A server name for Keel from a registry or connector name (io.github.x/y -> y).
export function keelName(name: string): string {
  const last = name.split("/").pop() ?? name;
  return last.replace(/[^\w.-]+/g, "-").replace(/_+$/, "").replace(/__+/g, "_").replace(/^-+|-+$/g, "").slice(0, 64) || "server";
}

export function connectorConfig(c: Connector, opt: { gh?: boolean; client_id?: string; client_secret_env?: string }): McpServerConfig {
  const cfg: McpServerConfig = { url: c.url };
  if (c.via === "gh" && opt.gh) cfg.headers_helper = ghHelper();
  if (opt.client_id) cfg.oauth = { client_id: opt.client_id, ...(opt.client_secret_env ? { client_secret_env: opt.client_secret_env } : {}) };
  return cfg;
}
