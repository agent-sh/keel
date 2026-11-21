import type { APIRequestContext, Page } from "./isolate.ts";
import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openPanel, shoot, tabInto } from "./shots.ts";

// Feature: the layout is the owner's. The number of panes is the one picked
// in the rail (1, 2, 3, more when the window holds them) and Keel never adds
// one: opening a session opens it in the pane worked in (a pane just added is
// the one worked in); closing one closes its pane, and an empty pane is not
// kept over a reload. The list's edge and the line
// between two panes drag (and move with the arrow keys, reset on a double
// click), and the sizes are remembered. A session dragged from the list
// lands in the pane it is dropped on; a pane's header dropped on another
// trades their places. Type is larger by default, and the text size (Ctrl +,
// Ctrl -, Ctrl 0, or Settings) scales the whole interface and is remembered,
// with nothing clipped. A long transcript never makes the row of panes scroll.
const MODEL = "scripted:stand-in";
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1700, height: 980 } });

test("panes by number, dragging, and text size", async ({ page, request }) => {
  const tag = Date.now().toString(36);
  const mk = async (title: string, text: string) => {
    const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title } })).json()).session;
    await request.post(`/api/sessions/${s.id}/messages`, { data: { text } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).events.some((e: any) => e.kind === "turn_end" || e.kind === "error"), { timeout: 30_000 }).toBe(true);
    return s.id as string;
  };
  const a = await mk(`Rotate the staging database credentials ${tag}`, "Rotate them.");
  const b = await mk(`Draft the release notes and list every breaking change ${tag}`, "Draft them.");
  const c = await mk(`Cut the build time: cache the toolchain ${tag}`, "Cut it.");
  const d = await mk(`Investigate the layout shift after the font swap ${tag}`, "Look into it.");
  const long = await mk(`A long transcript ${tag}`, "Fill it. script:fill");

  const bridge = page.getByTestId("bridge");
  const panes = bridge.locator(":scope > [data-slot]");
  const pane = (i: number) => bridge.locator(`:scope > [data-slot="${i}"]`);
  const side = page.getByTestId("sidebar");
  const entry = (id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);
  const width = async (l: ReturnType<typeof pane>) => (await l.boundingBox())!.width;
  const stored = (k: string) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), k);
  const rootPx = () => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  const fontPx = (sel: string) => page.locator(sel).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const fits = async () => {
    // Nothing spills: the page, the row of panes, the rail's rows, each pane's tools and message box.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await bridge.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="session-row"]')].every((el) => el.scrollWidth <= el.clientWidth + 1))).toBe(true);
    expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="bridge"] > [data-station]')].every((st) => {
      const box = st.getBoundingClientRect();
      const inside = (el: Element | null) => { if (!el) return true; const r = el.getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1 && r.bottom <= innerHeight + 1; };
      return inside(st.querySelector('[data-testid="station-close"]')) && inside(st.querySelector('[data-testid="composer"]'));
    }))).toBe(true);
  };

  // A kept layout of two panes, one of them empty, opens as one pane: the empty one is not forced.
  await page.addInitScript((id) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("keel.panes", JSON.stringify({ count: 2, slots: [id, null], sizes: {}, active: 1 }));
  }, a);
  await page.goto(`/s/${a}`);
  await expect(panes).toHaveCount(1);
  await expect(pane(0)).toHaveAttribute("data-station", a);
  // Two by the owner's number: the new pane is the one worked in.
  await page.getByTestId("panes-2").click();
  await expect(panes).toHaveCount(2);
  await expect(pane(1)).toHaveAttribute("data-testid", "pane-empty");
  await expect(pane(1)).toContainText("the next session opens here");

  // Type is larger by default: what is read and what is glanced at.
  expect(await rootPx()).toBe(17);
  expect(await fontPx('[data-testid="transcript"] .prose-keel')).toBeGreaterThanOrEqual(18);
  expect(await fontPx('[data-testid="session-row"] .k-row-title')).toBeGreaterThanOrEqual(14);
  expect(await fontPx('[data-testid="composer"]')).toBeGreaterThanOrEqual(15);

  // Opening a session never adds a pane: it goes to the pane worked in.
  await entry(b).click();
  await expect(pane(1)).toHaveAttribute("data-station", b);
  await expect(panes).toHaveCount(2);
  await entry(c).click();
  await expect(pane(1)).toHaveAttribute("data-station", c);
  await expect(pane(0)).toHaveAttribute("data-station", a);
  await expect(panes).toHaveCount(2);

  // Three panes by the owner's number: the new one is empty and offers what is not on screen.
  await page.getByTestId("panes-3").click();
  await expect(panes).toHaveCount(3);
  await expect(pane(2)).toHaveAttribute("data-testid", "pane-empty");
  await expect(pane(2)).toContainText("the next session opens here");
  await expect(side).toHaveAttribute("data-open", "true");
  await shoot(page, "layout-01-three-panes-one-empty");
  await pane(2).locator(`[data-testid="pane-offer"][data-session="${b}"]`).click();
  await expect(pane(2)).toHaveAttribute("data-station", b);
  await fits();
  await shoot(page, "layout-02-three-panes");

  // Closing a session closes its pane. One pane keeps the one worked in; an empty pane is gone after a reload.
  await pane(2).getByTestId("station-close").click();
  await expect(panes).toHaveCount(2);
  await entry(a).click();
  await page.getByTestId("panes-1").click();
  await expect(panes).toHaveCount(1);
  await expect(pane(0)).toHaveAttribute("data-station", a);
  await shoot(page, "layout-03-one-pane");
  await page.getByTestId("panes-2").click();
  await expect(panes).toHaveCount(2);
  await expect(pane(1)).toHaveAttribute("data-testid", "pane-empty");
  await page.reload();
  await expect(panes).toHaveCount(1);
  await expect(pane(0)).toHaveAttribute("data-station", a);
  await page.getByTestId("panes-2").click();

  // A session dragged from the list lands in the pane it is dropped on.
  await entry(d).dragTo(pane(1));
  await expect(pane(1)).toHaveAttribute("data-station", d);
  await expect(page).toHaveURL(new RegExp(`/s/${d}`));
  // A pane's header dropped on another pane trades their places.
  await pane(0).getByTestId("station-head").dragTo(pane(1));
  await expect(pane(0)).toHaveAttribute("data-station", d);
  await expect(pane(1)).toHaveAttribute("data-station", a);
  // The pane under a dragged session says the drop lands there.
  const data = await page.evaluateHandle((id) => { const dt = new DataTransfer(); dt.setData("application/x-keel-session", id); return dt; }, c);
  await pane(1).dispatchEvent("dragover", { dataTransfer: data });
  await expect(pane(1)).toHaveAttribute("data-drop", /./);
  await shoot(page, "layout-04-drop-target");
  await pane(1).dispatchEvent("dragleave", { dataTransfer: data });
  await expect(pane(1)).not.toHaveAttribute("data-drop", /./);

  // The line between two panes drags; the arrow keys move it; the sizes are remembered; a double click evens them.
  const grip = page.getByTestId("pane-grip");
  const even = await width(pane(0));
  const at = (await grip.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + 300);
  await page.mouse.down();
  await page.mouse.move(at.x + at.width / 2 + 160, at.y + 300, { steps: 6 });
  await page.mouse.up();
  expect(Math.abs((await width(pane(0))) - (even + 160))).toBeLessThan(3);
  await grip.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  expect(Math.abs((await width(pane(0))) - (even + 128))).toBeLessThan(3);
  // The list's edge drags too.
  const edge = page.getByTestId("list-grip");
  const list0 = (await side.boundingBox())!.width;
  const le = (await edge.boundingBox())!;
  await page.mouse.move(le.x + le.width / 2, 400);
  await page.mouse.down();
  await page.mouse.move(le.x + le.width / 2 + 90, 400, { steps: 5 });
  await page.mouse.up();
  expect(Math.abs((await side.boundingBox())!.width - (list0 + 90))).toBeLessThan(3);
  await edge.focus();
  await page.keyboard.press("ArrowRight");
  expect(Math.abs((await side.boundingBox())!.width - (list0 + 106))).toBeLessThan(3);
  await fits();
  await shoot(page, "layout-05-resized");
  const wide = await width(pane(0));
  await page.reload();
  await expect(panes).toHaveCount(2);
  expect(Math.abs((await width(pane(0))) - wide)).toBeLessThan(3);
  expect(Math.abs((await side.boundingBox())!.width - (list0 + 106))).toBeLessThan(3);
  await page.getByTestId("list-grip").dblclick();
  expect(Math.abs((await side.boundingBox())!.width - list0)).toBeLessThan(3);
  await page.getByTestId("pane-grip").dblclick();
  expect(Math.abs((await width(pane(0))) - (await width(pane(1))))).toBeLessThan(3);

  // A long transcript scrolls inside its pane; the row of panes never scrolls into blank space.
  await entry(long).click();
  await expect(bridge.locator(`[data-station="${long}"]`)).toContainText("lorem ipsum");
  expect(await bridge.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);

  // Text size: Ctrl + steps the whole interface up, and it is remembered.
  const read0 = await fontPx('[data-testid="transcript"] .prose-keel');
  await page.keyboard.press("Control+=");
  expect(await rootPx()).toBeCloseTo(18.7, 1);
  expect(await fontPx('[data-testid="transcript"] .prose-keel')).toBeCloseTo(read0 * 1.1, 1);
  expect(await stored("keel.textScale")).toBe(1.1);
  await page.reload();
  expect(await rootPx()).toBeCloseTo(18.7, 1);
  await expect(panes).toHaveCount(2);
  await fits();
  // Settings has the same control.
  await page.goto("/settings/general");
  const sizes = page.getByTestId("text-size");
  await expect(sizes.getByRole("radio", { checked: true })).toHaveAttribute("data-testid", "text-size-110");
  await shoot(page, "layout-06-settings-text-size");
  await page.getByTestId("text-size-135").click();
  expect(await rootPx()).toBeCloseTo(22.95, 1);
  await expect(sizes.getByRole("radio", { checked: true })).toHaveAttribute("data-testid", "text-size-135");
  // At the larger sizes two panes still stand side by side, nothing clipped.
  await page.goto(`/s/${long}`);
  await expect(panes).toHaveCount(2);
  await expect(bridge.locator(`[data-station="${long}"]`)).toContainText("lorem ipsum");
  await fits();
  await shoot(page, "layout-07-text-135");
  await page.keyboard.press("Control+-");
  expect(await rootPx()).toBeCloseTo(20.4, 1);
  await fits();
  await shoot(page, "layout-08-text-120");
  await page.keyboard.press("Control+0");
  expect(await rootPx()).toBe(17);
  expect(await stored("keel.textScale")).toBe(1);
  await page.keyboard.press("Control+-");
  expect(await rootPx()).toBeCloseTo(15.3, 1);
  await fits();
  await page.keyboard.press("Control+0");

  for (const id of [a, b, c, d, long]) await request.delete(`/api/sessions/${id}`);
});

// The pane count and the Settings choices (theme, text size, send key) are
// radio groups: one Tab stop on the option chosen, the arrows move to the
// next option and choose it, the next Tab leaves the group.
test("pane count and settings choices by keyboard", async ({ page, request }) => {
  await page.setViewportSize({ width: 1920, height: 1040 });
  const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title: `Choices by keyboard ${Date.now().toString(36)}` } })).json()).session;
  const stored = (k: string) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), k);
  const at = (group: ReturnType<typeof page.getByTestId>) => group.locator(":focus");

  await page.goto(`/s/${s.id}`);
  const panes = page.getByTestId("bridge").locator(":scope > [data-slot]");
  const count = page.getByTestId("pane-count");
  await page.getByTestId("panes-2").click();
  await expect(panes).toHaveCount(2);
  await tabInto(page, count);
  await expect(at(count)).toHaveAttribute("data-testid", "panes-2");
  await page.keyboard.press("ArrowRight");
  await expect(at(count)).toHaveAttribute("data-testid", "panes-3");
  await expect(panes).toHaveCount(3);
  await shoot(page, "layout-09-pane-count-by-keyboard");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(at(count)).toHaveAttribute("data-testid", "panes-1");
  await expect(panes).toHaveCount(1);
  expect((await stored("keel.panes")).count).toBe(1);
  await page.keyboard.press("Tab");
  await expect(at(count)).toHaveCount(0);
  // A pane command sets the number from outside the group: Tab still lands on the number shown.
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("3 panes");
  await page.getByRole("option", { name: /3 panes/ }).first().click();
  await expect(panes).toHaveCount(3);
  await tabInto(page, count);
  await expect(at(count)).toHaveAttribute("data-testid", "panes-3");
  // The ring of the option under the keyboard stays inside the group's track.
  const inside = (group: ReturnType<typeof page.getByTestId>) => group.evaluate((g) => {
    const el = g.querySelector<HTMLElement>(":focus")!;
    const c = getComputedStyle(el);
    const reach = parseFloat(c.outlineWidth) + parseFloat(c.outlineOffset);
    const a = el.getBoundingClientRect(), b = g.getBoundingClientRect();
    return c.outlineStyle !== "none" && a.left - reach >= b.left && a.right + reach <= b.right && a.top - reach >= b.top && a.bottom + reach <= b.bottom;
  });
  expect(await inside(count)).toBe(true);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(panes).toHaveCount(1);

  await page.goto("/settings/general");
  const theme = page.getByRole("radiogroup", { name: "Theme" });
  const sizes = page.getByTestId("text-size");
  const send = page.getByRole("radiogroup", { name: "Send with" });
  const dark = () => page.evaluate(() => document.documentElement.classList.contains("dark"));
  await page.emulateMedia({ colorScheme: "light" });
  await tabInto(page, theme);
  await expect(at(theme)).toHaveText("System");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(at(theme)).toHaveText("Dark");
  await expect.poll(dark).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("keel.theme"))).toBe("dark");
  await page.keyboard.press("ArrowLeft");
  await expect(at(theme)).toHaveText("Light");
  await expect.poll(dark).toBe(false);
  // The next Tab leaves the theme for the text size, on the size in use.
  await page.keyboard.press("Tab");
  await expect(at(theme)).toHaveCount(0);
  await expect(at(sizes)).toHaveAttribute("data-testid", "text-size-100");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(at(sizes)).toHaveAttribute("data-testid", "text-size-120");
  expect(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBeCloseTo(20.4, 1);
  expect(await stored("keel.textScale")).toBe(1.2);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  expect(await stored("keel.textScale")).toBe(1);
  await page.keyboard.press("Tab");
  await expect(at(send)).toHaveText("Enter");
  await page.keyboard.press("ArrowRight");
  await expect(at(send)).toHaveText("Ctrl Enter");
  await expect(page.getByText("Ctrl Enter sends, Enter makes a new line.")).toBeVisible();
  expect(await stored("keel.enterSends")).toBe(false);
  await shoot(page, "layout-10-settings-choices-by-keyboard");
  // Out of the group and back: it is entered on the option chosen, from either end.
  await page.keyboard.press("Tab");
  await expect(at(send)).toHaveCount(0);
  await page.keyboard.press("Shift+Tab");
  await expect(at(send)).toHaveText("Ctrl Enter");
  expect(await inside(send)).toBe(true);
  // A size set from outside the group (Ctrl +) moves its Tab stop with it.
  await page.keyboard.press("Control+=");
  expect(await stored("keel.textScale")).toBe(1.1);
  await page.keyboard.press("Shift+Tab");
  await expect(at(sizes)).toHaveAttribute("data-testid", "text-size-110");
  // Set while the keyboard is in the group (Ctrl 0), the focus goes to the size now in use.
  await page.keyboard.press("Control+0");
  await expect(at(sizes)).toHaveAttribute("data-testid", "text-size-100");
  // The rail's theme button changes the theme: Tab into the group lands on the new one.
  await page.getByTestId("theme-toggle").click();
  await expect.poll(dark).toBe(true);
  await tabInto(page, theme);
  await expect(at(theme)).toHaveText("Dark");

  // The send key is the one chosen: Enter now makes a new line.
  await page.goto(`/s/${s.id}`);
  const composer = page.getByTestId("composer");
  await composer.fill("one");
  await composer.press("Enter");
  await composer.pressSequentially("two");
  await expect(composer).toHaveValue("one\ntwo");
  await expect(page.getByTestId("user-message")).toHaveCount(0);
  await request.delete(`/api/sessions/${s.id}`);
});

// Settings > General on a small phone at the largest text size: all six text
// sizes are on the screen, the one in use is marked, and the default is one
// tap away with nothing to pan to.
test("text size choices fit a small phone", async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("keel.textScale", "1.5"); } });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/settings/general");
  const sizes = page.getByTestId("text-size");
  await sizes.scrollIntoViewIfNeeded();
  const radios = sizes.getByRole("radio");
  await expect(radios).toHaveCount(6);
  for (const r of await radios.all()) await expect(r).toBeInViewport({ ratio: 1 });
  const group = (await sizes.boundingBox())!;
  expect(group.x).toBeGreaterThanOrEqual(0);
  expect(group.x + group.width).toBeLessThanOrEqual(320);
  // The six stand in one row, in order, none over another.
  const boxes = await Promise.all((await radios.all()).map(async (r) => (await r.boundingBox())!));
  for (let i = 1; i < boxes.length; i++) {
    expect(boxes[i]!.x).toBeGreaterThanOrEqual(boxes[i - 1]!.x + boxes[i - 1]!.width - 0.5);
    expect(Math.abs(boxes[i]!.y - boxes[0]!.y)).toBeLessThan(1);
  }
  const current = sizes.getByRole("radio", { checked: true });
  await expect(current).toHaveAttribute("data-testid", "text-size-150");
  expect(await current.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(await sizes.getByTestId("text-size-100").evaluate((el) => getComputedStyle(el).backgroundColor));
  await shoot(page, "layout-10-text-size-phone");
  // Back to the default from where the page stands.
  await sizes.getByTestId("text-size-100").click();
  expect(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(17);
  await expect(sizes.getByRole("radio", { checked: true })).toHaveAttribute("data-testid", "text-size-100");
  // With room the control keeps its own width beside the label.
  await page.setViewportSize({ width: 1920, height: 1040 });
  expect((await sizes.boundingBox())!.width).toBeLessThan(260);
  await shoot(page, "layout-11-text-size-wide");
});

// Settings search under the keyboard: Tab reaches "Find a setting" and the
// field shows it in the focus color of each theme, and it keeps its name once
// something is typed in it.
test("settings search shows keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto("/settings/general");
  const field = page.getByPlaceholder("Find a setting");
  await page.getByRole("button", { name: "Back" }).focus();
  await page.keyboard.press("Tab");
  await expect(field).toBeFocused();
  // What marks the field (its box), read with the theme's ring color beside it.
  const mark = () => field.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--ring)";
    document.body.append(probe);
    const ring = getComputedStyle(probe).color;
    probe.remove();
    const box = el.closest("label")!;
    const s = getComputedStyle(box);
    return { ring, shown: `${s.boxShadow} ${s.outlineStyle === "none" ? "" : s.outlineColor}` };
  });
  const rings: string[] = [];
  for (const dark of [false, true]) {
    await page.evaluate((d) => document.documentElement.classList.toggle("dark", d), dark);
    const m = await mark();
    expect(m.shown).toContain(m.ring);
    rings.push(m.ring);
  }
  expect(rings[0]).not.toBe(rings[1]);
  await shoot(page, "layout-12-settings-search-focus");
  await field.fill("usage");
  await expect(page.getByRole("textbox", { name: "Find a setting" })).toHaveValue("usage");
  // (Storage answers to the word too: it keeps the usage records and says for how long.)
  await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("button")).toHaveText(["Usage", "Storage"]);
  // Away from the field the mark goes.
  await page.keyboard.press("Tab");
  expect((await mark()).shown).not.toContain((await mark()).ring);
});

// A narrow Settings page (a phone, or a window the session list and a large
// text size leave little of) names its section in a bar under the head: the
// bar is the section's title and opens the search and the grouped list in
// place of the section. A wide page keeps the grouped rail, with the row of
// the section shown in view.
test("settings sections on a narrow page", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/settings/storage");
  const settings = page.getByTestId("settings");
  const jump = page.getByTestId("settings-jump");
  const nav = settings.getByRole("navigation", { name: "Settings sections" });
  const row = (id: string) => nav.locator(`button[data-section="${id}"]`);
  const title = page.getByTestId("settings-title");
  // Nothing on the page is wider than the page, so nothing pans sideways.
  const fits = () => settings.evaluate((el) => [el, ...el.querySelectorAll("*")].every((n) => n.scrollWidth <= n.clientWidth + 1 || getComputedStyle(n).overflowX === "visible" || getComputedStyle(n).overflowX === "hidden" || getComputedStyle(n).overflowX === "clip"));
  const inView = (l: ReturnType<typeof row>) => l.evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1; });

  // A direct link to a late section: the bar says which one, whole, inside the page.
  await expect(title).toHaveText("Storage");
  await expect(jump).toBeVisible();
  await expect(jump).toContainText("Machine");
  await expect(jump).toContainText("Storage");
  await expect(jump).toHaveAttribute("aria-expanded", "false");
  expect(await inView(jump)).toBe(true);
  expect(await fits()).toBe(true);
  await expect(row("storage")).toBeHidden();
  await shoot(page, "layout-13-settings-narrow");

  // The bar opens the grouped list in place of the section, on the row of the section shown.
  await jump.click();
  await expect(jump).toHaveAttribute("aria-expanded", "true");
  await expect(row("storage")).toHaveAttribute("aria-current", "page");
  await expect.poll(() => inView(row("storage"))).toBe(true);
  await expect(nav.getByRole("heading", { name: "Machine" })).toBeVisible();
  await expect(settings.getByTestId("storage-panel")).toBeHidden();
  expect(await fits()).toBe(true);
  await shoot(page, "layout-14-settings-narrow-sections");

  // Search reaches General; picking it shows the section and closes the list.
  await page.getByTestId("settings-find").fill("theme");
  await expect(nav.locator("button[data-section]")).toHaveCount(1);
  await shoot(page, "layout-15-settings-narrow-search");
  await row("general").click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await expect(title).toHaveText("General");
  await expect(jump).toContainText("General");
  await expect(jump).toHaveAttribute("aria-expanded", "false");
  await expect(jump).toBeFocused();
  await expect(page.getByTestId("text-size")).toBeVisible();
  expect(await fits()).toBe(true);
  // And back, through the groups: the search is empty again, and Escape closes without a pick.
  await jump.click();
  await expect(page.getByTestId("settings-find")).toHaveValue("");
  await page.getByTestId("settings-find").fill("no such setting");
  await expect(page.getByTestId("settings-none")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(jump).toHaveAttribute("aria-expanded", "false");
  await expect(title).toHaveText("General");
  await jump.click();
  await row("storage").scrollIntoViewIfNeeded();
  await row("storage").click();
  await expect(title).toHaveText("Storage");
  await expect(settings.getByTestId("storage-panel")).toBeVisible();
  // A section reached from elsewhere while the list is open (here, Back in the history) closes the list on it.
  await jump.click();
  await expect(jump).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() => { history.replaceState(null, "", "/settings/about"); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(title).toHaveText("About");
  await expect(jump).toHaveAttribute("aria-expanded", "false");
  await expect(jump).toContainText("About");
  await expect(row("about")).toBeHidden();
  // Opened narrow, then the window is widened: a rail click keeps the search as typed.
  await jump.click();
  await page.setViewportSize({ width: 1920, height: 1040 });
  await expect(jump).toBeHidden();
  await page.getByTestId("settings-find").fill("a");
  await row("storage").click();
  await expect(title).toHaveText("Storage");
  await expect(page.getByTestId("settings-find")).toHaveValue("a");
  await page.getByTestId("settings-find").fill("");
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(jump).toHaveAttribute("aria-expanded", "false");

  // With the session list open and the text at 150%, a 1024 px window leaves a narrow page: the same bar.
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.evaluate(() => { localStorage.setItem("keel.textScale", "1.5"); localStorage.setItem("keel.list", "true"); });
  await page.reload();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(jump).toBeVisible();
  expect(await fits()).toBe(true);
  await shoot(page, "layout-16-settings-1024-text-150");
  await page.evaluate(() => localStorage.removeItem("keel.textScale"));

  // A wide page keeps the grouped rail and no bar; a short window still has the row of a late section in view.
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto("/settings/about");
  await expect(jump).toBeHidden();
  await expect(nav.getByRole("heading", { name: "Working" })).toBeVisible();
  await expect(row("about")).toHaveAttribute("aria-current", "page");
  await expect(title).toBeVisible();
  await shoot(page, "layout-17-settings-wide");
  await page.setViewportSize({ width: 1920, height: 420 });
  await page.reload();
  await expect(row("about")).toBeVisible();
  await expect.poll(() => inView(row("about"))).toBe(true);
});

// The Settings head on a small phone at the largest text size: the title is
// whole and Back is still there, as its arrow.
test("the settings head fits a small phone at the largest text size", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/settings/general");
  await page.evaluate(() => localStorage.setItem("keel.textScale", "1.5"));
  await page.reload();
  expect(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBeCloseTo(25.5, 1);
  const head = page.getByTestId("settings").locator("header");
  const title = head.getByRole("heading", { name: "Settings" });
  await expect(title).toBeVisible();
  expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const t = (await title.boundingBox())!;
  expect(t.x + t.width).toBeLessThanOrEqual(320);
  const back = head.getByRole("button", { name: "Back", exact: true });
  await expect(back).toBeVisible();
  const b = (await back.boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(t.x + 0.5);
  expect(await head.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await shoot(page, "layout-18-settings-head-phone-150");
  // At the default size the word is back beside its arrow.
  await page.evaluate(() => localStorage.setItem("keel.textScale", "1"));
  await page.reload();
  await expect(back).toHaveText("Back");
  await expect(back.getByText("Back")).toBeVisible();
  expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await back.click();
  await expect(page).not.toHaveURL(/\/settings\//);
});

// Two long conversations side by side, both scrolled away from their ends.
async function twoLong(page: Page, request: APIRequestContext) {
  const tag = Date.now().toString(36);
  const mk = async (title: string) => {
    const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title } })).json()).session;
    await request.post(`/api/sessions/${s.id}/messages`, { data: { text: "Fill it. script:fill" } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).events.some((e: any) => e.kind === "turn_end" || e.kind === "error"), { timeout: 30_000 }).toBe(true);
    return s.id as string;
  };
  const a = await mk(`Left conversation ${tag}`);
  const b = await mk(`Right conversation ${tag}`);
  const pane = (id: string) => page.getByTestId("station").and(page.locator(`[data-station="${id}"]`));
  const scroller = (id: string) => pane(id).getByTestId("transcript").locator("..");
  await page.goto(`/s/${a}`);
  await expect(pane(a)).toHaveAttribute("data-helm", "true");
  const row = page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${b}"]`);
  await row.hover();
  await row.getByTestId("row-beside").click();
  await expect(pane(b)).toHaveAttribute("data-helm", "true");
  return { a, b, pane, scroller, drop: async () => { for (const id of [a, b]) await request.delete(`/api/sessions/${id}`); } };
}

// End goes to the end of the conversation in the pane worked in, and of no other.
test("End follows the end of the active pane only", async ({ page, request }) => {
  const { a, b, pane, scroller, drop } = await twoLong(page, request);
  try {
    const top = (id: string) => scroller(id).evaluate((el) => el.scrollTop);
    const fromEnd = (id: string) => scroller(id).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    for (const id of [a, b]) {
      await expect.poll(() => fromEnd(id)).toBeLessThan(2);
      await scroller(id).evaluate((el) => { el.scrollTop = 200; });
      await expect(pane(id).getByTestId("jump-latest")).toBeVisible();
    }
    // The left pane is the one worked in: a press in its conversation, then End.
    await pane(a).getByTestId("assistant-text").first().click({ position: { x: 20, y: 20 } });
    await expect(pane(a)).toHaveAttribute("data-helm", "true");
    await page.keyboard.press("End");
    await expect(pane(a).getByTestId("jump-latest")).toHaveCount(0);
    await expect.poll(() => fromEnd(a)).toBeLessThan(2);
    // The other one stays where it was being read.
    await page.waitForTimeout(600); // a smooth scroll would be on its way by now
    expect(await top(b)).toBe(200);
    await expect(pane(b).getByTestId("jump-latest")).toBeVisible();
    await shoot(page, "layout-19-end-active-pane");

    // Typed in the message box, End is the box's own key: the caret goes to the end of the
    // line and the conversation stays where it is being read. Ctrl End still goes to its end.
    await scroller(a).evaluate((el) => { el.scrollTop = 200; });
    await expect(pane(a).getByTestId("jump-latest")).toBeVisible();
    const box = pane(a).getByTestId("composer");
    await box.fill("hello world");
    await page.keyboard.press("Home");
    expect(await box.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(0);
    await page.keyboard.press("End");
    expect(await box.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(11);
    await page.waitForTimeout(400);
    expect(await top(a)).toBe(200);
    await expect(pane(a).getByTestId("jump-latest")).toBeVisible();
    await page.keyboard.press("Control+End");
    await expect(pane(a).getByTestId("jump-latest")).toHaveCount(0);
    await expect.poll(() => fromEnd(a)).toBeLessThan(2);
    expect(await top(b)).toBe(200);
  } finally { await drop(); }
});

// Going to a pane that is off screen brings it into view: with a glide, or at
// once for someone who asked their system for reduced motion.
test("a pane off screen is shown without a glide under reduced motion", async ({ page, request }) => {
  const tag = Date.now().toString(36);
  const ids: string[] = [];
  for (const name of ["First", "Second", "Third"]) ids.push((await (await request.post("/api/sessions", { data: { model: MODEL, title: `${name} pane ${tag}` } })).json()).session.id);
  const pane = (i: number) => page.getByTestId("station").and(page.locator(`[data-station="${ids[i]}"]`));
  try {
    // Three panes kept from a wider window: this one holds two, the third is off screen.
    await page.setViewportSize({ width: 1150, height: 980 });
    await page.addInitScript((slots) => {
      const scrolls: { station?: string; behavior?: string }[] = ((window as any).scrolls = []);
      const real = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (arg?: boolean | ScrollIntoViewOptions) {
        scrolls.push({ station: (this as HTMLElement).dataset.station ?? this.tagName, behavior: typeof arg === "object" ? arg.behavior : undefined });
        return real.call(this, arg);
      };
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("keel.panes", JSON.stringify({ count: 3, slots, sizes: {}, active: 0 }));
    }, ids);
    const asked = (i: number) => page.evaluate((id) => ((window as any).scrolls as { station?: string; behavior?: string }[]).filter((s) => s.station === id).map((s) => s.behavior), ids[i]!);
    const clear = () => page.evaluate(() => { (window as any).scrolls.length = 0; });

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/s/${ids[0]}`);
    await expect(pane(0)).toHaveAttribute("data-helm", "true");
    await expect(pane(2)).toBeAttached();
    await expect(pane(2)).not.toBeInViewport({ ratio: 0.9 });
    await clear();
    // Next pane, twice, by keyboard: the third pane is the one worked in and is on screen at once.
    await page.keyboard.press("Alt+]");
    await page.keyboard.press("Alt+]");
    await expect(pane(2)).toHaveAttribute("data-helm", "true");
    await expect(pane(2)).toBeInViewport({ ratio: 0.99 });
    const reduced = await asked(2);
    expect(reduced.length).toBeGreaterThan(0);
    expect(reduced).not.toContain("smooth");
    await shoot(page, "layout-20-offscreen-pane-reduced-motion");

    // Without that preference the same move glides.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(pane(0)).not.toBeInViewport({ ratio: 0.9 });
    await clear();
    await page.keyboard.press("Alt+]");
    await expect(pane(0)).toHaveAttribute("data-helm", "true");
    await expect(pane(0)).toBeInViewport({ ratio: 0.99 });
    expect(await asked(0)).toEqual(["smooth"]);

    // A jump to a changed line in the Changes panel follows the same rule.
    const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `motion-${tag}`);
    mkdirSync(ws, { recursive: true });
    const changed = (await (await request.post("/api/sessions", { data: { model: MODEL, title: `Changed lines ${tag}`, workspace: ws } })).json()).session.id as string;
    ids.push(changed);
    await request.put(`/api/sessions/${changed}/permissions`, { data: { mode: "full-auto" } });
    const lines = Array.from({ length: 240 }, (_, i) => `line ${i + 1}`).join("\n");
    await request.post(`/api/sessions/${changed}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Write", input: { file_path: join(ws, "notes.txt"), content: lines } }])}` } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${changed}`)).json()).session.phase, { timeout: 30_000 }).toBe("idle");
    await page.setViewportSize({ width: 1700, height: 980 });
    await page.goto(`/s/${changed}`);
    await openPanel(page, "changes");
    const file = page.getByTestId("diff-file").first();
    await expect(file.locator('tr[data-new="200"]')).toBeAttached();
    const path = (await file.getAttribute("data-path"))!;
    const jump = async () => {
      await clear();
      await page.evaluate((path) => { window.dispatchEvent(new CustomEvent("keel:diff-jump", { detail: { path, line: 200 } })); }, path);
      await expect(file.locator('tr[data-new="200"]')).toBeInViewport();
      return page.evaluate(() => ((window as any).scrolls as { station?: string; behavior?: string }[]).filter((s) => s.station === "TR").map((s) => s.behavior));
    };
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await jump()).toEqual(["instant"]);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await file.evaluate((el) => el.scrollIntoView({ block: "start" }));
    expect(await jump()).toEqual(["smooth"]);
  } finally { for (const id of ids) await request.delete(`/api/sessions/${id}`); }
});

// A session goes to the pane the owner picks without dragging: from its row
// in the list (Shift Enter, or the row's button) and from a pane's header, a
// menu of the panes; picking one places it there, and a session that has a
// pane trades places with the one picked, also when they are not neighbours.
// Escape leaves the layout as it was.
test("a session placed in a chosen pane by keyboard", async ({ page, request }) => {
  const tag = Date.now().toString(36);
  const mk = async (title: string) => (await (await request.post("/api/sessions", { data: { model: MODEL, title: `${title} ${tag}` } })).json()).session.id as string;
  const [a, b, c, d] = [await mk("Alpha station"), await mk("Bravo station"), await mk("Charlie station"), await mk("Delta from the list")];
  try {
    await page.addInitScript((slots) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("keel.panes", JSON.stringify({ count: 3, slots, sizes: {}, active: 0 }));
    }, [a, b, c]);
    await page.goto(`/s/${a}`);
    const bridge = page.getByTestId("bridge");
    const slots = () => bridge.locator(":scope > [data-slot]").evaluateAll((els) => els.map((el) => el.getAttribute("data-station")));
    const helm = () => bridge.locator(":scope > [data-helm]").getAttribute("data-slot");
    const kept = () => page.evaluate(() => { const k = JSON.parse(localStorage.getItem("keel.panes")!); return { slots: k.slots, active: k.active }; });
    await expect.poll(slots).toEqual([a, b, c]);
    const row = page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${d}"]`);
    const menu = page.getByTestId("pane-menu");

    // From the list, by keys alone. Escape first: nothing moved, the keys are back on the row.
    await row.focus();
    await page.keyboard.press("Shift+Enter");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("pane-menu-item")).toHaveCount(3);
    await expect(menu.getByTestId("pane-menu-item").nth(1)).toContainText("Bravo station");
    await expect(menu.getByTestId("pane-menu-item").first()).toBeFocused();
    await shoot(page, "layout-07-pane-menu-from-the-list");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    expect(await slots()).toEqual([a, b, c]);
    expect(await helm()).toBe("0");
    await expect(row).toBeFocused();
    // Then the second pane: the session is there, and it is the pane worked in.
    await page.keyboard.press("Shift+Enter");
    await expect(menu.getByTestId("pane-menu-item").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByTestId("pane-menu-item").nth(1)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(slots).toEqual([a, d, c]);
    expect(await helm()).toBe("1");
    await expect(page).toHaveURL(new RegExp(`/s/${d}$`));
    expect(await kept()).toEqual({ slots: [a, d, c], active: 1 });

    // From a pane's header: the first and the third pane trade places directly.
    const place = bridge.locator(':scope > [data-slot="0"]').getByTestId("station-place");
    await place.focus();
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("pane-menu-item").first()).toBeDisabled();
    await expect(menu.getByTestId("pane-menu-item").nth(2)).toContainText("trade places");
    await shoot(page, "layout-08-pane-menu-from-a-pane");
    await page.keyboard.press("End");
    await expect(menu.getByTestId("pane-menu-item").nth(2)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(slots).toEqual([c, d, a]);
    expect(await helm()).toBe("2");
    expect(await kept()).toEqual({ slots: [c, d, a], active: 2 });
    // Escape from there too.
    await bridge.locator(':scope > [data-slot="2"]').getByTestId("station-place").focus();
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    expect(await slots()).toEqual([c, d, a]);
    expect(await kept()).toEqual({ slots: [c, d, a], active: 2 });

    // With an empty pane on the bridge, the keys start on it (it costs no session its pane),
    // and the card that stands beside a row is away while the menu is open.
    await page.getByTestId("panes-2").click();
    await page.getByTestId("panes-3").click();
    await expect.poll(slots).toEqual([c, a, null]);
    await row.hover();
    await expect(page.getByTestId("rail-card")).toBeVisible();
    await row.getByTestId("row-place").click();
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("rail-card")).toHaveCount(0);
    await expect(menu.getByTestId("pane-menu-item").nth(2)).toContainText("Empty pane");
    await expect(menu.getByTestId("pane-menu-item").nth(2)).toBeFocused();
    await shoot(page, "layout-09-pane-menu-empty-pane-first");
    await page.keyboard.press("Enter");
    await expect.poll(slots).toEqual([c, a, d]);
  } finally {
    for (const id of [a, b, c, d]) await request.delete(`/api/sessions/${id}`);
  }
});
