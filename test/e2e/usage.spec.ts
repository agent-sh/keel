import { expect, test } from "./isolate.ts";
import { HAIKU, ask, shoot } from "./shots.ts";

// Feature: Settings > Usage reads the local telemetry of a real turn: spend,
// cache hit rate, time to first token and failures as tiles, the series as
// charts with a readout under the pointer, cache breaks by cause, the tables
// by model and tool with a tool's last failures, and spend limits that stop a
// turn before its request.
test("usage dashboard", async ({ page, request }) => {
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const s = (await (await request.post("/api/sessions", {
    data: {
      model: HAIKU,
      text: ask(
        "Run `echo usage-check` with your shell tool, then read the file /nonexistent/keel-usage-check.txt with your file reading tool, then write two sentences about prompt caching.",
        'script:calls [{"name":"Bash","input":{"command":"echo usage-check"}},{"name":"Read","input":{"file_path":"/nonexistent/keel-usage-check.txt"}}]',
      ),
    },
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
  const name = (await (await request.get("/api/models")).json()).models.find((m: any) => m.id === HAIKU).name as string;
  await expect(panel.getByTestId("usage-models")).toContainText(name);
  await shoot(page, "usage-01-dashboard");
  // How fast the calls were has a view of its own: a whole reply through its retries, beside one try.
  await panel.getByTestId("usage-go-calls").click();
  await expect(panel.getByTestId("tile-step")).toContainText("without retries");
  await expect(panel.getByTestId("tile-step")).not.toContainText("none;");
  await expect(panel.getByTestId("cache-breaks")).not.toBeEmpty();

  // The readout under the pointer lists every series at that bucket. A plot takes two buckets
  // (one alone reads as a value): a daemon that measured in one bucket only gets it in the one before too.
  await page.route(/\/api\/telemetry\?/, async (route) => {
    const body = await (await route.fetch()).json();
    const filled = (body.series as any[]).filter((p) => p.calls > 0);
    if (filled.length === 1) {
      const before = { ...filled[0], t_ms: filled[0].t_ms - body.bucket_ms };
      body.series = [...(body.series as any[]).filter((p) => p.t_ms !== before.t_ms), before].sort((x, y) => x.t_ms - y.t_ms);
    }
    await route.fulfill({ json: body });
  });
  await page.getByRole("radio", { name: "Day" }).click();
  const chart = panel.getByTestId("chart-latency").locator("svg");
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
  await expect(panel.getByTestId("chart-tooltip")).toContainText("First word");
  await shoot(page, "usage-02-readout");

  // A tool with failures opens its last failed calls, linked to the session.
  const failedTool = ex[0].tool;
  const failed = panel.getByTestId("usage-tools").locator("tbody tr").filter({ has: page.getByText(failedTool, { exact: true }) }).first();
  await failed.click();
  await expect(panel.getByTestId("tool-failures")).toContainText("keel-usage-check");
  await panel.getByTestId("usage-tools").scrollIntoViewIfNeeded();
  await shoot(page, "usage-03-tables");

  // A daily limit already passed: the next turn stops before its request and says why.
  await panel.getByRole("radio", { name: "Overview" }).click();
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

// A chart readout stays inside its chart. A bucket near the middle (the
// measurement is moved there) with long series names: beside the crosshair
// with room; on a small phone at the largest text size over the plot's top
// edge, no wider than the chart, every name whole; and inside the plot's top
// when the pane shows nothing above the plot, so it is never cut off.
test("chart readouts stay inside the chart", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
  const s = (await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Readout check", text: "One line." } })).json()).session;
  await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 60_000 }).toBe(true);
  await request.post(`/api/sessions/${s.id}/messages`, { data: { text: "Another line." } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 60_000 }).toBe(2);
  await page.route("**/api/telemetry/tokens*", async (route) => {
    const body = await (await route.fetch()).json();
    const mid = Math.floor((body.since_ms + body.until_ms) / 2 / body.bucket_ms) * body.bucket_ms;
    // Two buckets side by side: one alone is shown as a value, with no plot to point at.
    body.series = body.series.slice(-1).flatMap((p: any) => [{ ...p, t_ms: mid - body.bucket_ms }, { ...p, t_ms: mid }]);
    await route.fulfill({ json: body });
  });
  const panel = page.getByTestId("usage-panel");
  const chart = panel.getByRole("figure", { name: "Share of each bucket's prompt read from the cache" });
  const tip = chart.getByTestId("chart-tooltip");
  // The plot at the foot of what the pane shows, its legend above it, or at the pane's top.
  const open = async (block: "end" | "start" = "end") => {
    await page.goto("/settings/usage");
    await panel.getByRole("radio", { name: "Token zones" }).click();
    // Room under the page, so the plot reaches the pane's top however few rows this daemon has measured.
    await chart.locator("svg").evaluate((el, block) => { if (block === "start") (el.closest('[data-testid="settings-scroll"]')!.firstElementChild as HTMLElement).style.paddingBottom = "100vh"; el.scrollIntoView({ block }); }, block);
    const box = (await chart.locator("svg").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2);
    await expect(tip).toContainText("Frozen history read from cache");
    await expect(tip).toContainText("Volatile tail read from cache");
  };
  // The readout against the box the chart is drawn in, and whether a name is cut.
  const measure = () => tip.evaluate((el) => {
    const t = el.getBoundingClientRect(), c = el.parentElement!.getBoundingClientRect();
    const cut = [...el.querySelectorAll("span")].some((n) => n.scrollWidth > n.clientWidth + 1);
    const pane = el.closest('[data-testid="settings-scroll"]')!.getBoundingClientRect();
    return { left: t.left - c.left, right: c.right - t.right, top: t.top - c.top, bottom: t.bottom - c.top, plot: c.height, cut, view: innerWidth - t.right, underPaneTop: t.top - pane.top, plotUnderPaneTop: c.top - pane.top };
  });

  await open();
  const wide = await measure();
  expect(wide.left).toBeGreaterThanOrEqual(0);
  expect(wide.right).toBeGreaterThanOrEqual(0);
  expect(wide.top).toBeGreaterThanOrEqual(0);
  expect(wide.bottom).toBeLessThanOrEqual(wide.plot);
  expect(wide.cut).toBe(false);
  await expect(tip).toHaveAttribute("data-at", "beside");
  await shoot(page, "usage-05-readout-middle");

  await page.evaluate(() => localStorage.setItem("keel.textScale", "1.5"));
  await page.setViewportSize({ width: 320, height: 800 });
  await open();
  const narrow = await measure();
  expect(narrow.left).toBeGreaterThanOrEqual(0);
  expect(narrow.right).toBeGreaterThanOrEqual(0);
  expect(narrow.view).toBeGreaterThanOrEqual(0);
  expect(narrow.cut).toBe(false);
  // It leaves the plot to the lines: it ends where the plot begins, and is on the screen.
  expect(narrow.bottom).toBeLessThanOrEqual(0);
  await expect(tip).toHaveAttribute("data-at", "above");
  await expect(tip).toBeInViewport({ ratio: 1 });
  await shoot(page, "usage-06-readout-phone");

  // A shorter phone, the plot at the top of the pane: nothing shows above it,
  // so the readout stands inside the plot's top, whole.
  await page.setViewportSize({ width: 320, height: 568 });
  await open("start");
  const top = await measure();
  expect(top.plotUnderPaneTop).toBeLessThan(40);
  expect(top.underPaneTop).toBeGreaterThanOrEqual(0);
  expect(top.top).toBeGreaterThanOrEqual(0);
  expect(top.left).toBeGreaterThanOrEqual(0);
  expect(top.right).toBeGreaterThanOrEqual(0);
  expect(top.cut).toBe(false);
  await expect(tip).toHaveAttribute("data-at", "over");
  await expect(tip).toBeInViewport({ ratio: 1 });
  await shoot(page, "usage-07-readout-phone-top");

  await request.delete(`/api/sessions/${s.id}`);
});

// The overview answers where the spend and the tokens went before anything
// else: the spend, then the tokens cut by what they were. Figures are one
// component on every page. A chart with one bucket of data is that bucket's
// values in words, not a dot in an empty plot.
test("usage: the answer first, one stat component, one bucket reads as a value", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
  const s = (await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Usage answer", text: "One line." } })).json()).session;
  await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 60_000 }).toBe(true);
  let buckets = 1;
  await page.route(/\/api\/telemetry\?/, async (route) => {
    const body = await (await route.fetch()).json();
    const last = body.series.at(-1);
    body.series = Array.from({ length: buckets }, (_, i) => ({ ...last, t_ms: last.t_ms - (buckets - 1 - i) * body.bucket_ms }));
    await route.fulfill({ json: body });
  });
  await page.goto("/settings/usage");
  const panel = page.getByTestId("usage-panel");
  const answer = panel.getByTestId("usage-answer");
  await expect(answer.getByTestId("tile-spend")).toContainText("$");
  await expect(answer).toContainText(/Where the (money|tokens) went/);
  await expect(answer.getByTestId("tile-cache")).toContainText("%");
  // The answer leads the page: nothing but the view switch stands above it.
  expect((await answer.boundingBox())!.y).toBeLessThan((await panel.getByTestId("usage-models").boundingBox())!.y);
  expect((await panel.getByTestId("usage-models").boundingBox())!.y).toBeLessThan((await panel.getByTestId("usage-health").boundingBox())!.y);
  // One bucket: its value, named, and no plot.
  await expect(panel.getByTestId("chart-spend").getByTestId("chart-value").first()).toBeVisible();
  await expect(panel.getByTestId("chart-spend").locator("svg")).toHaveCount(0);
  // The cache hit rate is said once on the page, in the answer.
  expect(((await panel.innerText()).match(/\d+% of the prompt/g) ?? []).length).toBe(1);
  // The answer: the split is in money beside its tokens, and one sentence says what drove the spend.
  await expect(answer.getByRole("heading", { name: "Where the money went" })).toBeVisible();
  await expect(answer.getByTestId("usage-split")).toContainText("of cost");
  await expect(answer.getByTestId("usage-split")).toContainText("New input, full price");
  await expect(answer.getByTestId("usage-drivers")).toContainText(/(All|\d+%) of it went to /);
  // The range is named for what it is; the calendar's pair stands once, in the answer, and the answer holds no input.
  await expect(answer.getByTestId("tile-spend")).toContainText("Spent in the past 7 days");
  expect(((await panel.innerText()).match(/This calendar month/g) ?? []).length).toBe(1);
  await expect(panel.getByText("This month", { exact: true })).toHaveCount(0);
  await expect(answer.getByTestId("usage-calendar")).toContainText("Today");
  await expect(answer.locator("input")).toHaveCount(0);
  await expect(panel.getByTestId("usage-budget").getByTestId("budget-daily_usd")).toBeVisible();
  // The two lists of where it went have the same columns, their heads on one line, and plain amounts.
  const heads = (id: string) => panel.getByTestId(id).locator("thead th");
  await expect(heads("usage-models")).toHaveText(["Model", "Spend", "Share", "Tokens", "Requests"]);
  await expect(heads("usage-purposes")).toHaveText(["Purpose", "Spend", "Share", "Tokens", "Requests"]);
  expect(Math.abs((await heads("usage-models").first().boundingBox())!.y - (await heads("usage-purposes").first().boundingBox())!.y)).toBeLessThanOrEqual(1);
  await expect(panel.getByTestId("usage-models").locator("tbody")).not.toContainText("+");
  // The page is what a person opens it to learn: the answer, where it went, and whether anything is wrong.
  // The charts and tables behind those figures are views of their own.
  const plain = async (ids: string[]) => { for (const id of ids) expect(await panel.getByTestId(id).evaluate((el) => { const c = getComputedStyle(el); return `${c.borderLeftWidth} ${c.boxShadow}`; }), id).toBe("0px none"); };
  await plain(["usage-answer", "usage-models", "usage-purposes", "chart-spend", "usage-health", "usage-budget"]);
  for (const id of ["chart-latency", "chart-cache", "usage-tools", "usage-memory"]) await expect(panel.getByTestId(id)).toHaveCount(0);
  expect(await panel.getByTestId("usage-overview").evaluate((el) => el.scrollHeight)).toBeLessThan(1150);
  // The three figures stand on the page, not in a frame of their own.
  expect(await panel.getByTestId("tile-ttft").evaluate((el) => getComputedStyle(el.parentElement!).boxShadow)).toBe("none");
  await expect(panel.getByTestId("tile-ttft")).toHaveAttribute("data-stat", "");
  await shoot(page, "usage-08-answer");
  await page.setViewportSize({ width: 390, height: 844 });
  await answer.scrollIntoViewIfNeeded();
  // On a phone the seven views go on to a second line, none cut, and the two lists show the money with no sideways scroll.
  const strip = panel.getByRole("radiogroup", { name: "View" });
  expect(await strip.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  for (const name of ["Overview", "Compare"]) await expect(strip.getByRole("radio", { name })).toBeInViewport({ ratio: 1 });
  for (const id of ["usage-models", "usage-purposes"]) expect(await panel.getByTestId(id).locator("table").evaluate((el) => el.parentElement!.scrollWidth - el.parentElement!.clientWidth)).toBeLessThanOrEqual(1);
  await shoot(page, "usage-10-answer-phone");
  await page.setViewportSize({ width: 1920, height: 1040 });

  // A figure is the door to its view: how fast calls were, whether the cache held, and the tools.
  await panel.getByTestId("usage-go-calls").click();
  await expect(panel.getByRole("radio", { name: "Speed and tools" })).toBeChecked();
  await expect(panel.getByTestId("chart-latency").getByTestId("chart-value").first()).toBeVisible();
  await expect(panel.getByTestId("chart-latency").locator("svg")).toHaveCount(0);
  await expect(panel.getByTestId("chart-latency")).toContainText("First word");
  await expect(panel.getByTestId("chart-cache").locator("svg")).toHaveCount(0);
  await expect(panel.getByTestId("chart-cache-one")).toContainText(/^One (hour|day|span of [a-z]+ hours) of data so far: \d+% of its prompt was read from cache/);
  // A section's hint is whole, and no section is a boxed card.
  expect(await panel.getByTestId("chart-cache").locator("h3 + span").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await plain(["chart-latency", "chart-cache", "usage-tools"]);
  await shoot(page, "usage-09-one-bucket");
  await panel.getByRole("radio", { name: "Memory" }).click();
  await plain(["usage-memory"]);
  // Two buckets: a plot again.
  buckets = 2;
  await page.reload();
  await panel.getByRole("radio", { name: "Speed and tools" }).click();
  await expect(panel.getByTestId("chart-cache").locator("svg")).toHaveCount(1);
  await expect(panel.getByTestId("chart-latency").getByTestId("chart-value")).toHaveCount(0);

  // The same figure component on every page that shows figures.
  await panel.getByRole("radio", { name: "Errors" }).click();
  await expect(panel.getByTestId("errors-failed")).toHaveAttribute("data-stat", "");
  await page.goto("/settings/resources");
  await expect(page.getByTestId("tile-memory")).toHaveAttribute("data-stat", "");
  await shoot(page, "usage-11-resources-stats");
  await page.goto("/settings/observability");
  await expect(page.getByTestId("obs-turns")).toHaveAttribute("data-stat", "");
  await request.delete(`/api/sessions/${s.id}`);
});
