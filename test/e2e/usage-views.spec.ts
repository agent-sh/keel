import { expect, test, type APIRequestContext } from "./isolate.ts";
import { HAIKU, shoot, choose } from "./shots.ts";

// Feature: Settings > Usage beyond the overview. Token zones: each request's
// prompt split into tools, system, frozen history and volatile tail with how
// the cache served each, in total, over time and per turn. Errors: failures by
// class per provider and model, over time (the scripted provider plays a 429, a
// 529, a dropped stream, a refusal and a request too long). Compactions: each
// one with its trigger, the context before and after, what it kept, its cost
// and the cache of the requests after it. Compare: two ranges or two models.
const STAND_IN = "scripted:stand-in";
// The model the zones and the compaction are measured on: on a scripted run
// the backup stand-in, so the comparison still has two models.
const REAL = HAIKU === STAND_IN ? "scripted:stand-in-backup" : HAIKU;

const ended = (request: APIRequestContext, id: string, n: number) =>
  expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 120_000 }).toBeGreaterThanOrEqual(n);

test("usage views: token zones, error classes, compactions, compare", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");

  // A real model, two turns: the second reads the first's prefix from the cache.
  const real = (await (await request.post("/api/sessions", { data: { model: REAL, title: "Zones check", text: "Name three prime numbers. One line." } })).json()).session;
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
  await choose(panel.getByTestId("zones-session"), real.id);
  await expect(panel.getByTestId("zones-turn")).toHaveCount(tok.turns.length);
  await shoot(page, "usage-views-01-zones");
  await panel.getByTestId("zones-turns").scrollIntoViewIfNeeded();
  await shoot(page, "usage-views-02-zones-turns");

  await panel.getByRole("radio", { name: "Errors" }).click();
  const byModel = panel.getByTestId("errors-classes");
  for (const label of ["Rate limited", "Overloaded", "Stream dropped", "Refused", "Context overflow"]) await expect(byModel).toContainText(label);
  // A plot, or the one bucket's counts by class when every failure fell in the same bucket.
  await expect(panel.getByTestId("errors-chart").locator('svg, [data-testid="chart-value"]').first()).toBeVisible();
  await shoot(page, "usage-views-03-errors");

  await panel.getByRole("radio", { name: "Compactions" }).click();
  const list = panel.getByTestId("compactions-list");
  const row = list.locator("tbody tr").filter({ hasText: "Zones check" }).first();
  await expect(row).toContainText("asked for");
  await row.click();
  await expect(panel.getByTestId("compaction-detail")).toContainText("Request 1 after");
  // Before and after are averaged over the same compactions: those measured after.
  await expect(panel.getByTestId("compactions-after")).toContainText(/\d+ of \d+ measured/);
  await shoot(page, "usage-views-04-compactions");

  await panel.getByRole("radio", { name: "Compare" }).click();
  await expect(panel.getByTestId("compare-table")).toContainText("First token, median");
  await panel.getByRole("radio", { name: "Two models" }).click();
  await choose(panel.getByTestId("compare-model-a"), REAL);
  await choose(panel.getByTestId("compare-model-b"), STAND_IN);
  await expect(panel.getByTestId("compare-table")).toContainText("Rate limited");
  // A count of failures differs by how many, not in rate points.
  const limited = panel.getByTestId("compare-table").locator("tr").filter({ hasText: "Rate limited" });
  await expect(limited).toContainText(/\d+ (more|fewer)/);
  await expect(limited).not.toContainText("pts");
  await shoot(page, "usage-views-05-compare");

  for (const s of [real, fail]) await request.delete(`/api/sessions/${s.id}`);
});

// Compare on a small phone at the largest text size: every measurement shows
// both values, each beside the name of its side, and the change, with nothing
// to pan to. With room it stays the four-column table. The models carry long
// names that differ only at their end.
test("usage compare: both sides and the change read together on a phone", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  const BACKUP = "scripted:stand-in-backup";
  test.skip(!models.includes(STAND_IN) || !models.includes(BACKUP), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const made: string[] = [];
  for (const [model, text] of [[STAND_IN, "script:rate-limit"], [BACKUP, "One line."]] as const) {
    const s = (await (await request.post("/api/sessions", { data: { model, title: "Compare check", text } })).json()).session;
    made.push(s.id);
    await ended(request, s.id, 1);
  }
  const LONG = "Laboratory long context instruct preview quantized";
  await page.route("**/api/models*", async (route) => {
    const body = await (await route.fetch()).json();
    for (const m of body.models ?? []) if (m.id === STAND_IN) m.name = `${LONG} A`; else if (m.id === BACKUP) m.name = `${LONG} B`;
    await route.fulfill({ json: body });
  });
  const panel = page.getByTestId("usage-panel");
  const table = panel.getByTestId("compare-table");
  const rows = table.locator("tbody tr");
  const open = async () => {
    await page.goto("/settings/usage");
    await panel.getByRole("radio", { name: "Compare" }).click();
    await panel.getByRole("radio", { name: "Two models" }).click();
    await choose(panel.getByTestId("compare-model-a"), STAND_IN);
    await choose(panel.getByTestId("compare-model-b"), BACKUP);
    await expect(table).toContainText("Rate limited");
  };
  // Where the cells of a row sit: [name, first side, second side, change].
  const cells = (row: ReturnType<typeof rows.first>) => row.evaluate((tr) => [...tr.children].map((c) => { const r = c.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, side: getComputedStyle(c, "::before").content }; }));

  // With room: one line a measurement, under heads that name the two models.
  await open();
  await expect(table.locator("thead")).toContainText(`${LONG} A`);
  await expect(table.locator("thead")).toContainText(`${LONG} B`);
  const wide = await cells(rows.filter({ hasText: "Requests" }).first());
  expect(new Set(wide.map((c) => Math.round(c.top))).size).toBe(1);
  await shoot(page, "usage-views-06-compare-long-names");

  await page.evaluate(() => localStorage.setItem("keel.textScale", "1.5"));
  await page.setViewportSize({ width: 320, height: 640 });
  await open();
  // Nothing of the table is off to the side, and nothing in it scrolls sideways.
  const fit = await table.locator("table").evaluate((el) => { const r = el.getBoundingClientRect(), w = el.parentElement!; return { left: r.left, right: r.right, pans: w.scrollWidth > w.clientWidth + 1 }; });
  expect(fit.pans).toBe(false);
  // The settings pane scrolls up and down only: nothing in it is wider than the pane,
  // in either way of comparing, and the block stands inside the pane with its margin.
  const pane = page.getByTestId("settings-scroll");
  const sideways = () => pane.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(await sideways()).toBeLessThanOrEqual(0);
  expect(fit.left).toBeGreaterThan(0);
  await panel.getByRole("radio", { name: "Two ranges" }).click();
  await expect(table).toContainText("The range before");
  expect(await sideways()).toBeLessThanOrEqual(0);
  // The seven views are wider than the pane: they go on to a second line, none cut, the chosen one in view.
  const views = panel.getByRole("radiogroup", { name: "View" });
  await pane.evaluate((el) => el.scrollTo(0, 0));
  expect(await views.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
  await expect(views.getByRole("radio", { name: "Overview" })).toBeInViewport({ ratio: 1 });
  await expect(views.getByRole("radio", { name: "Compare" })).toBeInViewport({ ratio: 1 });
  await panel.getByRole("radio", { name: "Two models" }).click();
  await expect(table).toContainText("Rate limited");
  expect(await sideways()).toBeLessThanOrEqual(0);
  // The page itself stays put: only the settings pane scrolls.
  expect(await page.evaluate(() => { const d = document.scrollingElement!; return d.scrollWidth <= d.clientWidth && d.scrollHeight <= d.clientHeight; })).toBe(true);
  expect(fit.left).toBeGreaterThanOrEqual(0);
  expect(fit.right).toBeLessThanOrEqual(320);
  for (const row of await rows.all()) {
    const [name, a, b, change] = await cells(row);
    for (const c of [name!, a!, b!, change!]) {
      expect(c.left).toBeGreaterThanOrEqual(0);
      expect(c.right).toBeLessThanOrEqual(320);
    }
    // The change is beside the name; each value is on a line that names its side.
    expect(change!.top).toBeLessThan(a!.top);
    expect(a!.bottom).toBeLessThanOrEqual(b!.top + 1);
    expect(a!.side).toContain(`${LONG} A`);
    expect(b!.side).toContain(`${LONG} B`);
  }
  const limited = rows.filter({ hasText: "Rate limited" });
  await expect(limited).toContainText(/\d+ (more|fewer)/);
  await limited.scrollIntoViewIfNeeded();
  await expect(limited).toBeInViewport({ ratio: 1 });
  await shoot(page, "usage-views-07-compare-phone");
  await rows.first().scrollIntoViewIfNeeded();
  await shoot(page, "usage-views-08-compare-phone-top");

  // The other views of the pane keep to its width as well.
  await pane.evaluate((el) => el.scrollTo(0, 0));
  for (const view of ["Compactions", "Errors", "Token zones", "Overview"]) {
    await views.getByRole("radio", { name: view }).click();
    await expect(views.getByRole("radio", { name: view })).toBeInViewport({ ratio: 0.95 });
    await expect(panel.getByText("Reading the measurements.")).toHaveCount(0);
    await expect.poll(sideways, view).toBeLessThanOrEqual(0);
  }
  await shoot(page, "usage-views-09-overview-phone");

  for (const id of made) await request.delete(`/api/sessions/${id}`);
});
