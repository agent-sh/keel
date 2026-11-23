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
  await shoot(page, "top-edge-01-pinned-1920");

  // On a phone the pinned head is clean too.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(head).toBeVisible();
  const p = (await head.boundingBox())!, pb = (await pane.locator(":scope > .k-band").boundingBox())!;
  expect(await inkAt(page, p.x + 1, pb.y + pb.height + 4)).toEqual([]);
  await shoot(page, "top-edge-02-pinned-390");
});
