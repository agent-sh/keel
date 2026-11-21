import { expect, test } from "./isolate.ts";
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

  // Files panel: find a file, read it highlighted, mention it.
  await page.keyboard.press("Control+Shift+E");
  await expect(page.getByTestId("side-panel")).toBeVisible();
  await page.getByTestId("files-search").fill("styles.css");
  await page.getByText("ui/src/styles.css").click();
  await expect(page.getByTestId("file-view").locator("[class^=th-]").first()).toBeVisible();
  await shoot(page, "wb-10-files-panel");
  await page.getByRole("button", { name: "Mention" }).click();
  await expect(page.getByTestId("composer")).toHaveValue(/@ui\/src\/styles\.css /);
  await page.getByTestId("composer").fill("");
  await page.keyboard.press("Control+\\");
  await expect(page.getByTestId("side-panel")).toBeHidden();

  // Session menu: delete asks first.
  await page.getByTestId("session-menu").click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByTestId("confirm")).toBeVisible();
  await shoot(page, "wb-11-confirm-delete");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("confirm")).toBeHidden();

  // Archive from the menu, find it under Archived, restore it.
  const sid = page.url().split("/s/")[1]!;
  await page.getByTestId("session-menu").click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(page.locator(`[data-session="${sid}"]`)).toHaveCount(0);
  await page.getByTestId("tab-archived").click();
  const row = page.locator(`[data-session="${sid}"]`);
  await expect(row).toBeVisible();
  await shoot(page, "wb-12-archived");
  await row.hover();
  await row.getByRole("button", { name: "Restore session" }).click();
  await expect(row).toHaveCount(0);
  await page.getByTestId("tab-active").click();
  await page.locator(`[data-session="${sid}"]`).click();
  await expect(page).toHaveURL(new RegExp(sid));

  // Installable: manifest and icons are served.
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.icons.length).toBeGreaterThan(2);
  for (const i of manifest.icons) expect((await request.get(i.src)).ok()).toBe(true);

  // Phone width: the sidebar is a drawer.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("sidebar")).not.toBeInViewport();
  await shoot(page, "wb-13-phone");
  await page.getByTestId("show-sidebar").click();
  await expect(page.getByTestId("sidebar")).toBeInViewport();
  await shoot(page, "wb-14-phone-drawer");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});


// The line being read stays put when something above it changes size (a
// report opening, an image loading late), while the reader is not following
// the end.
test("the reading line holds when content above it grows", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Reading line" } })).json();
  for (let i = 0; i < 6; i++) {
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:grow ${i}` } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.phase, { timeout: 20_000 }).toBe("idle");
  }
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${session.id}`);
  const replies = page.getByTestId("assistant-text");
  await expect(replies).toHaveCount(6);
  // Read the fourth reply: scroll it to the middle, away from the end.
  await replies.nth(3).evaluate((el) => {
    const sc = document.querySelector('[data-testid="transcript"]')!.parentElement!;
    sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - sc.clientHeight / 3;
  });
  await page.mouse.wheel(0, -40);
  await expect(page.getByTestId("jump-latest")).toBeVisible();
  const top = () => replies.nth(3).evaluate((el) => el.getBoundingClientRect().top);
  const before = await top();
  // Something in the reply above, on screen over the line being read, grows by 320 px.
  await replies.nth(2).evaluate((el) => { const d = document.createElement("div"); d.style.height = "320px"; el.prepend(d); });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(1);
  await shoot(page, "workbench-reading-line");
  await request.delete(`/api/sessions/${session.id}`);
});

// The side panel takes its form from the room the pane has: beside the
// conversation when both columns fit, else a sheet over the pane, which keeps
// its width. Crossing between the two keeps what the panel shows.
test("the side panel sits beside the conversation when the pane has room, else lies over it", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Panel layout", workspace: process.cwd() } })).json();
  try {
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "Review the release checklist." } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.phase, { timeout: 20_000 }).toBe("idle");
    const station = page.getByTestId("station").and(page.locator(`[data-station="${session.id}"]`));
    const side = page.getByTestId("side-panel");
    const close = page.getByRole("button", { name: "Close the panel" });
    // The pane's width, and how far the panes and the page scroll sideways.
    const measure = () => page.evaluate((id) => {
      const pane = document.querySelector(`[data-testid="station"][data-station="${id}"]`)!;
      const strip = document.querySelector('[data-testid="bridge"]')!;
      return { pane: Math.round(pane.getBoundingClientRect().width), strip: strip.scrollWidth - strip.clientWidth, page: document.documentElement.scrollWidth - innerWidth };
    }, session.id);
    const opened = () => expect(page.getByTestId("file-view").getByTitle("ui/src/styles.css")).toBeVisible();

    // 900 px: no room for two columns. The panel lies over the pane and nothing else moves.
    await page.setViewportSize({ width: 900, height: 1040 });
    await page.goto(`/s/${session.id}`);
    await expect(station.getByTestId("composer")).toBeVisible();
    const before = await measure();
    expect(before).toMatchObject({ strip: 0, page: 0 });
    await page.keyboard.press("Control+Shift+E");
    await expect(side).toBeVisible();
    expect(await measure()).toEqual(before);
    await expect(side).toHaveAttribute("data-mode", "sheet");
    await page.getByTestId("files-search").fill("styles.css");
    await page.getByText("ui/src/styles.css").click();
    await opened();
    await expect(close).toBeInViewport({ ratio: 1 });
    await expect(station.getByTestId("session-menu")).toBeInViewport({ ratio: 1 });
    await shoot(page, "wb-panel-900-sheet");

    // Wider: both columns fit, the same file is still open beside the conversation.
    await page.setViewportSize({ width: 1920, height: 1040 });
    await expect(side).toHaveAttribute("data-mode", "beside");
    await opened();
    await expect(station.getByTestId("composer")).toBeInViewport({ ratio: 1 });
    await expect(close).toBeInViewport({ ratio: 1 });
    const wide = await measure();
    expect(wide).toMatchObject({ strip: 0, page: 0 });
    const box = (await side.boundingBox())!;
    const text = (await station.getByTestId("transcript").boundingBox())!;
    expect(text.x + text.width).toBeLessThanOrEqual(box.x + 1);
    await shoot(page, "wb-panel-1920-beside");

    // Back across the line, then to a phone: the file stays, Close stays in reach.
    await page.setViewportSize({ width: 900, height: 1040 });
    await expect(side).toHaveAttribute("data-mode", "sheet");
    await opened();
    expect(await measure()).toEqual(before);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(side).toHaveAttribute("data-mode", "sheet");
    await opened();
    await expect(close).toBeInViewport({ ratio: 1 });
    expect((await measure()).page).toBe(0); // a phone's panes are pages: only the page itself must not scroll
    await shoot(page, "wb-panel-390-sheet");
    await page.setViewportSize({ width: 900, height: 1040 });
    await opened();
    await close.click();
    await expect(side).toBeHidden();
    await expect(station.getByTestId("composer")).toBeInViewport({ ratio: 1 });
    expect(await measure()).toEqual(before);

    // Opened with room, it goes straight beside.
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.keyboard.press("Control+Shift+E");
    await expect(side).toHaveAttribute("data-mode", "beside");
    expect(await measure()).toMatchObject({ strip: 0, page: 0 });
    await page.keyboard.press("Control+\\");
    await expect(side).toBeHidden();
  } finally { await request.delete(`/api/sessions/${session.id}`); }
});
