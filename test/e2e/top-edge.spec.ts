import { expect, test, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the top edge of the window. The rail's brand row and the pane's top bar are one height,
// so their content starts on one line. Where the pane worked in is wide, its head and the
// session's tools are one bar. Nothing is drawn at the pane's edge where it meets the rail: a
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
  // Pinned is said while the tools are quiet (the pointer is away): a pin after the title.
  await expect(head.getByTestId("station-pinned")).toBeVisible();
  // The tools are as wide as what they show: the head has the rest of the bar.
  const top = (await pane.locator(".k-top").boundingBox())!;
  expect(t.width, "the tools keep a share of the bar they do not use").toBeLessThan(top.width / 2 - 8);
  await shoot(page, "top-edge-01-pinned-1920");

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
    for (const width of [1920, 1440]) {
      await page.setViewportSize({ width, height: 1040 });
      await page.goto(`/s/${session.id}`);
      await expect(pane).toHaveAttribute("data-watch", "need", { timeout: 15_000 });
      await page.mouse.move(1000, 700);
      const head = pane.getByTestId("station-head");
      const h = (await head.boundingBox())!, brand = (await page.locator(".k-rail-brand").boundingBox())!;
      const t = (await pane.getByTestId("session-header").boundingBox())!;
      expect(Math.abs(t.y - h.y), `at ${width} the tools are a row under the head`).toBeLessThan(1);
      expect(Math.abs(h.y + h.height - (brand.y + brand.height)), `at ${width} the bar and the brand row end apart`).toBeLessThanOrEqual(1);
      // The reason keeps room beside the title, on the same line.
      const why = (await head.getByTestId("station-why").boundingBox())!, name = (await head.getByTestId("station-title").boundingBox())!;
      expect(Math.abs(why.y + why.height / 2 - (name.y + name.height / 2)), "the reason is on the title's line").toBeLessThan(4);
      expect(why.width).toBeGreaterThan(80);
    }
    await shoot(page, "top-edge-03-long-1440");
  } finally {
    await request.delete(`/api/sessions/${session.id}`);
  }
});
