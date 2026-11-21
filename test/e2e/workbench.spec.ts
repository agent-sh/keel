import { expect, test } from "./isolate.ts";
import { openPanel, shoot } from "./shots.ts";

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
    const phase = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.phase;
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "Review the release checklist." } });
    await expect.poll(phase, { timeout: 20_000 }).toBe("idle");
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
    // The pane's close, Session actions and the panel's close share one column.
    const mid = async (l: ReturnType<typeof page.getByTestId>) => { const r = (await l.boundingBox())!; return r.x + r.width / 2; };
    const column = [await mid(station.getByTestId("station-close")), await mid(station.getByTestId("session-menu")), await mid(close)];
    expect(Math.max(...column) - Math.min(...column)).toBeLessThanOrEqual(1.5);
    // The conversation under the sheet is out of reach: nothing there takes focus or text.
    await expect(station.locator(".k-session")).toHaveAttribute("inert", "");
    expect(await station.getByTestId("composer").evaluate((el) => { (el as HTMLElement).focus(); return document.activeElement === el; })).toBe(false);
    await shoot(page, "wb-panel-900-sheet");
    // Escape in a popup of the panel closes that popup, not the panel.
    await page.getByTestId("panel-switch").click();
    await expect(page.getByTestId("panel-picker")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("panel-picker")).toBeHidden();
    await expect(side).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

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
    // Escape leaves the sheet and does not reach the turn working behind it; the next one stops the turn.
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:long-tool" } });
    await expect.poll(phase).toBe("working");
    await close.focus();
    await page.keyboard.press("Escape");
    await expect(side).toBeHidden();
    await expect(station.locator(".k-session")).not.toHaveAttribute("inert");
    await expect(station.getByTestId("composer")).toBeInViewport({ ratio: 1 });
    expect(await measure()).toEqual(before);
    await page.waitForTimeout(400);
    expect(await phase()).toBe("working");
    await page.keyboard.press("Escape");
    await expect.poll(phase).toBe("idle");
    // From the panel's search field too.
    await page.keyboard.press("Control+Shift+E");
    await expect(side).toHaveAttribute("data-mode", "sheet");
    await page.getByTestId("files-search").focus();
    await page.keyboard.press("Escape");
    await expect(side).toBeHidden();

    // Opened with room, it goes straight beside. Escape is not its close: the conversation is in reach.
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.keyboard.press("Control+Shift+E");
    await expect(side).toHaveAttribute("data-mode", "beside");
    await expect(station.locator(".k-session")).not.toHaveAttribute("inert");
    expect(await measure()).toMatchObject({ strip: 0, page: 0 });
    await close.focus();
    await page.keyboard.press("Escape");
    await expect(side).toBeVisible();

    // Four panes at this width leave the helm no room for two columns: a sheet over its pane, and the row of panes does not scroll.
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("4 panes");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("bridge").locator(":scope > [data-slot]")).toHaveCount(4);
    await expect(side).toHaveAttribute("data-mode", "sheet");
    const four = await measure();
    expect(four).toMatchObject({ strip: 0, page: 0 });
    expect((await side.boundingBox())!.width).toBeLessThanOrEqual(four.pane + 1);
    await shoot(page, "wb-panel-1920-four-panes");
    await page.keyboard.press("Control+\\");
    await expect(side).toBeHidden();
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("1 pane");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("bridge").locator(":scope > [data-slot]")).toHaveCount(1);
  } finally { await request.delete(`/api/sessions/${session.id}`); }
});

// A file result's Mention is reachable without a mouse: by Tab from the
// result, and on a touch screen it shows before the row is tapped. Either way
// one press puts the path in the message box without opening the file.
const mentionSession = async (request: import("@playwright/test").APIRequestContext) =>
  (await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", workspace: process.cwd(), title: `Mention a file ${Date.now().toString(36)}` } })).json()).session;

test("a file result's Mention by keyboard", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const s = await mentionSession(request);
  await page.goto(`/s/${s.id}`);
  await openPanel(page, "files");
  await page.getByTestId("files-search").fill("ui/src/styles.css");
  const hit = page.getByTestId("files-panel").getByRole("button", { name: "ui/src/styles.css", exact: true });
  await expect(hit).toBeVisible();
  // The pointer is nowhere near: from the search box, Tab to the result, Tab to its Mention.
  await page.mouse.move(0, 0);
  await page.keyboard.press("Tab");
  await expect(hit).toBeFocused();
  await page.keyboard.press("Tab");
  const mention = page.getByRole("button", { name: "Mention ui/src/styles.css", exact: true });
  await expect(mention).toBeFocused();
  expect(await mention.evaluate((b) => getComputedStyle(b).opacity)).toBe("1");
  await shoot(page, "wb-15-file-mention-by-keyboard");
  await page.keyboard.press("Enter");
  const composer = page.locator(`[data-station="${s.id}"]`).getByTestId("composer");
  await expect(composer).toHaveValue("@ui/src/styles.css ");
  await expect(composer).toBeFocused();
  await expect(page.getByTestId("file-view")).toHaveCount(0);
  await request.delete(`/api/sessions/${s.id}`);
});

test.describe("on a touch screen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("a file result's Mention shows before a tap", async ({ page, request }) => {
    const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
    test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
    const s = await mentionSession(request);
    await page.goto(`/s/${s.id}`);
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    await openPanel(page, "files");
    await page.getByTestId("files-search").fill("ui/src/styles.css");
    await expect(page.getByTestId("files-panel").getByRole("button", { name: "ui/src/styles.css", exact: true })).toBeVisible();
    const mention = page.getByRole("button", { name: "Mention ui/src/styles.css", exact: true });
    await expect(mention).toBeVisible();
    expect(await mention.evaluate((b) => getComputedStyle(b).opacity)).toBe("1");
    const b = (await mention.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(390);
    expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(24);
    await shoot(page, "wb-16-file-mention-touch");
    await mention.tap();
    await expect(page.locator(`[data-station="${s.id}"]`).getByTestId("composer")).toHaveValue("@ui/src/styles.css ");
    await expect(page.getByTestId("file-view")).toHaveCount(0);
    await request.delete(`/api/sessions/${s.id}`);
  });
});

// The "/" and "@" suggestions by keyboard and by what assistive technology is
// told: the focus stays in the message box, which names the list it controls
// and the option the arrows are on; that option stays in view; Enter applies
// it; Escape closes the list and leaves the draft.
test("the message box names its suggestions and the active one", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Suggestions", workspace: process.cwd() } })).json();
  try {
    await page.goto(`/s/${session.id}`);
    const box = page.getByTestId("composer");
    await expect(box).toBeFocused();
    await expect(box).toHaveAttribute("aria-haspopup", "listbox");
    // The option the box points at: a real option of the list it controls, marked selected, whole in the popup.
    const active = async (menu: "slash-menu" | "mention-menu") => {
      const id = await box.getAttribute("aria-activedescendant");
      expect(id).toBeTruthy();
      const list = page.locator(`[id="${await box.getAttribute("aria-controls")}"]`);
      await expect(list).toHaveAttribute("role", "listbox");
      const option = list.locator(`[id="${id}"]`);
      await expect(option).toHaveAttribute("role", "option");
      await expect(option).toHaveAttribute("aria-selected", "true");
      await expect(list.locator('[aria-selected="true"]')).toHaveCount(1);
      expect(await option.evaluate((el, testid) => {
        const r = el.getBoundingClientRect();
        const view = el.closest(`[data-testid="${testid}"]`)!.getBoundingClientRect();
        return r.top >= view.top - 0.5 && r.bottom <= view.bottom + 0.5;
      }, menu)).toBe(true);
      await expect(box).toBeFocused();
      return option;
    };

    for (const [menu, typed, name] of [["slash-menu", "/", "Commands"], ["mention-menu", "Read @", /^Files in /]] as const) {
      await box.fill("");
      await page.keyboard.type(typed);
      const popup = page.getByTestId(menu);
      await expect(popup).toBeVisible();
      const options = page.getByRole("listbox", { name }).getByRole("option");
      const n = await options.count();
      // More options than the popup shows at once: the last ones start out of its view.
      expect(await popup.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
      await expect(await active(menu)).toHaveAttribute("id", (await options.first().getAttribute("id"))!);
      for (let i = 1; i < n; i++) {
        await page.keyboard.press("ArrowDown");
        if (i % 5 === 0 || i === n - 1) await active(menu);
      }
      const last = await active(menu);
      expect(await last.getAttribute("id")).toBe(await options.last().getAttribute("id"));
      await shoot(page, menu === "slash-menu" ? "wb-15-slash-last-option" : "wb-16-mention-last-option");
      await page.keyboard.press("ArrowUp");
      expect(await (await active(menu)).getAttribute("id")).toBe(await options.nth(n - 2).getAttribute("id"));
      // Escape closes the list: the words stay, the box points at nothing, and typing on in the same word keeps it closed.
      await page.keyboard.press("Escape");
      await expect(popup).toBeHidden();
      await expect(box).toHaveValue(typed);
      await expect(box).toBeFocused();
      expect(await box.getAttribute("aria-activedescendant")).toBeNull();
      expect(await box.getAttribute("aria-controls")).toBeNull();
      await page.keyboard.type("a");
      await expect(popup).toBeHidden();
      await expect(box).toHaveValue(`${typed}a`);
    }

    // Enter applies the option the box points at, not the first one.
    await box.fill("");
    await page.keyboard.type("/");
    await expect(page.getByTestId("slash-menu")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    const command = (await (await active("slash-menu")).locator("span.font-medium").innerText()).trim();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("slash-menu")).toBeHidden();
    // A command that takes an argument is written into the box; one that takes none runs and empties it.
    expect(["", `${command} `]).toContain(await box.inputValue());
    await box.fill("");
    await page.keyboard.type("Read @");
    await expect(page.getByTestId("mention-menu")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    const path = (await (await active("mention-menu")).innerText()).trim();
    await page.keyboard.press("Enter");
    await expect(box).toHaveValue(new RegExp(`^Read @${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await expect(box).toBeFocused();
  } finally { await request.delete(`/api/sessions/${session.id}`); }
});

// The shortcut sheet names the keys that send and that make a new line as
// the "Send with" setting has them now, not as they are by default.
test("the shortcut sheet follows the Send with setting", async ({ page, request }) => {
  await page.goto("/settings/general");
  const sendWith = page.getByRole("radiogroup", { name: "Send with" });
  const sheet = page.getByTestId("shortcuts");
  const keys = (label: string) => sheet.locator("div.h-8", { hasText: new RegExp(`^${label}`) }).locator("kbd");
  const open = async () => { await page.keyboard.press("Control+/"); await expect(sheet).toBeVisible(); };
  const close = async () => { await page.keyboard.press("Escape"); await expect(sheet).toBeHidden(); };

  await open();
  await expect(keys("Send")).toHaveText(["Enter"]);
  await expect(keys("New line")).toHaveText(["Shift", "Enter"]);
  await close();
  await sendWith.getByRole("radio", { name: "Ctrl Enter" }).click();
  await open();
  await expect(keys("Send")).toHaveText(["Ctrl", "Enter"]);
  await expect(keys("New line")).toHaveText(["Enter"]);
  await keys("Send").first().scrollIntoViewIfNeeded();
  await shoot(page, "wb-17-shortcuts-send-with");
  await close();
  // The setting's own page lists the same keys.
  await page.goto("/settings/keyboard");
  await expect(page.locator("div.h-8", { hasText: /^Send/ }).locator("kbd")).toHaveText(["Ctrl", "Enter"]);
  await page.goto("/settings/general");
  await sendWith.getByRole("radio", { name: "Enter", exact: true }).click();
  await open();
  await expect(keys("Send")).toHaveText(["Enter"]);
  await expect(keys("New line")).toHaveText(["Shift", "Enter"]);
  await close();

  // In a session the conversation's keys are listed once each, together.
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  if (!models.includes("scripted:stand-in")) return;
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Sheet in a session" } })).json();
  try {
    await page.goto(`/s/${session.id}`);
    await expect(page.getByTestId("composer")).toBeVisible();
    await open();
    await expect(sheet.locator("div.h-8", { hasText: "Go to the end and follow" })).toHaveCount(1);
    const conversation = sheet.locator("section", { has: page.getByRole("heading", { name: "Conversation" }) });
    await expect(conversation.locator("div.h-8 > span:first-child")).toHaveText(["Go to the end and follow", "Previous prompt", "Next prompt", "Focus the message box"]);
    await conversation.scrollIntoViewIfNeeded();
    await shoot(page, "wb-17b-shortcuts-conversation");
    await close();
  } finally { await request.delete(`/api/sessions/${session.id}`); }
});

// Panels search: Enter opens the result at the top of the list as it is
// shown (grouped), and nothing when nothing matches.
test("Enter in the Panels search opens the first result shown", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Panels search" } })).json();
  try {
    await page.goto(`/s/${session.id}`);
    const search = page.getByTestId("panel-search");
    const picks = page.getByTestId("panel-picker").locator('[data-testid^="panel-pick-"]');
    const side = page.getByTestId("side-panel");
    // "re" matches Review (shown first, under Work) and Terminal (earlier in the registry, shown last under More).
    for (const q of ["re", "t", "u"]) {
      await page.getByTestId("panel-menu").click();
      await search.fill(q);
      expect(await picks.count()).toBeGreaterThan(1);
      const first = (await picks.first().getAttribute("data-testid"))!.replace("panel-pick-", "");
      if (q === "re") { expect(first).toBe("review"); await shoot(page, "wb-18-panel-search"); }
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("panel-picker")).toBeHidden();
      await expect(side).toHaveAttribute("data-panel", first);
    }
    // Nothing matches: Enter opens nothing and the panel on screen stays.
    const before = await side.getAttribute("data-panel");
    await page.getByTestId("panel-menu").click();
    await search.fill("no such panel");
    await expect(page.getByTestId("panel-picker")).toContainText("No panel matches.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("panel-picker")).toBeVisible();
    await expect(search).toHaveValue("no such panel");
    await expect(side).toHaveAttribute("data-panel", before!);
  } finally { await request.delete(`/api/sessions/${session.id}`); }
});
