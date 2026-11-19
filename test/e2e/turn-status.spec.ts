import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HAIKU } from "./shots.ts";

// Feature: what a screen reader is told about a running turn. One status
// region per session changes when the reason changes (working, waiting for an
// approval, the end), never with the ticking clock, and says nothing when an
// idle session opens or the page reconnects.
test("turn status is announced once per change", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `status-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("turn-announcer")).toHaveText("");

  // Record every text the region takes.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="turn-announcer"]')!;
    (window as any).said = [];
    new MutationObserver(() => (window as any).said.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await page.getByTestId("composer").fill("Run exactly this Bash command and nothing else: touch status.txt. Then reply with the word ok.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("approval")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(2500); // the visible clock ticks meanwhile
  await page.getByTestId("allow-once").click();
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
  await expect(page.getByTestId("turn-announcer")).toHaveText("The turn ended.");
  const said = (await page.evaluate(() => (window as any).said)).filter(Boolean);
  expect(said).toEqual(["Working.", "Waiting for your approval.", "Working.", "The turn ended."]);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
