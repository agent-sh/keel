import { expect, test } from "./isolate.ts";
import { shoot, WORKBENCH } from "./shots.ts";

// Feature: what shapes the agent (instructions, rulings, lessons, skills, commands, agents, plugins,
// hooks, MCP servers, language servers, importing a setup) is one Customize page, opened from the
// sidebar footer and the palette, on the same frame as Settings. Settings keeps the rest, so its rail
// fits the window at rest. An old settings link to one of the eleven lands on its Customize place, and
// a search in Settings finds a Customize section and opens it there. On a phone it is a list, as
// Settings is.
const SECTIONS = ["instructions", "rulings", "lessons", "skills", "commands", "agents", "plugins", "hooks", "mcp", "lsp", "port"];
test.use({ storageState: WORKBENCH, viewport: { width: 1920, height: 1040 } });

test("Settings keeps its rail in the window and Customize holds the eleven sections", async ({ page }) => {
  await page.goto("/settings/general");
  await expect(page.getByTestId("settings-title")).toHaveText("General");
  // The rail at rest shows every section it holds without a scroll of its own.
  const rail = page.locator(".k-settings-rail");
  await expect.poll(() => rail.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(0);
  const settings = page.getByRole("navigation", { name: "Settings sections" });
  for (const id of SECTIONS) await expect(settings.locator(`button[data-section="${id}"]`), id).toHaveCount(0);
  await shoot(page, "customize-1-settings-rail");

  // Customize opens from the footer, beside Settings.
  const button = page.getByTestId("customize-button");
  await expect(button).toBeVisible();
  await button.click();
  await expect(page).toHaveURL(/\/customize\/instructions$/);
  await expect(page.getByTestId("settings-title")).toHaveText("Instructions");
  const nav = page.getByRole("navigation", { name: "Customize sections" });
  await expect(nav.locator("button[data-section]")).toHaveCount(11);
  expect(await nav.locator("button[data-section]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.section))).toEqual(SECTIONS);
  await expect(button).toHaveAttribute("aria-current", "page");
  await expect.poll(() => rail.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(0);
  await shoot(page, "customize-2-page");
  await page.setViewportSize({ width: 1366, height: 768 });
  await shoot(page, "customize-2b-page-1366");
  await page.setViewportSize({ width: 1920, height: 1040 });
  await nav.locator('button[data-section="hooks"]').click();
  await expect(page).toHaveURL(/\/customize\/hooks$/);
  await expect(page.getByTestId("settings-title")).toHaveText("Hooks");
  await expect(nav.locator('button[data-section="hooks"]')).toHaveAttribute("aria-current", "page");
});

test("the palette opens Customize and each of its sections by name", async ({ page }) => {
  await page.goto("/settings/general");
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("customize");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/customize\/instructions$/);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("customize language servers");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/customize\/lsp$/);
  await expect(page.getByTestId("settings-title")).toHaveText("Language servers");
});

test("old settings links to a Customize section land on it, and Settings search opens it there", async ({ page }) => {
  await page.goto("/customize/skills");
  await expect(page).toHaveURL(/\/customize\/skills$/);
  await expect(page.getByTestId("settings-title")).toHaveText("Skills");
  await page.goto("/customize/mcp");
  await expect(page.getByTestId("settings-title")).toHaveText("MCP servers");
  await page.goto("/settings/general");
  await expect(page.getByTestId("settings-title")).toHaveText("General");
  await page.getByPlaceholder("Find a setting").fill("slash commands");
  const hit = page.getByRole("navigation", { name: "Settings sections" }).locator('button[data-section="commands"]');
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page).toHaveURL(/\/customize\/commands$/);
  await expect(page.getByTestId("settings-title")).toHaveText("Commands");
});

test("on a phone Customize is a list of its sections, as Settings is", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/customize/skills");
  await expect(page.getByTestId("settings-title")).toHaveText("Skills");
  await shoot(page, "customize-3-phone");
  await page.getByTestId("settings-jump").click();
  const ids = await page.locator("[data-section]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.section));
  expect(ids).toEqual(SECTIONS);
  await shoot(page, "customize-4-phone-list");
  await page.locator('button[data-section="plugins"]').click();
  await expect(page).toHaveURL(/\/customize\/plugins$/);
  await expect(page.getByTestId("settings-title")).toHaveText("Plugins");
});

// Every page of Settings and Customize is headed in the UI face; a page opens on its controls, with the
// explanation of a long row behind a help mark, and the pages of rows share one width.
test("Settings and Customize share one heading face and one width, and open on their controls", async ({ page }) => {
  const face = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).fontFamily.split(",")[0]!.replace(/["']/g, "").trim());
  const body = () => page.locator(".k-settings-body").evaluate((el) => Math.round(el.getBoundingClientRect().width));
  const widths: Record<string, number> = {};
  for (const path of ["settings/models", "settings/providers", "settings/usage", "customize/agents", "customize/hooks"]) {
    await page.goto(`/${path}`);
    await expect(page.getByTestId("settings-title")).toBeVisible();
    const ui = await face(".k-settings-nav > button");
    expect(ui, "the UI face").toMatch(/Plex Sans/);
    expect(await face("[data-testid=settings-title]"), `${path} title`).toBe(ui);
    expect(await face(".k-settings .k-surface-title"), `${path} bar`).toBe(ui);
    widths[path] = await body();
  }
  expect(widths["settings/models"], "Models and Providers are one width").toBe(widths["settings/providers"]);
  // One width for every page of both, a form or a table or a reader: General does not stand in a narrower column than Customize.
  expect([...new Set(Object.values(widths))], `widths ${JSON.stringify(widths)}`).toHaveLength(1);
  // The names of a page and a panel are in the text face, a heading, not the instrument face.
  await page.goto("/");
  const startTitle = page.locator(".k-pane-title", { hasText: "Start a session" }).first();
  await expect(startTitle).toBeVisible();
  expect(await startTitle.evaluate((el) => getComputedStyle(el).fontFamily), "Start a session").toMatch(/Plex Sans/);
  // A label over the box is told by its place: a regular weight, smaller than the words typed under it.
  expect(await startTitle.evaluate((el) => [getComputedStyle(el).fontWeight, parseFloat(getComputedStyle(el).fontSize) < parseFloat(getComputedStyle(document.querySelector('[data-testid="composer"]')!).fontSize)]), "a quiet label").toEqual(["400", true]);
  await page.getByTestId("errors-button").click();
  expect(await page.getByTestId("errors-panel").locator(".k-surface-title").evaluate((el) => getComputedStyle(el).fontFamily), "a panel's title").toMatch(/Plex Sans/);
  await page.keyboard.press("Escape");
  await page.goto("/customize/agents");
  await expect(page.getByTestId("reader-title").first()).toBeVisible();
  expect(await face("[data-testid=reader-title]")).toBe(await face(".k-settings-nav > button"));

  // Models opens on its control with one short line a row; the long words are behind a help mark.
  await page.goto("/settings/models");
  const rows = page.locator(".k-setting");
  await expect(page.getByTestId("read-through-sessions-row")).toBeVisible();
  for (const hint of await rows.locator(".text-muted").allInnerTexts()) expect(hint.length, hint).toBeLessThan(110);
  const marks = page.getByTestId("set-help");
  expect(await marks.count()).toBeGreaterThanOrEqual(3);
  await marks.first().click();
  await expect(page.getByTestId("set-help-text")).toContainText("reads the cached conversation again");
  await shoot(page, "settings-heading-1-models-help");
  await page.keyboard.press("Escape");

  // Usage: the controls first, the note behind a mark instead of a 12px line.
  await page.goto("/settings/usage");
  await expect(page.getByTestId("usage-panel")).toBeVisible();
  await expect(page.getByText("Measured on this machine")).toHaveCount(0);
  await page.getByTestId("usage-panel").getByTestId("set-help").first().click();
  await expect(page.getByTestId("set-help-text")).toContainText("Measured on this machine");
  await shoot(page, "settings-heading-2-usage");
});
