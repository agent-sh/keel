import { expect, test } from "./isolate.ts";
import type { Locator } from "./isolate.ts";
import { openPanel, shoot } from "./shots.ts";

// Feature: the secondary surfaces are one container. A side panel, the Errors
// drawer, the Inbox, the Loops dialog and the Settings page each have a head of
// one height that names the surface in the title face, and (all but the page,
// whose way out is Back) the same close at its right end. The ink band is on
// top of the ones that stand over the bridge and says which is in front: the
// panel beside its conversation and the page have none.
test("side panel, Errors, Inbox, Loops and Settings share one container grammar", async ({ page, request }) => {
  const model = process.env.KEEL_TEST_MODEL ?? "scripted:stand-in";
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "One container grammar" } })).json();
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").first().waitFor();

  // Read in the light theme (a screenshot leaves the page in the dark one).
  const read = async (box: Locator) => {
    await box.waitFor();
    await page.evaluate(() => { document.documentElement.classList.add("theme-switch"); document.documentElement.classList.remove("dark"); });
    return box.evaluate(measureSurface);
  };
  const measureSurface = (el: Element) => {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const px = (v: string) => r2(parseFloat(v));
    // The color painted behind an element: its own, or the nearest ancestor's.
    const behind = (x: Element | null) => { for (let p = x; p; p = p.parentElement) { const c = getComputedStyle(p).backgroundColor; if (!/, 0\)$|\/ 0\)$|transparent/.test(c)) return c; } return "none"; };
    const head = el.querySelector(".k-surface-head");
    const title = el.querySelector(".k-surface-title");
    // The close button is the head's last (the side panel's pop-out wears the same button before it).
    const close = [...el.querySelectorAll(".k-surface-close")].at(-1) ?? null;
    // The band is the top border of the surface, or of a page's head.
    const banded = [el, head].find((x) => x && px(getComputedStyle(x).borderTopWidth) > 2);
    const b = banded ? getComputedStyle(banded) : null, t = title ? getComputedStyle(title) : null, h = head ? getComputedStyle(head) : null;
    return {
      band: b ? `${px(b.borderTopWidth)} ${b.borderTopColor}` : "none",
      head: h ? `${px(h.height)} ${h.borderBottomWidth} ${h.borderBottomColor}` : "none",
      title: t ? `${t.fontFamily.split(",")[0]} ${t.fontStretch} ${t.fontWeight} ${px(t.fontSize)} ${t.letterSpacing}` : "none",
      close: close ? `${r2(close.getBoundingClientRect().width)}x${r2(close.getBoundingClientRect().height)} ${getComputedStyle(close).borderRadius}` : "none",
      closeAtEnd: close && head ? Math.round(head.getBoundingClientRect().right - close.getBoundingClientRect().right) : -1,
      surface: behind(head),
    };
  };

  const got: Record<string, Awaited<ReturnType<typeof read>>> = {};
  await openPanel(page, "files");
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-mode", "beside");
  got.panel = await read(page.getByTestId("side-panel"));
  await shoot(page, "surfaces-01-side-panel");
  // In a window with no room beside the conversation the panel is a sheet over it, and has the band.
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-mode", "sheet");
  got.sheet = await read(page.getByTestId("side-panel"));
  await shoot(page, "surfaces-01-side-sheet");
  await page.setViewportSize({ width: 1920, height: 1040 });
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-mode", "beside");
  await page.getByTestId("errors-button").first().click();
  got.errors = await read(page.getByTestId("errors-panel"));
  await shoot(page, "surfaces-02-errors");
  await page.keyboard.press("Escape");
  await page.getByTestId("inbox-button").first().click();
  got.inbox = await read(page.getByTestId("inbox-panel"));
  await shoot(page, "surfaces-03-inbox");
  await page.keyboard.press("Escape");
  await page.getByTestId("loops-button").first().click();
  got.loops = await read(page.getByTestId("loops-panel"));
  await shoot(page, "surfaces-04-loops");
  await page.keyboard.press("Escape");
  await page.goto("/settings/general");
  await page.getByTestId("text-size").waitFor();
  got.settings = await read(page.getByTestId("settings"));
  await shoot(page, "surfaces-05-settings");
  console.log(Object.entries(got).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n"));

  const names = ["panel", "sheet", "errors", "inbox", "loops", "settings"] as const;
  for (const key of ["head", "title", "surface"] as const) {
    expect(new Set(names.map((n) => got[n]![key])).size, `${key}: ${names.map((n) => got[n]![key]).join(" | ")}`).toBe(1);
  }
  // The band: one band on what is over the bridge, none on what has its own place in the window.
  const over = ["sheet", "errors", "inbox", "loops"] as const;
  expect(new Set(over.map((n) => got[n]!.band)).size, `band: ${over.map((n) => got[n]!.band).join(" | ")}`).toBe(1);
  expect(got.errors!.band).not.toBe("none");
  expect([got.panel!.band, got.settings!.band]).toEqual(["none", "none"]);
  // A surface's name is in the text face, as a heading: the narrow mono is for a call sign and a key only.
  expect(got.panel!.title).not.toContain("Martian Mono");
  expect(got.panel!.title).toContain("Plex Sans");
  // The four that close: the same button, at the head's right end.
  const closing = ["panel", "errors", "inbox", "loops"] as const;
  expect(new Set(closing.map((n) => got[n]!.close)).size, closing.map((n) => got[n]!.close).join(" | ")).toBe(1);
  expect(got.panel!.close).not.toBe("none");
  for (const n of closing) expect(got[n]!.closeAtEnd, n).toBeLessThanOrEqual(18);
});

// The header keeps few tools: the session's own three at most, and the Panels
// chooser, which says Panels. The panels at hand (the ones used, or kept
// there on purpose, and the open one) head the chooser, each with its glyph
// and its name, the open one marked; a panel kept at hand joins them.
test("the panels at hand are named at the top of the Panels chooser", async ({ page, request }) => {
  const model = process.env.KEEL_TEST_MODEL ?? "scripted:stand-in";
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "Named shortcuts" } })).json();
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${session.id}`);
  const header = page.getByTestId("session-header").first();
  const menu = header.getByTestId("panel-menu");
  await expect(menu).toContainText("Panels");
  // No shortcut beside it: the row holds the session's tools, More and the chooser.
  await expect(header.locator('[data-testid^="panel-toggle-"]')).toHaveCount(0);

  // Nothing used yet: the five most sessions need are at hand, in this order, and every other panel is
  // one list under More. No name is listed twice, and the setup panel is named for what it is.
  await menu.click();
  const picker = page.getByTestId("panel-picker");
  await expect(picker.getByTestId("panel-pick-files")).toBeVisible();
  await expect(picker.locator(".k-picker-group")).toHaveText(["At hand", "More"]);
  await expect(picker.getByTestId("panels-at-hand").locator('[data-testid^="panel-pick-"]')).toHaveText([/^Review/, /^Work board/, /^Changes/, /^Files/, /^Terminal/]);
  const names = await picker.locator('[data-testid^="panel-pick-"] > span:first-of-type').allTextContents();
  expect(names.filter((n, i) => names.indexOf(n) !== i), "a panel name listed twice").toEqual([]);
  expect(names).toContain("Session settings");
  // Picked once, a panel is at hand: at the top, named, with its glyph, marked while it is open.
  await picker.getByTestId("panel-pick-files").click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "files");
  await menu.click();
  const hand = picker.getByTestId("panels-at-hand");
  await expect(picker.locator("section").first()).toHaveAttribute("data-testid", "panels-at-hand");
  await expect(hand.locator(".k-picker-group")).toHaveText("At hand");
  const files = hand.getByTestId("panel-pick-files");
  await expect(files).toContainText("Files");
  expect(await files.locator("svg").count()).toBeGreaterThan(0);
  await expect(hand.locator(".k-picker-row").filter({ has: page.getByTestId("panel-pick-files") })).toHaveAttribute("aria-current", "true");
  // Listed once: not again in its group.
  await expect(picker.getByTestId("panel-pick-files")).toHaveCount(1);
  // Kept at hand on purpose: another panel joins them.
  const usageRow = picker.locator(".k-picker-row").filter({ has: page.getByTestId("panel-pick-usage") });
  await usageRow.getByRole("button", { name: /Keep .* at hand/ }).click();
  await expect(hand.getByTestId("panel-pick-usage")).toBeVisible();
  await shoot(page, "surfaces-06-panels-at-hand");
  // A search lists the matches by group, at hand or not.
  await page.getByTestId("panel-search").fill("files");
  await expect(picker.getByTestId("panels-at-hand")).toHaveCount(0);
  await expect(picker.getByTestId("panel-pick-files")).toBeVisible();
  await page.getByTestId("panel-search").fill("");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close the panel" }).click();
  await expect(page.getByTestId("side-panel")).toHaveCount(0);

  // On a phone the chooser is the same, and nothing is cut.
  await page.setViewportSize({ width: 390, height: 844 });
  await header.getByTestId("panel-menu").click();
  await expect(picker.getByTestId("panels-at-hand")).toBeInViewport();
  await shoot(page, "surfaces-06b-panels-at-hand-phone");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1920, height: 1040 });
});

// An overlay ends cleanly. The panel chooser shows every group when the window
// has the room; the shortcut sheet keeps its head in place, a label that wraps
// has a row tall enough for it, and while more is below the foot fades out.
test("the panel chooser and the shortcut sheet end cleanly", async ({ page, request }) => {
  const model = process.env.KEEL_TEST_MODEL ?? "scripted:stand-in";
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "Overlays end cleanly" } })).json();
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("panel-menu").first().click();
  const list = page.getByTestId("panel-picker").locator(".k-picker-list");
  await list.waitFor();
  // Nothing is cut: the whole list is on screen, its last row inside the popup.
  const cut = await list.evaluate((el) => ({ hidden: el.scrollHeight - el.clientHeight, lastInside: el.lastElementChild!.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom + 1 }));
  expect(cut.hidden).toBeLessThanOrEqual(1);
  expect(cut.lastInside).toBe(true);
  await shoot(page, "surfaces-07-panel-chooser");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+/");
  const sheet = page.getByTestId("shortcuts");
  const body = page.getByTestId("shortcuts-body");
  await body.waitFor();
  // No row is shorter than its label, so a wrapped label never runs into the next row.
  const rows = await body.evaluate((el) => [...el.querySelectorAll("section > div")].map((row) => ({ label: row.firstElementChild!.textContent, row: row.getBoundingClientRect().height, text: row.firstElementChild!.getBoundingClientRect().height })));
  expect(rows.length).toBeGreaterThan(20);
  expect(rows.filter((r) => r.text > r.row)).toEqual([]);
  // The head stays; the body scrolls under it.
  await expect(sheet.locator(".k-surface-title")).toHaveText("Keyboard shortcuts");
  const foot = () => body.evaluate((el) => ({ more: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop), fade: parseFloat(getComputedStyle(el).getPropertyValue("--k-foot")) }));
  // A window too short for the sheet: its foot fades while more is below, and not at the end.
  await page.setViewportSize({ width: 1920, height: 700 });
  await expect.poll(async () => (await foot()).more).toBeGreaterThan(40);
  expect((await foot()).fade).toBeGreaterThan(20);
  await shoot(page, "surfaces-08-shortcuts");
  await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect.poll(async () => (await foot()).fade).toBe(0);
  await expect(sheet.locator(".k-surface-title")).toBeInViewport();
});
