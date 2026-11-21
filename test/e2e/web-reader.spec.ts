import { expect, test } from "./isolate.ts";
import { shoot, SCRIPTED, pickModel } from "./shots.ts";

// Feature: the reader. WebFetch on a long page hands the page and the
// model's prompt to the session's reader model; the working model gets the
// answer and the path of the whole page, not the page.
test("web reader: a long page is read for the prompt, the page saved whole", async ({ page, request }) => {
  test.skip(SCRIPTED, "needs a real model and the public network: a reader model has to answer from a page WebFetch brings from the web");
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  try {
    await page.goto("/");
    await pickModel(page);
    await page.getByTestId("composer").fill(
      "Call WebFetch once on https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand with the prompt " +
      "\"Which beta header does on-demand compaction need?\". Then reply with only that header.",
    );
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 150_000 });
    await expect(page.getByTestId("assistant-text").last()).toContainText("compact-2026-09-04");
    const card = page.locator('[data-tool="WebFetch"]').first();
    await card.click();
    await expect(card).toContainText(/read the page \(\d+ chars\) for this request/);
    await expect(card).toContainText("The whole page is saved to");
    await shoot(page, "web-reader-01-answer");
  } finally {
    await request.put("/api/permissions/settings", { data: { default_mode: prev } });
  }
});
