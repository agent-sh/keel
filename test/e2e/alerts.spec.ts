import { expect, test } from "./isolate.ts";
import { existsSync, readFileSync } from "node:fs";
import { HAIKU, shoot } from "./shots.ts";

// Feature: a turn that finishes while the owner looks elsewhere becomes an
// alert: unread in the inbox and on the session row, sent to the command hook
// (KEEL_NOTIFY_COMMAND). Reading the session clears it; mark all read is always
// there; routes per kind are settings. The command hook is checked when the
// daemon runs with KEEL_NOTIFY_COMMAND=test/e2e/fixtures/notify-log.sh and this
// spec gets the same KEEL_NOTIFY_LOG; another daemon's log is never read.
const NOTIFY_LOG = process.env.KEEL_NOTIFY_LOG;

test("alerts: inbox, unread, command hook, routes", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  await request.post("/api/alerts/read", { data: {} });
  // The command hook is checked only on a daemon started with KEEL_NOTIFY_COMMAND.
  const hooked = (await (await request.get("/api/alerts/settings")).json()).channels.some((c: any) => c.id === "command" && c.available);

  await page.goto("/");
  await expect(page.getByTestId("new-composer")).toBeVisible();
  // The turn runs while the page shows the home screen, not this session.
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, text: "Reply with only the word done." } })).json();
  await expect(page.getByTestId("inbox-count")).toHaveText("1", { timeout: 60_000 });
  // The rail: an unread session stands out.
  const row = page.locator(`[data-testid="session-row"][data-session="${session.id}"]`);
  await expect(row).toHaveAttribute("data-unread", "true");
  await shoot(page, "alerts-01-unread");

  if (hooked && NOTIFY_LOG) {
    // The hook is not waited for by the daemon: wait for this session's line.
    const sent = () =>
      (existsSync(NOTIFY_LOG) ? readFileSync(NOTIFY_LOG, "utf8").trim().split("\n") : [])
        .filter(Boolean).map((l) => JSON.parse(l)).find((a) => a.session_id === session.id);
    await expect.poll(sent, { timeout: 10_000 }).toMatchObject({ kind: "finished", session_id: session.id });
  }

  await page.getByTestId("inbox-button").click();
  await expect(page.getByTestId("inbox-item").first()).toHaveAttribute("data-unread", "true");
  await expect(page.getByTestId("inbox-item").first()).toContainText("Done");
  await shoot(page, "alerts-02-inbox");

  // Opening the alert goes to the session and reads it.
  await page.getByTestId("inbox-item").first().click();
  await expect(page).toHaveURL(new RegExp(`/s/${session.id}`));
  await expect(page.getByTestId("inbox-count")).toHaveCount(0);
  await expect(row).not.toHaveAttribute("data-unread", "true");
  await shoot(page, "alerts-03-read");

  // Routes per kind are a settings section.
  await page.getByTestId("inbox-button").click();
  await page.getByTestId("alert-routes-link").click();
  await expect(page.getByTestId("alert-routes")).toBeVisible();
  const sw = page.getByTestId("route-finished-command");
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  const st = (await (await request.get("/api/alerts/settings")).json()).settings;
  expect(st.routes.finished).not.toContain("command");
  await shoot(page, "alerts-04-routes");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");

  // Mark all read is always offered.
  await page.getByTestId("inbox-button").click();
  await expect(page.getByTestId("mark-all-read")).toBeVisible();
  await page.getByTestId("mark-all-read").click();
  await expect(page.getByTestId("inbox-item").first()).not.toHaveAttribute("data-unread", "true");

  // Each kind speaks in its state color: violet needs you, amber an agent
  // speaking, red failed; the count takes the most urgent unread one.
  for (const kind of ["agent", "failed", "approval"]) await request.post("/api/alerts/test", { data: { kind } });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inbox-count")).toHaveAttribute("data-watch", "need");
  await page.getByTestId("inbox-button").click();
  const icons = page.getByTestId("inbox-item").getByTestId("alert-icon");
  await expect(icons.nth(0)).toHaveAttribute("data-watch", "need");
  await expect(icons.nth(1)).toHaveAttribute("data-watch", "fail");
  await expect(icons.nth(2)).toHaveAttribute("data-watch", "work");
  await expect(icons.nth(3)).toHaveAttribute("data-watch", "done");
  await expect(icons.nth(3)).toHaveAttribute("data-read", "true");
  await shoot(page, "alerts-05-states");
  await page.getByTestId("mark-all-read").click();

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// Each row says in words what it is and whether it is read; its read toggle is
// a button of its own that the keyboard reaches; a reminder marked unread
// stays while the owner sits on that session; a hook that refuses is shown
// as failed and retried alone; each route switch is saved as its own change.
test("alerts: rows by keyboard, kept unread, a failed hook, routes one by one", async ({ page, request }) => {
  // The refused hook below is the one failure expected (captured once, folded
  // into one row when it repeats); nothing else may fail.
  const others = async () => (await (await request.get("/api/errors")).json()).errors.filter((e: any) => !String(e.message).startsWith("KEEL_NOTIFY_COMMAND exited")).length;
  const errorsBefore = await others();
  await request.post("/api/alerts/read", { data: {} });
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Inbox fixture" } })).json();
  await request.post("/api/alerts/test", { data: { kind: "agent", session_id: session.id } });
  await page.goto("/");
  await page.getByTestId("inbox-button").click();
  const row = page.getByTestId("inbox-item").first();
  await expect(row.getByTestId("inbox-place")).toHaveText("Inbox fixture");
  await expect(row.getByTestId("inbox-open")).toHaveAccessibleName(/unread/);
  // Read by keyboard, without opening anything.
  await row.getByTestId("inbox-toggle-read").focus();
  await page.keyboard.press("Enter");
  await expect(row).not.toHaveAttribute("data-unread", "true");
  await expect(row.getByTestId("inbox-open")).toHaveAccessibleName(/\bread\b/);
  await expect(page).toHaveURL(/\/$/);
  await expect(row.getByTestId("inbox-toggle-read")).toHaveAccessibleName("Mark unread");
  await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("data-unread", "true");
  await shoot(page, "alerts-06-row-states");

  // Space opens the row's session, once.
  await row.getByTestId("inbox-open").focus();
  await page.keyboard.press("Space");
  await expect(page).toHaveURL(new RegExp(`/s/${session.id}`));
  // The open read only that alert; mark it unread again from the session page:
  // the page showing the session does not read it back.
  await page.getByTestId("inbox-button").click();
  const kept = page.locator(`[data-testid="inbox-item"]`).first();
  await kept.getByTestId("inbox-toggle-read").click();
  await expect(kept).toHaveAttribute("data-unread", "true");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2500); // the presence check runs every second
  const after = (await (await request.get("/api/alerts?with_unread")).json()).unread;
  expect(after.sessions[session.id]).toBe(1);
  // The unread view lists exactly what the count says.
  await page.getByTestId("inbox-button").click();
  await page.getByTestId("inbox-unread-filter").check();
  await expect(page.getByTestId("inbox-item")).toHaveCount(1);
  await page.getByTestId("mark-all-read").click();
  await expect(page.getByTestId("inbox-item")).toHaveCount(0);

  // A hook that refuses: shown as failed with its own Retry; the inbox keeps one alert.
  const hooked = (await (await request.get("/api/alerts/settings")).json()).channels.some((c: any) => c.id === "command" && c.available);
  if (hooked && NOTIFY_LOG) {
    const { writeFileSync, rmSync } = await import("node:fs");
    writeFileSync(`${NOTIFY_LOG}.fail`, "");
    try {
      await page.getByTestId("inbox-unread-filter").check();
      await request.post("/api/alerts/test", { data: { kind: "agent" } });
      const failed = page.getByTestId("inbox-item").first();
      await expect(failed.getByTestId("inbox-failed")).toContainText("Command hook failed");
      await shoot(page, "alerts-07-hook-failed");
    } finally {
      rmSync(`${NOTIFY_LOG}.fail`, { force: true });
    }
    await page.getByTestId("inbox-retry").click();
    // The row says no route again once it went through; where it went is its tooltip.
    await expect(page.getByTestId("inbox-item").first().getByTestId("inbox-state")).toHaveAttribute("title", "Sent to Command hook");
    await expect(page.getByTestId("inbox-failed")).toHaveCount(0);
    await page.getByTestId("mark-all-read").click();
  }

  // Two switches flipped before either save returns both stay off.
  await page.getByTestId("alert-routes-link").click();
  const a = page.getByTestId("route-approval-command"), q = page.getByTestId("route-question-desktop");
  const was = { a: await a.getAttribute("aria-checked"), q: await q.getAttribute("aria-checked") };
  await page.evaluate(() => {
    (document.querySelector('[data-testid="route-approval-command"]') as HTMLElement).click();
    (document.querySelector('[data-testid="route-question-desktop"]') as HTMLElement).click();
  });
  await expect(a).toHaveAttribute("aria-checked", was.a === "true" ? "false" : "true");
  await page.reload();
  await expect(a).toHaveAttribute("aria-checked", was.a === "true" ? "false" : "true");
  await expect(q).toHaveAttribute("aria-checked", was.q === "true" ? "false" : "true");
  await a.click();
  await q.click();
  await expect(a).toHaveAttribute("aria-checked", String(was.a));
  // The test button says where the alert went.
  await page.getByTestId("alert-test").click();
  await expect(page.getByTestId("alert-test-result")).toContainText(hooked ? "Sent to Command hook" : "Inbox only");
  await shoot(page, "alerts-08-test-result");
  await request.post("/api/alerts/read", { data: {} });
  await request.delete(`/api/sessions/${session.id}`);
  expect(await others()).toBe(errorsBefore);
});

// A row is a title, a state and one line of plain words. Where alerts go is
// said once, at the top of the list; a row names a route only when it failed.
// The Inbox is a drawer with a title, as Errors is.
test("alerts: a row is title, state and one line; routes are said once", async ({ page, request }) => {
  await request.post("/api/alerts/read", { data: {} });
  await page.goto("/");
  await expect(page.getByTestId("new-composer")).toBeVisible();
  // A reply that opens with a markdown heading, finished while the page is elsewhere.
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Write up the parser move", text: "script:render" } })).json();
  await expect(page.getByTestId("inbox-count")).toHaveText("1", { timeout: 60_000 });
  for (const kind of ["question", "failed", "approval"]) await request.post("/api/alerts/test", { data: { kind, session_id: session.id } });
  // A second session with one alert, of a kind that asks nothing of the owner.
  const { session: quiet } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Tidy the changelog" } })).json();
  await request.post("/api/alerts/test", { data: { kind: "agent", session_id: quiet.id } });
  // A third with one alert that waits on the owner, under a title longer than its line has room for.
  const { session: waits } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Decide which of the three plan names the pricing page should carry from next quarter on" } })).json();
  await request.post("/api/alerts/test", { data: { kind: "question", session_id: waits.id } });

  await page.getByTestId("inbox-button").click();
  const panel = page.getByTestId("inbox-panel");
  // A title on screen, in a drawer that starts at the window's edge, not over the rail's.
  const title = await panel.getByRole("heading", { name: "Inbox" }).boundingBox();
  expect(title!.height).toBeGreaterThan(12);
  expect((await panel.boundingBox())!.x).toBeLessThan(16);
  await page.getByTestId("inbox-unread-filter").check();
  const all = page.getByTestId("inbox-item");
  await expect(all).toHaveCount(6);
  // A session's only alert takes one line, its title beside it; no mark has a box around it;
  // weight is on what waits for the owner, not on every unread title.
  const lone = page.locator(`[data-testid="inbox-item"]`).filter({ hasText: "Tidy the changelog" });
  await expect(lone.getByTestId("inbox-place")).toHaveText("Tidy the changelog");
  expect((await lone.boundingBox())!.height).toBeLessThanOrEqual(40);
  expect(await lone.getByTestId("alert-icon").evaluate((el) => { const c = getComputedStyle(el); return `${c.boxShadow} ${c.backgroundColor}`; })).toBe("none rgba(0, 0, 0, 0)");
  expect(Number(await lone.getByTestId("inbox-place").evaluate((el) => getComputedStyle(el).fontWeight))).toBeLessThan(600);
  // The kind stands in one place in both row forms: second, after the mark.
  const wordX = async (row: typeof lone) => Math.round((await row.getByTestId("inbox-word").boundingBox())!.x);
  const asks = all.filter({ hasText: "Decide which of the three" });
  expect(await wordX(lone)).toBe(await wordX(asks));
  expect((await lone.getByTestId("inbox-word").boundingBox())!.x).toBeLessThan((await lone.getByTestId("inbox-place").boundingBox())!.x);
  // On a shared line the width goes to what waits, not to the title: the title is cut first.
  expect((await asks.getByTestId("inbox-line").boundingBox())!.width).toBeGreaterThan((await asks.getByTestId("inbox-place").boundingBox())!.width);
  const rows = all.filter({ hasNotText: "Tidy the changelog" }).filter({ hasNotText: "Decide which of the three" });
  await expect(rows).toHaveCount(4);
  expect(await wordX(rows.first())).toBe(await wordX(lone));
  expect(Number(await rows.first().getByTestId("inbox-place").evaluate((el) => getComputedStyle(el).fontWeight))).toBeGreaterThanOrEqual(600);
  // A row offers the card that answers it only while that card waits (state-words.spec.ts has those): these
  // alerts were raised by the test route with no card behind them, so no row offers one.
  await expect(rows.getByTestId("inbox-opens")).toHaveCount(0);
  // The model's markdown is read as words.
  const finished = rows.filter({ hasText: "Done" }).first();
  await expect(finished.getByTestId("inbox-line")).toHaveText(/^The parser, moved: The change is in notes\/plan\.md:2/);
  // Routes: once for the list, on no row.
  await expect(page.getByTestId("inbox-routes")).toHaveCount(1);
  await expect(page.getByTestId("inbox-routes")).toContainText(/also go to .*Command hook|stay here/);
  for (const row of await rows.all()) {
    await expect(row).not.toContainText(/inbox only|sent to|sending to|not set up/i);
    // The state word is followed by the line, never by a separator with nothing after it.
    await expect(row.getByTestId("inbox-state").locator("svg")).toHaveCount(0);
    // One line: the row's words are the title's line and one more.
    const lines = await row.getByTestId("inbox-line").evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
    expect(lines).toBe(1);
  }
  // The four are one session's: its title stands once, over them. (None of them has a card that waits: they are new, not under Needs you.)
  await expect(rows.getByTestId("inbox-place")).toHaveCount(1);
  await expect(rows.getByTestId("inbox-place")).toHaveText("Write up the parser move");
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-part")))).toEqual(["new", "new", "new", "new"]);
  // An unread row says its state once, with its mark: no bar, no second colored mark,
  // and the state word in the same face and case as on a read row.
  const first = rows.first();
  const face = (row: typeof first) => row.getByTestId("inbox-word").evaluate((el) => { const c = getComputedStyle(el); return [c.fontFamily, c.textTransform, c.fontWeight, c.color].join("|"); });
  expect(await first.evaluate((el) => getComputedStyle(el, "::before").content)).toBe("none");
  const unreadFace = await face(first);
  expect(unreadFace).toContain("|none|");
  expect(await first.getByTestId("inbox-dot").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await rows.getByTestId("inbox-place").first().evaluate((el) => getComputedStyle(el).color));
  // What a person or a model wrote reads in its own direction.
  for (const id of ["inbox-place", "inbox-line"]) await expect(rows.getByTestId(id).first()).toHaveAttribute("dir", "auto");
  await shoot(page, "alerts-09-rows");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeInViewport({ ratio: 1 });
  // The page under the drawer is still the one it was opened over: no session's page took
  // its place as the window narrowed (the page would read that session's alerts as seen).
  await expect(page.getByTestId("new-composer")).toBeInViewport();
  await expect(page.getByTestId("inbox-unread-filter")).toHaveText("Unread6");
  // On a phone the list starts high: the bands over it are two short rows.
  expect((await page.getByTestId("inbox-part").first().boundingBox())!.y).toBeLessThanOrEqual(124);
  // A phone's drawer is too narrow for a title and its alert on one line: the lone alert stands under its title there.
  expect((await lone.boundingBox())!.height).toBeGreaterThan(44);
  await shoot(page, "alerts-09-rows-phone");
  await page.setViewportSize({ width: 1920, height: 1040 });
  // Read, the word keeps its face.
  await first.getByTestId("inbox-toggle-read").click();
  await page.getByTestId("inbox-panel").getByRole("radio", { name: "All" }).click();
  const read = page.locator(`[data-testid="inbox-item"]:not([data-unread])`).first();
  expect(await face(read)).toBe(await face(page.locator(`[data-testid="inbox-item"][data-unread]`).first()));
  // The Activity view says a session's title once a row (under the text), and marks an alert by its kind.
  await page.getByTestId("tab-activity").click();
  const act = page.locator('[data-testid="activity-item"][data-kind="alert"]').filter({ has: page.getByTestId("activity-place").filter({ hasText: "Tidy the changelog" }) }).first();
  await expect(act).toBeVisible();
  expect(((await act.innerText()).match(/Tidy the changelog/g) ?? []).length).toBe(1);
  await expect(act.getByTestId("alert-icon")).toHaveAttribute("data-watch", "work");
  await expect(act.getByTestId("activity-word")).toHaveText(/From the agent/);
  await shoot(page, "alerts-10-activity");
  await page.getByTestId("tab-inbox").click();
  await page.getByTestId("mark-all-read").click();
  await request.delete(`/api/sessions/${waits.id}`);
  await request.delete(`/api/sessions/${session.id}`);
  await request.delete(`/api/sessions/${quiet.id}`);
});
