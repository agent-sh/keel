import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "./isolate.ts";
import { FAKE_KEY, FAKE_MODEL, FAKE_TEXT_MODEL, startFake } from "./fixtures/fake-endpoint.ts";
import { PAGE_ONE, PAGE_TWO, startPaged } from "./fixtures/paged-endpoint.ts";
import { shoot, choose } from "./shots.ts";

// Feature: adding a provider by hand in Settings > Providers. A stand-in
// OpenAI-compatible server that wants a key and keeps its API under /v1: the
// test says what to fix at each step (a key, then the /v1), finding the models
// asks no model anything and reads the listing once, asking a model is an
// action of its own, the key typed in goes to the keyring and never into the
// endpoint file, the probe finds what
// the model can do, a price set by hand prices it, and a session runs a turn
// on it. Removing it takes its file and its saved key.
test("add an OpenAI-compatible endpoint, test it, probe it, price it, use it", async ({ page, request }) => {
  const need = await (await request.get("/api/providers/setup")).json();
  test.skip(!need.hosted.some((t: any) => t.id === "openrouter"), "needs the models.dev catalog (its hosted starting points), and this daemon has none: no network");
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
    const listed = fake.listings.n;
    await dlg.getByTestId("provider-test-run").click();
    await expect(listing).toContainText("on vLLM");
    await expect(dlg.locator('[data-testid="provider-test-step"][data-ok="false"]')).toHaveCount(0);
    // The models were found with one read of the listing and no request to a model.
    const asked = dlg.locator('[data-testid="provider-test-step"][data-step="model"]');
    await expect(asked).toHaveCount(0);
    expect(fake.listings.n).toBe(listed + 1);
    expect(fake.requests).toEqual([]);
    await shoot(page, "add-provider-03-passed");
    // Asking the model picked is the owner's own action.
    await expect(dlg.getByTestId("provider-test-model")).toHaveAttribute("data-value", FAKE_MODEL);
    await dlg.getByTestId("provider-test-model-run").click();
    await expect(asked).toContainText(`${FAKE_MODEL} answered "OK"`);
    expect(fake.requests).toEqual([{ model: FAKE_MODEL, tools: 0 }]);
    expect(fake.listings.n).toBe(listed + 1);
    await shoot(page, "add-provider-03-model-asked");
    await dlg.getByTestId("provider-save").click();
    // A machine with no system keyring (a clean scratch environment has none)
    // cannot keep the key: the form says so, stays open, and nothing is saved.
    // The rest of the feature needs the saved endpoint and is not run there.
    if (!(await (await request.get("/api/providers/setup")).json()).keyring.ready) {
      await expect(dlg).toContainText("the keyring did not take the key");
      await expect(dlg).toContainText("This machine has no system keyring: use a variable instead.");
      expect((await request.get(`/api/providers/endpoints/${id}`)).status()).toBe(404);
      await shoot(page, "add-provider-03-no-keyring");
      test.skip(true, "this machine has no system keyring: the refusal was checked, the saved endpoint's steps (probe, price, a turn, removal) were not");
    }
    await expect(dlg).toHaveCount(0);

    // Saved by name only: the file names a keyring entry and holds no key.
    const saved = await (await request.get(`/api/providers/endpoints/${id}`)).json();
    expect(saved.config.key_cred).toBe(`${id}-api-key`);
    expect(JSON.stringify(saved)).not.toContain(FAKE_KEY);

    const row = page.locator(`[data-testid="provider-row"][data-provider="${id}"]`);
    await expect(row).toContainText("2 models");
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

    // A model the probe finds without tools is sent none, and the composer says so; the owner's word wins.
    await page.goto("/settings/providers");
    await page.locator(`[data-testid="provider-row"][data-provider="${id}"]`).getByTestId("provider-models-toggle").click();
    const t = page.locator(`[data-testid="provider-model"][data-model="${id}:${FAKE_TEXT_MODEL}"]`);
    await t.getByTestId("model-probe").click();
    await expect(t.locator('[data-cap="tools"]')).toHaveAttribute("data-value", "false", { timeout: 60_000 });
    await page.goto("/");
    await page.getByTestId("model-picker").last().click();
    await page.getByPlaceholder("Search models").fill(FAKE_TEXT_MODEL);
    await page.locator(`[data-testid="model-option"][data-model="${id}:${FAKE_TEXT_MODEL}"]`).first().click();
    await expect(page.getByTestId("model-no-tools")).toContainText("cannot use tools (the probe found it)");
    await shoot(page, "add-provider-05-no-tools");
    const sent = fake.requests.length;
    await page.getByTestId("composer").fill("Say hello.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("assistant-text").last()).toContainText("Hello from the lab server.", { timeout: 60_000 });
    expect(fake.requests.slice(sent).filter((r) => r.model === FAKE_TEXT_MODEL).map((r) => r.tools)).toEqual([0]);
    const session = page.url().split("/s/")[1]!;
    await page.goto("/settings/providers");
    await page.locator(`[data-testid="provider-row"][data-provider="${id}"]`).getByTestId("provider-models-toggle").click();
    await t.getByTestId("model-edit").click();
    await choose(t.getByTestId("model-tools"), "true");
    await t.getByTestId("model-editor-save").click();
    await expect(t.locator('[data-cap="tools"]')).toHaveAttribute("data-value", "true");
    await page.goto(`/s/${session}`);
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.getByTestId("model-no-tools")).toHaveCount(0);
    const again = fake.requests.length;
    await page.getByTestId("composer").fill("Say hello again.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 60_000 });
    expect(fake.requests.slice(again).filter((r) => r.model === FAKE_TEXT_MODEL).every((r) => r.tools > 0)).toBe(true);

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

// An endpoint of the owner's providers.toml is read only in the UI until it is
// moved to a file of its own: the entry goes there with its comments, and
// providers.toml keeps it as comments under a note, the rest untouched.
test("a providers.toml endpoint moves to its own file and becomes editable", async ({ page, request }) => {
  const fake = await startFake();
  const id = "lab-toml-e2e";
  // dev.sh keeps the scratch config folder beside the state folder.
  const { state_dir } = await (await request.get("/api/daemon")).json();
  const cfg = join(dirname(state_dir), "config");
  const toml = join(cfg, "providers.toml");
  const before = existsSync(toml) ? readFileSync(toml, "utf8") : null;
  const mine = `# Owner's note: keep this one local\n[[endpoint]]\nid = "${id}"\n# the bench box\nlabel = "Lab toml"\nbase_url = "${fake.url}/v1"\nkey_env = "LAB_TOML_KEY"\n`;
  try {
    rmSync(join(cfg, "endpoints", `${id}.toml`), { force: true });
    writeFileSync(toml, (before ?? "") + "\n" + mine);
    await request.post("/api/providers/refresh", { data: {}, timeout: 60_000 });
    await page.goto("/settings/providers");
    const row = page.locator(`[data-testid="provider-row"][data-provider="${id}"]`);
    await expect(row).toContainText("providers.toml");
    await expect(row.getByTestId("provider-edit")).toHaveCount(0);
    await row.scrollIntoViewIfNeeded();
    await shoot(page, "add-provider-06-toml-entry");
    await row.getByTestId("provider-move-out").click();
    await expect(row.getByTestId("provider-edit")).toBeVisible();
    await expect(row.getByTestId("provider-move-out")).toHaveCount(0);
    const own = readFileSync(join(cfg, "endpoints", `${id}.toml`), "utf8");
    expect(own).toContain("# the bench box");
    expect(own).toContain(`base_url = "${fake.url}/v1"`);
    const left = readFileSync(toml, "utf8");
    expect(left).toContain(`# Moved to endpoints/${id}.toml`);
    expect(left).toContain("# Owner's note: keep this one local");
    expect(left).toContain(`# id = "${id}"`);
    if (before) expect(left.startsWith(before)).toBe(true);
    await row.scrollIntoViewIfNeeded();
    await shoot(page, "add-provider-07-moved");
  } finally {
    await request.delete(`/api/providers/endpoints/${id}`);
    if (before === null) rmSync(toml, { force: true }); else writeFileSync(toml, before);
    fake.server.close();
  }
});

// An Anthropic-style and a Gemini-style endpoint whose listing has two pages:
// the second page's model is offered in the picker and by `keel models`. A
// listing whose pages never end fails and says so, and the pages read are
// not taken for the whole list.
test("a listing in pages is read to its end, and one that never ends is an error", async ({ page, request, baseURL }) => {
  const wires = [["anthropic", "anthropic_messages"], ["gemini", "gemini_generate_content"]] as const;
  const fakes = await Promise.all(wires.map(([w]) => startPaged(w)));
  const loop = await startPaged("anthropic", { loop: true });
  const ids = [...wires.map(([w]) => `lab-paged-${w}`), "lab-paged-loop"];
  try {
    for (const id of ids) await request.delete(`/api/providers/endpoints/${id}`);
    for (const [i, [, wire]] of wires.entries()) {
      const r = await request.put(`/api/providers/endpoints/${ids[i]}`, { data: { config: { label: `Lab paged ${wires[i]![0]}`, wire, base_url: fakes[i]!.url, auth: "none" } } });
      expect((await r.json()).listing.models.map((m: any) => m.model)).toEqual([PAGE_ONE, PAGE_TWO]);
      expect(fakes[i]!.listings.length).toBe(2);
    }
    await page.goto("/");
    await page.getByTestId("model-picker").last().click();
    await page.getByPlaceholder("Search models").fill(PAGE_TWO);
    for (const id of ids.slice(0, 2)) await expect(page.locator(`[data-testid="model-option"][data-model="${id}:${PAGE_TWO}"]`).first()).toBeVisible();
    await shoot(page, "add-provider-08-page-two");
    await page.keyboard.press("Escape");
    const cli = spawnSync("bun", [join(import.meta.dirname, "../../src/main.ts"), "models", "--url", baseURL!], { encoding: "utf8" });
    for (const id of ids.slice(0, 2)) expect(cli.stdout).toContain(`${id}:${PAGE_TWO}`);

    const r = await (await request.put(`/api/providers/endpoints/${ids[2]}`, { data: { config: { label: "Lab paged loop", wire: "anthropic_messages", base_url: loop.url, auth: "none" } } })).json();
    expect(r.listing.state).toBe("failed");
    expect(r.listing.error).toContain("the model listing does not end (page 2 names a page cursor it gave before)");
    expect(r.listing.models).toEqual([]);
    expect(loop.listings.length).toBe(2);
    await page.goto("/settings/providers");
    const row = page.locator(`[data-testid="provider-row"][data-provider="${ids[2]}"]`);
    await expect(row.getByTestId("listing-error")).toContainText("does not end");
    await row.scrollIntoViewIfNeeded();
    await shoot(page, "add-provider-09-pages-never-end");
  } finally {
    for (const id of ids) await request.delete(`/api/providers/endpoints/${id}`);
    for (const f of [...fakes, loop]) f.server.close();
  }
});

// An endpoint saved with listing = false has no /models to ask: its catalog
// section names its models. Its connection test offers the same models as the
// saved endpoint does, and never asks the server for a listing.
test("an endpoint with no listing offers its catalog section's models, tested or saved", async ({ page, request }) => {
  const fake = await startFake();
  const id = "lab-nolist-e2e";
  try {
    await request.delete(`/api/providers/endpoints/${id}`);
    const setup = await (await request.get("/api/providers/setup")).json();
    const hosted = setup.hosted.find((t: any) => t.models > 0);
    test.skip(!hosted, "needs the models.dev catalog (a hosted starting point with models), and this daemon has none: no network");
    const section = hosted.catalog as string;
    const config = { label: "Lab no listing", base_url: `${fake.url}/v1`, auth: "none", catalog: section, listing: false };
    const draft = await (await request.post("/api/providers/test", { data: { config: { id, ...config } } })).json();
    expect(draft.steps.map((s: any) => [s.id, s.ok])).toEqual([["address", true], ["key", true], ["listing", true]]);
    expect(draft.models.length).toBeGreaterThan(0);
    const saved = await (await request.put(`/api/providers/endpoints/${id}`, { data: { config } })).json();
    expect(draft.models.map((m: any) => m.model)).toEqual(saved.listing.models.map((m: any) => m.model));

    await page.goto("/settings/providers");
    await page.locator(`[data-testid="provider-row"][data-provider="${id}"]`).getByTestId("provider-edit").click();
    const dlg = page.getByTestId("add-provider");
    await dlg.getByTestId("provider-test-run").click();
    await expect(dlg.locator('[data-testid="provider-test-step"][data-step="listing"]')).toContainText(`${draft.models.length} models of the catalog section ${section}`);
    await expect(dlg.getByTestId("provider-test-model")).toHaveAttribute("data-value", draft.models[0].model);
    await shoot(page, "add-provider-10-no-listing");
    expect(fake.listings.n).toBe(0);
    expect(fake.requests).toEqual([]);
  } finally {
    await request.delete(`/api/providers/endpoints/${id}`);
    fake.server.close();
  }
});

// Find running servers: a server found at the address of an endpoint that is
// already set up opens that endpoint's own settings, whatever its id is; one
// that is not set up opens a new form filled in from its template. The scan's
// answer is given here (what answers at the default local ports is the
// machine's own business); the endpoint it names is a real one.
test("a found server that is set up opens its own settings, another a new form", async ({ page, request }) => {
  const fake = await startFake();
  const id = "lab-found-custom";
  try {
    await request.delete(`/api/providers/endpoints/${id}?forget_key=1`);
    // Saved without a key: which form opens does not depend on one, and a machine with no keyring could not keep it.
    expect((await request.put(`/api/providers/endpoints/${id}`, { data: { config: { label: "Lab found", base_url: `${fake.url}/v1` } } })).ok()).toBe(true);
    await page.route("**/api/providers/scan", (route) => route.fulfill({ json: { found: [
      { template: "vllm", label: "vLLM", base_url: `${fake.url}/v1`, models: [FAKE_MODEL, FAKE_TEXT_MODEL], configured: id },
      { template: "ollama", label: "Ollama", base_url: "http://127.0.0.1:11434/v1", models: ["one"] },
    ] } }));
    await page.goto("/settings/providers");
    await page.getByTestId("providers-add").click();
    const dlg = page.getByTestId("add-provider");
    await dlg.getByTestId("provider-scan").click();
    const setUp = dlg.getByTestId("provider-start").filter({ hasText: `set up as ${id}` });
    const fresh = dlg.getByTestId("provider-start").filter({ hasText: "1 model running" });
    await expect(setUp).toHaveCount(1);
    await expect(fresh).toHaveCount(1);
    await shoot(page, "add-provider-11-found");

    // Not set up: a new form from the template, at the address found.
    await fresh.click();
    await expect(dlg.getByTestId("provider-base-url")).toHaveValue("http://127.0.0.1:11434/v1");
    await expect(dlg.getByTestId("provider-id")).toBeEnabled();
    await expect(dlg.getByTestId("provider-id")).toHaveValue(/^ollama/);
    await expect(dlg.getByTestId("provider-label")).toHaveValue("Ollama");

    // Set up under an id of its own: that endpoint's settings, not a new vLLM form.
    await setUp.click();
    await expect(dlg).toContainText(`Edit ${id}`);
    await expect(dlg.getByTestId("provider-id")).toHaveValue(id);
    await expect(dlg.getByTestId("provider-id")).toBeDisabled();
    await expect(dlg.getByTestId("provider-label")).toHaveValue("Lab found");
    await expect(dlg.getByTestId("provider-base-url")).toHaveValue(`${fake.url}/v1`);
    await shoot(page, "add-provider-12-found-opens-its-settings");
  } finally {
    await request.delete(`/api/providers/endpoints/${id}?forget_key=1`);
    fake.server.close();
  }
});
