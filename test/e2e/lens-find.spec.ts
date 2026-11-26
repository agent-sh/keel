import { expect, test, type Page } from "./isolate.ts";
import { rmSync } from "node:fs";
import { daemon, exited, seeded } from "./own-daemon.ts";
import { shoot } from "./shots.ts";

// Feature: Find inside the Conversation lens. The find key over the lens is the page's Find, not
// the browser's: it counts the matches of the whole conversation from the daemon's index (the lens
// holds no stretch's words), and a match inside a folded stretch opens only that stretch, read as
// far as the match, and only the call whose output holds it, in view and marked. Going on to a
// match in another stretch folds the first back; Escape folds back what Find opened, leaves what
// the owner opened, and puts the view back where it stood. The session is never read whole.

const WORD = "wombatique";

const marked = (page: Page) => page.evaluate(() => {
  const h = (CSS as any).highlights as Map<string, { values(): IterableIterator<Range>; size: number }>;
  const now = h.get("keel-find-now");
  return { now: now ? [...now.values()].map((r) => r.toString()).join("|") : "", all: h.get("keel-find")?.size ?? 0 };
});

test("find in the lens opens only the stretch and the call that hold the match, and Escape folds them back", async ({ page }) => {
  // 1500 events: stretches of about 300; the word is in a call's output 220 events into the second
  // stretch (past the part a stretch opens with) and in an early call of the third.
  const { state, ids: [id] } = seeded("lens-find", 1500, { shape: "coordinator", env: { KEEL_FIXTURE_FIND: WORD } }, "Coordinator");
  const d = await daemon(state);
  try {
    const all = ((await (await fetch(`${d.url}/api/sessions/${id}/events`)).json()) as any).events as { id: string; seq: number; kind: string; data: any }[];
    const results = all.filter((e) => e.kind === "tool_result" && JSON.stringify(e.data).includes(WORD));
    expect(results).toHaveLength(2);
    const [deep, early] = results.map((e) => ({ seq: e.seq, call: e.data.results[0].tool_use_id as string }));
    // (A store written before its daemon started is indexed once the start's own work is over.)
    await expect.poll(async () => ((await (await fetch(`${d.url}/api/search?q=${WORD}`)).json()) as any).hits.length, { timeout: 60_000 }).toBe(2);

    await page.setViewportSize({ width: 1920, height: 1040 });
    const asked: string[] = [];
    page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith(`/api/sessions/${id}/`)) asked.push(u.pathname + u.search); });
    await page.goto(`${d.url}/s/${id}`);
    const lens = page.getByTestId("lens");
    await expect(lens).toBeVisible({ timeout: 30_000 });
    const runs = lens.getByTestId("lens-run");
    await expect(runs.first()).toBeVisible();
    // Which stretch holds which match, by the seqs each line stands for.
    const spans = await runs.evaluateAll((els) => els.map((el) => el.getAttribute("data-events")!));
    const seqOf = new Map(all.map((e) => [e.id, e.seq]));
    const runOf = (seq: number) => spans.findIndex((s) => { const [a, b] = s.split(" ").map((x) => seqOf.get(x)!); return a! <= seq && seq <= b!; });
    const deepRun = runs.nth(runOf(deep!.seq)), earlyRun = runs.nth(runOf(early!.seq));
    expect(runOf(deep!.seq)).toBeGreaterThan(0);
    expect(runOf(early!.seq)).toBeGreaterThan(runOf(deep!.seq));
    const open = lens.locator('[data-testid="lens-run"][data-open]');

    // The owner opens the first stretch himself: Find leaves it open.
    await runs.nth(0).getByTestId("lens-run-toggle").click();
    await expect(runs.nth(0).getByTestId("lens-run-stream")).toBeVisible();
    await lens.hover();
    await page.mouse.wheel(0, -300);
    const scroller = page.locator(".k-reading");
    await page.waitForTimeout(200);
    const top = await scroller.evaluate((el) => el.scrollTop);

    // The key is the page's: from the message box it opens the bar over the lens.
    await page.getByTestId("composer").focus();
    await page.keyboard.press("Control+f");
    await expect(page.getByTestId("find-input")).toBeFocused();
    await page.keyboard.type(WORD);
    await expect(page.getByTestId("find-count")).toHaveText(/ of 2$|^2 matches$/, { timeout: 15_000 });
    // To the first match: the deep one in the second stretch.
    while ((await page.getByTestId("find-count").textContent()) !== "1 of 2") await page.getByTestId("find-next").click();
    await page.getByTestId("find-input").focus();
    const deepCard = deepRun.locator(`[data-testid="tool-call"][data-call="${deep!.call}"]`).last();
    await expect(deepCard).toHaveAttribute("data-open", "", { timeout: 30_000 });
    await expect(deepCard.getByText(WORD)).toBeInViewport();
    await expect.poll(async () => (await marked(page)).now).toBe(WORD);
    // Only that stretch opened (and the owner's own), and in it only that call.
    await expect(deepRun).toHaveAttribute("data-open", "true");
    await expect(open).toHaveCount(2);
    await expect(deepRun.locator('[data-testid="tool-call"][data-open]')).toHaveCount(1);
    // The stretch was read part by part as far as the match, never the session whole.
    expect(asked.filter((u) => u.includes("/page?")).length).toBeGreaterThanOrEqual(3);
    expect(asked.some((u) => u.startsWith(`/api/sessions/${id}/find?`))).toBe(true);
    expect(asked.some((u) => u.startsWith(`/api/sessions/${id}/events`))).toBe(false);
    await shoot(page, "lens-find-01-deep-match");

    // Enter: the match in the third stretch. The second folds back.
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-count")).toHaveText("2 of 2");
    const earlyCard = earlyRun.locator(`[data-testid="tool-call"][data-call="${early!.call}"]`).last();
    await expect(earlyCard).toHaveAttribute("data-open", "", { timeout: 30_000 });
    await expect(earlyCard.getByText(WORD)).toBeInViewport();
    await expect(deepRun).not.toHaveAttribute("data-open", /.*/);
    await expect(open).toHaveCount(2);
    await expect.poll(async () => (await marked(page)).now).toBe(WORD);
    await shoot(page, "lens-find-02-next-stretch");

    // Escape: the bar closes, its marks go, what it opened folds back, the owner's stretch stays
    // open, and the view is where it stood.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await expect(earlyRun).not.toHaveAttribute("data-open", /.*/);
    await expect(deepRun).not.toHaveAttribute("data-open", /.*/);
    await expect(runs.nth(0)).toHaveAttribute("data-open", "true");
    await expect(open).toHaveCount(1);
    expect(await marked(page)).toEqual({ now: "", all: 0 });
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeCloseTo(top, -1);
    await expect(page.getByTestId("composer")).toBeFocused();
    // Opened by hand again, the work Find opened is folded as it was, and no call is open.
    await earlyRun.getByTestId("lens-run-toggle").click();
    await expect(earlyRun.getByTestId("lens-run-stream")).toBeVisible();
    await expect(earlyRun.getByTestId("work-fold").first()).toBeVisible();
    await expect(earlyRun.locator('[data-testid="tool-call"][data-open]')).toHaveCount(0);
  } finally {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    rmSync(state, { recursive: true, force: true });
  }
});
