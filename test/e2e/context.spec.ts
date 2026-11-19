import { expect, test } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the context meter shows tokens against the model's listed window;
// effort comes from the model's listed efforts; compaction (with a focus)
// replaces the history with a summary and the session goes on; clear starts
// fresh and can be undone.
test("context meter, effort, compact and clear", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");

  // Effort: pick one the model lists; the next turn records it.
  await page.getByTestId("effort-picker").click();
  await page.getByRole("menuitem", { name: "low" }).click();
  await expect(page.getByTestId("effort-picker")).toContainText("low");

  await composer.fill("My favourite colour is teal. Reply with only the word noted.");
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 90_000 });
  const ev = await (await request.get(`/api/sessions/${session.id}`)).json();
  expect(ev.events.find((e: any) => e.kind === "turn_start").data.effort).toBe("low");

  await page.getByTestId("context-meter").click();
  await expect(page.getByTestId("context-popup")).toContainText(/of 1\.0M tokens/);
  await expect(page.getByTestId("context-popup")).toContainText("Conversation");
  await shoot(page, "context-01-meter");

  // The breakdown follows a reply committed while the popup stays open.
  const zone = page.getByTestId("zone-conversation");
  const before = await zone.textContent();
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `Remember this list, reply only with ok: ${"lantern harbour ".repeat(300)}` } });
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 90_000 });
  await expect(zone).not.toHaveText(before ?? "");

  await page.getByTestId("compact-focus").fill("the favourite colour");
  await page.getByTestId("compact-now").click();
  await expect(page.getByTestId("compacted")).toBeVisible({ timeout: 90_000 });
  await page.keyboard.press("Escape");
  await page.getByTestId("compacted").locator("summary").click();
  await expect(page.getByTestId("compacted")).toContainText(/teal/i);
  await shoot(page, "context-02-compacted");

  // The model still knows what the summary kept.
  await composer.fill("What is my favourite colour? One word.");
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(3, { timeout: 90_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText(/teal/i);

  // Clear, then undo.
  await page.getByTestId("context-meter").click();
  await page.getByTestId("clear-context").click();
  await expect(page.getByTestId("cleared")).toBeVisible();
  await page.keyboard.press("Escape");
  await shoot(page, "context-03-cleared");
  await page.getByTestId("cleared").getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("cleared")).toHaveCount(0);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
