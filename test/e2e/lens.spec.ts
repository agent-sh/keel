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

    // The owner comes back to a run that says what matters without opening it: its last words, the agents that
    // still work under it, and the question it ended asking him in prose. An agent at work first (its command runs on).
    const api = page.request;
    await api.put(`${d.url}/api/sessions/${id}/permissions`, { data: { mode: "full-auto" } });
    const sleeper = [{ name: "Bash", input: { command: "sleep 240", run_in_background: true, description: "Long lane run" } }];
    await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: `Long lane\nscript:calls ${JSON.stringify(sleeper)}`, isolation: "none" } }])}`);
    await page.getByTestId("composer").press("Enter");
    const stateOf = async () => ((await (await api.get(`${d.url}/api/state`)).json()).states as Record<string, { watch: string; why?: string; text?: string; agents: number; parked?: number }>)[id!]!;
    await expect.poll(async () => { const s = await stateOf(); return s.agents - (s.parked ?? 0); }, { timeout: 30_000 }).toBe(1);
    // A question his own turn's reply ends with is his to read now: nothing is owed for it.
    const ask = "Shall I land the parser lanes now?";
    await page.getByTestId("composer").fill(`script:say The lanes are ready.\\n\\n${ask}`);
    await page.getByTestId("composer").press("Enter");
    await expect(lens.locator('[data-lens-item="reply"]').last()).toContainText(ask, { timeout: 30_000 });
    await expect.poll(async () => (await stateOf()).watch, { timeout: 15_000 }).toBe("work");
    // A wake starts a turn nobody asked for, and its reply ends asking him: one more run, once its turn ended.
    const runsBefore = await runs.count();
    expect((await api.post(`${d.url}/api/waits`, { data: { session_id: id, spec: { kind: "timer", seconds: 1 }, note: "check the lanes" } })).ok()).toBe(true);
    await expect(runs).toHaveCount(runsBefore + 1, { timeout: 30_000 });
    // (Its turn ended: the last run is settled.)
    await expect.poll(async () => { const it = ((await (await api.get(`${d.url}/api/sessions/${id}/lens`)).json()) as { items: { t: string; open?: boolean }[] }).items.at(-1); return it?.t === "run" && !it.open; }, { timeout: 30_000 }).toBe(true);
    const last = runs.last();
    await shoot(page, "lens-05-asks-you");
    // The owner's window: the workbench at the small text size, where the dock is.
    await page.setViewportSize({ width: 1320, height: 860 });
    await page.evaluate(() => dispatchEvent(new CustomEvent("keel-look", { detail: { view: "workbench", scale: 0.9 } })));
    await expect(last.getByTestId("lens-run-came")).toBeVisible();
    await shoot(page, "lens-06-asks-you-1320x860-small");
    await expect(last.getByTestId("lens-run-came")).toHaveText("Asks you, 1 agent at work");
    await expect(last.getByTestId("lens-run-said")).toHaveText(ask);
    await expect(last).toHaveAttribute("data-state", "needs");
    // The session's state counts it as needing him, and so does the dock.
    await expect.poll(async () => { const s = await stateOf(); return `${s.watch} ${s.why} ${s.text}`; }, { timeout: 15_000 }).toBe(`need prose Asks you: ${ask}`);
    await expect(page.getByTestId("dock-now")).toHaveAttribute("data-watch", "need");
    await page.evaluate(() => dispatchEvent(new CustomEvent("keel-look", { detail: null })));
    await page.setViewportSize({ width: 1920, height: 1040 });
    // Every other run says its last words.
    await expect(runs.nth(1).getByTestId("lens-run-said")).toHaveText(/^Noted report \d+:/);
    // His answer is what pays it: the run before it is history, and the session works on.
    await page.getByTestId("composer").fill("script:say Not yet.");
    await page.getByTestId("composer").press("Enter");
    await expect.poll(async () => (await stateOf()).watch, { timeout: 15_000 }).toBe("work");
    await expect(lens.locator('[data-lens-item="reply"]').last()).toContainText("Not yet.", { timeout: 30_000 });
    await expect(lens.getByTestId("lens-run-came").filter({ hasText: "Asks you" })).toHaveCount(0);

    // The full stream is a choice away, and kept for this session across a reload. (It is what the
    // session showed before the lens: every report, every call.)
    await page.getByTestId("lens-to-stream").click();
    await expect(page.getByTestId("transcript")).toBeVisible();
    await expect(lens).toHaveCount(0);
    await shoot(page, "lens-00-full-stream");
    await page.reload();
    await expect(page.getByTestId("transcript")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("lens")).toHaveCount(0);
    // This spec's own daemon is on another origin, so it opens in Focus.
    await page.getByTestId("focus-leave").click({ timeout: 10_000 });
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

// The lens reads on its own: with the stream's snapshot held back, the lens's own text paints, and nothing waits for
// a question about the session's agents when the list already counts them. Once the snapshot comes, the message box
// keeps what was typed meanwhile and the full stream is a press away.
test("the lens paints its text while the stream's snapshot is held back", async ({ page }) => {
  const { state, ids: [id] } = seeded("lens-alone", 600, "coordinator", "Coordinator");
  const d = await daemon(state);
  try {
    await page.setViewportSize({ width: 1320, height: 860 });
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const asked: string[] = [];
    page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith(`/api/sessions/${id}`)) asked.push(u.pathname.slice(`/api/sessions/${id}`.length) + u.search); });
    await page.route((u) => u.pathname === `/api/sessions/${id}` && u.searchParams.has("page"), async (route) => { await held; await route.continue(); });
    await page.goto(`${d.url}/`);
    await page.locator(`[data-testid="session-row"][data-session="${id}"]`).locator("visible=true").first().click();
    const lens = page.getByTestId("lens");
    await expect(lens.locator('[data-lens-item="reply"]').last()).toContainText("Reply to your message 4");
    expect(asked.some((a) => a.startsWith("?page="))).toBe(true); // asked, and still held
    expect(asked.filter((a) => a === "/has-agents")).toEqual([]);
    await page.getByTestId("composer").fill("Typed while the stream was on its way");
    await shoot(page, "lens-05-alone");
    release();
    await expect(page.getByTestId("composer")).toHaveValue("Typed while the stream was on its way");
    await page.getByTestId("lens-to-stream").click();
    await expect(page.getByTestId("transcript")).toContainText("Reply to your message 4");
    await expect(page.getByTestId("composer")).toHaveValue("Typed while the stream was on its way");
  } finally {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
  }
});
