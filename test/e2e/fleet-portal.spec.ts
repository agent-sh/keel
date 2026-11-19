import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { writeSite } from "./fixtures/dev-site.ts";
import { HAIKU, shoot, openPanel } from "./shots.ts";

// Feature: the portal. A dev server the session starts shows up in the
// Preview panel; opened, it runs in a sandboxed frame through the portal
// (its root-relative assets, its own fetch and its hot-reload socket stay
// inside), and the element picker hands what was clicked to the message box.
// A session of another daemon gets the same preview through that daemon.
// A port free now, so the dev server never meets another one. Deleting the
// session at the end stops it (a session's commands go with it).
const PORT = Number(execFileSync("python3", ["-c", "import socket; s=socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1])"], { encoding: "utf8" }).trim());
const SITE = `${process.env.HOME}/.cache/keel-work/bun/dev-fleet/site-e2e`;
const PEER = process.env.KEEL_PEER_URL ?? "http://127.0.0.1:47975";

const site = () => writeSite(SITE);
const START = `Use the Bash tool once with run_in_background true to run: bun serve.ts ${PORT}. Then reply "started".`;

test("portal: the session's dev server in the preview, assets and fetch inside, picker", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  site();
  const s = (await (await request.post("/api/sessions", { data: { workspace: SITE, title: "Preview a site", model: HAIKU } })).json()).session;
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "full-auto" } });

  try {
    await page.goto(`/s/${s.id}`);
    await page.getByTestId("composer").fill(START);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });

    await openPanel(page, "preview");
    const port = page.locator(`[data-testid="preview-port"][data-port="${PORT}"]`);
    await expect(port).toBeVisible({ timeout: 15_000 });
    await port.click();
    const frame = page.frameLocator('[data-testid="preview-frame"]');
    await expect(frame.locator("h1")).toHaveText("Portal works");
    await expect(frame.locator("h1")).toHaveCSS("color", "rgb(13, 148, 136)");
    await expect(frame.locator("#d")).toHaveText("fetched through the portal");
    await expect(frame.locator(".ws")).toHaveText(["hello from the dev server", "echo ping test-hmr"]);
    await shoot(page, "fleet-portal-01-preview");

    await page.getByTestId("preview-point").click();
    await expect(page.getByTestId("preview-point")).toHaveAttribute("aria-pressed", "true");
    // The frame reloads with the picker; a click there seeds the message box.
    await expect(async () => {
      await frame.locator("h1").click();
      await expect(page.getByTestId("composer")).toHaveValue(new RegExp(`preview \\(http://127\\.0\\.0\\.1:${PORT}/\\), the element \`html > body > h1\` \\("Portal works"\\)`), { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await shoot(page, "fleet-portal-02-picked");

    // Closed, the same address is gone.
    const url = (await (await request.get(`/api/sessions/${s.id}/portal`)).json()).ports.find((p: any) => p.port === PORT).url;
    await port.click();
    expect((await request.get(url)).status()).toBe(404);

    const errors = (await (await request.get("/api/errors")).json()).errors;
    expect(errors.slice(0, errors.length - errorsBefore).filter((e: any) => e.source !== "provider")).toEqual([]);
  } finally {
    await request.delete(`/api/sessions/${s.id}`);
  }
});

test("portal: a session of another daemon, previewed through it, socket included", async ({ page, request }) => {
  const peerUp = await request.get(`${PEER}/api/health`, { timeout: 3000 }).then((r) => r.ok(), () => false);
  test.skip(!peerUp, `no peer daemon at ${PEER}: start a second daemon and set KEEL_PEER_URL and KEEL_PEER_ROOT`);
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  site();
  const { machines } = await (await request.get("/api/fleet/machines")).json();
  let m = machines.find((x: any) => x.daemon_url === PEER);
  if (!m) m = (await (await request.post("/api/fleet/machines", { data: { name: "devbox", daemon_url: PEER, workspace_root: SITE } })).json()).machines.find((x: any) => x.daemon_url === PEER);
  // The session lives on the other daemon, which starts the dev server.
  const s = (await (await request.post(`${PEER}/api/sessions`, { data: { workspace: SITE, title: "Preview over there", model: HAIKU } })).json()).session;
  await request.put(`${PEER}/api/sessions/${s.id}/permissions`, { data: { mode: "full-auto" } });
  try {
    await page.goto(`/s/${m.id}--${s.id}`);
    await page.getByTestId("composer").fill(START);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });

    await openPanel(page, "preview");
    const port = page.locator(`[data-testid="preview-port"][data-port="${PORT}"]`);
    await expect(port).toBeVisible({ timeout: 15_000 });
    await port.click();
    await expect(page.getByTestId("preview-frame")).toHaveAttribute("src", new RegExp(`^/fleet-portal/${m.id}/${s.id}/${PORT}/`));
    const frame = page.frameLocator('[data-testid="preview-frame"]');
    await expect(frame.locator("h1")).toHaveCSS("color", "rgb(13, 148, 136)");
    await expect(frame.locator("#d")).toHaveText("fetched through the portal");
    await expect(frame.locator(".ws")).toHaveText(["hello from the dev server", "echo ping test-hmr"]);
    await shoot(page, "fleet-portal-03-remote");

    // Closed over there, this daemon's address for it is gone too.
    const src = (await page.getByTestId("preview-frame").getAttribute("src"))!;
    await port.click();
    expect((await request.get(src)).status()).toBe(404);
    const errors = (await (await request.get("/api/errors")).json()).errors;
    expect(errors.slice(0, errors.length - errorsBefore).filter((e: any) => e.source !== "provider")).toEqual([]);
  } finally {
    await request.delete(`${PEER}/api/sessions/${s.id}`);
  }
});
