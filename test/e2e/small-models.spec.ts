import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the owner's small models. Settings > Models holds an ordered list
// of the models that read long material for every session; the first listed
// one reads, the next one when it is not listed or fails. Adding, ordering and
// removing is saved in the daemon's settings.
test("small models: picked in order, reordered and removed in Settings", async ({ page, request }) => {
  const before = (await (await request.get("/api/settings")).json()).settings.small_models;
  const { models } = await (await request.get("/api/models")).json();
  // Two models whose names no other listed model shares, so a search finds exactly them.
  const shown = (models as any[]).filter((m) => !m.hidden);
  const two = shown.filter((m) => shown.filter((o) => o.name.toLowerCase().includes(m.name.toLowerCase())).length === 1).slice(0, 2);
  test.skip(two.length < 2, "fewer than two models are listed");
  try {
    await request.patch("/api/settings", { data: { small_models: { ids: [] } } });
    await page.goto("/settings/models");
    const box = page.getByTestId("small-models");
    await expect(box).toBeVisible();
    for (const m of two) {
      await box.getByTestId("model-picker").click();
      await page.getByPlaceholder("Search models").fill(m.name);
      await page.getByRole("option").filter({ hasText: m.name }).first().click();
    }
    await expect(box.getByTestId("small-model")).toHaveCount(2);
    await expect.poll(async () => (await (await request.get("/api/settings")).json()).settings.small_models.ids).toEqual(two.map((m) => m.id));
    await shoot(page, "small-models-01-two");

    // The second moves up: it reads first now.
    await box.getByTestId("small-model").nth(1).getByRole("button", { name: "Move up" }).click();
    await expect.poll(async () => (await (await request.get("/api/settings")).json()).settings.small_models.ids).toEqual([two[1].id, two[0].id]);
    await box.getByTestId("small-model").first().getByRole("button", { name: /^Remove/ }).click();
    await expect(box.getByTestId("small-model")).toHaveCount(1);
    await expect.poll(async () => (await (await request.get("/api/settings")).json()).settings.small_models.ids).toEqual([two[0].id]);
    // A list that is not model ids is refused.
    expect((await request.patch("/api/settings", { data: { small_models: { ids: [3] } } })).status()).toBe(400);
  } finally {
    await request.patch("/api/settings", { data: { small_models: before ?? { ids: [] } } });
  }
});
