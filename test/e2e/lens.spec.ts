import { expect, test, type Page } from "./isolate.ts";
import { daemon, exited, seeded } from "./own-daemon.ts";
import { shoot } from "./shots.ts";

// Feature: the Conversation lens. A session that has agents opens on the owner's
// own messages, the reply each of his turns ended with, and between them one
// folded line for each stretch of turns the harness started, saying what came of
// it (landed, failed, how long, what it spent). A line opens its stretch's full
// stream in place; the full stream is a choice away and is kept for the
// session; New since read lands on the first new item of the lens. The lens
// costs what it shows: its answer carries the bodies of the shown events alone.
// The spec runs its own daemon on a seeded coordinator of three days.

type Lens = { items: { t: string; id?: string; seq?: number; from?: number; to?: number }[]; events: Record<string, unknown>; last: { id: string; seq: number } };

const lensRead = (page: Page, id: string) => page.waitForResponse((r) => new URL(r.url()).pathname === `/api/sessions/${id}/lens`);

test("a session with agents opens on the conversation, its stretches folded and opened in place", async ({ page }) => {
  const { state, ids: [id] } = seeded("lens", 600, "coordinator", "Coordinator");
  const d = await daemon(state);
  try {
    await page.setViewportSize({ width: 1920, height: 1040 });
    const first = lensRead(page, id!);
    await page.goto(`${d.url}/s/${id}`);
    const lens = page.getByTestId("lens");
    await expect(lens).toBeVisible({ timeout: 30_000 });
    const answer = (await (await first).json()) as Lens;
    // Four messages of the owner's, the four replies, a stretch after each.
    await expect(lens.locator('[data-lens-item="you"]')).toHaveCount(4);
    await expect(lens.locator('[data-lens-item="reply"]')).toHaveCount(4);
    await expect(lens.getByText("Start three workers on the parser lanes and land what passes.")).toBeVisible();
    // It costs what it shows: the bodies of the eight shown events, none of a folded stretch's hundreds.
    expect(Object.keys(answer.events).length).toBe(8);
    const runs = lens.getByTestId("lens-run");
    await expect(runs).toHaveCount(8);
    // What came of a stretch of the harness's turns, first: what landed and what failed, then what it took.
    const failedRun = runs.filter({ has: page.locator('[data-testid="lens-run-came"]', { hasText: "1 failed" }) });
    await expect(failedRun).toHaveCount(1);
    await expect(failedRun.getByTestId("lens-run-came")).toHaveText("4 landed, 1 failed");
    await expect(failedRun.getByTestId("lens-run-took")).toContainText("20 turns, 15 agent reports, 3 wakes");
    await expect(failedRun).toHaveAttribute("data-state", "failed");
    await shoot(page, "lens-01-conversation");

    // A stretch opens its stream in place: the agents' reports and the turns they started, read when asked.
    const part = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/sessions/${id}/page`);
    await failedRun.getByTestId("lens-run-toggle").click();
    await part;
    const stream = failedRun.getByTestId("lens-run-stream");
    await expect(stream.getByText(/Noted report 4:/)).toBeVisible();
    await expect(failedRun.getByTestId("lens-run-toggle")).toHaveAttribute("aria-expanded", "true");
    if (await failedRun.getByTestId("lens-run-more").isVisible()) await failedRun.getByTestId("lens-run-more").click();
    await expect(stream.getByText(/Noted report 18:/)).toBeVisible();
    await shoot(page, "lens-02-stretch-open");
    await failedRun.getByTestId("lens-run-toggle").click();
    await expect(stream).toHaveCount(0);

    // A message of the owner's now: it is in the lens, and so is the reply.
    await page.getByTestId("composer").fill("script:say The lanes are all landed.");
    await page.getByTestId("composer").press("Enter");
    await expect(lens.locator('[data-lens-item="you"]')).toHaveCount(5, { timeout: 20_000 });
    await expect(lens.locator('[data-lens-item="reply"]').last()).toContainText("The lanes are all landed.", { timeout: 30_000 });

    // The full stream is a choice away, and kept for this session across a reload. (It is what the
    // session showed before the lens: every report, every call.)
    await page.getByTestId("lens-to-stream").click();
    await expect(page.getByTestId("transcript")).toBeVisible();
    await expect(lens).toHaveCount(0);
    await shoot(page, "lens-00-full-stream");
    await page.reload();
    await expect(page.getByTestId("transcript")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(300);
    await expect(page.getByTestId("lens")).toHaveCount(0);
    await page.getByTestId("session-menu").click();
    await page.getByTestId("menu-lens").click();
    await expect(page.getByTestId("lens")).toBeVisible();

    // New since read lands on the first new item of the lens: the place is read up to the
    // second reply, so the stretch after it is where what is new starts.
    const reply2 = answer.items.filter((x) => x.t === "reply")[1]!;
    const readEvent = reply2.id!;
    // (Set before the page's own code runs, once: the page leaving writes its own places first.)
    await page.goto("about:blank");
    await page.addInitScript(({ sid, ev, seq }) => {
      if (location.pathname !== `/s/${sid}` || sessionStorage.getItem("lens-read-set")) return;
      sessionStorage.setItem("lens-read-set", "1");
      const all = JSON.parse(localStorage.getItem("keel.places") ?? "{}");
      all[sid] = { ...all[sid], read: ev, readSeq: seq, readAt: Date.now() - 3600_000, at: Date.now() };
      localStorage.setItem("keel.places", JSON.stringify(all));
    }, { sid: id!, ev: readEvent, seq: reply2.seq! });
    await page.goto(`${d.url}/s/${id}`);
    await expect(page.getByTestId("lens")).toBeVisible({ timeout: 30_000 });
    const jump = page.getByTestId("new-since-jump");
    await expect(jump).toBeVisible();
    await shoot(page, "lens-03-new-since");
    await jump.click();
    const rule = page.locator('[data-testid="lens"] [data-new-since]');
    await expect(rule).toHaveCount(1);
    // The first new item is the stretch right after the reply that was read.
    await expect(rule).toHaveAttribute("data-testid", "lens-run");
    await expect(rule.getByTestId("lens-run-came")).toHaveText("4 landed, 1 failed");
    const box = await rule.boundingBox();
    expect(box!.y).toBeLessThan(200);
    // In view, the way to it goes; read down to the end, what was new is read and the rule goes too.
    await expect(jump).toHaveCount(0);
    await page.getByTestId("lens").hover();
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 4000);
    await expect(rule).toHaveCount(0, { timeout: 15_000 });

    // A phone: the line keeps its outcome on one row and wraps what it took under it.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("lens-run").last().scrollIntoViewIfNeeded();
    await shoot(page, "lens-04-phone");
  } finally {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
  }
});
