// A token refresh against a scratch OAuth server: one at a time per server,
// and one that comes back after a sign-out, a removal or a newer sign-in
// writes nothing.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthStore } from "./oauth.ts";

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
