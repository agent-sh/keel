import { expect, test, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: switching the model or the effort while the prompt cache is warm
// asks first, with the tokens the next request reads again and their cost;
// switching back to the model the conversation ran on, or with nothing
// cached, switches at once. Runs on the scripted stand-in (its listing has
// prices and its usage reports cache reads).
const STAND_IN = "scripted:stand-in";

async function pickModel(page: Page, name: string) {
  await page.getByTestId("model-picker").click();
  await page.getByPlaceholder("Search models").fill(name);
  await page.getByRole("option", { name: new RegExp(name) }).first().click();
}

test("cache warning before a model or effort switch", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN } })).json();
  await page.goto(`/s/${session.id}`);
  const confirm = page.getByTestId("confirm");

  // Nothing cached yet: the switch happens at once.
  await page.getByTestId("effort-picker").click();
  await page.getByRole("menuitem", { name: "low" }).click();
  await expect(page.getByTestId("effort-picker")).toContainText("low");
  await expect(confirm).toHaveCount(0);

  const composer = page.getByTestId("composer");
  await composer.fill("Hello there.");
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });

  // Another model: asked first; Cancel keeps the model.
  await pickModel(page, "Scripted backup");
  await expect(confirm).toContainText("Switch to Scripted backup?");
  await expect(confirm).toContainText(/reads about [\d.]+k? tokens again without the prompt cache/);
  await expect(confirm).toContainText(/costs about \$[\d.]+, against <?\$[\d.]+ from the cache/);
  await shoot(page, "switch-01-model-warning");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("model-picker")).toContainText("Scripted stand-in");

  // The effort is part of the cached prompt on this wire: asked; Cancel keeps it.
  await page.getByTestId("effort-picker").click();
  await page.getByRole("menuitem", { name: "high" }).click();
  await expect(confirm).toContainText("Change the effort to high?");
  await expect(confirm).toContainText("The effort is part of the cached prompt.");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("effort-picker")).toContainText("low");

  // Switch, then back to the model the conversation ran on: no question the second time.
  await pickModel(page, "Scripted backup");
  await confirm.getByRole("button", { name: "Switch" }).click();
  await expect(page.getByTestId("model-picker")).toContainText("Scripted backup");
  await pickModel(page, "Scripted stand-in");
  await expect(page.getByTestId("model-picker")).toContainText("Scripted stand-in");
  await expect(confirm).toHaveCount(0);
  await shoot(page, "switch-02-switched-back");

  const r = await (await request.get(`/api/sessions/${session.id}/switch-warning?model=scripted:stand-in-backup`)).json();
  expect(r.warning.cause).toBe("model");
  expect(r.cached_tokens).toBeGreaterThan(0);
  expect((await request.get(`/api/sessions/${session.id}/switch-warning?model=nope:none`)).status()).toBe(400);
});
