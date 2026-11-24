import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a failure's notification with no session to open (an outage across sessions, a failed loop)
// lands on the Errors panel, on a phone as on the desk: the page opens at /?errors=1, the path the
// daemon gives such a click (src/automation/alerts.ts alertPath) and the phone app's push names.
for (const [name, viewport] of [["phone", { width: 390, height: 844 }], ["desk", { width: 1920, height: 1040 }]] as const) {
  test.describe(`on a ${name}`, () => {
    test.use({ viewport, ...(name === "phone" ? { hasTouch: true, isMobile: true } : {}) });
    test("a failure's notification opens the Errors panel with what failed", async ({ page, request }) => {
      const tag = `outage ${Date.now().toString(36)}`;
      await request.post("/api/errors", { data: { message: `${tag}: HTTP 529 from the provider in 3 sessions`, context: { url: "/" } } });
      await page.goto("/?errors=1");
      const panel = page.getByTestId("errors-panel");
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId("error-row").filter({ hasText: tag })).toHaveCount(1);
      // On a phone the panel has the width of the screen, inside it.
      const box = (await panel.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      await shoot(page, `phone-fleet-01-errors-${name}`);
      // It closes as any panel does, and the page is the list it opened over.
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      // Without the word the page opens as before: no panel.
      await page.goto("/");
      await expect(page.getByTestId("errors-panel")).toHaveCount(0);
      // Put back: what this test made is resolved.
      const open = (await (await request.get("/api/errors?resolved=0")).json()).errors ?? [];
      for (const e of open.filter((e: any) => e.message.startsWith(tag))) await request.patch(`/api/errors/${e.id}`, { data: { resolved: true } });
    });
  });
}
