// A token refresh against a scratch OAuth server: one at a time per server,
// and one that comes back after a sign-out, a removal or a newer sign-in
// writes nothing.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientRefused, OAuthStore } from "./oauth.ts";

// The server rotates refresh tokens (each works once) and holds every
// refresh until the test lets it answer.
let refreshes: string[] = [];
let n = 0;
let arrived: () => void = () => {};
let release: () => void = () => {};
let held = Promise.resolve();
const hold = () => {
  const came = new Promise<void>((r) => (arrived = r));
  held = new Promise<void>((r) => (release = r));
  return came;
};
const srv = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const body = new URLSearchParams(await req.text());
    if (body.get("grant_type") === "authorization_code") {
      return Response.json({ access_token: "at-signin", refresh_token: "rt-signin", expires_in: 3600 });
    }
    const rt = body.get("refresh_token") ?? "";
    refreshes.push(rt);
    arrived();
    await held;
    if (rt !== `rt-${n}`) return Response.json({ error: "invalid_grant" }, { status: 400 });
    n++;
    return Response.json({ access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 3600 });
  },
});
afterAll(() => srv.stop(true));

const endpoint = `http://127.0.0.1:${srv.port}/token`;
const client = { client_id: "c", redirect_uri: "http://127.0.0.1/cb" };
let dir = "";
const file = () => JSON.parse(readFileSync(join(dir, "mcp-oauth.json"), "utf8"));

beforeEach(() => {
  refreshes = [];
  n = 0;
  dir = mkdtempSync(join(tmpdir(), "keel-mcp-oauth-"));
  // An access token past its expiry, with a refresh token.
  writeFileSync(join(dir, "mcp-oauth.json"), JSON.stringify({
    servers: { s: { issuer: "x", token_endpoint: endpoint, resource: "https://r", client, tokens: { access_token: "at-0", refresh_token: "rt-0", expires_at: Date.now() - 1000 } } },
    clients: { "s x http://127.0.0.1/cb": client },
    pending: { st: { server: "s", verifier: "v", issuer: "x", token_endpoint: endpoint, resource: "https://r", client, at: Date.now() } },
  }));
});

test("three concurrent calls send one refresh and get the same token", async () => {
  const store = new OAuthStore(dir);
  const came = hold();
  const calls = [store.token("s"), new OAuthStore(dir).token("s"), store.token("s")];
  await came;
  release();
  expect(await Promise.all(calls)).toEqual(["at-1", "at-1", "at-1"]);
  expect(refreshes).toEqual(["rt-0"]);
  expect(file().servers.s.tokens.refresh_token).toBe("rt-1");
  // The next call uses the stored token and sends nothing.
  expect(await store.token("s")).toBe("at-1");
  expect(refreshes).toEqual(["rt-0"]);
});

test("a sign-out during a refresh stays signed out", async () => {
  const store = new OAuthStore(dir);
  const came = hold();
  const call = store.token("s");
  await came;
  store.signOut("s");
  release();
  expect(await call).toBeUndefined();
  expect(store.signedIn("s")).toBe(false);
});

test("a removal during a refresh keeps the server and its client forgotten", async () => {
  const store = new OAuthStore(dir);
  const came = hold();
  const call = store.token("s");
  await came;
  store.forget("s");
  release();
  expect(await call).toBeUndefined();
  expect(file().servers).toEqual({});
  expect(file().clients).toEqual({});
});

test("a newer sign-in during a refresh keeps its tokens", async () => {
  const store = new OAuthStore(dir);
  const came = hold();
  const call = store.token("s");
  await came;
  await store.finish(new URLSearchParams({ state: "st", code: "k" }));
  release();
  expect(await call).toBe("at-signin");
  expect(file().servers.s.tokens.refresh_token).toBe("rt-signin");
});

// Sign-out and removal revoke at the authorization server (RFC 7009) when it advertises
// a revocation_endpoint, then the tokens are forgotten either way.
const revoked: { auth: string | null; form: Record<string, string> }[] = [];
let revokeStatus = 200;
const rev = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    revoked.push({ auth: req.headers.get("authorization"), form: Object.fromEntries(new URLSearchParams(await req.text())) });
    return new Response(null, { status: revokeStatus });
  },
});
afterAll(() => rev.stop(true));

const signedIn = (revocation_endpoint?: string, secret?: string) => writeFileSync(join(dir, "mcp-oauth.json"), JSON.stringify({
  servers: { s: { issuer: "http://127.0.0.1:1", token_endpoint: endpoint, ...(revocation_endpoint === undefined ? {} : { revocation_endpoint }), resource: "https://r", client: { ...client, client_secret: secret }, tokens: { access_token: "at-0", refresh_token: "rt-0" } } },
  clients: {},
  pending: {},
}));

test("a sign-out revokes the refresh token, then the access token, as the client registered", async () => {
  revoked.length = 0;
  revokeStatus = 200;
  signedIn(`http://127.0.0.1:${rev.port}/revoke`, "sec");
  const store = new OAuthStore(dir);
  const gone = store.signOut("s");
  expect(store.signedIn("s")).toBe(false);
  expect(await store.revoke(gone!)).toEqual([]);
  expect(revoked.map((r) => r.form)).toEqual([
    { token: "rt-0", token_type_hint: "refresh_token", client_id: "c" },
    { token: "at-0", token_type_hint: "access_token", client_id: "c" },
  ]);
  expect(revoked[0]!.auth).toBe(`Basic ${btoa("c:sec")}`);
});

test("a refused revoke is reported and the tokens stay forgotten", async () => {
  revoked.length = 0;
  revokeStatus = 503;
  signedIn(`http://127.0.0.1:${rev.port}/revoke`);
  const store = new OAuthStore(dir);
  const gone = store.forget("s");
  expect(file().servers).toEqual({});
  expect(await store.revoke(gone!)).toEqual(["refresh_token: HTTP 503", "access_token: HTTP 503"]);
  expect(revoked.length).toBe(2);
});

test("a server that names no revocation endpoint is only forgotten", async () => {
  revoked.length = 0;
  signedIn("");
  const store = new OAuthStore(dir);
  const gone = store.signOut("s");
  expect(store.signedIn("s")).toBe(false);
  expect(await store.revoke(gone!)).toEqual([]);
  expect(revoked).toEqual([]);
  expect(store.signOut("s")).toBeUndefined();
});

test("a sign-in keeps the revocation endpoint its metadata advertises", async () => {
  revoked.length = 0;
  revokeStatus = 200;
  const as = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const o = u.origin;
      if (u.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: o, authorization_endpoint: `${o}/authorize`, token_endpoint: `${o}/token`, registration_endpoint: `${o}/register`, revocation_endpoint: `${o}/revoke` });
      if (u.pathname === "/register") return Response.json({ client_id: "reg" });
      if (u.pathname === "/token") return Response.json({ access_token: "at-x", refresh_token: "rt-x" });
      if (u.pathname === "/revoke") revoked.push({ auth: null, form: Object.fromEntries(new URLSearchParams(await req.text())) });
      return new Response(null, { status: u.pathname === "/revoke" ? 200 : 404 });
    },
  });
  try {
    const store = new OAuthStore(dir);
    const url = new URL(await store.begin("s", `http://127.0.0.1:${as.port}/mcp`, null, "http://127.0.0.1/cb"));
    await store.finish(new URLSearchParams({ state: url.searchParams.get("state")!, code: "k" }));
    expect(file().servers.s.revocation_endpoint).toBe(`http://127.0.0.1:${as.port}/revoke`);
    expect(await store.revoke(store.signOut("s")!)).toEqual([]);
    expect(revoked.map((r) => r.form.token)).toEqual(["rt-x", "at-x"]);
  } finally {
    as.stop(true);
  }
});

// A registration the authorization server no longer knows (RFC 6749 5.2 invalid_client, or HTTP 410) is dropped,
// and the sign-in registers again once.
let registered = 0;
let tokenAnswer: { status: number; body: any } = { status: 400, body: { error: "invalid_client" } };
const authSrv: ReturnType<typeof Bun.serve> = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url);
    const base = u.origin;
    if (u.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
    }
    if (u.pathname === "/register") return Response.json({ client_id: `reg-${++registered}` });
    if (u.pathname === "/token") return Response.json(tokenAnswer.body, { status: tokenAnswer.status });
    return new Response(null, { status: 404 });
  },
});
afterAll(() => authSrv.stop(true));

const fresh = () => { dir = mkdtempSync(join(tmpdir(), "keel-mcp-oauth-")); return new OAuthStore(dir); };
const redirect = "http://127.0.0.1:1/cb";
const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
const clientOf = (url: string) => new URL(url).searchParams.get("client_id");

for (const [name, answer] of [
  ["invalid_client", { status: 400, body: { error: "invalid_client" } }],
  ["HTTP 410 Gone", { status: 410, body: {} }],
] as const) {
  test(`a registration refused as ${name} at the redirect is dropped, and the next sign-in registers again`, async () => {
    registered = 0;
    tokenAnswer = answer;
    const store = fresh();
    const url = `http://127.0.0.1:${authSrv.port}/mcp`;
    const first = await store.begin("s", url, null, redirect);
    expect(clientOf(first)).toBe("reg-1");
    const refused = await store.finish(new URLSearchParams({ state: stateOf(first), code: "k" })).catch((e) => e);
    expect(refused).toBeInstanceOf(ClientRefused);
    expect(refused.message).toContain("no longer knows Keel's client registration");
    expect(refused.again).toBe(false);
    expect(file().clients).toEqual({});
    // The next sign-in posts a new registration and offers the new client.
    const second = await store.begin("s", url, null, redirect, {}, true);
    expect(clientOf(second)).toBe("reg-2");
    expect(registered).toBe(2);
    // Refused again: told, and not offered a third time.
    const again = await store.finish(new URLSearchParams({ state: stateOf(second), code: "k" })).catch((e) => e);
    expect(again).toBeInstanceOf(ClientRefused);
    expect(again.again).toBe(true);
    expect(again.message).toContain("refused too");
    expect(registered).toBe(2);
  });
}

test("a refresh the server refuses as invalid_client drops the cached registration", async () => {
  registered = 0;
  tokenAnswer = { status: 400, body: { error: "invalid_client" } };
  const store = fresh();
  const url = `http://127.0.0.1:${authSrv.port}/mcp`;
  const first = await store.begin("s", url, null, redirect);
  tokenAnswer = { status: 200, body: { access_token: "a", refresh_token: "r", expires_in: 1 } };
  await store.finish(new URLSearchParams({ state: stateOf(first), code: "k" }));
  expect(Object.keys(file().clients)).toHaveLength(1);
  tokenAnswer = { status: 400, body: { error: "invalid_client" } };
  await store.token("s");
  expect(file().clients).toEqual({});
  expect(clientOf(await store.begin("s", url, null, redirect))).toBe("reg-2");
});
