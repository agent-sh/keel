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
  await Promise.all([page.waitForResponse("**/api/providers/choices"), hidden.getByTestId("show-model").click()]);
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

// The picker's words agree with what it shows and does: the count says what
// is offered or what matched, an exact route id finds that route first, the
// default's Hide is refused in place (pointer and keyboard), Recent follows
// the owner's picks, and a model hidden by both rules says so and offers
// both ways back. Runs on the scripted stand-ins.
test("model picker: counts, exact ids, the default, recent picks, two hide rules", async ({ page, request }) => {
  const { models, default: def } = await (await request.get("/api/models")).json();
  const ids = models.map((m: any) => m.id);
  test.skip(!ids.includes("scripted:stand-in-text"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  test.skip(def.startsWith("scripted:"), "the default is a scripted model");
  await request.post("/api/providers/choices", { data: { show_provider: "scripted", provider: "scripted", show: ["stand-in-text"] } });
  const visible = (await (await request.get("/api/models")).json()).models.filter((m: any) => !m.hidden).length;

  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("keel.recentModels"));
  await page.reload();
  const popup = page.getByTestId("model-popup");
  const search = page.getByPlaceholder("Search models");
  const count = page.getByTestId("model-count");
  await page.getByTestId("model-picker").click();
  await expect(count).toHaveText(`${visible} available`);
  await search.fill("zzzz-no-such-model");
  await expect(count).toHaveText("No matches");

  // The exact id a session's settings show: that route, first, alone in its group.
  await search.fill("scripted:stand-in");
  await expect(popup.locator('[data-group="exact"] [data-testid="model-option"]')).toHaveAttribute("data-model", "scripted:stand-in");
  await expect(count).toHaveText(/^\d+ matches$/);

  // The default: no Hide on its row, and Ctrl+H says why without asking the daemon.
  await search.fill(def);
  const defRow = popup.locator(`[data-group="exact"] [data-model="${def}"]`);
  await expect(defRow).toBeVisible();
  await expect(defRow.getByTestId("hide-model")).toHaveCount(0);
  let posted = 0;
  page.on("request", (r) => { if (r.url().includes("/api/providers/choices")) posted++; });
  await search.press("Control+h");
  await expect(page.getByTestId("picker-hint")).toHaveText("Choose another default before hiding this model.");
  expect(posted).toBe(0);

  // A pick goes to the front of Recent.
  await search.fill("Scripted backup");
  await page.getByRole("option", { name: /Scripted backup/ }).first().click();
  await page.getByTestId("model-picker").click();
  await expect(popup.locator('[data-group="recent"] [data-testid="model-option"]').first()).toHaveAttribute("data-model", "scripted:stand-in-backup");
  await page.keyboard.press("Escape");

  // A refresh that reorders the listing under the highlight: Enter takes the
  // model that was highlighted, not the one that moved into its row. One that
  // left the listing is not replaced: Enter does nothing until a key moves.
  const reorder = (drop?: string) => page.route("**/api/models?refresh", async (route) => {
    const body = await (await route.fetch()).json();
    body.models = body.models.reverse().filter((m: any) => m.id !== drop);
    await route.fulfill({ json: body });
  });
  await page.getByTestId("model-picker").click();
  await search.fill("Scripted");
  await search.press("ArrowDown");
  await search.press("ArrowUp");
  const lit = popup.locator('[data-testid="model-option"][data-highlighted]');
  const was = await lit.getAttribute("data-model");
  await reorder();
  await Promise.all([page.waitForResponse("**/api/models?refresh"), page.getByTestId("refresh-models").click()]);
  await expect(lit).not.toHaveAttribute("data-model", was!);
  await expect(popup.locator("[data-held]")).toHaveAttribute("data-model", was!);
  await search.press("Enter");
  const wasName = models.find((m: any) => m.id === was).name;
  await expect(page.getByTestId("model-picker")).toContainText(wasName);
  await page.unroute("**/api/models?refresh");

  await page.getByTestId("model-picker").click();
  await search.fill("Scripted");
  const gone = await lit.getAttribute("data-model");
  await reorder(gone!);
  await Promise.all([page.waitForResponse("**/api/models?refresh"), page.getByTestId("refresh-models").click()]);
  await expect(page.getByTestId("picker-hint")).toContainText("left the listing");
  await expect(popup.locator("[data-held]")).toHaveCount(0);
  await search.press("Enter");
  await expect(popup).toBeVisible();
  await expect(page.getByTestId("model-picker")).toContainText(wasName);
  await search.press("ArrowDown");
  await expect(page.getByTestId("picker-hint")).toHaveCount(0);
  await page.unroute("**/api/models?refresh");
  await page.keyboard.press("Escape");
  await page.reload();

  // Hidden by itself and by its provider: the row says both; showing the
  // provider leaves it hidden, Show both brings it back.
  await request.post("/api/providers/choices", { data: { provider: "scripted", hide: ["stand-in-text"] } });
  await request.post("/api/providers/choices", { data: { hide_provider: "scripted" } });
  await page.reload();
  await page.getByTestId("model-picker").click();
  await search.fill("Scripted text only");
  const row = popup.locator('[data-group="hidden"] [data-model="scripted:stand-in-text"]');
  await expect(row.getByTestId("hidden-reason")).toHaveText("Provider and model hidden");
  await expect(count).toHaveText("1 hidden match");
  await shoot(page, "picker-03-hidden-both");
  await row.hover();
  await Promise.all([page.waitForResponse("**/api/providers/choices"), row.getByTestId("show-provider").click()]);
  await expect(row.getByTestId("hidden-reason")).toHaveText("Hidden");
  await expect(popup.locator('[data-group="hidden"] [data-model="scripted:stand-in-backup"]')).toHaveCount(0);
  await request.post("/api/providers/choices", { data: { hide_provider: "scripted" } });
  await page.reload();
  await page.getByTestId("model-picker").click();
  await search.fill("Scripted text only");
  await row.hover();
  await Promise.all([page.waitForResponse("**/api/providers/choices"), row.getByTestId("show-both").click()]);
  await expect(popup.locator('[data-group="hidden"] [data-model="scripted:stand-in-text"]')).toHaveCount(0);
  await expect(popup.locator('[data-model="scripted:stand-in-text"]').first()).toBeVisible();
  await page.keyboard.press("Escape");
  await request.post("/api/providers/choices", { data: { show_provider: "scripted", provider: "scripted", show: ["stand-in-text"] } });
});
