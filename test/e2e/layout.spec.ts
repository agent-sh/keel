import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the layout is the owner's. The number of panes is the one picked
// in the rail (1, 2, 3, more when the window holds them) and Keel never adds
// or removes one: opening a session fills a free pane, else replaces the one
// worked in; closing one leaves its pane empty. The list's edge and the line
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

  // The owner's layout to start from: two panes, one of them free.
  await page.addInitScript((id) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("keel.panes", JSON.stringify({ count: 2, slots: [id, null], sizes: {}, active: 0 }));
  }, a);
  await page.goto(`/s/${a}`);
  await expect(panes).toHaveCount(2);
  await expect(pane(0)).toHaveAttribute("data-station", a);
  await expect(pane(1)).toHaveAttribute("data-testid", "pane-empty");
  await expect(page.getByTestId("panes-2")).toHaveAttribute("aria-checked", "true");

  // Type is larger by default: what is read and what is glanced at.
  expect(await rootPx()).toBe(16);
  expect(await fontPx('[data-testid="transcript"] .prose-keel')).toBeGreaterThanOrEqual(17);
  expect(await fontPx('[data-testid="session-row"] .k-row-title')).toBeGreaterThanOrEqual(14);
  expect(await fontPx('[data-testid="composer"]')).toBeGreaterThanOrEqual(15);

  // Opening a session never adds a pane: it takes the free one, and with none free it replaces the one worked in.
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

  // Closing a session leaves its pane, empty. One pane keeps the one worked in; the number holds over a reload.
  await pane(2).getByTestId("station-close").click();
  await expect(panes).toHaveCount(3);
  await expect(pane(2)).not.toHaveAttribute("data-station", b);
  await entry(a).click();
  await page.getByTestId("panes-1").click();
  await expect(panes).toHaveCount(1);
  await expect(pane(0)).toHaveAttribute("data-station", a);
  await shoot(page, "layout-03-one-pane");
  await page.getByTestId("panes-2").click();
  await expect(panes).toHaveCount(2);
  await expect(pane(1)).toHaveAttribute("data-testid", "pane-empty");
  await page.reload();
  await expect(panes).toHaveCount(2);
  await expect(pane(0)).toHaveAttribute("data-station", a);

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
  await expect(pane(1)).toHaveAttribute("data-drop", "true");
  await shoot(page, "layout-04-drop-target");
  await pane(1).dispatchEvent("dragleave", { dataTransfer: data });
  await expect(pane(1)).not.toHaveAttribute("data-drop", "true");

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
  expect(await rootPx()).toBeCloseTo(17.6, 1);
  expect(await fontPx('[data-testid="transcript"] .prose-keel')).toBeCloseTo(read0 * 1.1, 1);
  expect(await stored("keel.textScale")).toBe(1.1);
  await page.reload();
  expect(await rootPx()).toBeCloseTo(17.6, 1);
  await expect(panes).toHaveCount(2);
  await fits();
  // Settings has the same control.
  await page.goto("/settings/general");
  const sizes = page.getByTestId("text-size");
  await expect(sizes.getByRole("radio", { checked: true })).toHaveAttribute("data-testid", "text-size-110");
  await shoot(page, "layout-06-settings-text-size");
  await page.getByTestId("text-size-135").click();
  expect(await rootPx()).toBeCloseTo(21.6, 1);
  await expect(sizes.getByRole("radio", { checked: true })).toHaveAttribute("data-testid", "text-size-135");
  // At the larger sizes two panes still stand side by side, nothing clipped.
  await page.goto(`/s/${long}`);
  await expect(panes).toHaveCount(2);
  await expect(bridge.locator(`[data-station="${long}"]`)).toContainText("lorem ipsum");
  await fits();
  await shoot(page, "layout-07-text-135");
  await page.keyboard.press("Control+-");
  expect(await rootPx()).toBeCloseTo(19.2, 1);
  await fits();
  await shoot(page, "layout-08-text-120");
  await page.keyboard.press("Control+0");
  expect(await rootPx()).toBe(16);
  expect(await stored("keel.textScale")).toBe(1);
  await page.keyboard.press("Control+-");
  expect(await rootPx()).toBeCloseTo(14.4, 1);
  await fits();
  await page.keyboard.press("Control+0");

  for (const id of [a, b, c, d, long]) await request.delete(`/api/sessions/${id}`);
});
