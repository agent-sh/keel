import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// Feature: plan mode. The session reads and plans but changes nothing; the
// model presents its plan on a card; the owner sends it back once, then
// approves it and picks the mode the work goes on in, and the work happens.
test("plan mode and plan approval", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `plan-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("permission-menu").click();
  await page.getByTestId("mode-plan").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("permission-mode")).toHaveText("Plan");

  await page.getByTestId("composer").fill("Plan how to create hello.txt containing the line hi. Present the plan with your plan tool; after it is approved, create the file with one command.");
  await page.keyboard.press("Enter");
  const card = page.getByTestId("plan-card");
  await expect(card).toBeVisible({ timeout: 90_000 });
  expect(existsSync(join(ws, "hello.txt"))).toBe(false);
  await shoot(page, "plan-01-card");

  // Sent back once with a change; the model presents again.
  await card.getByTestId("plan-back").click();
  await card.getByTestId("plan-feedback").fill("Also say in the plan that the file ends with a newline.");
  await page.keyboard.press("Enter");
  await expect(card).toHaveCount(1, { timeout: 90_000 });
  await expect(card.getByTestId("plan-text")).toContainText(/newline/i, { timeout: 90_000 });

  await card.getByTestId("plan-mode").selectOption("auto-edits");
  await card.getByTestId("plan-approve").click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("permission-mode")).toHaveText("Auto edits");
  // Auto edits still asks before a command that writes (no sandbox here).
  const ask = page.getByTestId("approval");
  await expect(ask).toBeVisible({ timeout: 90_000 });
  await ask.getByTestId("allow-once").click();
  await expect.poll(() => existsSync(join(ws, "hello.txt")), { timeout: 120_000 }).toBe(true);
  expect(readFileSync(join(ws, "hello.txt"), "utf8").trim()).toBe("hi");
  const { plan } = await (await request.get(`/api/sessions/${session.id}/plan`)).json();
  expect(plan.mode).toBe("auto-edits");
  expect(plan.plan).toMatch(/newline/i);
  await shoot(page, "plan-02-done");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
