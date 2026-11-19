#!/usr/bin/env bun
// An HTTP MCP server behind OAuth, the way hosted servers are: a 401 with
// resource_metadata, protected-resource and authorization-server metadata,
// dynamic client registration, an authorize page the person approves, PKCE
// S256 checked at the token endpoint, the resource parameter checked, short
// tokens and a refresh. One tool, whoami, answers with the signed-in name.
// Prints its port on the first line. GET /stats says what happened.
import { createHash, randomBytes } from "node:crypto";

const stats = { registrations: 0, authorized: 0, codes_redeemed: 0, refreshes: 0, calls: 0, bad_tokens: 0 };
const clients = new Map<string, string[]>(); // client_id -> redirect_uris
const codes = new Map<string, { client_id: string; redirect_uri: string; challenge: string; resource: string }>();
const tokens = new Map<string, number>(); // access token -> expiry
const refresh = new Set<string>();
const tok = () => randomBytes(18).toString("base64url");

let origin = "";
const issue = () => {
  const access = tok();
  const r = tok();
  tokens.set(access, Date.now() + 30_000);
  refresh.add(r);
  // 30 s: under a minute, so every use refreshes first.
  return Response.json({ access_token: access, token_type: "Bearer", expires_in: 30, refresh_token: r });
};
const oauthError = (error: string, status = 400) => Response.json({ error }, { status });

const tools = [{ name: "whoami", description: "Name the account this server is signed in as.", inputSchema: { type: "object", properties: {} } }];

function rpc(m: any) {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize":
      return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "oauth-mcp", version: "1.0.0" } });
    case "tools/list":
      return reply({ tools });
    case "tools/call":
      stats.calls++;
      return reply({ content: [{ type: "text", text: "signed in as fixture-owner" }] });
    case "ping":
      return reply({});
    default:
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no method ${m.method}` } };
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    switch (u.pathname) {
      case "/stats":
        return Response.json(stats);
      case "/.well-known/oauth-protected-resource/mcp":
      case "/.well-known/oauth-protected-resource":
        return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["tools"] });
      case "/.well-known/oauth-authorization-server":
        return Response.json({
          issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
          code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true,
        });
      case "/register": {
        const b: any = await req.json();
        if (!Array.isArray(b.redirect_uris) || !b.redirect_uris.length) return oauthError("invalid_redirect_uri");
        const id = `client-${tok()}`;
        clients.set(id, b.redirect_uris);
        stats.registrations++;
        return Response.json({ client_id: id, redirect_uris: b.redirect_uris, token_endpoint_auth_method: "none" }, { status: 201 });
      }
      case "/authorize": {
        const q = u.searchParams;
        const id = q.get("client_id") ?? "";
        const redirect = q.get("redirect_uri") ?? "";
        if (!clients.get(id)?.includes(redirect)) return new Response("unknown client or redirect", { status: 400 });
        if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return new Response("PKCE S256 is required", { status: 400 });
        if (q.get("resource") !== `${origin}/mcp`) return new Response(`wrong resource ${q.get("resource")}`, { status: 400 });
        if (req.method === "GET") {
          return new Response(
            `<!doctype html><title>Sign in to oauth-mcp</title><body style="font-family:sans-serif;padding:3rem"><h1>Allow Keel to use oauth-mcp?</h1><p>Scope: ${q.get("scope") ?? ""}</p><form method="post"><button name="decision" value="allow">Allow</button> <button name="decision" value="deny">Deny</button></form></body>`,
            { headers: { "content-type": "text/html" } },
          );
        }
        const decision = (await req.formData()).get("decision");
        const back = new URL(redirect);
        back.searchParams.set("state", q.get("state") ?? "");
        back.searchParams.set("iss", origin);
        if (decision !== "allow") back.searchParams.set("error", "access_denied");
        else {
          const code = tok();
          codes.set(code, { client_id: id, redirect_uri: redirect, challenge: q.get("code_challenge")!, resource: q.get("resource")! });
          back.searchParams.set("code", code);
          stats.authorized++;
        }
        return Response.redirect(back.toString(), 302);
      }
      case "/token": {
        const f = new URLSearchParams(await req.text());
        if (f.get("resource") !== `${origin}/mcp`) return oauthError("invalid_target");
        if (f.get("grant_type") === "authorization_code") {
          const c = codes.get(f.get("code") ?? "");
          codes.delete(f.get("code") ?? "");
          if (!c || c.client_id !== f.get("client_id") || c.redirect_uri !== f.get("redirect_uri")) return oauthError("invalid_grant");
          if (createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") !== c.challenge) return oauthError("invalid_grant");
          stats.codes_redeemed++;
          return issue();
        }
        if (f.get("grant_type") === "refresh_token") {
          if (!refresh.delete(f.get("refresh_token") ?? "")) return oauthError("invalid_grant");
          stats.refreshes++;
          return issue();
        }
        return oauthError("unsupported_grant_type");
      }
      case "/mcp": {
        const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
        if (!bearer || !((tokens.get(bearer) ?? 0) > Date.now())) {
          if (bearer) stats.bad_tokens++;
          return new Response("sign in first", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="tools"` } });
        }
        if (req.method !== "POST") return new Response(null, { status: 405 });
        const m: any = await req.json();
        if (m.id === undefined) return new Response(null, { status: 202 });
        return Response.json(rpc(m));
      }
    }
    return new Response("not found", { status: 404 });
  },
});
origin = `http://127.0.0.1:${server.port}`;
process.stdout.write(`${server.port}\n`);
