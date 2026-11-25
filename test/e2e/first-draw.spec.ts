import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: on a wide window the page's first draw already holds the session list and the bridge. Their
// code is its own chunks, named in the built page's head and waited for by the first draw; a view drawn
// after a fallback would reach the screen 300 ms later (React holds back content that follows a fallback),
// which the desktop app shows as a blank window at every start. The check is the order of the draw, not a
// time: what the page first put in its root already has the list's rows in it.
test.use({ viewport: { width: 1920, height: 1040 } });

test("the first thing drawn has the session list in it, not a shell that waits for it", async ({ page, request }) => {
  // Something in the list to look for.
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "First draw check" } })).json();
  await page.addInitScript(() => {
    const w = window as any;
    w.__first = null;
    const mo = new MutationObserver(() => {
      const root = document.getElementById("root");
      if (!root || w.__first || !root.firstElementChild) return;
      w.__first = { rail: !!root.querySelector(".k-rail-wrap > *"), at: Math.round(performance.now()) };
      mo.disconnect();
    });
    document.addEventListener("DOMContentLoaded", () => mo.observe(document.documentElement, { childList: true, subtree: true }));
  });
  try {
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    // The preloads are the built page's: a daemon serving the sources has no chunks to name.
    const built = await page.evaluate(() => !!document.head.querySelector('link[rel="modulepreload"]'));
    test.skip(!built, "needs the built page (scripts/smoke.sh --bin dist/keel): the sources are not split into chunks");
    const first = await page.evaluate(() => (window as any).__first);
    expect(first, "the root was drawn").not.toBeNull();
    expect(first.rail, "the list is in the first draw").toBe(true);
    await shoot(page, "first-draw");
  } finally {
    await request.delete(`/api/sessions/${session.id}`).catch(() => {});
  }
});
