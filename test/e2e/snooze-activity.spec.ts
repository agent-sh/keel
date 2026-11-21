import { expect, test } from "./isolate.ts";
import { HAIKU, shoot, choose } from "./shots.ts";

// Feature: snooze a session (its routine alerts go to the inbox read, a failed
// turn or a card ends it, its time passing wakes it with one alert), snooze
// every alert for a while (held off the channels, one alert when it ends), and
// the activity list of everything that happened, filtered by kind, session and words.
test("alerts: snooze per session and global, activity list", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  await request.post("/api/alerts/read", { data: {} });
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Snooze target" } })).json();
  await page.goto(`/s/${session.id}`);

  // Snooze the session for an hour from its header.
  await page.getByTestId("snooze-button").click();
  await page.getByRole("menuitem", { name: "For 1 hour" }).click();
  await expect(page.getByTestId("snoozed-mark")).toBeVisible();
  await page.getByTestId("snooze-button").click();
  await expect(page.getByTestId("snooze-state")).toContainText("Snoozed until");
  await shoot(page, "snooze-01-session-menu");
  await page.keyboard.press("Escape");

  // Away from the session: a routine alert is put away read, a failed turn comes through and ends the snooze.
  // (The daemon drops a routine finish of a session a page is watching, and a page says where it is
  // once a second: the alert is raised after this page has said it left the session.)
  const left = page.waitForRequest((r) => r.url().endsWith("/api/presence") && r.postDataJSON()?.session_id == null);
  await page.goto("/");
  await (await left).response();
  await request.post("/api/alerts/test", { data: { kind: "finished", session_id: session.id } });
  await page.getByTestId("inbox-button").click();
  // (This session's rows: a turn another spec left running may finish meanwhile and stand above them.)
  const mine = page.getByTestId("inbox-item").filter({ hasText: "Snooze target" });
  const item = mine.first();
  await expect(item).toContainText("snoozed");
  await expect(item).not.toHaveAttribute("data-unread");
  await expect(page.getByTestId("inbox-count")).toHaveCount(0);
  await request.post("/api/alerts/test", { data: { kind: "failed", session_id: session.id } });
  await expect(mine.first()).toHaveAttribute("data-unread", "true");
  await expect(page.getByTestId("snoozed-mark")).toHaveCount(0);
  await shoot(page, "snooze-02-inbox");

  // A snooze whose time passes wakes the session with one alert.
  await request.put(`/api/sessions/${session.id}/snooze`, { data: { until_ms: Date.now() + 1500 } });
  await expect(page.getByTestId("inbox-item").first()).toContainText("Snooze over", { timeout: 10_000 });

  // Snooze every alert: still in the inbox, held off the channels; ending it says how many came.
  await page.getByTestId("snooze-all").click();
  await page.getByRole("menuitem", { name: "For 1 hour" }).click();
  await expect(page.getByTestId("snooze-all")).toContainText("Snoozed until");
  await request.post("/api/alerts/test", { data: { kind: "agent" } });
  await expect(page.getByTestId("inbox-item").first()).toContainText("held by the snooze");
  await shoot(page, "snooze-03-global");
  await page.getByTestId("snooze-all").click();
  await page.getByTestId("snooze-all-end").click();
  await expect(page.getByTestId("inbox-item").first()).toContainText("1 alert came while alerts were snoozed");

  // Activity: everything above, filtered.
  await page.getByTestId("tab-activity").click();
  await expect(page.getByTestId("activity-item").first()).toBeVisible();
  await page.getByTestId("activity-kind-snooze").click();
  await expect(page.getByTestId("activity-item").filter({ hasText: "Snoozed" }).first()).toBeVisible();
  await expect(page.locator('[data-testid="activity-item"]:not([data-kind="snooze"])')).toHaveCount(0);
  await choose(page.getByTestId("activity-session"), session.id);
  await page.getByTestId("activity-search").fill("a turn failed");
  await expect(page.getByTestId("activity-item")).toHaveCount(1);
  await expect(page.getByTestId("activity-item")).toContainText("Snooze ended: a turn failed");
  await page.getByTestId("activity-search").fill("");
  await page.getByTestId("activity-kind-snooze").click();
  await page.getByTestId("activity-kind-alert").click();
  await expect(page.getByTestId("activity-item").first()).toBeVisible();
  await shoot(page, "snooze-04-activity");

  await request.post("/api/alerts/read", { data: {} });
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
