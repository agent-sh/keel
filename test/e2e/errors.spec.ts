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

// A session deleted while the page was cut off, and a page that loaded while
// the daemon was down, are states the page settles quietly: the reconnect
// drops the session (the station says it is gone) and loads what failed, and
// nothing lands in the error table.
test("a reconnect after a deletion or a failed first load records no error", async ({ page, request }) => {
  const posted: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/errors") posted.push(r.postData() ?? ""); });
  const live: { ws?: import("@playwright/test").WebSocketRoute } = {};
  await page.routeWebSocket(/\/ws$/, (ws) => { ws.connectToServer(); live.ws = ws; });
  // The first model listing fails as a daemon restart would cut it.
  let listings = 0;
  await page.route(/\/api\/models(\?|$)/, (r) => (++listings === 1 ? r.abort("connectionrefused") : r.continue()));
  const s = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Deleted while away" } })).json()).session;
  await page.goto(`/s/${s.id}`);
  await expect(page.getByTestId("station-head").first()).toContainText("Deleted while away");
  await expect(page.getByTestId("permission-menu")).toBeVisible();
  // The listing is there after all: the socket's open loaded it again.
  await expect.poll(() => listings).toBeGreaterThanOrEqual(2);

  // Cut off, the session is deleted; the page hears of it only on reconnect.
  await live.ws!.close({ code: 4000, reason: "cut by the test" });
  await request.delete(`/api/sessions/${s.id}`);
  await expect(page.getByTestId("session-missing")).toBeVisible({ timeout: 15_000 });
  await shoot(page, "errors-03-deleted-while-away");
  await page.waitForTimeout(3_500); // a network failure is posted 3 s after it happened
  expect(posted).toEqual([]);
});
