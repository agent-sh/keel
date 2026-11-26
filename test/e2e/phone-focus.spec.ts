import { expect, test, type Page } from "./isolate.ts";
import { ask, calls, create, drop, folder, scripted } from "./answering.ts";
import { shoot } from "./shots.ts";

// Feature: Focus on a phone (ui/src/lib/focus.ts), the default there as at a desk. A session is the
// conversation and the message box under a bar that holds the list's button, card or no card: the list
// is one tap away. No strip of marks runs along the bottom; what needs the owner in other sessions is a
// quiet dot and figure in the bar that goes to the next. The bar keeps the state's dot, not its clock.
// The box is one line, its plus, Stop and Send a line's small icons in a finger's target. The agents
// over the box are one quiet item, the word and how many, never their names.

const rootPx = (page: Page) => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
const sleeper = (title: string) => ({ name: "spawn_agent", input: { message: `${title}\n${calls([{ name: "Bash", input: { command: "sleep 120" } }])}` } });

for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test.describe(`Focus on a phone, ${size.width}x${size.height}`, () => {
    // No saved choice: what the owner sees the first time.
    test.use({ storageState: { cookies: [], origins: [] }, viewport: size, hasTouch: true, isMobile: true });
    test.setTimeout(120_000);

    test("the conversation and a one-line box, the list one tap away, the agents one quiet item", async ({ page, request }) => {
      const model = await scripted(request);
      test.skip(!model, "needs the scripted stand-in: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
      const coord = await create(request, "Phone coordinator", folder("phone-focus-coord"));
      const asker = await create(request, "Phone asks for a command", folder("phone-focus-asker"));
      try {
        await request.put(`/api/sessions/${coord}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
        // Two agents at work and a command of its own: the turn runs, so Stop is in the box.
        await request.post(`/api/sessions/${coord}/messages`, { data: { text: calls([sleeper("Phone agent one"), sleeper("Phone agent two"), { name: "Bash", input: { command: "sleep 100" } }]) } });
        await page.goto(`/s/${coord}`);
        const pane = page.locator(".k-station[data-helm]");
        await expect(pane.getByTestId("composer")).toBeVisible();
        const px = await rootPx(page);

        // No strip of marks along the bottom; the bar holds the list's button and the state's dot, no clock.
        await expect(page.locator(".k-dock")).toBeHidden();
        await expect(pane.getByTestId("show-sidebar")).toBeVisible();
        await expect(pane.getByTestId("station-clock")).toBeHidden();

        // The agents: one quiet item, the word and how many are live, no names.
        await expect(page.getByTestId("dock-agents-count")).toHaveText("2", { timeout: 30_000 });
        await expect(page.getByTestId("dock-agents-line")).not.toContainText("Phone agent");
        await expect(page.getByTestId("dock-agent")).toHaveCount(0);
        expect(await page.getByTestId("dock-agents").locator(".k-agents-label").evaluate((e) => getComputedStyle(e).fontWeight)).toBe("400");

        // The box is one line while the turn runs: Stop and Send stand on the field's line, each drawn a line's icon.
        const box = pane.getByTestId("composer-box"), field = pane.getByTestId("composer");
        const stop = pane.getByTestId("stop"), send = pane.getByTestId("send");
        await expect(stop).toBeVisible({ timeout: 30_000 });
        const f = (await field.boundingBox())!, b = (await box.boundingBox())!;
        expect(b.height, `the box is ${b.height}px tall`).toBeLessThanOrEqual(f.height + 0.5 * px + 2);
        for (const btn of [stop, send]) {
          const r = (await btn.boundingBox())!;
          expect(r.y).toBeGreaterThanOrEqual(f.y - 1);
          expect(r.y + r.height).toBeLessThanOrEqual(f.y + f.height + 1);
          // A finger's target, but no fill or ring of that size: what shows is the icon.
          expect(r.height).toBeGreaterThanOrEqual(2.75 * px - 1);
          const look = await btn.evaluate((e) => { const s = getComputedStyle(e); return { bg: s.backgroundColor, border: s.borderTopWidth }; });
          expect(look.bg).toBe("rgba(0, 0, 0, 0)");
          expect(look.border).toBe("0px");
        }
        // Typed text gives Send its fill, a line's icon square.
        await field.fill("steer this");
        const fill = await send.evaluate((e) => { const s = getComputedStyle(e, "::before"); return { w: parseFloat(s.width), bg: s.backgroundColor }; });
        expect(fill.w).toBeLessThanOrEqual(1.75 * px + 1);
        expect(fill.bg).not.toBe("rgba(0, 0, 0, 0)");
        await field.fill("");
        // The mode and the model are behind the box's plus, with attach.
        await expect(box.getByTestId("model-picker")).toHaveCount(0);
        await box.getByTestId("box-more").click();
        await expect(page.getByTestId("box-more-popup").getByTestId("model-picker")).toBeVisible();
        await expect(page.getByTestId("box-more-popup").getByTestId("attach")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("box-more-popup")).toBeHidden();
        await shoot(page, `phone-focus-01-working-${size.width}`);

        // Another session asks: the bar says it as a quiet dot and figure, the list's button stays.
        await ask(request, asker, "approval", "phone");
        const need = pane.getByTestId("head-need");
        await expect(need).toBeVisible({ timeout: 30_000 });
        await expect(need).toHaveText(/^\d+ needs? you$/);
        expect(await need.locator(".k-dock-need-n").evaluate((e) => getComputedStyle(e).fontWeight)).toBe("400");
        // The list is one tap away, and the bar's count goes to the session that asks.
        await pane.getByTestId("show-sidebar").click();
        await expect(page.getByTestId("sidebar")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("sidebar")).toBeHidden();
        await need.click();
        await expect(page).toHaveURL(new RegExp(asker));
        // With its card on screen the bar keeps the list's button.
        const there = page.locator(".k-station[data-helm]");
        await expect(there.getByTestId("approval").first()).toBeVisible({ timeout: 30_000 });
        await expect(there.getByTestId("show-sidebar")).toBeVisible();
        await shoot(page, `phone-focus-02-card-${size.width}`);
      } finally {
        await drop(request, coord, asker);
      }
    });
  });
}
