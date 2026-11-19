import { expect, test, type Page } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { HAIKU, remoteHeaders, shoot } from "./shots.ts";

// Two daemons on this machine stand in for two machines: this one (KEEL_URL)
// forwards to the other (KEEL_PEER_URL).
const PEER = process.env.KEEL_PEER_URL ?? "http://127.0.0.1:47975";
const ROOT = process.env.KEEL_PEER_ROOT ?? `${process.env.HOME}/.cache/keel-work/bun/dev-fleet-b/root`;
const BASE = new URL(process.env.KEEL_URL ?? "http://127.0.0.1:47961");
// A name that is not the desk but still a secure context: *.localhost is loopback in Chromium.
const REMOTE = `http://device.localhost:${BASE.port}`;

async function authenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

// Feature: owner presence across the fleet forwarder. A request a remote
// device sends to another daemon's session through this one carries its
// standing, signed by the link key: the far daemon asks for the passkey as it
// would for a remote device of its own, the desk passes, a forged standing
// counts as remote, and the device's passkey (enrolled here) lets it through.
test("fleet forwarder keeps the caller's presence standing", async ({ page, browser, request }) => {
  const peerUp = await request.get(`${PEER}/api/health`, { timeout: 3000 }).then((r) => r.ok(), () => false);
  test.skip(!peerUp, `no peer daemon at ${PEER}: start a second daemon and set KEEL_PEER_URL and KEEL_PEER_ROOT`);
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  // Start clean: no old record of that daemon, nor sessions placed on one.
  const old = (await (await request.get("/api/fleet/machines")).json()).machines.filter((m: any) => m.daemon_url === PEER).map((m: any) => m.id);
  for (const s of (await (await request.get("/api/sessions")).json()).sessions) if (old.includes(s.machine)) await request.delete(`/api/sessions/${s.id}`);
  for (const id of old) await request.delete(`/api/fleet/machines/${id}`);
  mkdirSync(ROOT, { recursive: true });
  const paired = await request.post("/api/fleet/machines", { data: { name: "presence-peer", daemon_url: PEER, workspace_root: ROOT } });
  expect(paired.status()).toBe(201);
  const mid = (await paired.json()).id;
  const { session } = await (await request.post(`${PEER}/api/sessions`, { data: { workspace: ROOT, title: "Far session", model: HAIKU } })).json();
  await request.put(`${PEER}/api/sessions/${session.id}/permissions`, { data: { mode: "ask" } });
  const farMode = async () => (await (await request.get(`${PEER}/api/sessions/${session.id}/permissions`)).json()).perm.mode;
  const fwd = `/api/fleet/machines/${mid}/api/sessions/${session.id}/permissions`;

  // A passkey enrolled here, by a device with the code shown at the desk.
  const { code } = await (await request.post("/api/owner-presence/code")).json();
  const ctx = await browser.newContext();
  const phone = await ctx.newPage();
  try {
    await phone.goto(`${REMOTE}/settings/safety`);
    await authenticator(phone);
    await phone.getByTestId("passkey-code").fill(code);
    await phone.getByTestId("passkey-enroll").click();
    await expect(phone.getByTestId("passkey-msg")).toHaveText("Passkey enrolled.");

    // A remote device through the forwarder: the far daemon asks for the passkey.
    const loose = await request.put(fwd, { headers: await remoteHeaders(request), data: { mode: "full-auto" } });
    expect(loose.status()).toBe(428);
    expect((await loose.json()).presence.action).toBe(`perm:${session.id}`);
    expect(await farMode()).toBe("ask");
    // A standing written by hand, not by the link, counts as remote there too.
    const forged = await request.put(`${PEER}/api/sessions/${session.id}/permissions`, {
      headers: { ...(await remoteHeaders(request, PEER)), "x-keel-standing": JSON.stringify({ local: true, enrolled: false }), "x-keel-standing-key": "guess" },
      data: { mode: "full-auto" },
    });
    expect(forged.status()).toBe(428);

    // The desk through the forwarder needs nothing.
    expect((await request.put(fwd, { data: { mode: "auto-edits" } })).status()).toBe(200);
    expect(await farMode()).toBe("auto-edits");
    await request.put(fwd, { data: { mode: "ask" } });

    // The device in the UI: the far session's mode asks for its passkey, then changes there.
    await phone.goto(`${REMOTE}/s/${mid}--${session.id}`);
    await expect(phone.getByTestId("permission-mode")).toHaveText("Ask", { timeout: 15_000 });
    await phone.getByTestId("permission-menu").click();
    await phone.getByTestId("mode-full-auto").click();
    await expect(phone.getByTestId("permission-mode")).toHaveText("Full auto", { timeout: 15_000 });
    await shoot(phone, "fleet-presence-01-far-mode-signed");
    expect(await farMode()).toBe("full-auto");
    const used = (await (await request.get("/api/owner-presence")).json()).passkeys.find((p: any) => p.rp_id === "device.localhost").used;
    expect(used).toBeTruthy();
  } finally {
    const { passkeys } = await (await request.get("/api/owner-presence")).json();
    for (const p of passkeys) await request.delete(`/api/owner-presence/${encodeURIComponent(p.id)}`);
    await ctx.close();
    await request.delete(`${PEER}/api/sessions/${session.id}`);
    await request.delete(`/api/fleet/machines/${mid}`);
  }
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
