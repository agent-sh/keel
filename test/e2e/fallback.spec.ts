import { expect, test } from "./isolate.ts";
import { boxTools, closeBoxTools, shoot } from "./shots.ts";

// Feature: a session's fallback model, set from /fallback or a refusal card:
// when the model declines, the turn goes on by itself on the fallback, which
// stays the session's model. Runs on the scripted stand-in (its refusal is
// scripted; its backup model always answers).
const STAND_IN = "scripted:stand-in";
const BACKUP = "scripted:stand-in-backup";

test("fallback model for declined requests", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN } })).json();
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");
  const chip = page.getByTestId("fallback-chip");

  await composer.fill("/fallback Scripted backup");
  await composer.press("Enter");
  await expect((await boxTools(page)).getByTestId("fallback-chip")).toContainText("Scripted backup");
  await closeBoxTools(page);

  await composer.fill("script:refuse");
  await composer.press("Enter");
  await expect(page.getByTestId("note").last()).toContainText("declined (cyber). Continuing on Scripted backup.", { timeout: 15_000 });
  await expect(page.getByTestId("assistant-text").last()).toHaveText("The backup model took the request.");
  await expect(page.getByTestId("turn-end")).toHaveCount(1);
  await expect((await boxTools(page)).getByTestId("model-picker").first()).toContainText("Scripted backup");
  await shoot(page, "fallback-01-continued");

  await (await boxTools(page)).getByTestId("fallback-chip").getByRole("button", { name: "No fallback model" }).click();
  await expect(chip).toHaveCount(0);
  expect((await (await request.get(`/api/sessions/${session.id}`)).json()).session.settings.fallback).toBeUndefined();

  // From a refusal card: retry on another model and keep it as the fallback.
  const { session: s2 } = await (await request.post("/api/sessions", { data: { model: STAND_IN } })).json();
  await page.goto(`/s/${s2.id}`);
  await composer.fill("script:refuse");
  await composer.press("Enter");
  const card = page.getByTestId("refusal");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByTestId("model-picker").click();
  await page.getByPlaceholder("Search models").fill("Scripted backup");
  await page.getByRole("option", { name: /Scripted backup/ }).first().click();
  await card.getByTestId("refusal-keep-fallback").check();
  await shoot(page, "fallback-02-refusal-card");
  await card.getByRole("button", { name: "Retry on it" }).click();
  await expect(page.getByTestId("assistant-text").last()).toHaveText("The backup model took the request.", { timeout: 15_000 });
  await expect((await boxTools(page)).getByTestId("fallback-chip")).toContainText("Scripted backup");
  expect((await (await request.get(`/api/sessions/${s2.id}`)).json()).session.settings.fallback).toBe(BACKUP);
});
