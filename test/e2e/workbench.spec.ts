import { expect, test } from "@playwright/test";
import { shoot } from "./shots.ts";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

// Feature: the workbench shell. Folder picker, palette, shortcuts, settings,
// slash commands, @-mentions, a pasted image sent to the model, a highlighted
// code block with its copy button, and the phone layout with its drawer.
test("workbench", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  await page.goto("/");
  await expect(page.getByText("What should we work on?")).toBeVisible();
  await shoot(page, "wb-01-home");

  // Folder picker: browse to this repository by typing its path.
  await page.getByTestId("workspace-picker").click();
  await expect(page.getByTestId("workspace-popup")).toBeVisible();
  await page.getByPlaceholder("Type a path, Enter to open it").fill(process.cwd());
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("use-folder")).toBeVisible();
  await shoot(page, "wb-02-folder-browse");
  await page.getByTestId("use-folder").click();
  await expect(page.getByTestId("workspace-picker")).toContainText(process.cwd().split("/").pop()!);

  // Palette and shortcut sheet.
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.getByTestId("palette-input").fill("shortcuts");
  await shoot(page, "wb-03-palette");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("shortcuts")).toBeVisible();
  await shoot(page, "wb-04-shortcuts");
  await page.keyboard.press("Escape");

  // Settings, reached from the palette.
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("settings");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/settings\/general/);
  await page.getByRole("button", { name: "Models" }).click();
  await expect(page.getByTestId("settings-title")).toHaveText("Models");
  await shoot(page, "wb-05-settings-models");
  await page.getByTestId("new-session").click();

  // Slash commands and @-mentions in the message box.
  const box = page.getByTestId("composer");
  await box.fill("/");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await expect(page.getByTestId("slash-menu")).toContainText("/compact");
  await shoot(page, "wb-06-slash");
  await box.fill("/mod");
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("/model ");
  await box.fill("Look at @AGENTS");
  await expect(page.getByTestId("mention-menu")).toContainText("AGENTS.md");
  await shoot(page, "wb-07-mention");
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("Look at @AGENTS.md ");

  // A pasted picture: a red square drawn in the page.
  await page.getByTestId("model-picker").click();
  await page.getByPlaceholder("Search models").fill("haiku 5.5");
  await page.getByRole("option").first().click();
  await box.fill("");
  await box.focus();
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(64, 64);
    const g = c.getContext("2d")!;
    g.fillStyle = "#e00000";
    g.fillRect(0, 0, 64, 64);
    const blob = await c.convertToBlob({ type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "red.png", { type: "image/png" }));
    document.querySelector("[data-testid=composer]")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("attachments").locator("img")).toHaveCount(1);
  await box.fill("What color is this square? Answer in one word, then a fenced python code block that prints that word.");
  await shoot(page, "wb-08-attached");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/s\//);
  await expect(page.getByTestId("user-message").locator("img")).toHaveCount(1);
  await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText(/red/i);

  // Code block: highlighted once the reply ends, with a working copy button.
  const code = page.locator(".code-block").first();
  await expect(code).toBeVisible();
  await expect(code.locator("[class^=th-]").first()).toBeVisible();
  await code.locator(".code-copy").click();
  await expect(code.locator(".code-copy")).toContainText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/print/);
  await shoot(page, "wb-09-reply");

  // Session menu: delete asks first.
  await page.getByTestId("session-menu").click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByTestId("confirm")).toBeVisible();
  await shoot(page, "wb-10-confirm-delete");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("confirm")).toBeHidden();

  // Installable: manifest and icons are served.
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.icons.length).toBeGreaterThan(2);
  for (const i of manifest.icons) expect((await request.get(i.src)).ok()).toBe(true);

  // Phone width: the sidebar is a drawer.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("sidebar")).not.toBeInViewport();
  await shoot(page, "wb-11-phone");
  await page.getByTestId("show-sidebar").click();
  await expect(page.getByTestId("sidebar")).toBeInViewport();
  await shoot(page, "wb-12-phone-drawer");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

