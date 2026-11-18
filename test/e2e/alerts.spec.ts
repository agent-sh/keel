import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { HAIKU, shoot } from "./shots.ts";

// Feature: a turn that finishes while the owner looks elsewhere becomes an
// alert: unread in the inbox and on the session row, sent to the command hook
// (KEEL_NOTIFY_COMMAND). Reading the session clears it; mark all read is always
// there; routes per kind are settings.
const NOTIFY_LOG = process.env.KEEL_NOTIFY_LOG ?? `${process.env.HOME}/.cache/keel-work/bun/dev-automation/notify.log`;

test("alerts: inbox, unread, command hook, routes", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  await request.post("/api/alerts/read", { data: {} });
  const logBefore = existsSync(NOTIFY_LOG) ? readFileSync(NOTIFY_LOG, "utf8").split("\n").length : 0;

  await page.goto("/");
  await expect(page.getByTestId("new-composer")).toBeVisible();
  // The turn runs while the page shows the home screen, not this session.
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, text: "Reply with only the word done." } })).json();
  await expect(page.getByTestId("inbox-count")).toHaveText("1", { timeout: 60_000 });
  const row = page.getByTestId("session-row").filter({ hasText: "Reply with only the word done." });
  await expect(row.getByTestId("unread-dot")).toBeVisible();
  await shoot(page, "alerts-01-unread");

  if (existsSync(NOTIFY_LOG)) {
    const lines = readFileSync(NOTIFY_LOG, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(logBefore);
    const last = JSON.parse(lines.at(-1)!);
    expect(last).toMatchObject({ kind: "finished", session_id: session.id });
  }

  await page.getByTestId("inbox-button").click();
  await expect(page.getByTestId("inbox-item").first()).toHaveAttribute("data-unread", "true");
  await expect(page.getByTestId("inbox-item").first()).toContainText("Finished");
  await shoot(page, "alerts-02-inbox");

  // Opening the alert goes to the session and reads it.
  await page.getByTestId("inbox-item").first().click();
  await expect(page).toHaveURL(new RegExp(`/s/${session.id}`));
  await expect(page.getByTestId("inbox-count")).toHaveCount(0);
  await expect(row.getByTestId("unread-dot")).toHaveCount(0);
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

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
