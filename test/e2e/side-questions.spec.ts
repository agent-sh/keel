import { expect, test } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

// Feature: /btw asks a side question answered from the session's context with
// no tools; it opens the side panel, a follow-up continues the thread, and
// nothing is added to the conversation. Clear forgets the threads.
test("side questions stay out of the conversation", async ({ page, request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");
  await composer.fill("The project codename is Heron-42. Reply with only the word noted.");
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 90_000 });
  const before = (await (await request.get(`/api/sessions/${session.id}`)).json()).events.length;

  await composer.fill("/btw what is the project codename? Answer with the codename only.");
  await composer.press("Enter");
  const panel = page.getByTestId("side-questions");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("side-answer").last()).toContainText("Heron-42", { timeout: 60_000 });

  // A follow-up sees the thread so far.
  await panel.getByTestId("side-input").fill("Repeat your previous answer in lower case, nothing else.");
  await panel.getByTestId("side-input").press("Enter");
  await expect(panel.getByTestId("side-exchange")).toHaveCount(2, { timeout: 60_000 });
  await expect(panel.getByTestId("side-answer").last()).toContainText("heron-42", { timeout: 60_000 });
  await shoot(page, "side-01-thread");

  // The conversation is as it was: no prompt, reply or turn was added.
  const after = await (await request.get(`/api/sessions/${session.id}`)).json();
  expect(after.events.length).toBe(before);
  await expect(page.getByTestId("turn-end")).toHaveCount(1);
  await expect(page.getByTestId("user-message")).toHaveCount(1);

  // The threads come back after a reload, and Clear forgets them.
  await page.reload();
  await expect(page.getByTestId("side-exchange")).toHaveCount(2);
  await page.getByTestId("side-clear").click();
  await expect(page.getByTestId("side-exchange")).toHaveCount(0);
  expect((await (await request.get(`/api/sessions/${session.id}/side`)).json()).threads).toEqual([]);
});
