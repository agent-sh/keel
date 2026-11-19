import { expect, test } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the error tracker folds a failure that repeats into one row with a
// count, links it to the session it happened in, and a resolved kind leaves
// the Open list (and comes back if it happens again).
test("errors fold, link to their session and resolve", async ({ page, request }) => {
  const s = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Error tracker check" } })).json()).session;
  const tag = `e2e failure ${Date.now().toString(36)}`;
  for (let i = 1; i <= 3; i++) {
    await request.post("/api/errors", { data: { message: `${tag}: request ${i} timed out after ${i * 100} ms`, context: { url: `/s/${s.id}` } } });
  }

  await page.goto("/");
  await page.getByTestId("errors-button").click();
  const panel = page.getByTestId("errors-panel");
  const row = panel.getByTestId("error-row").filter({ hasText: tag });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("error-count")).toHaveText("3x");
  await row.locator("summary").click();
  await expect(row.getByTestId("error-session")).toContainText("Error tracker check");
  await shoot(page, "errors-01-open");

  await row.getByTestId("error-resolve").click();
  await expect(panel.getByTestId("error-row").filter({ hasText: tag })).toHaveCount(0);
  await panel.getByRole("tab", { name: /Resolved/ }).click();
  await expect(panel.getByTestId("error-row").filter({ hasText: tag })).toHaveCount(1);
  await shoot(page, "errors-02-resolved");

  // It happens again: back on the Open list with the count going on.
  await request.post("/api/errors", { data: { message: `${tag}: request 9 timed out after 900 ms`, context: { url: `/s/${s.id}` } } });
  await panel.getByRole("tab", { name: /Open/ }).click();
  const again = panel.getByTestId("error-row").filter({ hasText: tag });
  await expect(again.getByTestId("error-count")).toHaveText("4x");

  await again.locator("summary").click();
  await again.getByTestId("error-session").click();
  await expect(page).toHaveURL(new RegExp(`/s/${s.id}`));

  // Leave nothing open behind for the other specs' error counts.
  const id = (await (await request.get("/api/errors?resolved=0")).json()).errors.find((e: any) => e.message.startsWith(tag)).id;
  await request.patch(`/api/errors/${id}`, { data: { resolved: true } });
  await request.delete(`/api/sessions/${s.id}`);
});
