import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: answers that come late, twice or not at all. The phone pairing code
// asked the daemon without minding that an answer was already on its way:
// every click made a new code. The requests are held or failed in the browser;
// the daemon is the real one.

test("clicking for a pairing code again while one is on its way asks once", async ({ page }) => {
  let asked = 0;
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/mobile/pair", async (route) => {
    asked++;
    if (asked === 1) await held; // the first answer is slow
    if (asked === 3) return route.fulfill({ status: 500, json: { error: "the daemon is busy" } });
    await route.continue();
  });
  await page.goto("/settings/phone");
  const show = page.getByTestId("pair-show");
  await page.getByTestId("pair-url").fill("https://keel.example.test");
  await show.click();
  await expect(show).toBeDisabled();
  await shoot(page, "answer-order-01-pair-asking");
  // More clicks while it is on its way: by the pointer, and by a script that does not wait for the page.
  await show.click({ force: true });
  await show.evaluate((b: HTMLButtonElement) => { b.disabled = false; b.click(); b.click(); });
  release();
  await expect(page.getByTestId("pair-qr").locator("svg")).toBeVisible();
  expect(asked).toBe(1);
  // Asking again on purpose makes a new code.
  const first = await page.getByTestId("pair-bundle").getAttribute("data-link");
  await expect(show).toBeEnabled();
  await expect(show).toHaveText(/New code/);
  await show.click();
  await expect.poll(() => page.getByTestId("pair-bundle").getAttribute("data-link")).not.toBe(first);
  expect(asked).toBe(2);
  // A refused request says so and leaves the button usable.
  await show.click();
  await expect(page.getByText("the daemon is busy")).toBeVisible();
  await expect(show).toBeEnabled();
  expect(asked).toBe(3);
});
