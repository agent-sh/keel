import { expect, test } from "@playwright/test";
import { HAIKU, shoot } from "./shots.ts";

// Feature: start a session, the model calls tools, the reply streams in, the
// turn footer shows usage with cache reads; a second message continues it.
test("chat with tools", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  await page.goto("/");
  await expect(page.getByText("What should we work on?")).toBeVisible();
  await shoot(page, "01-home");

  await page.getByTestId("model-picker").click();
  await page.getByPlaceholder("Search models").fill("haiku 5.5");
  await page.getByRole("option").first().click();
  await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5");

  await page.getByTestId("composer").fill("List the files in the working directory with Bash, then tell me how many there are in one short sentence.");
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/s\//);
  await expect(page.getByTestId("user-message")).toBeVisible();
  await expect(page.getByTestId("tool-call").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("assistant-text").last()).not.toBeEmpty();
  await shoot(page, "02-turn-done");

  await page.getByTestId("tool-call").first().click();
  await expect(page.getByTestId("tool-call").first().locator("pre").first()).toBeVisible();
  await shoot(page, "03-tool-open");

  await page.getByTestId("composer").fill("Now say only the word done.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 120_000 });
  await expect(page.getByTestId("turn-end").last()).toContainText("cached");
  await shoot(page, "04-second-turn");

  await expect(page.getByTestId("session-list")).toContainText("List the files");
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
