import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the portal. A dev server the session starts shows up in the
// Preview panel; opened, it runs in a sandboxed frame through the portal
// (its root-relative assets and its own fetch stay inside), and the element
// picker hands what was clicked to the message box.
const PORT = Number(process.env.KEEL_PORTAL_TEST_PORT ?? 47989);
const SITE = `${process.env.HOME}/.cache/keel-work/bun/dev-fleet/site-e2e`;

test("portal: the session's dev server in the preview, assets and fetch inside, picker", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  mkdirSync(SITE, { recursive: true });
  writeFileSync(`${SITE}/index.html`, '<html><head><title>site</title><link rel="stylesheet" href="/style.css"></head><body><h1>Portal works</h1><script src="/app.js"></script></body></html>');
  writeFileSync(`${SITE}/style.css`, "h1{color:rgb(13, 148, 136)}");
  writeFileSync(`${SITE}/app.js`, 'fetch("/data.json").then(r=>r.json()).then(d=>{document.body.insertAdjacentHTML("beforeend","<p id=d>"+d.msg+"</p>")})');
  writeFileSync(`${SITE}/data.json`, '{"msg":"fetched through the portal"}');
  const s = (await (await request.post("/api/sessions", { data: { workspace: SITE, title: "Preview a site", model: HAIKU } })).json()).session;
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "full-auto" } });

  try {
    await page.goto(`/s/${s.id}`);
    await page.getByTestId("composer").fill(`Use the Bash tool once with run_in_background true to run: python3 -m http.server ${PORT} --bind 127.0.0.1. Then reply "started".`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });

    await page.getByTestId("panel-toggle-preview").click();
    const port = page.locator(`[data-testid="preview-port"][data-port="${PORT}"]`);
    await expect(port).toBeVisible({ timeout: 15_000 });
    await port.click();
    const frame = page.frameLocator('[data-testid="preview-frame"]');
    await expect(frame.locator("h1")).toHaveText("Portal works");
    await expect(frame.locator("h1")).toHaveCSS("color", "rgb(13, 148, 136)");
    await expect(frame.locator("#d")).toHaveText("fetched through the portal");
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
    try { execFileSync("fuser", ["-k", `${PORT}/tcp`], { stdio: "ignore" }); } catch {}
    await request.delete(`/api/sessions/${s.id}`);
  }
});
