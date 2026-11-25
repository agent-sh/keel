import { expect, test, type Page } from "./isolate.ts";
import { peerProblem } from "./peer.ts";
import { mkdirSync } from "node:fs";
import { HAIKU, remoteHeaders, shoot } from "./shots.ts";

// Two daemons on this machine stand in for two machines: this one (KEEL_URL)
// forwards to the other (KEEL_PEER_URL).
const PEER = process.env.KEEL_PEER_URL ?? "http://127.0.0.1:47975";
const ROOT = process.env.KEEL_PEER_ROOT ?? `${process.env.HOME}/.cache/keel-work/bun/dev-fleet-b/root`;
const BASE = new URL(process.env.KEEL_URL!);
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
  const peerWhy = await peerProblem(request, PEER);
  test.skip(!!peerWhy, peerWhy ?? "");
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

// Feature: another machine's session says its machine in its pane's head at any width of the pane, and
// that machine's part of the list, when it begins below what the list shows, is named at the list's foot.
test("another machine is named in a narrow pane's head, and its part of the list is a press away", async ({ page, request }) => {
  const peerWhy = await peerProblem(request, PEER);
  test.skip(!!peerWhy, peerWhy ?? "");
  const old = (await (await request.get("/api/fleet/machines")).json()).machines.filter((m: any) => m.daemon_url === PEER).map((m: any) => m.id);
  for (const s of (await (await request.get("/api/sessions")).json()).sessions) if (old.includes(s.machine)) await request.delete(`/api/sessions/${s.id}`);
  for (const id of old) await request.delete(`/api/fleet/machines/${id}`);
  mkdirSync(ROOT, { recursive: true });
  const mid = (await (await request.post("/api/fleet/machines", { data: { name: "far-desk", daemon_url: PEER, workspace_root: ROOT } })).json()).id as string;
  const { session: far } = await (await request.post(`${PEER}/api/sessions`, { data: { workspace: ROOT, title: "Far sweep", model: HAIKU } })).json();
  const ws = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/machines-${Date.now().toString(36)}`;
  const local: string[] = [];
  try {
    // Enough of this machine's sessions to fill the list: four folders of six.
    for (let f = 0; f < 4; f++) { mkdirSync(`${ws}/f${f}`, { recursive: true }); for (let i = 0; i < 6; i++) local.push((await (await request.post("/api/sessions", { data: { model: HAIKU, title: `Here ${f}.${i}`, workspace: `${ws}/f${f}` } })).json()).session.id); }
    const farId = `${mid}--${far.id}`;
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`/s/${local[0]}`);
    // The far machine's sessions are in the list once its relay has told of them.
    await expect(page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${farId}"]`)).toBeAttached({ timeout: 30_000 });
    // Four panes: each about 440 px. The far session's head names its machine.
    // Set from a page of this origin that runs none of the app: an open page writes its own panes back over them.
    await page.goto("/api/daemon");
    await page.evaluate((slots) => { localStorage.setItem("keel.focus", "false"); localStorage.setItem("keel.workbench", "true"); localStorage.setItem("keel.panes", JSON.stringify({ count: 4, slots, sizes: {}, active: 0 })); }, [local[0], farId, local[1], local[2]]);
    await page.goto(`/s/${local[0]}`);
    const pane = page.locator(`section.k-station[data-station="${farId}"]`);
    await expect(pane).toBeVisible({ timeout: 15_000 });
    expect((await pane.boundingBox())!.width).toBeLessThan(500);
    await expect(pane.getByTestId("station-machine")).toBeVisible({ timeout: 15_000 });
    await expect(pane.getByTestId("station-machine")).toHaveText("far-desk");
    await expect(page.locator(`section.k-station[data-station="${local[1]}"]`).getByTestId("station-machine")).toHaveCount(0);
    await shoot(page, "fleet-presence-02-narrow-head");
    // A short window: the far machine's part begins below the list's view, and the foot names it.
    // Set from a page of this origin that runs none of the app: an open page writes its own panes back over them.
    await page.goto("/api/daemon");
    await page.evaluate((slots) => localStorage.setItem("keel.panes", JSON.stringify({ count: 2, slots, sizes: {}, active: 0 })), [local[0], local[1]]);
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto(`/s/${local[0]}`);
    const sep = page.locator(`[data-testid="machine-sep"][data-machine="${mid}"]`);
    await expect(sep).toBeAttached({ timeout: 15_000 });
    await page.getByTestId("session-list").evaluate((l) => { l.scrollTop = 0; });
    await expect(sep).not.toBeInViewport();
    const foot = page.locator(`[data-testid="machine-foot"][data-machine="${mid}"]`);
    await expect(foot).toBeInViewport();
    await expect(foot).toContainText("far-desk");
    await shoot(page, "fleet-presence-03-machine-foot");
    await foot.click();
    await expect(sep).toBeInViewport();
    await expect(foot).toHaveCount(0);
  } finally {
    for (const id of local) await request.delete(`/api/sessions/${id}`);
    await request.delete(`${PEER}/api/sessions/${far.id}`);
    await request.delete(`/api/fleet/machines/${mid}`);
  }
});

// Feature: a session of another machine names its machine once in its page head (the machine button,
// which also moves it), and the list's foot line for a part of the list below the view says how many
// of its sessions work and wait for the owner.
test("a remote session names its machine once, and the foot line of its part counts what works", async ({ page, request }) => {
  const peerWhy = await peerProblem(request, PEER);
  test.skip(!!peerWhy, peerWhy ?? "");
  const old = (await (await request.get("/api/fleet/machines")).json()).machines.filter((m: any) => m.daemon_url === PEER).map((m: any) => m.id);
  for (const s of (await (await request.get("/api/sessions")).json()).sessions) if (old.includes(s.machine)) await request.delete(`/api/sessions/${s.id}`);
  for (const id of old) await request.delete(`/api/fleet/machines/${id}`);
  mkdirSync(ROOT, { recursive: true });
  const mid = (await (await request.post("/api/fleet/machines", { data: { name: "far-desk", daemon_url: PEER, workspace_root: ROOT } })).json()).id as string;
  const { session: far } = await (await request.post(`${PEER}/api/sessions`, { data: { workspace: ROOT, title: "Far long build", model: HAIKU } })).json();
  await request.put(`${PEER}/api/sessions/${far.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  await request.post(`${PEER}/api/sessions/${far.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "sleep 600" } }])}` } });
  const ws = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/machine-chip-${Date.now().toString(36)}`;
  const local: string[] = [];
  try {
    for (let f = 0; f < 4; f++) { mkdirSync(`${ws}/f${f}`, { recursive: true }); for (let i = 0; i < 6; i++) local.push((await (await request.post("/api/sessions", { data: { model: HAIKU, title: `Here ${f}.${i}`, workspace: `${ws}/f${f}` } })).json()).session.id); }
    const farId = `${mid}--${far.id}`;
    await page.setViewportSize({ width: 1400, height: 700 });
    await page.goto(`/s/${local[0]}`);
    const sep = page.locator(`[data-testid="machine-sep"][data-machine="${mid}"]`);
    await expect(sep).toBeAttached({ timeout: 30_000 });
    await page.getByTestId("session-list").evaluate((l) => { l.scrollTop = 0; });
    const foot = page.locator(`[data-testid="machine-foot"][data-machine="${mid}"]`);
    await expect(foot).toBeInViewport();
    // It works there: the folded line says so, and what is only a count before is not all it says.
    await expect(foot.getByTestId("machine-foot-work")).toHaveText("1 working", { timeout: 30_000 });
    await shoot(page, "fleet-presence-04-foot-counts");
    // The far session's page: the machine is named once in the head, by the tag beside the title; its button (the
    // move) is in the session's menu with the other tools, not in the row.
    await page.goto(`/s/${farId}`);
    await expect(page.getByTestId("station-machine")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("station-machine")).toHaveText("far-desk");
    await expect(page.getByTestId("machine-chip")).toBeHidden();
    await expect(page.locator('[data-testid="session-header"], [data-testid="station-head"]').getByText("far-desk").filter({ visible: true })).toHaveCount(1);
    await page.getByTestId("session-menu").click();
    await expect(page.getByTestId("header-more").getByTestId("machine-chip")).toBeVisible();
    await page.keyboard.press("Escape");
    await shoot(page, "fleet-presence-05-one-machine-chip");
  } finally {
    for (const id of local) await request.delete(`/api/sessions/${id}`);
    await request.post(`${PEER}/api/sessions/${far.id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
    await request.delete(`${PEER}/api/sessions/${far.id}`);
    await request.delete(`/api/fleet/machines/${mid}`);
  }
});
