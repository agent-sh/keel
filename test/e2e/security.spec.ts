import { expect, test, type Page } from "./isolate.ts";
import { HAIKU } from "./shots.ts";

// Regression checks from the security review: each one is an attack that
// worked before its fix. A remote device is a request with x-forwarded-for
// (what a tunnel or reverse proxy adds); the desk is a plain loopback call.
const BASE = new URL(process.env.KEEL_URL ?? "http://127.0.0.1:47961");
const REMOTE = `http://device.localhost:${BASE.port}`;
const AWAY = { "x-forwarded-for": "10.0.0.2" };

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
