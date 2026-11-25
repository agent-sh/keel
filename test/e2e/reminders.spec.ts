import { expect, test } from "./isolate.ts";
import { ask, create, drop, folder, idle, scripted, settle, type Kind } from "./answering.ts";
import { shoot } from "./shots.ts";

// Feature: a request that waits on the owner while they are away is told again at growing gaps (the
// schedule, the one notification a session and the stored schedule are in src/automation/reminder-schedule.ts
// and reminders.ts, with their own tests). Where no phone is paired the reminders reach this desktop
// only, and the card and Settings > Alerts say so. A scratch daemon has no phone paired.
const LINE = "No phone paired: reminders reach this desktop only";

for (const kind of ["approval", "question", "plan", "secret"] as Kind[]) {
  test(`a ${kind} that waits says that no phone is paired`, async ({ page, request }) => {
    await scripted(request);
    await settle(request);
    const push = (await (await request.get("/api/alerts/settings")).json()).channels.find((c: { id: string }) => c.id === "push");
    test.skip(!push || push.paired, "needs a daemon with no phone paired: this one has one");
    const id = await create(request, `Reminder ${kind}`, folder(`reminder-${kind}`));
    try {
      await ask(request, id, kind, `remind${kind}`);
      await page.goto(`/s/${id}`);
      const line = page.getByTestId("reach-line");
      await expect(line).toHaveText(LINE);
      await shoot(page, `reminders-01-${kind}`);
      if (kind === "approval") {
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(line).toBeVisible();
        expect(await line.evaluate((el) => el.getBoundingClientRect().right <= innerWidth)).toBe(true);
        await shoot(page, "reminders-02-phone-width");
        await page.setViewportSize({ width: 1920, height: 1040 });
      }
    } finally {
      await drop(request, id);
    }
  });
}

test("Settings > Alerts says where reminders reach, and the card's line goes with the card", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const push = (await (await request.get("/api/alerts/settings")).json()).channels.find((c: { id: string }) => c.id === "push");
  test.skip(!push || push.paired, "needs a daemon with no phone paired: this one has one");
  await page.goto("/settings/alerts");
  await expect(page.getByTestId("reach-line-settings")).toHaveText(LINE);
  await shoot(page, "reminders-03-settings");
  // Nothing waits: no line on a session without a card.
  const id = await create(request, "Reminder none", folder("reminder-none"));
  try {
    await page.goto(`/s/${id}`);
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.getByTestId("reach-line")).toHaveCount(0);
    await ask(request, id, "approval", "remindgone");
    await expect(page.getByTestId("reach-line")).toHaveText(LINE);
    const [open] = (await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals as { id: string }[];
    await request.post(`/api/sessions/${id}/approvals/${open!.id}`, { data: { choice: "once", seen: "whole", via: "page" } });
    await expect(page.getByTestId("reach-line")).toHaveCount(0);
    await idle(request, id);
  } finally {
    await drop(request, id);
  }
});
