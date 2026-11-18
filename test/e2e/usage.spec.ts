import { expect, test } from "@playwright/test";
import { HAIKU, shoot } from "./shots.ts";

// Feature: Settings > Usage reads the local telemetry of a real turn: spend,
// cache hit rate, time to first token and failures as tiles, the series as
// charts with a readout under the pointer, and the tables by model and tool.
test("usage dashboard", async ({ page, request }) => {
  const s = (await (await request.post("/api/sessions", {
    data: { model: HAIKU, text: "Run `echo usage-check` with your shell tool, then write two sentences about prompt caching." },
  })).json()).session;
  await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 120_000 }).toBe(true);

  const t = await (await request.get(`/api/telemetry?session_id=${s.id}`)).json();
  expect(t.total.calls).toBeGreaterThanOrEqual(2);
  expect(t.total.latency_p50).toBeGreaterThan(0);
  expect(t.total.ttft_p50).toBeGreaterThan(0);
  expect(t.total.ttft_p50).toBeLessThanOrEqual(t.total.latency_p50);
  expect(t.total.tool_calls).toBeGreaterThanOrEqual(1);

  await page.goto("/settings/usage");
  const panel = page.getByTestId("usage-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("tile-ttft")).not.toContainText("none");
  await expect(panel.getByTestId("tile-cache")).toContainText("%");
  await expect(panel.getByTestId("usage-models")).toContainText("Haiku");
  await expect(panel.getByTestId("usage-tools").locator("tbody tr").first()).toBeVisible();
  await shoot(page, "usage-01-dashboard");

  // The readout under the pointer lists every series at that bucket.
  await page.getByRole("radio", { name: "Day" }).click();
  const chart = panel.getByTestId("chart-latency").locator("svg");
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
  await expect(panel.getByTestId("chart-tooltip")).toContainText("First token");
  await shoot(page, "usage-02-readout");

  await panel.getByTestId("usage-tools").scrollIntoViewIfNeeded();
  await shoot(page, "usage-03-tables");
  await request.delete(`/api/sessions/${s.id}`);
});
