import { expect, test } from "./isolate.ts";
import { calls } from "./answering.ts";
import { shoot } from "./shots.ts";

// Feature: a phone turned on its side gets the phone's layout, not the desktop's. At 844x390 the
// desktop layout leaves a reply no height; a touch screen under 500 px tall has one row for the head,
// the list closed, finger-size targets, and most of the height for the conversation.
const MODEL = "scripted:stand-in";
const SIZES = [{ width: 844, height: 390 }, { width: 915, height: 412 }];

for (const size of SIZES) {
  for (const scale of [1, 1.5]) {
    test.describe(`a phone on its side, ${size.width}x${size.height} at ${scale * 100}% text`, () => {
      test.use({ viewport: size, hasTouch: true, isMobile: true });
      test.setTimeout(60_000);
      test("the reply has the height, the list is closed, the targets are a finger", async ({ page, request }) => {
        const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
        test.skip(!models.includes(MODEL), "requires the scripted provider");
        await page.addInitScript((s) => localStorage.setItem("keel.textScale", String(s)), scale);
        const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title: "Fix cart total rounding" } })).json();
        try {
          await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
          await request.post(`/api/sessions/${session.id}/messages`, { data: { text: calls([{ name: "Bash", input: { command: "echo cart.ts" } }]) } });
          await expect.poll(async () => { const d = await (await request.get(`/api/sessions/${session.id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 30_000 }).toBe(true);
          await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:render" } });
          await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 30_000 }).toBe(2);
          await page.goto(`/s/${session.id}`);
          const pane = page.locator(".k-station[data-helm]");
          await expect(pane.getByTestId("turn-end").last()).toBeVisible();
          await shoot(page, `phone-land-${size.width}-${scale}`);
          const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));

          // The list is closed: its button is in the head, and no list is beside the conversation.
          await expect(pane.getByTestId("show-sidebar")).toBeVisible();
          await expect(page.getByTestId("session-row").first()).toBeHidden();
          // The head is one row, and a third of the height at most.
          const bar = (await pane.locator(".k-top").boundingBox())!;
          expect(bar.height, "the head is one row").toBeLessThanOrEqual(3.5 * rem + 1);
          expect(bar.height, "the head leaves the height to the reply").toBeLessThan(size.height / 4 + 1);
          // The reply has most of the height: what is between the head and the message box is nearly half the screen
          // (the dock is gone: the list's button in the head is the way to the other sessions).
          await expect(page.locator(".k-dock")).toBeHidden();
          const box = (await pane.getByTestId("composer-box").boundingBox())!;
          expect(box.y - (bar.y + bar.height), "the reply has the height").toBeGreaterThan(size.height * 0.45);
          // Targets are a finger: the head's buttons and the message box's send or tools.
          for (const id of ["show-sidebar", "session-menu"]) {
            const b = (await pane.getByTestId(id).first().boundingBox())!;
            expect(Math.min(b.width, b.height), `${id} is a finger`).toBeGreaterThanOrEqual(2.25 * rem - 0.5);
            expect(b.x + b.width, `${id} is inside the page`).toBeLessThanOrEqual(size.width);
          }
          // A tap opens the box's tools: each is in the page and a finger's size.
          await pane.getByTestId("composer").tap();
          await expect(pane.getByTestId("composer-tools")).toBeVisible();
          for (const id of ["attach", "send"]) {
            const b = (await pane.getByTestId(id).boundingBox())!;
            expect(Math.min(b.width, b.height), `${id} is a finger`).toBeGreaterThanOrEqual(2.25 * rem - 0.5);
            await expect(pane.getByTestId(id)).toBeInViewport({ ratio: 1 });
          }
          await shoot(page, `phone-land-open-${size.width}-${scale}`);
          expect(await page.evaluate(() => document.documentElement.scrollWidth), "no sideways scroll").toBeLessThanOrEqual(size.width);
        } finally { await request.delete(`/api/sessions/${session.id}`); }
      });
    });
  }
}
