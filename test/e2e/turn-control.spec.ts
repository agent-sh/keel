import { expect, test } from "@playwright/test";
import { HAIKU, shoot } from "./shots.ts";

// Feature: while a turn works, Enter steers (the text joins the turn after the
// running tool), Tab queues for after it; Stop cuts the running tool at once
// and holds the queue; a queued prompt can be sent now.
test("steer, queue, stop and send now", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const r = await request.post("/api/sessions", { data: { model: HAIKU } });
  const { session } = await r.json();
  // Commands run without an approval card here; approvals have their own e2e.
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await page.goto(`/s/${session.id}`);

  const composer = page.getByTestId("composer");
  await composer.fill("Run `sleep 6; echo first-done` with Bash, then reply in one short sentence.");
  await composer.press("Enter");
  await expect(page.getByTestId("tool-call").first()).toBeVisible({ timeout: 60_000 });

  // Steer while the tool runs, and queue a follow-up.
  await composer.fill("Also tell me what 2+2 is, in the same reply.");
  await composer.press("Enter");
  await composer.fill("Now reply with only the word queued-ok.");
  await composer.press("Tab");
  await expect(page.getByTestId("queue-item")).toHaveCount(2);
  await shoot(page, "turn-01-steer-and-queue");

  // The steer lands in the same turn; the queued prompt runs as the next turn.
  await expect(page.getByTestId("origin-steer")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("origin-queued")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 90_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText(/queued-ok/i);
  await expect(page.getByTestId("queue-item")).toHaveCount(0);
  await shoot(page, "turn-02-steered-then-queued");

  // Stop during a long tool: it returns at once, the queue is held.
  await composer.fill("Run `sleep 60` with Bash.");
  await composer.press("Enter");
  await expect(page.getByTestId("tool-call")).toHaveCount(2, { timeout: 60_000 });
  await page.waitForTimeout(2_000); // the call is stored and its command runs
  await composer.fill("Reply with only the word after-stop.");
  await composer.press("Tab");
  const t0 = Date.now();
  await page.getByTestId("stop").click();
  await expect(page.getByTestId("turn-end").last()).toContainText("Stopped", { timeout: 10_000 });
  expect(Date.now() - t0).toBeLessThan(8_000);
  await expect(page.getByTestId("queue-held")).toBeVisible();
  await expect(page.getByTestId("resume")).toBeVisible();
  await shoot(page, "turn-03-stopped-queue-held");

  await page.getByTestId("queue-send-now").click();
  await expect(page.getByTestId("turn-end")).toHaveCount(4, { timeout: 90_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText(/after-stop/i);
  await expect(page.getByTestId("queue")).toHaveCount(0);
  await expect(page.getByTestId("turn-end").last()).toContainText("$");
  await expect(page.getByTestId("session-usage")).toContainText("cached");
  await shoot(page, "turn-04-sent-now");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
