import { expect, test } from "@playwright/test";
import { HAIKU, shoot } from "./shots.ts";

// Feature: edit-and-resend makes a branch and the arrows move between the
// versions; fork from a message opens a new session; rename, archive, restore,
// search across what sessions said, and delete.
test("branches, fork, rename, archive, search, delete", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const tag = `zq${Date.now().toString(36)}`;
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");

  await composer.fill(`Reply with only the word apple. (${tag})`);
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText(/apple/i);

  // Edit and resend: a second version, shown as 2/2.
  await page.getByTestId("user-message").hover();
  await page.getByTestId("edit-message").click();
  await page.getByTestId("edit-box").fill(`Reply with only the word banana. (${tag})`);
  await page.getByTestId("edit-send").click();
  await expect(page.getByTestId("branch-pos")).toHaveText("2/2", { timeout: 30_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText(/banana/i, { timeout: 90_000 });
  await expect(page.getByTestId("turn-end")).toHaveCount(1);
  await shoot(page, "tree-01-second-version");

  await page.getByRole("button", { name: "Previous version" }).click();
  await expect(page.getByTestId("branch-pos")).toHaveText("1/2");
  await expect(page.getByTestId("assistant-text").last()).toContainText(/apple/i);
  await shoot(page, "tree-02-first-version");

  // Fork from the reply: a new session with this branch.
  await page.getByRole("button", { name: "Fork a new session from here" }).last().click();
  await expect(page).not.toHaveURL(new RegExp(session.id));
  await expect(page.getByTestId("session-title")).toContainText("(fork)");
  await expect(page.getByTestId("assistant-text").last()).toContainText(/apple/i);
  const forkUrl = page.url();

  // Rename the fork from the header menu.
  await page.getByTestId("session-menu").click();
  await page.getByTestId("menu-rename").click();
  await page.getByLabel("Session title").fill(`Fruit fork ${tag}`);
  await page.getByLabel("Session title").press("Enter");
  await expect(page.getByTestId("session-title")).toHaveText(`Fruit fork ${tag}`);

  // Archive it, find it among the archived, restore it.
  await page.getByTestId("session-menu").click();
  await page.getByTestId("menu-archive").click();
  await expect(page.getByTestId("session-list")).not.toContainText(`Fruit fork ${tag}`);
  await page.getByTestId("tab-archived").click();
  await expect(page.getByTestId("session-list")).toContainText(`Fruit fork ${tag}`);
  await shoot(page, "tree-03-archived");
  await page.getByTestId("session-menu").click();
  await page.getByTestId("menu-restore").click();
  await expect(page.getByTestId("session-list")).not.toContainText(`Fruit fork ${tag}`);
  await page.getByTestId("tab-active").click();
  await expect(page.getByTestId("session-list")).toContainText(`Fruit fork ${tag}`);

  // Search what was said: the edited prompt of the first session opens on its branch.
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill(`banana ${tag}`);
  const hit = page.getByRole("option").filter({ hasText: "banana" }).first();
  await expect(hit).toBeVisible();
  await shoot(page, "tree-04-search");
  await hit.click();
  await expect(page).toHaveURL(new RegExp(session.id));
  await expect(page.getByTestId("branch-pos")).toHaveText("2/2");

  // Delete the fork.
  await page.goto(forkUrl);
  await page.getByTestId("session-menu").click();
  await page.getByTestId("menu-delete").click();
  await page.getByTestId("confirm").getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("session-list")).not.toContainText(`Fruit fork ${tag}`);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
