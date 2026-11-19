import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

const BASE = new URL(process.env.KEEL_URL ?? "http://127.0.0.1:47961");
// A name that is not the desk but still a secure context: *.localhost is loopback in Chromium.
const REMOTE = `http://device.localhost:${BASE.port}`;
const DESK = `http://localhost:${BASE.port}`;

async function authenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

// Feature: verified owner presence. A device enrolls a passkey with a code
// shown at the desk; from that device a high-risk approval asks for the
// passkey, signed over that one action, and then goes through; a looser mode
// from a remote device without one is refused; the desk itself never asks.
test("passkeys for remote approvals", async ({ page, browser, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  // This spec needs the gate to ask: set it, whatever an earlier spec left behind.
  const prevMode = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "ask" } });
  await page.goto(`${DESK}/settings/safety`);
  await page.getByTestId("passkey-code-new").click();
  const code = (await page.getByTestId("passkey-code-shown").locator("span").first().textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9]{8}$/);
  await shoot(page, "passkeys-01-desk");

  const ctx = await browser.newContext();
  const phone = await ctx.newPage();
  await phone.goto(`${REMOTE}/settings/safety`);
  await authenticator(phone);
  await phone.getByTestId("passkey-code").fill(code);
  await phone.getByTestId("passkey-enroll").click();
  await expect(phone.getByTestId("passkey-msg")).toHaveText("Passkey enrolled.");
  await expect(phone.getByTestId("passkey-list")).toContainText("device.localhost");
  await shoot(phone, "passkeys-02-enrolled");

  try {
    // A remote device cannot loosen a mode without the passkey.
    const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `presence-${Date.now()}`);
    mkdirSync(ws, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    writeFileSync(join(ws, "a.txt"), "a\n");
    const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
    const loose = await request.put(`/api/sessions/${session.id}/permissions`, { headers: { "x-forwarded-for": "10.0.0.2" }, data: { mode: "full-auto" } });
    expect(loose.status()).toBe(428);
    expect((await loose.json()).presence.action).toBe(`perm:${session.id}`);

    // A high-risk card answered from the device: the passkey is asked, then the call runs.
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "Run exactly this one Bash command and nothing else: git clean -fdx\nThen reply ok." } });
    await phone.goto(`${REMOTE}/s/${session.id}`);
    const card = phone.getByTestId("approval");
    await expect(card).toHaveAttribute("data-risk", "high", { timeout: 60_000 });
    await shoot(phone, "passkeys-03-card");
    await card.getByTestId("allow-once").click();
    await expect(card).toHaveCount(0, { timeout: 30_000 });
    const all = (await (await request.get(`/api/sessions/${session.id}/approvals?all`)).json()).approvals;
    expect(all.at(-1).state).toBe("allowed");
    const ok = await (await request.get(`/api/owner-presence`)).json();
    expect(ok.passkeys.find((p: any) => p.rp_id === "device.localhost").used).toBeTruthy();
  } finally {
    const { passkeys } = await (await request.get("/api/owner-presence")).json();
    for (const p of passkeys) await request.delete(`/api/owner-presence/${encodeURIComponent(p.id)}`);
    await ctx.close();
  }

  await request.put("/api/permissions/settings", { data: { default_mode: prevMode } });
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
