import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the model picker over hundreds of listed models. With no query it
// shows favorites, recent models and one folded group per provider (the
// default's provider first, then plan providers); a favorite pins a model on
// top, a hidden model or provider leaves the list and search still finds it.
test("model picker: favorites, hiding, folded groups, search", async ({ page, request }) => {
  const { models, default: def } = await (await request.get("/api/models")).json();
  expect(models.length).toBeGreaterThan(0);
  const defProvider = models.find((m: any) => m.id === def).provider;

  const other = models.find((m: any) => m.provider !== defProvider && !m.hidden);
  // A run that stopped half way may have left it pinned.
  await request.post("/api/providers/choices", { data: { unpin: [other.id], provider: other.provider, show: [other.model] } });
  const before = (await (await request.get("/api/providers")).json()).choices;

  await page.goto("/");
  const popup = page.getByTestId("model-popup");
  await page.getByTestId("model-picker").click();
  await expect(popup).toBeVisible();
  // The default's provider is the first provider group.
  const firstProvider = popup.locator('[data-testid="model-group"]:not([data-group="favorites"]):not([data-group="recent"])').first();
  await expect(firstProvider).toHaveAttribute("data-group", defProvider);
  await shoot(page, "picker-01-default-view");

  // Pin one model of another provider: it shows under Favorites.
  await page.getByPlaceholder("Search models").fill(other.model);
  const row = popup.locator(`[data-testid="model-option"][data-model="${other.id}"]`).first();
  await row.hover();
  await Promise.all([page.waitForResponse("**/api/providers/choices"), row.getByTestId("pin-model").click()]);
  await page.getByPlaceholder("Search models").fill("");
  await expect(popup.locator('[data-group="favorites"]')).toContainText(other.name);

  // Hide it: it leaves the default view, search finds it under Hidden.
  const fav = popup.locator(`[data-group="favorites"] [data-model="${other.id}"]`);
  await fav.hover();
  await Promise.all([page.waitForResponse("**/api/providers/choices"), fav.getByTestId("hide-model").click()]);
  await expect(popup.locator(`[data-model="${other.id}"]`)).toHaveCount(0);
  await page.getByPlaceholder("Search models").fill(other.model);
  const hidden = popup.locator(`[data-group="hidden"] [data-model="${other.id}"]`);
  await expect(hidden).toBeVisible();
  await shoot(page, "picker-02-search-hidden");
  await hidden.hover();
  await Promise.all([page.waitForResponse("**/api/providers/choices"), hidden.getByTestId("hide-model").click()]);
  await expect(popup.locator(`[data-group="hidden"] [data-model="${other.id}"]`)).toHaveCount(0);

  // A large provider is folded; Show all opens it.
  await page.getByPlaceholder("Search models").fill("");
  const big = popup.getByTestId("show-all").first();
  if (await big.count()) {
    const name = await big.evaluate((e) => e.closest<HTMLElement>("[data-group]")!.dataset.group);
    const group = popup.locator(`[data-testid="model-group"][data-group="${name}"]`);
    const shown = await group.getByTestId("model-option").count();
    await big.click();
    await expect.poll(() => group.getByTestId("model-option").count()).toBeGreaterThan(shown);
  }

  // Search is instant over every model: one keystroke narrows the list.
  const t0 = Date.now();
  await page.getByPlaceholder("Search models").fill(other.name);
  await expect(popup.locator(`[data-model="${other.id}"]`).first()).toBeVisible();
  expect(Date.now() - t0).toBeLessThan(1000);
  await page.keyboard.press("Escape");

  // Restore the owner's choices.
  await request.post("/api/providers/choices", { data: { unpin: [other.id], provider: other.provider, show: [other.model] } });
  const after = (await (await request.get("/api/providers")).json()).choices;
  expect(after.pinned ?? []).toEqual(before.pinned ?? []);
});
