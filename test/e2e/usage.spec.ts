import { expect, test } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

// Feature: Settings > Usage reads the local telemetry of a real turn: spend,
// cache hit rate, time to first token and failures as tiles, the series as
// charts with a readout under the pointer, cache breaks by cause, the tables
// by model and tool with a tool's last failures, and spend limits that stop a
// turn before its request.
test("usage dashboard", async ({ page, request }) => {
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const s = (await (await request.post("/api/sessions", {
    data: { model: HAIKU, text: "Run `echo usage-check` with your shell tool, then read the file /nonexistent/keel-usage-check.txt with your file reading tool, then write two sentences about prompt caching." },
  })).json()).session;
  await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 120_000 }).toBe(true);

  const t = await (await request.get(`/api/telemetry?session_id=${s.id}`)).json();
  expect(t.total.calls).toBeGreaterThanOrEqual(2);
  expect(t.total.latency_p50).toBeGreaterThan(0);
  expect(t.total.ttft_p50).toBeGreaterThan(0);
  expect(t.total.ttft_p50).toBeLessThanOrEqual(t.total.latency_p50);
  expect(t.total.tool_calls).toBeGreaterThanOrEqual(2);
  expect(t.total.tool_errors).toBeGreaterThanOrEqual(1);
  const ex = (await (await request.get(`/api/telemetry/examples?session_id=${s.id}`)).json()).examples;
  expect(ex[0].error).toBeTruthy();
  expect(ex[0].event_id).toBeTruthy();

  await page.goto("/settings/usage");
  const panel = page.getByTestId("usage-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("tile-ttft")).not.toContainText("none");
  await expect(panel.getByTestId("tile-cache")).toContainText("%");
  // A model step through its retries, beside one attempt.
  await expect(panel.getByTestId("tile-step")).toContainText("one attempt");
  await expect(panel.getByTestId("tile-step")).not.toContainText("none;");
  await expect(panel.getByTestId("cache-breaks")).not.toBeEmpty();
  await expect(panel.getByTestId("usage-models")).toContainText("Haiku");
  await shoot(page, "usage-01-dashboard");

  // The readout under the pointer lists every series at that bucket.
  await page.getByRole("radio", { name: "Day" }).click();
  const chart = panel.getByTestId("chart-latency").locator("svg");
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
  await expect(panel.getByTestId("chart-tooltip")).toContainText("First token");
  await shoot(page, "usage-02-readout");

  // A tool with failures opens its last failed calls, linked to the session.
  const failedTool = ex[0].tool;
  const failed = panel.getByTestId("usage-tools").locator("tbody tr").filter({ has: page.getByText(failedTool, { exact: true }) }).first();
  await failed.click();
  await expect(panel.getByTestId("tool-failures")).toContainText("keel-usage-check");
  await panel.getByTestId("usage-tools").scrollIntoViewIfNeeded();
  await shoot(page, "usage-03-tables");

  // A daily limit already passed: the next turn stops before its request and says why.
  await panel.getByTestId("budget-daily_usd").fill("0.000001");
  await panel.getByTestId("budget-daily_usd").press("Enter");
  await expect.poll(async () => (await (await request.get("/api/settings")).json()).settings.budget.daily_usd).toBe(0.000001);
  await panel.getByTestId("usage-budget").scrollIntoViewIfNeeded();
  await shoot(page, "usage-04-budget");
  await request.post(`/api/sessions/${s.id}/messages`, { data: { text: "Say ok." } });
  await expect.poll(async () => JSON.stringify((await (await request.get(`/api/sessions/${s.id}`)).json()).events.filter((e: any) => e.kind === "error")), { timeout: 30_000 }).toContain("daily spend limit");
  // The limit reads as what was set: a sub-cent limit is never shown as $0.00.
  expect(JSON.stringify((await (await request.get(`/api/sessions/${s.id}`)).json()).events.filter((e: any) => e.kind === "error"))).toContain("limit of $0.000001 is reached");

  await request.patch("/api/settings", { data: { budget: { daily_usd: null } } });
  await request.put("/api/permissions/settings", { data: { default_mode: prev } });
  await request.delete(`/api/sessions/${s.id}`);
  // The refusal is an error kind of its own: resolve it so later counts start clean.
  for (const e of (await (await request.get("/api/errors?resolved=0")).json()).errors) if (e.message.includes("spend limit")) await request.patch(`/api/errors/${e.id}`, { data: { resolved: true } });
});
