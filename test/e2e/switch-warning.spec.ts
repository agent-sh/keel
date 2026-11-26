import { expect, test, type Page } from "./isolate.ts";
import { boxTools, shoot } from "./shots.ts";

// Feature: each row of the model picker says what a switch to it re-reads
// without the prompt cache and what that adds, and offers Compact first. A
// switch asks first only when that is material: it adds at least the owner's
// amount (model_switch.ask_usd, a quarter by default; this spec sets a cent), or the conversation is
// past where the new model compacts. Asked, it names the tokens and their
// cost; switching back to the model the conversation ran on, or with nothing
// cached, never asks. Runs on the scripted stand-in (its listing has prices
// and its usage reports cache reads).
const STAND_IN = "scripted:stand-in";

async function pickModel(page: Page, name: string) {
  await (await boxTools(page)).getByTestId("model-picker").click();
  await page.getByPlaceholder("Search models").fill(name);
  await page.getByRole("option", { name: new RegExp(name) }).first().click();
}

test("cache warning before a model or effort switch", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  // The owner's amount as it was, put back at the end.
  const kept = (await (await request.get("/api/settings")).json()).settings.model_switch ?? null;
  const setAsk = async (v: number | null) => expect((await request.patch("/api/settings", { data: { model_switch: v === null ? kept : { ask_usd: v } } })).ok()).toBe(true);
  await setAsk(0.01);
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN } })).json();
  try {
    await page.goto(`/s/${session.id}`);
    const confirm = page.getByTestId("confirm");

    // Nothing cached yet: the switch happens at once.
    await (await boxTools(page)).getByTestId("effort-picker").click();
    await page.getByRole("menuitem", { name: "low" }).click();
    await expect((await boxTools(page)).getByTestId("effort-picker")).toContainText("low");
    await expect(confirm).toHaveCount(0);

    const composer = page.getByTestId("composer");
    await composer.fill("Hello there.");
    await composer.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });

    // The row says what a switch adds; a tenth of a cent is under the cent the owner is asked about, so Enter switches.
    await (await boxTools(page)).getByTestId("model-picker").click();
    await page.getByPlaceholder("Search models").fill("Scripted backup");
    const popup = page.getByTestId("model-popup");
    const backupRow = popup.locator('[data-testid="model-option"][data-model="scripted:stand-in-backup"]').first();
    await expect(backupRow.getByTestId("row-cache-cost")).toHaveText(/^\+<?\$0\.\d{4}$/);
    await expect(backupRow.getByTestId("row-cache-cost")).toHaveAttribute("title", /re-reads about [\d.]+k? cached tokens without the prompt cache: about <?\$[\d.]+, against <?\$[\d.]+ from the cache/);
    await expect(backupRow.getByTestId("compact-first")).toBeVisible();
    // The model the cache is on costs nothing to go back to.
    await page.getByPlaceholder("Search models").fill("Scripted stand-in");
    await expect(popup.locator('[data-testid="model-option"][data-model="scripted:stand-in"]').first().getByTestId("row-cache-cost")).toHaveCount(0);
    await page.getByPlaceholder("Search models").fill("Scripted backup");
    await shoot(page, "switch-00-row-cost");
    // On a phone the cost and Compact first are on the row too.
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    const tools = page.getByTestId("composer-open");
    if (await tools.isVisible()) await tools.click();
    await page.getByTestId("model-picker").click();
    await page.getByPlaceholder("Search models").fill("Scripted backup");
    await expect(backupRow.getByTestId("row-cache-cost")).toBeVisible();
    await expect(backupRow.getByTestId("compact-first")).toBeVisible();
    await shoot(page, "switch-00-row-cost-phone");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1920, height: 1040 });
    await (await boxTools(page)).getByTestId("model-picker").click();
    await page.getByPlaceholder("Search models").fill("Scripted backup");
    await expect(backupRow).toHaveAttribute("data-highlighted", "");
    await page.keyboard.press("Enter");
    await expect((await boxTools(page)).getByTestId("model-picker")).toContainText("Scripted backup");
    await expect(confirm).toHaveCount(0);
    await pickModel(page, "Scripted stand-in");
    await expect((await boxTools(page)).getByTestId("model-picker")).toContainText("Scripted stand-in");
    await expect(confirm).toHaveCount(0);
    expect(await (await request.get(`/api/sessions/${session.id}/switch-warning?model=scripted:stand-in-backup`)).json()).toMatchObject({ ask: false, ask_usd: 0.01, ran_on: STAND_IN, can_compact: true });

    // The owner asks about every lost cache (0): another model asks first; Cancel keeps the model.
    await setAsk(0);
    await pickModel(page, "Scripted backup");
    await expect(confirm).toContainText("Switch to Scripted backup?");
    await expect(confirm).toContainText(/reads about [\d.]+k? tokens again without the prompt cache/);
    // (How much is in the cache depends on the system prompt, which holds the daemon's folders and instruction
    // files: on a machine with a bare home both amounts are under a hundredth of a cent.)
    await expect(confirm).toContainText(/costs about <?\$[\d.]+, against <?\$[\d.]+ from the cache/);
    await shoot(page, "switch-01-model-warning");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect((await boxTools(page)).getByTestId("model-picker")).toContainText("Scripted stand-in");

    // A message sent while the switch is still being checked waits for it: nothing
    // leaves on the old model, and Cancel leaves the text in the box.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/switch-warning**", async (route) => { await held; await route.continue(); });
    await pickModel(page, "Scripted backup");
    await composer.fill("Send me on the new model.");
    await composer.press("Enter");
    await expect(page.getByTestId("composer-notice")).toContainText("not confirmed yet");
    await expect(composer).toHaveValue("Send me on the new model.");
    release();
    await expect(confirm).toContainText("Switch to Scripted backup?");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await page.unroute("**/switch-warning**");
    await expect((await boxTools(page)).getByTestId("model-picker")).toContainText("Scripted stand-in");
    await expect(composer).toHaveValue("Send me on the new model.");
    expect((await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "user")).toHaveLength(1);
    await composer.fill("");

    // /model asks the same question, and a name several routes share is not guessed.
    await composer.fill("/model Scripted backup");
    await composer.press("Enter");
    await expect(confirm).toContainText("Switch to Scripted backup?");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect((await boxTools(page)).getByTestId("model-picker")).toContainText("Scripted stand-in");
    await composer.fill("/model Scripted");
    await composer.press("Enter");
    await expect(page.getByTestId("composer-notice")).toContainText("Give the full id");
    await expect((await boxTools(page)).getByTestId("model-picker")).toContainText("Scripted stand-in");

    // The effort is part of the cached prompt on this wire: asked; Cancel keeps it.
    await (await boxTools(page)).getByTestId("effort-picker").click();
    await page.getByRole("menuitem", { name: "high" }).click();
    await expect(confirm).toContainText("Change the effort to high?");
    await expect(confirm).toContainText("The effort is part of the cached prompt.");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect((await boxTools(page)).getByTestId("effort-picker")).toContainText("low");

    // Switch, then back to the model the conversation ran on: no question the second time.
    await pickModel(page, "Scripted backup");
    await confirm.getByRole("button", { name: "Switch" }).click();
    await expect((await boxTools(page)).getByTestId("model-picker")).toContainText("Scripted backup");
    await pickModel(page, "Scripted stand-in");
    await expect((await boxTools(page)).getByTestId("model-picker")).toContainText("Scripted stand-in");
    await expect(confirm).toHaveCount(0);
    await shoot(page, "switch-02-switched-back");

    const r = await (await request.get(`/api/sessions/${session.id}/switch-warning?model=scripted:stand-in-backup`)).json();
    expect(r.warning.cause).toBe("model");
    expect(r).toMatchObject({ ask: true, why: "cost" });
    expect(r.cached_tokens).toBeGreaterThan(0);
    expect((await request.get(`/api/sessions/${session.id}/switch-warning?model=nope:none`)).status()).toBe(400);

    // Compact first, the row's second action: the model in use summarizes from its warm cache, then the switch, unasked.
    await (await boxTools(page)).getByTestId("model-picker").click();
    await page.getByPlaceholder("Search models").fill("Scripted backup");
    await backupRow.hover();
    await backupRow.getByTestId("compact-first").click();
    await expect((await boxTools(page)).getByTestId("model-picker")).toContainText("Scripted backup");
    await expect(confirm).toHaveCount(0);
    await expect.poll(async () => ((await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[]).find((e) => e.kind === "compaction")?.data.model).toBe(STAND_IN);
    await shoot(page, "switch-03-compacted-from-row");

    // The owner's amount is a setting of the models' page.
    await page.goto("/settings/models");
    const field = page.getByTestId("switch-ask-usd");
    await expect(field).toHaveValue("0");
    await field.fill("0.05");
    await field.press("Enter");
    await expect.poll(async () => (await (await request.get("/api/settings")).json()).settings.model_switch.ask_usd).toBe(0.05);
    await field.scrollIntoViewIfNeeded();
    await shoot(page, "switch-04-ask-setting");
  } finally {
    await setAsk(null);
    await request.delete(`/api/sessions/${session.id}`);
  }
});
