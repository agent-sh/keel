import { expect, test } from "./isolate.ts";
import { ask, cardIn, create, drop, folder, scripted, settle, type Kind } from "./answering.ts";
import { shoot } from "./shots.ts";

// Feature: a request that waits on the owner while they are away is told again at growing gaps (the
// schedule, the one notification a session and the stored schedule are in src/automation/reminder-schedule.ts
// and reminders.ts, with their own tests). Where no phone is paired the reminders reach this desktop
// only: Settings > Alerts says so, and the Inbox's Routes control with the routes. Nothing says it over a card that
// waits: a line of what is not set up, over every request, took the eye from the request. A scratch daemon has no phone paired.
const LINE = "No phone paired: reminders reach this desktop only";

for (const kind of ["approval", "question", "plan", "secret"] as Kind[]) {
  test(`a ${kind} that waits has no line about the phone over it`, async ({ page, request }) => {
    await scripted(request);
    await settle(request);
    const push = (await (await request.get("/api/alerts/settings")).json()).channels.find((c: { id: string }) => c.id === "push");
    test.skip(!push || push.paired, "needs a daemon with no phone paired: this one has one");
    const id = await create(request, `Reminder ${kind}`, folder(`reminder-${kind}`));
    try {
      await ask(request, id, kind, `remind${kind}`);
      await page.goto(`/s/${id}`);
      await expect(cardIn(page, id, kind)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("reach-line")).toHaveCount(0);
      await expect(page.getByTestId("composer-tray")).not.toContainText("No phone paired");
      await shoot(page, `reminders-01-${kind}`);
      if (kind === "approval") {
        // The Inbox says it once, with where alerts go: in the Routes control's words.
        await page.getByTestId("inbox-button").click();
        await expect(page.getByTestId("alert-routes-link")).toHaveAttribute("title", new RegExp(`${LINE}\\.$`));
        await expect(page.getByTestId("inbox-routes")).toContainText(LINE);
        await shoot(page, "reminders-02-inbox");
        await page.keyboard.press("Escape");
      }
    } finally {
      await drop(request, id);
    }
  });
}

test("Settings > Alerts says where reminders reach", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const push = (await (await request.get("/api/alerts/settings")).json()).channels.find((c: { id: string }) => c.id === "push");
  test.skip(!push || push.paired, "needs a daemon with no phone paired: this one has one");
  await page.goto("/settings/alerts");
  await expect(page.getByTestId("reach-line-settings")).toHaveText(LINE);
  await shoot(page, "reminders-03-settings");
});
