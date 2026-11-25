import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: prompts queued while a turn streams do not move the message box. The queue shows its first two
// and folds the rest into one line, so the region above the box stops growing after them: the conversation
// is not pushed about by prompts that came from somewhere else. The line opens all of them, on the owner's tap.
const MODEL = "scripted:stand-in";

for (const size of [{ width: 390, height: 844 }, { width: 1920, height: 1040 }]) {
  test.describe(`queued prompts at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size, hasTouch: size.width < 800, isMobile: size.width < 800 });
    test("the third and later prompts leave the box and the queue above it as they are", async ({ page, request }) => {
      const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
      test.skip(!models.includes(MODEL), "requires the scripted provider");
      const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title: "Queue me" } })).json();
      try {
        await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
        await page.goto(`/s/${session.id}`);
        const pane = page.locator(".k-station[data-helm]");
        await expect(pane.getByTestId("composer")).toBeVisible();
        await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:count" } });
        const queue = pane.getByTestId("queue-item");
        const place = async () => ({ box: (await pane.getByTestId("composer-box").boundingBox())!.y, queue: Math.round((await pane.getByTestId("queue").boundingBox())!.height) });
        const queued = async (n: number) => { for (let i = 0; i < n; i++) await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `queued ${i + 1}` } }); };
        await queued(3);
        await expect(pane.getByTestId("queue-more")).toHaveText("1 more queued");
        await expect(queue).toHaveCount(2);
        const before = await place();
        await queued(3);
        await expect(pane.getByTestId("queue-more")).toHaveText("4 more queued");
        await page.waitForTimeout(500);
        expect(await place(), "the box and the queue over it stay").toEqual(before);
        await shoot(page, `queue-steady-${size.width}`);
        // The owner opens the rest, and closes it again.
        await pane.getByTestId("queue-more").click();
        await expect(queue).toHaveCount(6);
        await pane.getByTestId("queue-more").click();
        await expect(queue).toHaveCount(2);
        expect(await place()).toEqual(before);
      } finally {
        await request.post(`/api/sessions/${session.id}/interrupt`, { data: { by: "owner" } });
        await request.delete(`/api/sessions/${session.id}`);
      }
    });
  });
}
