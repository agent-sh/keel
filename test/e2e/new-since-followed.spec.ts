import { expect, test } from "./isolate.ts";

// Feature: a turn the owner watches, though they did not send it, leaves no "New since" chip behind. The
// chip is for what came while they were away; what streamed into the end of the view as they looked at it
// is read, even though the line the rule would stand at went by above the view as the reply grew.
const MODEL = "scripted:stand-in";

test.describe("a watched turn", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("is not left as new when its end was followed", async ({ page, request }) => {
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes(MODEL), "requires the scripted provider");
    const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title: "Watch me" } })).json();
    try {
      await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:say first." } });
      await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 30_000 }).toBe(1);
      await page.goto(`/s/${session.id}`);
      const pane = page.locator(".k-station[data-helm]");
      await expect(pane.getByTestId("composer")).toBeVisible();
      await page.waitForTimeout(800);
      // A long reply streams in, started from outside the page.
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:count" } });
      await expect(pane.getByTestId("user-message").last()).toContainText("script:count");
      // (The page is on its end through the reply and for a few seconds after it.)
      await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 60_000 }).toBe(2);
      await page.waitForTimeout(6000);
      await expect(pane.getByTestId("new-since-jump")).toHaveCount(0);
      await expect(pane.locator("[data-new-since]")).toHaveCount(0);
    } finally {
      await request.post(`/api/sessions/${session.id}/interrupt`, { data: { by: "owner" } });
      await request.delete(`/api/sessions/${session.id}`);
    }
  });
});
