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
  // The folded rail: an unread session keeps a full mark.
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
  await expect(page.getByTestId("inbox-item").first()).toContainText("Finished");
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
  await page.getByTestId("inbox-unread-filter").click();
  await expect(page.getByTestId("inbox-item")).toHaveCount(1);
  await page.getByTestId("mark-all-read").click();
  await expect(page.getByTestId("inbox-item")).toHaveCount(0);

  // A hook that refuses: shown as failed with its own Retry; the inbox keeps one alert.
  const hooked = (await (await request.get("/api/alerts/settings")).json()).channels.some((c: any) => c.id === "command" && c.available);
  if (hooked && NOTIFY_LOG) {
    const { writeFileSync, rmSync } = await import("node:fs");
    writeFileSync(`${NOTIFY_LOG}.fail`, "");
    try {
      await page.getByTestId("inbox-unread-filter").click();
      await request.post("/api/alerts/test", { data: { kind: "agent" } });
      const failed = page.getByTestId("inbox-item").first();
      await expect(failed.getByTestId("inbox-failed")).toContainText("Command hook failed");
      await shoot(page, "alerts-07-hook-failed");
    } finally {
      rmSync(`${NOTIFY_LOG}.fail`, { force: true });
    }
    await page.getByTestId("inbox-retry").click();
    await expect(page.getByTestId("inbox-item").first().getByTestId("inbox-state")).toContainText("sent to Command hook");
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
