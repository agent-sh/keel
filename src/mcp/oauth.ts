// OAuth sign-in for HTTP MCP servers, per the MCP authorization spec:
// protected-resource metadata (RFC 9728) found from the 401's
// WWW-Authenticate header or the well-known paths, authorization-server
// metadata (RFC 8414 / OIDC discovery) with the issuer checked, a client from
// the config or dynamic registration (RFC 7591), PKCE S256, the resource
// parameter (RFC 8707), and the iss check on the redirect (RFC 9207).
// The client, in the spec's order: the config's, then a Client ID Metadata Document (the owner's published
// https URL, when the authorization server says it supports them), then dynamic registration (RFC 7591).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeOwnFile } from "../core/ownfile.ts";

type Client = { client_id: string; client_secret?: string; redirect_uri: string };
type Tokens = { access_token: string; refresh_token?: string; expires_at?: number; scope?: string; token_type?: string };
// revocation_endpoint: the server's own, "" when its metadata names none (an older file has no field: asked again at sign-out).
type ServerAuth = { issuer: string; token_endpoint: string; revocation_endpoint?: string; resource: string; client: Client; tokens?: Tokens };
// again: this sign-in already follows one that found its client refused (it is not offered a second time).
type PendingSignIn = { again?: boolean; server: string; verifier: string; issuer: string; token_endpoint: string; revocation_endpoint?: string; resource: string; client: Client; at: number };
// What a sign-out or removal forgot, kept to revoke at the authorization server.
export type Forgotten = ServerAuth & { tokens: Tokens };
type File = { servers: Record<string, ServerAuth>; clients: Record<string, Client>; pending: Record<string, PendingSignIn> };

// The authorization server does not know the client Keel presented (RFC 6749 5.2 invalid_client, or a registration
// the service retired: HTTP 410). The cached registration is dropped when this is told; the next sign-in registers anew.
class ClientGone extends Error {}

// A sign-in's redirect came back with a registration the server had retired. `again` is true when the sign-in was
// already the second try: it is told to the owner, never started a third time.
export class ClientRefused extends Error {
  constructor(message: string, readonly server: string, readonly redirectUri: string, readonly again: boolean) { super(message); }
}

export type OAuthConfig = { client_id?: string; client_secret_env?: string; scopes?: string[] };

const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
const rand = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

// The refresh under way per token file and server, shared by every store of
// the same file.
const refreshing = new Map<string, Promise<string | undefined>>();

export class OAuthStore {
  private path: string;
  // `metadataUrl`: where the owner published Keel's client metadata document ("" when none: dynamic registration).
  constructor(stateDir: string, private metadataUrl: () => string = () => "") {
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

  // Whole or not at all (a temp file renamed over it): a crash mid-write
  // leaves the old file, not one that reads as no server signed in. No .prev:
  // a second copy of a token would outlive a sign-out.
  private write(f: File) {
    writeOwnFile(this.path, JSON.stringify(f, null, 2), { mode: 0o600, prev: false });
  }

  signedIn(server: string) {
    return !!this.read().servers[server]?.tokens;
  }

  // Both forget the tokens at once and hand back what they held: `revoke` of it
  // tells the authorization server (the forget never waits on, or fails with, that).
  signOut(server: string): Forgotten | undefined {
    const f = this.read();
    const a = f.servers[server];
    delete f.servers[server];
    this.write(f);
    return a?.tokens ? { ...a, tokens: a.tokens } : undefined;
  }

  // A removed server takes its tokens and its client registration with it
  // (as Claude Code does): the next server at that address registers anew, so
  // a client the provider has since forgotten is never offered again.
  forget(server: string): Forgotten | undefined {
    const f = this.read();
    const a = f.servers[server];
    delete f.servers[server];
    for (const k of Object.keys(f.clients)) if (k.startsWith(`${server} `)) delete f.clients[k];
    this.write(f);
    return a?.tokens ? { ...a, tokens: a.tokens } : undefined;
  }

  // RFC 7009: the refresh token first (the grant), then the access token, each
  // with the client's own authentication. Nothing when the authorization server
  // names no revocation_endpoint. Returns what failed, one line each.
  async revoke(a: Forgotten): Promise<string[]> {
    let endpoint = a.revocation_endpoint;
    if (endpoint === undefined) {
      try { endpoint = (await authServerMetadata(a.issuer)).revocation_endpoint ?? ""; } catch { endpoint = ""; }
    }
    if (!endpoint) return [];
    const failed: string[] = [];
    const sent: [string, string][] = [];
    if (a.tokens.refresh_token) sent.push([a.tokens.refresh_token, "refresh_token"]);
    sent.push([a.tokens.access_token, "access_token"]);
    for (const [token, hint] of sent) {
      try {
        const r = await revokeRequest(endpoint, a.client, token, hint);
        if (!r.ok) failed.push(`${hint}: HTTP ${r.status}`);
      } catch (e) {
        failed.push(`${hint}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return failed;
  }

  // A valid access token, refreshed when it is about to expire. One refresh
  // runs at a time per server: callers that arrive while it is out wait for
  // it, so a rotating refresh token is never sent twice. What the refresh
  // brings is written only if the server still holds the tokens it was made
  // from: a sign-out, a removal or a newer sign-in while it was out wins.
  async token(server: string): Promise<string | undefined> {
    const a = this.read().servers[server];
    if (!a?.tokens) return undefined;
    if (!a.tokens.expires_at || a.tokens.expires_at - Date.now() > 60_000) return a.tokens.access_token;
    if (!a.tokens.refresh_token) return a.tokens.access_token;
    const key = `${this.path}\0${server}`;
    let p = refreshing.get(key);
    if (!p) {
      p = this.refresh(server, a, a.tokens).finally(() => refreshing.delete(key));
      refreshing.set(key, p);
    }
    return p;
  }

  private async refresh(server: string, a: ServerAuth, from: Tokens): Promise<string | undefined> {
    let t: Tokens;
    try {
      t = await tokenRequest(a.token_endpoint, a.client, {
        grant_type: "refresh_token",
        refresh_token: from.refresh_token!,
        resource: a.resource,
      });
    } catch (e) {
      // A refused refresh means a new sign-in; the 401 that follows says so. A client the server no longer knows
      // is dropped, so that sign-in registers anew.
      if (e instanceof ClientGone) this.dropClient(a.client.client_id);
      return this.read().servers[server]?.tokens?.access_token;
    }
    const f = this.read();
    const now = f.servers[server];
    const same = now?.tokens && now.token_endpoint === a.token_endpoint
      && now.tokens.access_token === from.access_token && now.tokens.refresh_token === from.refresh_token;
    if (!same) return now?.tokens?.access_token;
    now.tokens = { ...t, refresh_token: t.refresh_token ?? from.refresh_token };
    this.write(f);
    return now.tokens.access_token;
  }

  // Forget the registrations made with this client id (never a client the config names: it is not in the file).
  private dropClient(id: string): boolean {
    const f = this.read();
    const keys = Object.keys(f.clients).filter((k) => f.clients[k]!.client_id === id);
    for (const k of keys) delete f.clients[k];
    if (keys.length) this.write(f);
    return keys.length > 0;
  }

  // Start a sign-in: discovery, a client, and the URL to open.
  async begin(server: string, url: string, wwwAuthenticate: string | null, redirectUri: string, cfg: OAuthConfig = {}, again = false): Promise<string> {
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
      : undefined;
    // Nothing is registered for a metadata document: the server reads it from its URL, so there is nothing to keep.
    let cimdWhy = "";
    if (!client && as.client_id_metadata_document_supported === true && this.metadataUrl()) {
      cimdWhy = await metadataProblem(this.metadataUrl(), redirectUri);
      if (!cimdWhy) client = { client_id: this.metadataUrl(), redirect_uri: redirectUri };
    }
    client ??= f.clients[key];
    if (!client) {
      if (!as.registration_endpoint && cimdWhy) throw new Error(`${as.issuer} wants a client metadata document, and Keel's cannot be used: ${cimdWhy}`);
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
    f.pending[state] = { server, verifier, issuer: as.issuer, token_endpoint: as.token_endpoint, revocation_endpoint: as.revocation_endpoint ?? "", resource, client, at: Date.now(), ...(again ? { again } : {}) };
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
    let tokens: Tokens;
    try {
      tokens = await tokenRequest(p.token_endpoint, p.client, {
        grant_type: "authorization_code",
        code,
        redirect_uri: p.client.redirect_uri,
        code_verifier: p.verifier,
        resource: p.resource,
      });
    } catch (e) {
      // A registration the server no longer knows is dropped (one the config names is not ours to drop).
      if (!(e instanceof ClientGone) || !this.dropClient(p.client.client_id)) throw e;
      throw new ClientRefused(
        `${p.issuer} no longer knows Keel's client registration (${e.message}); it was dropped${p.again ? ", and the new one was refused too: sign in again" : " and Keel registers again"}`,
        p.server, p.client.redirect_uri, !!p.again,
      );
    }
    const g = this.read();
    g.servers[p.server] = { issuer: p.issuer, token_endpoint: p.token_endpoint, revocation_endpoint: p.revocation_endpoint, resource: p.resource, client: p.client, tokens };
    this.write(g);
    return p.server;
  }
}

// A form post as the client registered: its secret as Basic, else its id in the form.
function clientPost(endpoint: string, client: Client, params: Record<string, string>) {
  const body = new URLSearchParams({ ...params, client_id: client.client_id });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (client.client_secret) headers.authorization = `Basic ${btoa(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`)}`;
  return fetch(endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(20_000) });
}

const revokeRequest = (endpoint: string, client: Client, token: string, hint: string) =>
  clientPost(endpoint, client, { token, token_type_hint: hint });

async function tokenRequest(endpoint: string, client: Client, params: Record<string, string>): Promise<Tokens> {
  const r = await clientPost(endpoint, client, params);
  const text = await r.text();
  let d: any;
  try { d = JSON.parse(text); } catch { d = Object.fromEntries(new URLSearchParams(text)); }
  if (!r.ok || !d.access_token) {
    const why = `token request failed: HTTP ${r.status} ${d.error ?? ""} ${d.error_description ?? ""}`.trim();
    throw new (r.status === 410 || d.error === "invalid_client" ? ClientGone : Error)(why);
  }
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

// Why the owner's client metadata document cannot be offered ("" when it can): the draft's checks a client makes
// of its own document (it is JSON, its client_id is its URL, it lists the redirect), so the owner is told here and not by
// the authorization server's error page. A loopback redirect matches with any port (RFC 8252 7.3).
async function metadataProblem(url: string, redirectUri: string): Promise<string> {
  const d = await getJson(url);
  if (!d || typeof d !== "object") return `${url} did not answer with a JSON document`;
  if (d.client_id !== url) return `its client_id is ${JSON.stringify(d.client_id)}, not ${url}`;
  const uris: unknown[] = Array.isArray(d.redirect_uris) ? d.redirect_uris : [];
  const same = (a: string, b: string) => {
    if (a === b) return true;
    try {
      const x = new URL(a), y = new URL(b);
      const loop = (h: string) => h === "127.0.0.1" || h === "[::1]" || h === "localhost";
      return x.protocol === "http:" && y.protocol === "http:" && loop(x.hostname) && x.hostname === y.hostname && x.pathname === y.pathname;
    } catch { return false; }
  };
  return uris.some((u) => typeof u === "string" && same(u, redirectUri)) ? "" : `it does not list the redirect ${redirectUri}`;
}

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
    return d as { issuer: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string; revocation_endpoint?: string; client_id_metadata_document_supported?: boolean };
  }
  // Servers from before discovery existed: the spec's default endpoints.
  return {
    issuer: u.origin,
    authorization_endpoint: `${u.origin}/authorize`,
    token_endpoint: `${u.origin}/token`,
    registration_endpoint: `${u.origin}/register`,
  };
}
