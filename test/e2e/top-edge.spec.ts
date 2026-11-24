import { expect, test, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the top edge of the window. The rail's brand row and the pane's top bar are one height,
// so their content starts on one line. Where a pane is as wide as a desk window leaves it (a
// 40rem pane and up), its head and the session's tools are one bar, and panes side by side end on
// one line. The head in the bar is one line or two: the title whole with the reason beside it,
// else the title over the state and its reason, which then have the head's width. Nothing is drawn at the pane's edge where it meets the rail: a
// pinned session's head once wore an ink tab there, a short white line in the dark theme.

// What lies at a point, top first: the classes of each element whose own background is the ink.
const inkAt = (page: Page, x: number, y: number) => page.evaluate(([px, py]) => {
  const probe = document.createElement("div");
  probe.style.background = "var(--fg)";
  document.body.append(probe);
  const ink = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return document.elementsFromPoint(px!, py!).filter((el) => getComputedStyle(el).backgroundColor === ink).map((el) => el.className || el.tagName);
}, [x, y]);

test("the rail and a pinned pane meet in one clean top edge, the head and its tools one bar", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string; provider: string }[];
  const model = models.find((m) => m.provider === "scripted")?.id;
  test.skip(!model, "needs the scripted provider: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "Pinned at the top edge" } })).json();
  await request.patch(`/api/sessions/${session.id}`, { data: { settings: { pinned_ms: Date.now() } } });
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${session.id}`);
  const pane = page.getByTestId("station").and(page.locator(`[data-station="${session.id}"]`));
  const head = pane.getByTestId("station-head");
  const tools = pane.getByTestId("session-header");
  await expect(head).toBeVisible();
  await expect(page.getByTestId("pinned-group").locator(`[data-session="${session.id}"]`)).toBeVisible();
  await page.mouse.move(1000, 700);

  const h = (await head.boundingBox())!, t = (await tools.boundingBox())!;
  const brand = (await page.locator(".k-rail-brand").boundingBox())!;
  const band = (await pane.locator(":scope > .k-band").boundingBox())!;
  // Nothing in ink at the pane's edge under the band.
  for (const y of [band.y + band.height + 2, band.y + band.height + 12]) expect(await inkAt(page, h.x + 1, y)).toEqual([]);
  // One bar: the tools stand beside the head, on its line, as high as it is.
  expect(Math.abs(t.y - h.y), "the tools are a row under the head").toBeLessThan(1);
  expect(Math.abs(t.y + t.height - (h.y + h.height))).toBeLessThan(1);
  expect(t.x).toBeGreaterThan(h.x + h.width / 2);
  // One top edge: the bar (band included) is the brand row's height.
  expect(Math.abs(h.y + h.height - (brand.y + brand.height)), "the bar and the brand row end apart").toBeLessThanOrEqual(1);
  // Pinned is said with the pointer away: the pane's tools rest in view, and the pin is pressed, in ink.
  await expect(head.getByTestId("station-pin")).toHaveAttribute("aria-pressed", "true");
  expect(await head.locator(".k-station-tools").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  // The tools are as wide as what they show: the head has the rest of the bar.
  const top = (await pane.locator(".k-top").boundingBox())!;
  expect(t.width, "the tools keep a share of the bar they do not use").toBeLessThan(top.width / 2 - 8);
  await shoot(page, "top-edge-01-pinned-1920");

  // Panes side by side: the other pane's head ends where the bar does.
  const { session: other } = await (await request.post("/api/sessions", { data: { model, title: "Beside the pinned one" } })).json();
  try {
    // Two panes, the other session dropped on the second from the list.
    await page.getByTestId("panes-2").click();
    const second = page.getByTestId("bridge").locator(':scope > [data-slot="1"]');
    await expect(second).toBeVisible();
    await page.locator(`[data-testid="session-row"][data-session="${other.id}"]`).dragTo(second);
    await expect(second).toHaveAttribute("data-station", other.id);
    await page.mouse.move(1000, 700);
    await expect(page.getByTestId("station-head")).toHaveCount(2);
    const ends = await page.getByTestId("station-head").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().bottom)));
    for (const end of ends) expect(Math.abs(end - (brand.y + brand.height)), `panes end at ${ends.join(", ")}, the brand row at ${brand.y + brand.height}`).toBeLessThanOrEqual(1);
    await shoot(page, "top-edge-04-two-panes");
    await page.getByTestId("panes-1").click();
  } finally {
    await request.delete(`/api/sessions/${other.id}`);
  }

  // On a phone the pinned head is clean too.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(head).toBeVisible();
  const p = (await head.boundingBox())!, pb = (await pane.locator(":scope > .k-band").boundingBox())!;
  expect(await inkAt(page, p.x + 1, pb.y + pb.height + 4)).toEqual([]);
  await shoot(page, "top-edge-02-pinned-390");
});

test("a head with a long title and a long reason is still one bar, the brand row's height", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string; provider: string }[];
  const model = models.find((m) => m.id === "scripted:stand-in")?.id;
  test.skip(!model, "needs the scripted stand-in: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
  const title = "A session with a rather long title that keeps going on and on across the bar";
  const { session } = await (await request.post("/api/sessions", { data: { model, title } })).json();
  try {
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask" } });
    // An approval it waits on (never given): the head's reason is long, and the band is the thicker one of a state that calls the owner.
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "echo a long command line that keeps going on and on so the reason does not fit beside the title > top-edge-long-reason.txt" } }])}` } });
    const pane = page.getByTestId("station").and(page.locator(`[data-station="${session.id}"]`));
    // Below 1400 the bar is one too (it once was two rows there, 125px against the brand row's 60).
    for (const width of [1920, 1440, 1366, 1200, 1050]) {
      await page.setViewportSize({ width, height: 1040 });
      await page.goto(`/s/${session.id}`);
      await expect(pane).toHaveAttribute("data-watch", "need", { timeout: 15_000 });
      await page.mouse.move(1000, 700);
      const head = pane.getByTestId("station-head");
      const h = (await head.boundingBox())!, brand = (await page.locator(".k-rail-brand").boundingBox())!;
      const t = (await pane.getByTestId("session-header").boundingBox())!;
      expect(Math.abs(t.y - h.y), `at ${width} the tools are a row under the head`).toBeLessThan(1);
      expect(Math.abs(h.y + h.height - (brand.y + brand.height)), `at ${width} the bar and the brand row end apart`).toBeLessThanOrEqual(1);
      // The reason has room for about twenty characters at least: beside a title shown whole, or on the
      // line under it with the head's width (this title is too long to leave it room beside).
      const why = (await head.getByTestId("station-why").boundingBox())!, name = (await head.getByTestId("station-title").boundingBox())!;
      // (Whole, or cut no shorter than about twenty characters.)
      const chars = await head.getByTestId("station-why").evaluate((el) => el.scrollWidth <= el.clientWidth ? Infinity : el.getBoundingClientRect().width / (parseFloat(getComputedStyle(el).fontSize) * 0.5));
      expect(chars, `at ${width} the reason is cut to about ${Math.round(chars)} characters`).toBeGreaterThan(20);
      const beside = Math.abs(why.y + why.height / 2 - (name.y + name.height / 2)) < 4;
      if (beside) expect(await head.getByTestId("station-title").evaluate((el) => el.scrollWidth <= el.clientWidth), `at ${width} the reason is beside a cut title`).toBe(true);
      else {
        expect(why.y, `at ${width} the reason is under the title`).toBeGreaterThan(name.y + name.height - 2);
        if (chars !== Infinity) expect(why.width, `at ${width} the reason under the title is cut short of the head`).toBeGreaterThan(h.width * 0.5);
      }
      if (width === 1440 || width === 1050) await shoot(page, `top-edge-03-long-${width}`);
    }
  } finally {
    await request.delete(`/api/sessions/${session.id}`);
  }
});
