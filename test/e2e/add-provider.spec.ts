import { expect, test } from "./isolate.ts";
import { FAKE_KEY, FAKE_MODEL, startFake } from "./fixtures/fake-endpoint.ts";
import { shoot } from "./shots.ts";

// Feature: adding a provider by hand in Settings > Providers. A stand-in
// OpenAI-compatible server that wants a key and keeps its API under /v1: the
// test says what to fix at each step (a key, then the /v1), the key typed in
// goes to the keyring and never into the endpoint file, the probe finds what
// the model can do, a price set by hand prices it, and a session runs a turn
// on it. Removing it takes its file and its saved key.
test("add an OpenAI-compatible endpoint, test it, probe it, price it, use it", async ({ page, request }) => {
  const fake = await startFake();
  const id = "lab-e2e";
  try {
    await request.delete(`/api/providers/endpoints/${id}?forget_key=1`);
    const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;

    await page.goto("/settings/providers");
    await page.getByTestId("providers-add").click();
    const dlg = page.getByTestId("add-provider");
    await expect(dlg.getByTestId("provider-starts")).toContainText("Ollama");
    // Hosted starting points come from the catalog, not from code.
    await dlg.getByTestId("provider-start-search").fill("openrouter");
    await expect(dlg.locator('[data-start="openrouter"]')).toBeVisible();
    await shoot(page, "add-provider-01-starts");

    await dlg.locator('[data-start="blank"]').click();
    await dlg.getByTestId("provider-label").fill("Lab e2e");
    await expect(dlg.getByTestId("provider-id")).toHaveValue(id);
    await dlg.getByTestId("provider-base-url").fill(fake.url);
    await dlg.getByRole("radio", { name: "None" }).click();
    await dlg.getByTestId("provider-test-run").click();
    // No key: the listing step says the server wants one and where it can come from.
    const listing = dlg.locator('[data-testid="provider-test-step"][data-step="listing"]');
    await expect(listing).toHaveAttribute("data-ok", "false");
    await expect(listing).toContainText("wants a key");
    await expect(listing).toContainText("environment variable or a keyring entry");
    await shoot(page, "add-provider-02-needs-key");

    await dlg.getByRole("radio", { name: "Keyring" }).click();
    await dlg.getByTestId("provider-key-secret").fill(FAKE_KEY);
    await dlg.getByTestId("provider-test-run").click();
    // The root answers with a web page; the API was found under /v1 and is offered.
    await expect(dlg.getByTestId("provider-use-suggest")).toBeVisible();
    await dlg.getByTestId("provider-use-suggest").click();
    await expect(dlg.getByTestId("provider-base-url")).toHaveValue(`${fake.url}/v1`);
    await dlg.getByTestId("provider-test-run").click();
    await expect(dlg.locator('[data-testid="provider-test-step"][data-ok="false"]')).toHaveCount(0);
    await expect(dlg.locator('[data-testid="provider-test-step"][data-step="model"]')).toContainText(`${FAKE_MODEL} answered "OK"`);
    await expect(listing).toContainText("on vLLM");
    await shoot(page, "add-provider-03-passed");
    await dlg.getByTestId("provider-save").click();
    await expect(dlg).toHaveCount(0);

    // Saved by name only: the file names a keyring entry and holds no key.
    const saved = await (await request.get(`/api/providers/endpoints/${id}`)).json();
    expect(saved.config.key_cred).toBe(`${id}-api-key`);
    expect(JSON.stringify(saved)).not.toContain(FAKE_KEY);

    const row = page.locator(`[data-testid="provider-row"][data-provider="${id}"]`);
    await expect(row).toContainText("1 model");
    await row.getByTestId("provider-models-toggle").click();
    const m = row.locator(`[data-testid="provider-model"][data-model="${id}:${FAKE_MODEL}"]`);
    await expect(m).toContainText("33k");
    await expect(m.locator('[data-cap="tools"]')).toHaveAttribute("data-value", "unknown");
    await m.getByTestId("model-probe").click();
    await expect(m.getByTestId("model-probe-note")).toBeVisible({ timeout: 60_000 });
    for (const cap of ["tools", "images", "reasoning", "caching"]) await expect(m.locator(`[data-cap="${cap}"]`)).toHaveAttribute("data-value", "true");
    await expect(m.getByTestId("model-price")).toHaveText("no price");

    await m.getByTestId("model-edit").click();
    await m.getByTestId("model-price-input").fill("0.5");
    await m.getByTestId("model-price-output").fill("2");
    await m.getByTestId("model-editor-save").click();
    await expect(m.getByTestId("model-price")).toHaveText("$0.5 / $2");
    await shoot(page, "add-provider-04-models");

    // A session on it: the turn runs through the new endpoint and is priced.
    await page.goto("/");
    await page.getByTestId("model-picker").last().click();
    await page.getByPlaceholder("Search models").fill(FAKE_MODEL);
    await page.locator(`[data-testid="model-option"][data-model="${id}:${FAKE_MODEL}"]`).first().click();
    await page.getByTestId("composer").fill("Say hello.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("assistant-text").last()).toContainText("Hello from the lab server.");
    await expect(page.getByTestId("turn-cost").first()).toBeVisible();

    // Remove: the file and the key Keel saved go.
    await page.goto("/settings/providers");
    await page.locator(`[data-testid="provider-row"][data-provider="${id}"]`).getByTestId("provider-edit").click();
    await page.getByTestId("add-provider").getByTestId("provider-remove").click();
    await expect(page.locator(`[data-testid="provider-row"][data-provider="${id}"]`)).toHaveCount(0);
    expect((await request.get(`/api/providers/endpoints/${id}`)).status()).toBe(404);

    expect((await (await request.get("/api/errors")).json()).errors.length).toBe(errorsBefore);
  } finally {
    await request.delete(`/api/providers/endpoints/${id}?forget_key=1`);
    fake.server.close();
  }
});
