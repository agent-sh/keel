// OAuth sign-in for HTTP MCP servers, per the MCP authorization spec:
// protected-resource metadata (RFC 9728) found from the 401's
// WWW-Authenticate header or the well-known paths, authorization-server
// metadata (RFC 8414 / OIDC discovery) with the issuer checked, a client from
// the config or dynamic registration (RFC 7591), PKCE S256, the resource
// parameter (RFC 8707), and the iss check on the redirect (RFC 9207).
// Client ID metadata documents need a public HTTPS URL, which a local daemon
// does not have, so registration is the path for servers we have no client for.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Client = { client_id: string; client_secret?: string; redirect_uri: string };
type Tokens = { access_token: string; refresh_token?: string; expires_at?: number; scope?: string; token_type?: string };
type ServerAuth = { issuer: string; token_endpoint: string; resource: string; client: Client; tokens?: Tokens };
type PendingSignIn = { server: string; verifier: string; issuer: string; token_endpoint: string; resource: string; client: Client; at: number };
type File = { servers: Record<string, ServerAuth>; clients: Record<string, Client>; pending: Record<string, PendingSignIn> };

export type OAuthConfig = { client_id?: string; client_secret_env?: string; scopes?: string[] };

const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
const rand = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export class OAuthStore {
  private path: string;
  constructor(stateDir: string) {
    this.path = join(stateDir, "mcp-oauth.json");
  }

  private read(): File {
    try {
      const f = JSON.parse(readFileSync(this.path, "utf8"));
      return { servers: f.servers ?? {}, clients: f.clients ?? {}, pending: f.pending ?? {} };
    } catch {
      return { servers: {}, clients: {}, pending: {} };
    }
  }

  private write(f: File) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(f, null, 2), { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  signedIn(server: string) {
    return !!this.read().servers[server]?.tokens;
  }

  signOut(server: string) {
    const f = this.read();
    delete f.servers[server];
    this.write(f);
  }

  // A removed server takes its tokens and its client registration with it
  // (as Claude Code does): the next server at that address registers anew, so
  // a client the provider has since forgotten is never offered again.
  forget(server: string) {
    const f = this.read();
    delete f.servers[server];
    for (const k of Object.keys(f.clients)) if (k.startsWith(`${server} `)) delete f.clients[k];
    this.write(f);
  }

  // A valid access token, refreshed when it is about to expire.
  async token(server: string): Promise<string | undefined> {
    const f = this.read();
    const a = f.servers[server];
    if (!a?.tokens) return undefined;
    if (!a.tokens.expires_at || a.tokens.expires_at - Date.now() > 60_000) return a.tokens.access_token;
    if (!a.tokens.refresh_token) return a.tokens.access_token;
    try {
      const t = await tokenRequest(a.token_endpoint, a.client, {
        grant_type: "refresh_token",
        refresh_token: a.tokens.refresh_token,
        resource: a.resource,
      });
      a.tokens = { ...t, refresh_token: t.refresh_token ?? a.tokens.refresh_token };
      this.write(f);
      return a.tokens.access_token;
    } catch {
      // A refused refresh means a new sign-in; the 401 that follows says so.
      return a.tokens.access_token;
    }
  }

  // Start a sign-in: discovery, a client, and the URL to open.
  async begin(server: string, url: string, wwwAuthenticate: string | null, redirectUri: string, cfg: OAuthConfig = {}): Promise<string> {
    const challenge = parseWwwAuthenticate(wwwAuthenticate);
    const prm = await protectedResource(url, challenge.resource_metadata);
    const issuer = prm?.authorization_servers?.[0] ?? new URL(url).origin;
    const as = await authServerMetadata(issuer);
    const resource = prm?.resource ?? canonicalResource(url);
    const f = this.read();
    // One client per server (and issuer and redirect): removing the server forgets it.
    const key = `${server} ${as.issuer} ${redirectUri}`;
    let client: Client | undefined = cfg.client_id
      ? { client_id: cfg.client_id, client_secret: cfg.client_secret_env ? process.env[cfg.client_secret_env] : undefined, redirect_uri: redirectUri }
      : f.clients[key];
    if (!client) {
      if (!as.registration_endpoint) throw new Error(`${as.issuer} offers no client registration; set oauth.client_id for this server in mcp.json`);
      const r = await fetch(as.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_name: "Keel",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          application_type: "native",
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) throw new Error(`client registration at ${as.issuer} failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      const reg: any = await r.json();
      client = { client_id: reg.client_id, client_secret: reg.client_secret, redirect_uri: redirectUri };
      f.clients[key] = client; // credentials are bound to the issuer that made them
    }
    const verifier = rand(48);
    const state = rand(24);
    const scope = challenge.scope ?? cfg.scopes?.join(" ") ?? prm?.scopes_supported?.join(" ");
    const q = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
      code_challenge_method: "S256",
      state,
      resource,
    });
    if (scope) q.set("scope", scope);
    // drop stale sign-ins (older than 15 minutes)
    for (const [k, p] of Object.entries(f.pending)) if (Date.now() - p.at > 15 * 60_000) delete f.pending[k];
    f.pending[state] = { server, verifier, issuer: as.issuer, token_endpoint: as.token_endpoint, resource, client, at: Date.now() };
    this.write(f);
    const auth = new URL(as.authorization_endpoint);
    for (const [k, v] of q) auth.searchParams.set(k, v);
    return auth.toString();
  }

  // Finish a sign-in from the redirect's query. Returns the server's name.
  async finish(query: URLSearchParams): Promise<string> {
    const state = query.get("state") ?? "";
    const f = this.read();
    const p = f.pending[state];
    if (!p) throw new Error("this sign-in is unknown or expired; start it again");
    delete f.pending[state];
    this.write(f);
    const iss = query.get("iss");
    if (iss && iss !== p.issuer) throw new Error(`the redirect names issuer ${iss}, not ${p.issuer}`);
    if (query.get("error")) throw new Error(`sign-in refused: ${query.get("error")} ${query.get("error_description") ?? ""}`.trim());
    const code = query.get("code");
    if (!code) throw new Error("the redirect carries no code");
    const tokens = await tokenRequest(p.token_endpoint, p.client, {
      grant_type: "authorization_code",
      code,
      redirect_uri: p.client.redirect_uri,
      code_verifier: p.verifier,
      resource: p.resource,
    });
    const g = this.read();
    g.servers[p.server] = { issuer: p.issuer, token_endpoint: p.token_endpoint, resource: p.resource, client: p.client, tokens };
    this.write(g);
    return p.server;
  }
}

async function tokenRequest(endpoint: string, client: Client, params: Record<string, string>): Promise<Tokens> {
  const body = new URLSearchParams({ ...params, client_id: client.client_id });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (client.client_secret) headers.authorization = `Basic ${btoa(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`)}`;
  const r = await fetch(endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  let d: any;
  try { d = JSON.parse(text); } catch { d = Object.fromEntries(new URLSearchParams(text)); }
  if (!r.ok || !d.access_token) throw new Error(`token request failed: HTTP ${r.status} ${d.error ?? ""} ${d.error_description ?? ""}`.trim());
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    token_type: d.token_type,
    scope: d.scope,
    expires_at: d.expires_in ? Date.now() + Number(d.expires_in) * 1000 : undefined,
  };
}

export function parseWwwAuthenticate(h: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const m of h.matchAll(/([a-zA-Z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) out[m[1]!] = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
  return out;
}

const canonicalResource = (url: string) => {
  const u = new URL(url);
  u.hash = "";
  u.search = "";
  return u.toString().replace(/\/$/, "");
};

async function getJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// The header's URL first, then the path-specific well-known URI, then the root.
async function protectedResource(url: string, fromHeader?: string) {
  const u = new URL(url);
  const tries = [
    fromHeader,
    u.pathname !== "/" ? `${u.origin}/.well-known/oauth-protected-resource${u.pathname.replace(/\/$/, "")}` : undefined,
    `${u.origin}/.well-known/oauth-protected-resource`,
  ].filter(Boolean) as string[];
  for (const t of tries) {
    const d = await getJson(t);
    if (d?.authorization_servers?.length) return d as { resource?: string; authorization_servers: string[]; scopes_supported?: string[] };
  }
  return null;
}

// RFC 8414 and OIDC discovery in the order the spec lists, issuer checked.
async function authServerMetadata(issuer: string) {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, "");
  const tries = path
    ? [
        `${u.origin}/.well-known/oauth-authorization-server${path}`,
        `${u.origin}/.well-known/openid-configuration${path}`,
        `${u.origin}${path}/.well-known/openid-configuration`,
      ]
    : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  for (const t of tries) {
    const d = await getJson(t);
    if (!d?.authorization_endpoint || !d.token_endpoint) continue;
    if (d.issuer && d.issuer.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) continue;
    return d as { issuer: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string };
  }
  // Servers from before discovery existed: the spec's default endpoints.
  return {
    issuer: u.origin,
    authorization_endpoint: `${u.origin}/authorize`,
    token_endpoint: `${u.origin}/token`,
    registration_endpoint: `${u.origin}/register`,
  };
}
