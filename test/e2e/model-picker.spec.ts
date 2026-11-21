import { createServer } from "node:http";
import { expect, test, type APIRequestContext, type Locator } from "./isolate.ts";
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

// Two stand-in OpenAI-compatible servers with long, alike names: providers
// whose labels differ in their last word, models whose ids differ in their
// last letter.
const LAB_MODELS = "abcdefgh".split("").map((x) => `laboratory/long-context-instruct-preview-quantized-${x}`);
async function withLab(request: APIRequestContext, run: () => Promise<void>) {
  const server = createServer((req, res) => {
    res.writeHead(req.url?.startsWith("/v1/models") ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: LAB_MODELS.map((id) => ({ id, object: "model", owned_by: "lab", max_model_len: 131072 })) }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const labs = [["lab-east", "Laboratory inference cluster east"], ["lab-west", "Laboratory inference cluster west"]] as const;
  try {
    for (const [id, label] of labs) expect((await request.put(`/api/providers/endpoints/${id}`, { data: { config: { label, base_url: url } } })).ok()).toBe(true);
    await run();
  } finally {
    for (const [id] of labs) {
      await request.post("/api/providers/choices", { data: { unpin: LAB_MODELS.map((m) => `${id}:${m}`), provider: id, show: LAB_MODELS } });
      await request.delete(`/api/providers/endpoints/${id}`);
    }
    server.close();
  }
}
// Every name in the list is shown whole: nothing is cut off at its end.
const whole = (names: Locator) => names.evaluateAll((els) => els.every((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight));

// Long names stay apart in the chooser at its full width: a name too long for
// its row goes on to a second line instead of losing its end.
test("model picker: long names are shown whole", async ({ page, request }) => {
  await withLab(request, async () => {
    await page.goto("/");
    const popup = page.getByTestId("model-popup");
    await page.getByTestId("model-picker").click();
    await page.getByPlaceholder("Search models").fill("preview-quantized");
    await expect(popup.getByTestId("model-option")).toHaveCount(2 * LAB_MODELS.length);
    expect(await whole(popup.getByTestId("model-name"))).toBe(true);
    await expect(popup.getByTestId("model-group-label")).toHaveText(["Laboratory inference cluster east", "Laboratory inference cluster west"]);
    expect(await whole(popup.getByTestId("model-group-label"))).toBe(true);
    await expect(popup.getByTestId("model-option").first()).toContainText(`${LAB_MODELS[0]}`);
    await shoot(page, "picker-04-long-names");

    // Under Recent a row names its provider beside the model: a long label
    // gives way on one line, whole in its title, before the name loses room.
    await page.keyboard.press("Escape");
    await page.evaluate((id) => localStorage.setItem("keel.recentModels", JSON.stringify([id])), `lab-east:${LAB_MODELS[0]}`);
    await page.reload();
    await page.getByTestId("model-picker").click();
    const recent = popup.locator(`[data-group="recent"] [data-model="lab-east:${LAB_MODELS[0]}"]`);
    const label = recent.getByTestId("model-provider");
    await expect(label).toHaveAttribute("title", "Laboratory inference cluster east");
    expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth && el.getBoundingClientRect().height < 2 * parseFloat(getComputedStyle(el).lineHeight))).toBe(true);
    expect(await whole(recent.getByTestId("model-name"))).toBe(true);
    expect(await recent.getByTestId("model-name").evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)))).toBeLessThanOrEqual(2);
    await shoot(page, "picker-08-long-provider-label");
    await page.evaluate(() => localStorage.removeItem("keel.recentModels"));
  });
});

// A small phone at the largest text size: the chooser fits the screen with
// the search field in view, only the results scroll, names and providers are
// shown whole, and the last result's actions answer a tap.
test.describe("on a small phone", () => {
  test.use({ viewport: { width: 320, height: 480 }, hasTouch: true, isMobile: true });
  test("model picker: fits, scrolls its results only, acts by touch", async ({ page, request }) => {
    await page.addInitScript(() => { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("keel.textScale", "1.5"); } });
    const { session } = await (await request.post("/api/sessions", { data: { title: "Chooser on a phone" } })).json();
    await withLab(request, async () => {
      await page.goto(`/s/${session.id}`);
      const popup = page.getByTestId("model-popup");
      const search = page.getByPlaceholder("Search models");
      const list = popup.getByRole("listbox");
      const fits = async () => {
        const box = (await popup.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(320);
        expect(box.y + box.height).toBeLessThanOrEqual(480);
        await expect(search).toBeInViewport({ ratio: 1 });
        await expect(page.getByTestId("model-count")).toBeInViewport({ ratio: 1 });
      };
      await page.locator(`[data-station="${session.id}"]`).getByTestId("model-picker").tap();
      await expect(popup).toBeVisible();
      await fits();
      // A full list takes the sheet down to the window's bottom edge.
      await expect.poll(async () => { const b = (await popup.boundingBox())!; return b.y + b.height; }).toBeGreaterThanOrEqual(479);
      await shoot(page, "picker-05-phone");

      // The results have at least half of the window, and only they scroll: the popup itself has nothing more below.
      expect(await list.evaluate((el) => el.clientHeight)).toBeGreaterThanOrEqual(240);
      expect(await popup.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await fits();
      // A group label held at the top of the results sits on their edge: no row shows above it.
      expect(await list.evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const held = [...el.querySelectorAll('[data-testid="model-group"]')].map((g) => g.firstElementChild!.getBoundingClientRect()).filter((r) => r.top < top + 8 && r.bottom > top);
        return held.length === 1 && Math.abs(held[0]!.top - top) < 1;
      })).toBe(true);

      // Alike names from alike providers, whole.
      await search.fill("preview-quantized");
      await expect(popup.getByTestId("model-option")).toHaveCount(2 * LAB_MODELS.length);
      expect(await whole(popup.getByTestId("model-name"))).toBe(true);
      expect(await whole(popup.getByTestId("model-group-label"))).toBe(true);
      await fits();
      await shoot(page, "picker-06-phone-long-names");

      // The last result: its star and its hide are on the screen, large enough for a finger.
      const last = popup.getByTestId("model-option").last();
      const id = (await last.getAttribute("data-model"))!;
      const [provider, model] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
      const reach = async (action: Locator) => {
        await action.scrollIntoViewIfNeeded();
        await expect(action).toBeInViewport({ ratio: 1 });
        await expect(action).toHaveCSS("opacity", "1");
        const box = (await action.boundingBox())!;
        expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
        await fits();
      };
      await reach(last.getByTestId("pin-model"));
      await Promise.all([page.waitForResponse("**/api/providers/choices"), last.getByTestId("pin-model").tap()]);
      await search.fill("");
      const favorite = popup.locator(`[data-group="favorites"] [data-model="${id}"]`);
      await expect(favorite).toBeVisible();
      // Under Favorites a row names its provider, whole as well.
      await expect(favorite.getByTestId("model-provider")).toHaveText("Laboratory inference cluster west");
      expect(await whole(favorite.getByTestId("model-provider"))).toBe(true);
      expect(await whole(favorite.getByTestId("model-name"))).toBe(true);
      await search.fill(model);
      const row = popup.locator(`[data-testid="model-option"][data-model="${id}"]`).last();
      await reach(row.getByTestId("hide-model"));
      await Promise.all([page.waitForResponse("**/api/providers/choices"), row.getByTestId("hide-model").tap()]);
      const hidden = popup.locator(`[data-group="hidden"] [data-model="${id}"]`);
      await expect(hidden).toBeVisible();
      await reach(hidden.getByTestId("show-model"));
      await shoot(page, "picker-07-phone-hidden");
      await Promise.all([page.waitForResponse("**/api/providers/choices"), hidden.getByTestId("show-model").tap()]);
      await expect(hidden).toHaveCount(0);
      await expect(popup.locator(`[data-model="${id}"]`).first()).toBeVisible();
      expect((await (await request.get("/api/models")).json()).models.find((m: any) => m.id === id && m.provider === provider).hidden).toBeFalsy();

      // At the smallest text size an action is still a finger wide.
      await page.evaluate(() => localStorage.setItem("keel.textScale", "0.9"));
      await page.reload();
      await page.locator(`[data-station="${session.id}"]`).getByTestId("model-picker").tap();
      // (Read once the sheet has finished opening: it grows into place.)
      await expect.poll(async () => { const b = (await popup.getByTestId("pin-model").first().boundingBox())!; return Math.min(b.width, b.height); }).toBeGreaterThanOrEqual(44);
      // A tap beside the sheet closes it.
      await page.touchscreen.tap(4, 200);
      await expect(popup).toBeHidden();

      // A wider phone or a small tablet: the sheet stands in the middle of the window.
      await page.setViewportSize({ width: 700, height: 600 });
      await page.locator(`[data-station="${session.id}"]`).getByTestId("model-picker").tap();
      await expect(popup).toBeVisible();
      await expect.poll(async () => { const b = (await popup.boundingBox())!; return Math.abs(b.x + b.width / 2 - 350); }).toBeLessThan(2);
      expect((await popup.boundingBox())!.width).toBeLessThan(600);
      await shoot(page, "picker-09-sheet-700");
    });
    await request.delete(`/api/sessions/${session.id}`);
  });
});
