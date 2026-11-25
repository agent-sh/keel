import { expect, test } from "./isolate.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { calls, create, drop, folder, scripted } from "./answering.ts";
import { shoot } from "./shots.ts";

// Feature: the card the owner is looking at stays where it is when another request arrives. The region above
// the box goes to the oldest request only when that card is out of view, and the agents line does not
// shift what is shown: the card's Allow takes a press at once, with no "it moved a moment ago".
test.use({ storageState: { cookies: [], origins: [] } });

const bash = (command: string) => ({ name: "Bash", input: { command } });
const spawn = (message: string) => ({ name: "spawn_agent", input: { message, isolation: "none" } });
const question = { name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color should I use?", options: [{ label: "Teal" }, { label: "Amber" }], multiSelect: false }] } };

for (const size of [{ width: 1920, height: 1040 }, { width: 390, height: 844 }]) {
  test(`a request that arrives leaves the card on screen where it is at ${size.width}x${size.height}`, async ({ page, request }) => {
    await scripted(request);
    await page.setViewportSize(size);
    const ws = folder("tray-still");
    const root = await create(request, "Coordinator", ws);
    const ids = [root];
    try {
      await request.put(`/api/sessions/${root}/permissions`, { data: { mode: "ask", sandbox: "off" } });
      // Alpha asks to run a command at once; the question of its agent Gamma comes a few seconds later.
      const gamma = `Gamma\n${calls([{ ...question, after_ms: 9000 }])}`;
      const alpha = `Alpha\n${calls([spawn(gamma), bash("touch alpha.txt")])}`;
      await request.post(`/api/sessions/${root}/messages`, { data: { text: calls([spawn(alpha)]) } });
      await page.goto(`/s/${root}`);
      const station = page.locator(`[data-station="${root}"]`);
      const allow = station.locator('[data-testid="child-asks"]').getByTestId("allow-once");
      await expect(allow).toBeVisible({ timeout: 45_000 });
      await expect(allow).not.toHaveAttribute("aria-disabled", "true", { timeout: 10_000 });
      // The first minutes of the transcript (the agents starting) are over: the card stands still before the request comes.
      await expect.poll(async () => { const a = (await allow.boundingBox())!.y; await page.waitForTimeout(700); return Math.abs((await allow.boundingBox())!.y - a); }, { timeout: 15_000 }).toBe(0);
      await shoot(page, `tray-still-01-${size.width}`);
      // Watch the Allow on every frame until the grandchild's question is drawn.
      const seen = await page.evaluate(() => new Promise<{ tops: number[]; disabled: boolean }>((done) => {
        const tops: number[] = [];
        let disabled = false;
        const a = () => document.querySelector<HTMLElement>('[data-testid="child-asks"] [data-testid="allow-once"]')!;
        let after = 0;
        const frame = () => {
          const el = a();
          tops.push(Math.round(el.getBoundingClientRect().top * 10) / 10);
          if (el.getAttribute("aria-disabled") === "true") disabled = true;
          if (document.querySelector('[data-testid="child-asks"] [data-testid="question"]')) after++;
          if (after > 90) done({ tops, disabled }); else requestAnimationFrame(frame);
        };
        frame();
      }));
      // (The transcript's own row above may grow by a pixel as its agent's state changes: the card stands under it.)
      expect(Math.max(...seen.tops) - Math.min(...seen.tops), `the Allow's top on each frame: ${[...new Set(seen.tops)].join(", ")}`).toBeLessThan(2);
      expect(seen.disabled).toBe(false);
      await shoot(page, `tray-still-02-${size.width}`);
      // A press right after the request arrived is taken.
      await allow.click({ timeout: 3000 });
      await expect.poll(() => existsSync(join(ws, "alpha.txt")), { timeout: 30_000 }).toBe(true);
      // With the first request answered, the region goes to the one that waited below it.
      await expect.poll(() => page.evaluate(() => {
        const box = document.querySelector('[data-testid="composer-tray"]')!.getBoundingClientRect();
        const at = document.querySelector('[data-testid="question-option"]')!.getBoundingClientRect();
        return at.top >= box.top - 1 && at.bottom <= box.bottom + 1;
      }), { timeout: 10_000 }).toBe(true);
      await shoot(page, `tray-still-03-${size.width}`);
    } finally {
      await drop(request, ...ids.reverse());
    }
  });
}
