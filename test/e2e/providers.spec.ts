import { expect, test, type Page } from "@playwright/test";
import { shoot } from "./shots.ts";

// Feature: Settings > Providers shows every provider with its listing state and
// the plugins; one session moves between providers and model families
// (Claude on Bedrock, GPT on the ChatGPT sign-in, then a provider plugin)
// and each turn runs its tool call and shows its cost where a price is known.
const pick = async (page: Page, search: string, provider: string) => {
  await page.getByTestId("model-picker").last().click();
  await page.getByPlaceholder("Search models").fill(search);
  await page.locator(`[data-testid="model-option"][data-model^="${provider}:"]`).first().click();
  // A switch while the prompt cache is warm asks first.
  const ask = page.getByRole("alertdialog");
  if (await ask.isVisible({ timeout: 1500 }).catch(() => false)) await ask.getByRole("button", { name: "Switch" }).click();
};

test("providers and a cross-family session", async ({ page, request }) => {
  // A refresh first: a listing that keeps failing is recorded once, so the
  // refresh in the panel below adds no error.
  const providers = await (await request.post("/api/providers/refresh", { data: {}, timeout: 120_000 })).json();
  const has = (id: string) => providers.providers.some((p: any) => p.id === id && p.available && p.listing.models > 0);
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;

  await page.goto("/settings/providers");
  const panel = page.getByTestId("providers-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-provider="bedrock"]')).toContainText("models");
  await panel.getByTestId("providers-refresh").click();
  await expect(panel.getByTestId("providers-refresh")).toBeEnabled({ timeout: 120_000 });
  const plugin = providers.plugins.find((p: any) => p.state === "ready");
  if (plugin) await expect(panel.locator(`[data-plugin="${plugin.id}"]`)).toContainText("ready");
  await shoot(page, "providers-01-panel");
  await page.goto("/");

  await pick(page, "haiku 5.5", "bedrock");
  await page.getByTestId("composer").fill("Run `echo one` with the Bash tool, then reply with its output only.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
  await expect(page.getByTestId("turn-cost").first()).toBeVisible();

  let turns = 1;
  if (has("chatgpt")) {
    await pick(page, "luna", "chatgpt");
    await page.getByTestId("composer").fill("Run `echo two` with your shell tool, then reply with its output only.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(++turns, { timeout: 120_000 });
  }
  // A plugin provider's model: one whose family is not Claude, to cross a wire.
  const models = (await (await request.get("/api/models")).json()).models;
  const viaPlugin = models.find((m: any) => m.provider.includes("/") && m.family !== "claude" && !/pro|high|orchestr/i.test(m.name));
  if (viaPlugin) {
    await pick(page, viaPlugin.name, viaPlugin.provider);
    await page.getByTestId("composer").fill("Run `echo three` with your shell tool, then reply with its output only.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(++turns, { timeout: 120_000 });
  }
  await expect(page.getByTestId("assistant-text").last()).not.toBeEmpty();
  expect(await page.getByTestId("tool-call").count()).toBeGreaterThanOrEqual(turns);
  await shoot(page, "providers-02-switched");

  // The usage report prices the Bedrock calls and counts the plan calls as included.
  const sid = page.url().match(/\/s\/([\w-]+)/)![1];
  const usage = await (await request.get(`/api/usage?group=provider&session_id=${sid}`)).json();
  const bedrock = usage.buckets.find((b: any) => b.key === "bedrock");
  expect(bedrock.priced_cost_usd).toBeGreaterThan(0);
  expect(usage.total.calls).toBeGreaterThanOrEqual(turns * 2);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
