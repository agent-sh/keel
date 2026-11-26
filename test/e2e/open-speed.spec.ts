import { expect, test, type Page } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { daemon, exited, seeded, specEnv } from "./own-daemon.ts";
import { shoot } from "./shots.ts";

// Feature: a press on a session shows its text at once. The page measures each opening itself, from the
// press to the frame after the conversation's first rows were laid out (`keel:open-text`, ui/src/lib/open-mark.ts),
// and this spec holds it to its bounds at 1920x1040: under 400 ms for a session the daemon has not read since
// it started, under 150 ms for one it holds. The spec runs its own daemon on a seeded store: a long chat
// (the full stream) and a coordinator of 300 messages of the owner's with agents (the Conversation lens), whose
// lens is read for its newest turns first and whole after its text shows.

const COLD_MS = 400, WARM_MS = 150;

// One press on the session's row in the list, and how long its text took by the page's own measure.
async function press(page: Page, id: string): Promise<number> {
  await page.evaluate(() => performance.clearMeasures("keel:open-text"));
  await page.locator(`[data-testid="session-row"][data-session="${id}"]`).locator("visible=true").first().click();
  const h = await page.waitForFunction((id) => performance.getEntriesByName("keel:open-text").find((e) => (e as PerformanceMeasure).detail?.session === id)?.duration, id, { timeout: 30_000 });
  return Math.round((await h.jsonValue()) as number);
}

// Back to the start page, whose list holds the rows.
async function home(page: Page) {
  await page.goBack();
  await expect(page.locator('[data-testid="session-row"]').locator("visible=true").first()).toBeVisible();
}

test("a session's text shows within the bounds, cold and in memory, stream and lens", async ({ page }) => {
  const { state, ids: [coord] } = seeded("open-speed", 9000, { shape: "coordinator", env: { KEEL_FIXTURE_ASKS: "300" } }, "Coordinator");
  const [chat] = JSON.parse(execFileSync("bun", [join(import.meta.dirname, "fixtures/long-transcript.ts"), state, state, "2000", "Long chat"], { encoding: "utf8", env: { ...specEnv(state), KEEL_FIXTURE_SHAPE: "turns" } })) as string[];
  const d = await daemon(state);
  try {
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${d.url}/`);
    await expect(page.locator(`[data-testid="session-row"][data-session="${chat}"]`).locator("visible=true").first()).toBeVisible({ timeout: 30_000 });
    const took: Record<string, number> = {};

    // Not read by the daemon since it started: its rows come off the disk on the press.
    took.chatCold = await press(page, chat!);
    await expect(page.getByTestId("transcript")).toContainText(/Reply \d+ ends here\./);
    await shoot(page, "open-speed-01-chat");
    await home(page);
    // A long coordinator's lens is read first for its newest turns, then whole: the older items come in above.
    const whole = page.waitForResponse((r) => { const u = new URL(r.url()); return u.pathname === `/api/sessions/${coord}/lens` && !u.search; });
    const lensReads: string[] = [];
    page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname === `/api/sessions/${coord}/lens`) lensReads.push(u.search); });
    took.coordCold = await press(page, coord!);
    const lens = page.getByTestId("lens");
    await expect(lens.locator('[data-lens-item="you"]').last()).toContainText("Message 300:");
    await whole;
    await expect(lens.locator('[data-lens-item="you"]')).toHaveCount(300);
    expect(lensReads.slice(0, 2)).toEqual(["?turns=200", ""]);
    await shoot(page, "open-speed-02-lens");

    // In memory: opened again.
    await home(page);
    took.chatWarm = await press(page, chat!);
    await home(page);
    took.coordWarm = await press(page, coord!);
    // The lens draws its newest screen first and the older items after it: all of them come.
    await expect(lens.locator('[data-lens-item="you"]')).toHaveCount(300);

    // A fresh page, the daemon holding the session: the row the hand rests on is read before the press.
    await page.goto(`${d.url}/`);
    const row = page.locator(`[data-testid="session-row"][data-session="${coord}"]`).locator("visible=true").first();
    const ahead = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/sessions/${coord}/lens`);
    await row.hover();
    await ahead;
    took.coordRested = await press(page, coord!);

    console.log(`open-speed: ${JSON.stringify(took)}`);
    expect(took.chatCold).toBeLessThan(COLD_MS);
    expect(took.coordCold).toBeLessThan(COLD_MS);
    expect(took.chatWarm).toBeLessThan(WARM_MS);
    expect(took.coordWarm).toBeLessThan(WARM_MS);
    expect(took.coordRested).toBeLessThan(WARM_MS);
  } finally {
    d.proc.kill();
    await exited(d.proc);
  }
});
