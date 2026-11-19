import { expect, test } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the palette finds what was said in any session and opens the
// session at that message.
test("search conversations", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const word = `quokka${Date.now().toString(36)}`;
  const r = await request.post("/api/sessions", { data: { model: HAIKU, text: `Reply with only the word ok. The code word is ${word}.` } });
  const { session } = await r.json();
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.phase, { timeout: 60_000 }).toBe("idle");

  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill(word.slice(0, -2));
  const hit = page.getByRole("option").filter({ hasText: word });
  await expect(hit.first()).toBeVisible();
  await expect(page.getByTestId("palette")).toContainText("In conversations");
  await shoot(page, "search-01-hit");
  await page.getByRole("option").filter({ has: page.locator("mark") }).first().click();
  await expect(page).toHaveURL(new RegExp(`/s/${session.id}`));
  await expect(page.locator(".flash")).toBeVisible();
  await shoot(page, "search-02-opened");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
