import { expect, test, type APIRequestContext } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a restart that does not say it must go now waits while the owner is at a page, joins the
// restarts asked meanwhile into one, and says so in the band across the top. The band restarts at once
// or calls the wait off. (The page's own Restart goes at once: restart-ask.spec.ts.)
const daemon = async (request: APIRequestContext) => (await (await request.get("/api/daemon")).json()) as { pid: number; restart_waiting: { asks: number; until_ms: number } | null };
const restart = (request: APIRequestContext, reason: string, now = false) =>
  request.post("/api/drain", { data: { restart: true, timeout_seconds: 5, reason, ...(now ? { now: true } : {}) } }).then((r) => r.json());

test("a restart asked while you are at a page waits for you, joined into one, and the band restarts it or calls it off", async ({ page, request }) => {
  await page.goto("/");
  // The page says the owner just did something in it: the owner is here.
  await request.post("/api/presence", { data: { session_id: null, focused: true, idle_ms: 0 } });
  const before = (await daemon(request)).pid;

  const first = await restart(request, "a landing");
  expect(first.waiting).toMatchObject({ asks: 1, reasons: ["a landing"] });
  const again = await restart(request, "another landing");
  expect(again.waiting).toMatchObject({ asks: 2, reasons: ["a landing", "another landing"], until_ms: first.waiting.until_ms });
  expect((await daemon(request)).pid).toBe(before);

  const band = page.getByTestId("restart-waiting");
  await expect(band).toContainText("A restart waits until you step away, by ");
  await expect(band).toContainText("2 restarts joined into one");
  // One thing to press is drawn as a button; calling the wait off is plain words beside it.
  expect(await band.evaluate((el) => ["restart-waiting-now", "restart-waiting-off"].map((id) => getComputedStyle(el.querySelector(`[data-testid="${id}"]`)!).boxShadow !== "none"))).toEqual([true, false]);
  await shoot(page, "restart-wait-01-band");

  // Not now: the wait is called off, and nothing restarts.
  await band.getByTestId("restart-waiting-off").click();
  await expect(band).toHaveCount(0);
  expect((await daemon(request)).restart_waiting).toBeNull();

  // Asked again, then Restart now from the band: the daemon restarts at once.
  await restart(request, "a third landing");
  await expect(band).toBeVisible();
  await band.getByTestId("restart-waiting-now").click();
  await expect.poll(async () => { const d = await daemon(request).catch(() => null); return d && d.pid !== before ? d.pid : 0; }, { timeout: 120_000, intervals: [1000] }).toBeGreaterThan(0);
  expect((await daemon(request)).restart_waiting).toBeNull();
});

for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) test.describe(`on a phone, ${size.width}x${size.height}`, () => {
  test.use({ viewport: size, hasTouch: true, isMobile: true });
  test("the band says its sentence whole and its two answers are quiet words in the band, once, on the page where you are", async ({ page, request }) => {
    await page.goto("/");
    await request.post("/api/presence", { data: { session_id: null, focused: true, idle_ms: 0 } });
    await restart(request, "a landing");
    await restart(request, "another landing");
    const band = page.getByTestId("restart-waiting");
    await expect(band).toContainText("2 restarts joined into one");
    const said = band.locator("span").first();
    expect(await said.evaluate((e) => e.scrollWidth <= e.clientWidth + 1 && getComputedStyle(e).textOverflow !== "ellipsis"), "the sentence is not cut").toBe(true);
    const box = (await band.boundingBox())!;
    for (const id of ["restart-waiting-now", "restart-waiting-off"]) {
      const b = band.getByTestId(id);
      const r = (await b.boundingBox())!;
      expect(r.y + r.height, `${id} stays inside the band`).toBeLessThanOrEqual(box.y + box.height + 0.5);
      expect(await b.evaluate((e) => getComputedStyle(e).boxShadow), `${id} has no frame`).toBe("none");
    }
    // On its side the phone has the width for one line and no height for two: the answers sit beside the sentence.
    if (size.width > size.height) {
      const line = (await said.boundingBox())!, now = (await band.getByTestId("restart-waiting-now").boundingBox())!;
      expect(Math.abs(line.y + line.height / 2 - (now.y + now.height / 2)), "the answers are on the sentence's line").toBeLessThanOrEqual(4);
      expect(box.height, "the band is one line").toBeLessThanOrEqual(now.height + 2);
    }
    await shoot(page, `restart-wait-02-phone-${size.width}`);
    // On a phone the owner's being there is what holds the restart: the band is said on the page where the
    // wait began, and the pages gone to after it leave it out.
    const { session } = await (await request.post("/api/sessions", { data: { title: "Read on the phone" } })).json();
    try {
      await page.evaluate((id) => { history.pushState(null, "", `/s/${id}`); dispatchEvent(new PopStateEvent("popstate")); }, session.id);
      await expect(page.locator(".k-station[data-helm]").getByTestId("station-title")).toBeVisible();
      await page.waitForTimeout(300);
      await shoot(page, `restart-wait-03-phone-elsewhere-${size.width}`);
      await expect(band, "not on every page").toHaveCount(0);
      expect((await daemon(request)).restart_waiting, "the restart still waits").not.toBeNull();
      await page.goBack();
      await expect(band).toBeVisible();
      await band.getByTestId("restart-waiting-off").tap();
      await expect(band).toHaveCount(0);
    } finally {
      await request.delete("/api/drain/waiting").catch(() => {});
      await request.delete(`/api/sessions/${session.id}`);
    }
  });
});
