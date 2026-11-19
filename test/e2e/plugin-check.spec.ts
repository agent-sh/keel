import { expect, test } from "@playwright/test";
import { shoot } from "./shots.ts";

// Feature: the protocol v1 conformance check of a configured plugin, from
// Settings > Providers (the same runner as `keel plugin check <id>`): fake
// credentials, a fake vendor, every fixture of the spec, one row each.
test("plugin check: a configured plugin passes protocol v1", async ({ page, request }) => {
  const { plugins } = await (await request.get("/api/providers")).json();
  const plugin = plugins.find((p: any) => p.state === "ready");
  test.skip(!plugin, "no plugin is configured and ready");
  await page.goto("/settings/providers");
  const row = page.locator(`[data-testid="plugin-row"][data-plugin="${plugin.id}"]`);
  await row.getByTestId("plugin-check-run").click();
  await expect(row.getByTestId("plugin-check-summary")).toContainText("0 failed", { timeout: 120_000 });
  await expect(row.locator('[data-testid="plugin-check-row"][data-result="fail"]')).toHaveCount(0);
  await row.locator("summary").click();
  await expect(row.locator('[data-testid="plugin-check-row"]').first()).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await shoot(page, "plugin-check-01-passed");
});
