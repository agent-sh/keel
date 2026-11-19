import { expect, test, type APIRequestContext } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

// Feature: Settings > Usage beyond the overview. Token zones: each request's
// prompt split into tools, system, frozen history and volatile tail with how
// the cache served each, in total, over time and per turn. Errors: failures by
// class per provider and model, over time (the scripted provider plays a 429, a
// 529, a dropped stream, a refusal and a request too long). Compactions: each
// one with its trigger, the context before and after, what it kept, its cost
// and the cache of the requests after it. Compare: two ranges or two models.
const STAND_IN = "scripted:stand-in";

const ended = (request: APIRequestContext, id: string, n: number) =>
  expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 120_000 }).toBeGreaterThanOrEqual(n);

test("usage views: token zones, error classes, compactions, compare", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");

  // A real model, two turns: the second reads the first's prefix from the cache.
  const real = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Zones check", text: "Name three prime numbers. One line." } })).json()).session;
  await ended(request, real.id, 1);
  await request.post(`/api/sessions/${real.id}/messages`, { data: { text: "Now three more. One line." } });
  await ended(request, real.id, 2);
  // Then the owner compacts it: a summary request, and the next turn after it.
  expect((await request.post(`/api/sessions/${real.id}/compact`, { data: {} })).status()).toBeLessThan(300);
  await request.post(`/api/sessions/${real.id}/messages`, { data: { text: "And one more prime. One word." } });
  await ended(request, real.id, 3);

  // The scripted stand-in fails in each way once (each is retried or ends the turn).
  const fail = (await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Failures check" } })).json()).session;
  let n = 0;
  for (const s of ["rate-limit", "overloaded", "drop", "refuse", "overflow"]) {
    await request.post(`/api/sessions/${fail.id}/messages`, { data: { text: `script:${s}` } });
    await ended(request, fail.id, ++n);
  }

  // The API: zones add up to what the provider counted; the classes are named.
  const tok = await (await request.get(`/api/telemetry/tokens?session_id=${real.id}`)).json();
  expect(tok.turns.length).toBeGreaterThanOrEqual(3);
  const second = tok.turns[1].per_request[0].zones;
  expect(second.history.tokens).toBeGreaterThan(0);
  expect(second.tools.read + second.system.read).toBeGreaterThan(0);
  const t = await (await request.get(`/api/telemetry?session_id=${fail.id}`)).json();
  const classes = t.error_classes.map((e: any) => e.class);
  for (const c of ["rate_limit", "overloaded", "stream_drop", "refusal", "context_overflow"]) expect(classes).toContain(c);
  const comp = (await (await request.get(`/api/telemetry/compactions?session_id=${real.id}`)).json()).compactions;
  expect(comp[0].trigger).toBe("owner");
  expect(comp[0].tokens_after).toBeGreaterThan(0);
  expect(comp[0].cache.after.length).toBeGreaterThanOrEqual(1);

  await page.goto("/settings/usage");
  const panel = page.getByTestId("usage-panel");
  await panel.getByRole("radio", { name: "Token zones" }).click();
  await expect(panel.getByTestId("zones-total")).toContainText("Frozen history");
  await panel.getByTestId("zones-session").selectOption(real.id);
  await expect(panel.getByTestId("zones-turn")).toHaveCount(tok.turns.length);
  await shoot(page, "usage-views-01-zones");
  await panel.getByTestId("zones-turns").scrollIntoViewIfNeeded();
  await shoot(page, "usage-views-02-zones-turns");

  await panel.getByRole("radio", { name: "Errors" }).click();
  const byModel = panel.getByTestId("errors-classes");
  for (const label of ["Rate limited", "Overloaded", "Stream dropped", "Refused", "Context overflow"]) await expect(byModel).toContainText(label);
  await expect(panel.getByTestId("errors-chart").locator("svg")).toBeVisible();
  await shoot(page, "usage-views-03-errors");

  await panel.getByRole("radio", { name: "Compactions" }).click();
  const list = panel.getByTestId("compactions-list");
  const row = list.locator("tbody tr").filter({ hasText: "Zones check" }).first();
  await expect(row).toContainText("asked for");
  await row.click();
  await expect(panel.getByTestId("compaction-detail")).toContainText("Request 1 after");
  await shoot(page, "usage-views-04-compactions");

  await panel.getByRole("radio", { name: "Compare" }).click();
  await expect(panel.getByTestId("compare-table")).toContainText("First token, median");
  await panel.getByRole("radio", { name: "Two models" }).click();
  await panel.getByTestId("compare-model-a").selectOption(HAIKU);
  await panel.getByTestId("compare-model-b").selectOption(STAND_IN);
  await expect(panel.getByTestId("compare-table")).toContainText("Rate limited");
  await shoot(page, "usage-views-05-compare");

  for (const s of [real, fail]) await request.delete(`/api/sessions/${s.id}`);
});
