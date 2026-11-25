import { expect, test } from "./isolate.ts";
import { calls } from "./answering.ts";
import { shoot } from "./shots.ts";

// Feature: on a phone the home screen shows what waits on the owner in the first screen. At a large text size
// the start box and its pickers took the screen and the first Allow once was a screen or more down: while
// something waits, the start box rests as one line, and its heading and pickers come with a tap on it.
const MODEL = "scripted:stand-in";
const bash = (command: string) => calls([{ name: "Bash", input: { command } }]);

for (const size of [{ width: 390, height: 844 }, { width: 412, height: 915 }]) {
  for (const scale of [1, 1.5]) {
    test.describe(`phone home ${size.width}x${size.height} at ${scale * 100}% text`, () => {
      test.use({ viewport: size, hasTouch: true, isMobile: true });
      test.setTimeout(90_000);
      test("the first answer is in view and the start box rests as a line", async ({ page, request }) => {
        const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
        test.skip(!models.includes(MODEL), "requires the scripted provider");
        await page.addInitScript((s) => localStorage.setItem("keel.textScale", String(s)), scale);
        const made: string[] = [];
        try {
          for (const [i, command] of ["touch schema.txt", "touch clean.txt", "touch lock.txt"].entries()) {
            const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title: `Approve step ${i + 1}` } })).json();
            made.push(session.id);
            await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
            await request.post(`/api/sessions/${session.id}/messages`, { data: { text: bash(command) } });
            await expect.poll(async () => ((await (await request.get(`/api/sessions/${session.id}/approvals`)).json()).approvals ?? []).length, { timeout: 30_000 }).toBe(1);
          }
          await page.goto("/");
          const allow = page.getByTestId("home-allow").first();
          await expect(allow).toBeVisible();
          await shoot(page, `phone-home-${size.width}-${scale}`);
          const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
          // The first answer is whole in the page where it opens, with no scroll, and the box is a line of one finger.
          await expect(allow).toBeInViewport({ ratio: 1 });
          const start = page.getByTestId("new-composer");
          await expect(start).toBeInViewport({ ratio: 1 });
          expect((await start.boundingBox())!.height, "the start box rests as about one line").toBeLessThanOrEqual(4 * rem);
          // A tap on it brings the heading, the pickers and its tools.
          await start.locator("textarea").tap();
          await expect(page.getByTestId("home-start").getByText("Start a session")).toBeVisible();
          await expect(start.getByTestId("composer-tools")).toBeVisible();
          await shoot(page, `phone-home-tapped-${size.width}-${scale}`);
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
        } finally {
          for (const id of made) { await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {}); await request.delete(`/api/sessions/${id}`).catch(() => {}); }
        }
      });
    });
  }
}
