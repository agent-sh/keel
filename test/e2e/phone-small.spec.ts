import { expect, test, type WebSocketRoute } from "./isolate.ts";
import { ask, create, folder, scripted } from "./answering.ts";
import { shoot } from "./shots.ts";

// Feature: the small things a phone needs said. A request that came while the socket was down is read out
// to a screen reader once the page has caught up (one line, when what waits grew). In a session the
// message box says where the mic is on a phone: the keyboard's own. A phone on its side has no dock, so
// the head says how many need the owner, and a press opens the next one.

const SIZES = [{ width: 390, height: 844 }, { width: 412, height: 915 }, { width: 844, height: 390 }];

for (const size of SIZES) {
  for (const scale of [1, 1.5]) {
    test.describe(`on a phone, ${size.width}x${size.height} at ${scale * 100}% text`, () => {
      test.use({ viewport: size, hasTouch: true, isMobile: true });
      test.setTimeout(90_000);
      test.beforeEach(async ({ page, request }) => {
        await scripted(request);
        await page.addInitScript((s) => localStorage.setItem("keel.textScale", String(s)), scale);
      });

      // (The words do not depend on the text size: one run a size.)
      if (scale === 1) test("a request that came while the socket was down is announced once after the reconnect", async ({ page, request }) => {
        const quiet = await create(request, "Quiet phone session", folder("phone-small-quiet"));
        const asker = await create(request, "Asks while the socket is down", folder("phone-small-asks"));
        // What the screen reader is told: each text the status region takes, in order (the region is emptied between two).
        await page.addInitScript(() => {
          const told: string[] = [];
          (window as unknown as { __told: string[] }).__told = told;
          let was = "";
          new MutationObserver(() => {
            const t = document.querySelector('[data-testid="announce-status"]')?.textContent ?? "";
            if (t && t !== was) told.push(t);
            was = t;
          }).observe(document, { subtree: true, childList: true, characterData: true });
        });
        // The page's socket can be cut, and kept from opening again.
        const net: { ws?: WebSocketRoute; down: boolean } = { down: false };
        await page.routeWebSocket(/\/ws$/, (ws) => { if (net.down) return void ws.close({ code: 4000, reason: "down for the test" }); ws.connectToServer(); net.ws = ws; });
        await page.goto(`/s/${quiet}`);
        await expect(page.locator(".k-station[data-helm]").getByTestId("composer")).toBeVisible();
        await expect(page.getByTestId("daemon-away")).toHaveCount(0);

        net.down = true;
        net.ws!.close({ code: 4000, reason: "down for the test" });
        await expect(page.getByTestId("daemon-away")).toBeVisible({ timeout: 30_000 });
        // The request comes while the page cannot hear it.
        await ask(request, asker, "approval", "late");
        const told = () => page.evaluate(() => (window as unknown as { __told: string[] }).__told);
        expect(await told(), "nothing is said while the socket is down").toEqual([]);

        net.down = false;
        await expect(page.getByTestId("daemon-away")).toHaveCount(0, { timeout: 60_000 });
        await expect.poll(async () => (await told()).filter((t) => /Back online/.test(t)).length, { timeout: 30_000 }).toBe(1);
        const line = (await told()).find((t) => /Back online/.test(t))!;
        expect(line).toMatch(/^Back online: \d+ needs? you, \d+ new\.$/);
        // Said once: the page catching up further does not say it again.
        await page.waitForTimeout(3000);
        expect((await told()).filter((t) => /Back online/.test(t))).toHaveLength(1);
      });

      test("the box says the keyboard is the mic where the session has none of its own", async ({ page, request }) => {
        const id = await create(request, "Mic in the keyboard", folder("phone-small-mic"));
        await page.goto(`/s/${id}`);
        const pane = page.locator(".k-station[data-helm]");
        const box = pane.getByTestId("composer");
        await expect(box).toBeVisible();
        // At rest the box is one line and its tools are one tap away; with them open the mic's place is the hint's.
        if (await pane.getByTestId("composer-open").isVisible()) await pane.getByTestId("composer-open").click();
        await expect(pane.getByTestId("composer-tools")).toBeVisible();
        await expect(pane.getByTestId("dictate")).toBeHidden();
        await expect(box).toHaveAttribute("placeholder", /keyboard's mic/);
        // The hint is whole: the box holds it on the lines it has, and the tools stay in the page.
        const fit = await box.evaluate((el: HTMLTextAreaElement) => ({ rows: el.scrollHeight <= el.clientHeight + 1 }));
        expect(fit.rows, "the hint is not cut off").toBe(true);
        await expect(pane.getByTestId("converse")).toBeInViewport({ ratio: 1 });
        await shoot(page, `phone-small-mic-${size.width}x${size.height}-${scale * 100}`);
      });
    });
  }
}
