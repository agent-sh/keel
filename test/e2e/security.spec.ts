import { expect, test, type Page } from "./isolate.ts";
import { HAIKU, remoteHeaders, shoot } from "./shots.ts";

// Regression checks from the security review: each one is an attack that
// worked before its fix. A remote device is a request with x-forwarded-for
// (what a tunnel or reverse proxy adds) and the access token; the desk is a
// plain loopback call.
const BASE = new URL(process.env.KEEL_URL!);
const REMOTE = `http://device.localhost:${BASE.port}`;

async function authenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

test("a remote device needs the passkey for what runs programs", async ({ page, browser, request }) => {
  // A passkey enrolled by a device, so presence rules apply.
  const { code } = await (await request.post("/api/owner-presence/code")).json();
  const ctx = await browser.newContext();
  const phone = await ctx.newPage();
  const name = `sec-${Date.now().toString(36)}`;
  const AWAY = await remoteHeaders(request);
  try {
    await phone.goto(`${REMOTE}/settings/safety`);
    await authenticator(phone);
    await phone.getByTestId("passkey-code").fill(code);
    await phone.getByTestId("passkey-enroll").click();
    await expect(phone.getByTestId("passkey-msg")).toHaveText("Passkey enrolled.");

    // Pairing hands out a key that runs shell commands here (fleet hands).
    const pair = await request.post("/api/fleet/pair", { headers: AWAY, data: { daemon_id: `${name}-daemon`, name } });
    expect(pair.status()).toBe(428);
    expect((await (await request.get("/api/fleet/pairs")).json()).pairs.map((p: any) => p.daemon_id ?? p.id)).not.toContain(`${name}-daemon`);
    // An MCP server that is a command runs that program.
    const mcp = await request.post("/api/mcp/servers", { headers: AWAY, data: { name, command: "/bin/true" } });
    expect(mcp.status()).toBe(428);
    expect((await (await request.get("/api/mcp/servers")).json()).servers.map((s: any) => s.name)).not.toContain(name);
    expect((await request.post("/api/mcp/import", { headers: AWAY, data: { source: "x", name } })).status()).toBe(428);
    // The run endpoint (the CLI's) took a permission mode that asks less, unchecked.
    const before = (await (await request.get("/api/sessions")).json()).sessions.length;
    const run = await request.post("/api/run", { headers: AWAY, data: { text: "Reply with ok.", model: HAIKU, permission_mode: "full-auto" } });
    expect(run.status()).toBe(428);
    expect((await (await request.get("/api/sessions")).json()).sessions.length).toBe(before);
  } finally {
    const { passkeys } = await (await request.get("/api/owner-presence")).json();
    for (const p of passkeys) await request.delete(`/api/owner-presence/${encodeURIComponent(p.id)}`);
    await ctx.close();
    await request.delete(`/api/mcp/servers/${name}`).catch(() => {});
    await request.delete(`/api/fleet/pairs/${name}-daemon`).catch(() => {});
  }
});

// A request through a proxy or tunnel reached the whole API with no
// credential: it needs the access token now, which the desk alone can show,
// and a remote browser keeps it as a cookie from the link.
test("a request through a tunnel needs the access token", async ({ page, request }) => {
  const away = { "x-forwarded-for": "10.0.0.2" };
  expect((await request.get("/api/sessions", { headers: away })).status()).toBe(403);
  expect((await request.post("/api/sessions", { headers: away, data: { title: "through a tunnel" } })).status()).toBe(403);
  expect((await request.get("/api/remote-access", { headers: await remoteHeaders(request) })).status()).toBe(403);
  // The phone's own signed API and the link are not behind it.
  expect((await request.get("/v1/health", { headers: away })).status()).toBe(200);
  const { path } = await (await request.get("/api/remote-access")).json();
  expect((await request.get("/api/remote/enter?token=wrong", { headers: away, maxRedirects: 0 })).status()).toBe(403);
  const enter = await request.get(path, { headers: away, maxRedirects: 0 });
  expect(enter.status()).toBe(303);
  const cookie = (enter.headers()["set-cookie"] ?? "").split(";")[0]!;
  expect(enter.headers()["set-cookie"]).toContain("HttpOnly");
  expect((await request.get("/api/sessions", { headers: { ...away, cookie } })).status()).toBe(200);

  await page.goto("/settings/safety");
  await expect(page.getByTestId("remote-access-link")).toContainText("/api/remote/enter?token=");
  await page.getByTestId("remote-access").scrollIntoViewIfNeeded();
  await shoot(page, "security-01-remote-access");
});
