import { expect, test } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

// Feature: `/loop 10m <prompt>` in the composer makes a loop that runs now and
// again on its interval; the Loops panel lists it with its run history; it can
// be paused, run by hand and deleted. A calendar loop shows its next times.
test("loops: /loop, history, pause, run now, calendar", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);

  await page.getByTestId("composer").fill("/loop 10m say only the word tick");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("loop-notice")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId("background-button")).toContainText("1 in background");
  await shoot(page, "loops-01-first-run");

  await page.getByTestId("background-button").click();
  await expect(page.getByTestId("bg-loop")).toContainText("every 10 minutes");
  await shoot(page, "loops-02-background");
  await page.keyboard.press("Escape");

  await page.getByTestId("loops-button").click();
  await expect(page.getByTestId("loops-panel")).toBeVisible();
  const item = page.getByTestId("loop-item").filter({ hasText: "say only the word tick" }).first();
  await item.click();
  await expect(page.getByTestId("loop-run")).toHaveCount(1);
  await shoot(page, "loops-03-panel");

  // Run by hand: a second run in the history.
  await item.hover();
  await item.getByTitle("Run now").click();
  await expect(page.getByTestId("loop-run")).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByTestId("loop-run").first()).not.toContainText("running", { timeout: 60_000 });

  // Pause.
  await item.hover();
  await item.getByTitle("Pause").click();
  await expect(item).toContainText("paused");
  await shoot(page, "loops-04-paused");

  // A calendar loop made in the panel, in a session of its own.
  await page.getByTestId("new-loop-button").click();
  await page.getByTestId("new-loop-schedule").fill("weekdays 09:30");
  await page.getByTestId("new-loop-prompt").fill("Summarize yesterday's commits in this repository.");
  await page.getByRole("button", { name: "Create loop" }).click();
  await expect(page.getByTestId("loop-history")).toContainText("weekdays at 09:30");
  // Its times are in a named zone kept with it, shown beside them.
  await expect(page.getByTestId("loop-zone")).toHaveText(/\(\w+(\/[\w+-]+)*\)/);
  await shoot(page, "loops-05-calendar");

  // Clean up: the loops end with the test.
  const { loops } = await (await request.get("/api/loops")).json();
  for (const l of loops) await request.delete(`/api/loops/${l.id}`);
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
