import { expect, test } from "@playwright/test";
import { shoot } from "./shots.ts";

// Feature: the machine is kept awake while a loop's next run is near (not only
// while a turn runs), so a sleeping laptop does not miss it; the hold ends when
// the loop goes, and the activity list says how long it lasted.
test("keep awake while a loop is due, with the hold in the activity list", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const aw = await (await request.get("/api/awake")).json();
  test.skip(!aw.available, "this machine has no logind lock to hold");
  const loop = await (await request.post("/api/loops", { data: { name: "Awake check", schedule: "10m", prompt: "Reply with only the word ok." } })).json();

  await page.goto("/settings/daemon");
  await expect(page.getByTestId("awake-state")).toHaveText(/Held/, { timeout: 45_000 });
  await expect(page.getByText("loop due within 15 minutes")).toBeVisible();
  await shoot(page, "awake-01-loop-due");

  await request.delete(`/api/loops/${loop.id}`);
  await expect(page.getByTestId("awake-state")).toHaveText(/Not held/, { timeout: 45_000 });
  await page.getByTestId("inbox-button").click();
  await page.getByTestId("tab-activity").click();
  await page.getByTestId("activity-kind-awake").click();
  await expect(page.getByTestId("activity-item").first()).toContainText("loop due within 15 minutes");
  await shoot(page, "awake-02-activity");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
