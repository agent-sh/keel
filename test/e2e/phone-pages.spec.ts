import { expect, test } from "./isolate.ts";
import { create, drop, folder, pane, scripted, settle } from "./answering.ts";
import { shoot } from "./shots.ts";

// Feature: a phone draws the page in view first. Its sessions are pages to swipe between, and each
// one reads its conversation and draws it; all of them at the first load stand between the owner
// and the page in view. The page in view is read first; the others are asked for once it has its
// conversation, one after another, and a page swiped to before then is drawn at once.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("a phone reads the page in view first and the other pages after it", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("phone-pages");
  const view = await create(request, "In view: the importer", ws);
  const others = [
    await create(request, "Beside: the release notes", ws),
    await create(request, "Beside: the flaky test", ws),
    await create(request, "Beside: the standup", ws),
  ];
  const asked: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    const m = /^\/api\/sessions\/([^/]+)$/.exec(u.pathname);
    if (r.method() === "GET" && m && u.searchParams.has("page")) asked.push(m[1]!);
  });
  // The page in view cannot be read yet (its box is drawn, its conversation is not): whatever else the page asks for is asked for too early.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route(`**/api/sessions/${view}?page=*`, async (route) => { await held; await route.continue(); });
  try {
    await page.goto(`/s/${view}`);
    await expect(page.locator("section.k-station[data-station]")).toHaveCount(4);
    await expect(pane(page, view).getByTestId("composer")).toBeVisible();
    // (Two frames: whatever the first commit asked for has been sent.)
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    expect(asked.filter((id) => id !== view)).toEqual([]);
    release();
    for (const id of [view, ...others]) await expect(pane(page, id).getByTestId("composer")).toBeVisible({ timeout: 30_000 });
    // Each session was read once.
    expect([...asked].sort()).toEqual([view, ...others].sort());
    await shoot(page, "phone-pages-01-after");
  } finally {
    release();
    await drop(request, view, ...others);
  }
});
