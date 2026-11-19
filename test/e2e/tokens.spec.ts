import { expect, test } from "@playwright/test";
import { HAIKU, shoot, openPanel } from "./shots.ts";

// Feature: the session's Tokens panel lists every turn with what it sent
// (read from cache, written, full price), its output and cost, and the
// session totals; the second turn reads the first one's prefix from cache.
test("tokens panel per turn", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");
  for (const [i, text] of ["Reply with only the word one.", "Reply with only the word two."].entries()) {
    await composer.fill(text);
    await composer.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(i + 1, { timeout: 90_000 });
  }

  await openPanel(page, "usage");
  const panel = page.getByTestId("session-usage");
  await expect(panel.getByTestId("usage-turn")).toHaveCount(2);
  await expect(panel.getByTestId("usage-turn").nth(1)).toContainText("two");
  await expect(panel.getByTestId("usage-sent")).toContainText(/% read from cache/);
  await expect(panel.getByTestId("usage-cost")).toContainText("$");

  // The second turn's first request read the conversation from cache.
  const { events } = await (await request.get(`/api/sessions/${session.id}`)).json();
  const replies = events.filter((e: any) => e.kind === "assistant");
  expect(replies.at(-1).data.usage.cache_read).toBeGreaterThan(0);
  await shoot(page, "tokens-01-panel");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
