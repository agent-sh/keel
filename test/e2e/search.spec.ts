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
  // Opened from the keyboard, the message is where the keyboard is too.
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill(word);
  await expect(page.getByRole("option").filter({ has: page.locator("mark") })).toHaveCount(1);
  await page.keyboard.press("ArrowDown"); // from the session row to the hit
  await page.keyboard.press("Enter");
  await expect(page.locator(".flash")).toBeVisible();
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-event-id"));
  const hitEvent = (await (await request.get(`/api/search?q=${word}`)).json()).hits.find((h: any) => h.event_id).event_id;
  expect(focused).toBe(hitEvent);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);

  // A failed search says so and offers Retry; it is not "Nothing matches".
  await page.keyboard.press("Control+k");
  const input = page.getByTestId("palette-input");
  await page.route(/\/api\/search\?/, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "the index is rebuilding" }) }));
  await input.fill(word);
  await expect(page.getByTestId("palette-search-failed")).toContainText("the index is rebuilding");
  await expect(page.getByTestId("palette")).not.toContainText("Nothing matches");
  await shoot(page, "search-03-failed");
  await page.unroute(/\/api\/search\?/);
  await page.getByTestId("palette-search-retry").click();
  await expect(page.getByTestId("palette-search-failed")).toHaveCount(0);
  await expect(page.getByRole("option").filter({ hasText: word })).toHaveCount(1);

  // The input names the highlighted row for assistive technology.
  await input.focus();
  const activeId = await input.getAttribute("aria-activedescendant");
  expect(activeId).toBeTruthy();
  await expect(page.locator(`#${activeId}`)).toHaveAttribute("aria-selected", "true");

  // A hit of the query just erased is not opened by Enter while the new
  // query's answer is out.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(/\/api\/search\?/, async (route) => { await held; await route.fallback(); });
  await input.fill(`zz${word}`);
  await expect(page.getByTestId("palette-searching")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("palette")).toBeVisible();
  release();
  await page.unroute(/\/api\/search\?/);
});
