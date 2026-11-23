import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the machine is kept awake while a loop's next run is near (not only
// while a turn runs), so a sleeping laptop does not miss it; the hold ends when
// the loop goes, and the activity list says how long it lasted.
test("keep awake while a loop is due, with the hold in the activity list", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const aw = await (await request.get("/api/awake")).json();
  test.skip(!aw.available, "this machine has no logind lock to hold");
  const loop = await (await request.post("/api/loops", { data: { name: "Awake check", schedule: "10m", prompt: "Reply with only the word ok." } })).json();

  // The lock is asked for once a loop is due: logind may refuse it (a server whose user has no
  // seat, polkit says no). Then there is nothing to hold here, and the daemon says so.
  let refused: string | undefined;
  await expect.poll(async () => {
    const st = await (await request.get("/api/awake")).json();
    refused = st.refused;
    // `locked`: logind handed the lock out (a lock asked for is held before logind answers).
    return st.locked || !!refused;
  }, { timeout: 45_000 }).toBe(true);
  if (refused) await request.delete(`/api/loops/${loop.id}`);
  test.skip(!!refused, `logind refused the lock here (${refused}): nothing to hold`);

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
