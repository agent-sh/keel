import { expect, test, type Page } from "./isolate.ts";
import { mkdirSync } from "node:fs";

// Feature: what focuses by itself never takes the keyboard from the owner.
// The message box takes the keyboard as its page or its session opens, and it
// is drawn when its session is in, which may be a while after the page shows.
// A control the owner went to meanwhile (the list's separator, the filter
// field) keeps the keyboard: its keys go on working and what is typed stays
// where it was typed. An act that opens a session (a press on its row, the New
// session button) still puts the keyboard in that session's message box.
const STAND_IN = "scripted:stand-in";
const WS = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws`;

const active = (page: Page) => page.evaluate(() => { const a = document.activeElement; return a && a !== document.body ? a.getAttribute("data-testid") ?? a.tagName.toLowerCase() : "nothing"; });
// The session reads answer late: the page and its list are up, the session's pane is not drawn yet.
const slowSessions = (page: Page, ms: number) => page.route(/\/api\/sessions(\/[^/?]+)?(\?.*)?$/, async (route) => {
  if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, ms));
  // (A read still held back when the spec stops holding them is let go by then.)
  await route.continue().catch(() => {});
});

test("the message box takes the keyboard on a load and a session switch, never from a control the owner went to", async ({ page, request }) => {
  await page.setViewportSize({ width: 1920, height: 1040 });
  mkdirSync(WS, { recursive: true });
  const made: string[] = [];
  const mk = async (title: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title, workspace: WS } })).json();
    made.push(session.id);
    return session.id as string;
  };
  try {
    const a = await mk("Self focus: the session on screen");
    const b = await mk("Self focus: another session");
    const box = page.getByTestId("composer");
    const side = page.getByTestId("sidebar");
    const grip = page.getByTestId("list-grip");
    const width = () => side.evaluate((el) => el.getBoundingClientRect().width);

    // 1. A plain load: nothing holds the keyboard, the box takes it.
    await page.goto(`/s/${a}`);
    await expect(box).toBeFocused();

    // 2. A slow load: the owner is on the list's separator before the box is drawn, and stays there.
    await slowSessions(page, 1500);
    await page.reload();
    await grip.waitFor();
    await grip.focus();
    expect(await box.count(), "the message box is not drawn yet").toBe(0);
    const w0 = await width();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(width).toBeLessThan(w0);
    await expect(box).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(400);
    expect(await active(page), "the keyboard after the message box was drawn").toBe("list-grip");
    const w1 = await width();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(width, { message: `a second step of the separator; the keyboard is on ${await active(page)}` }).toBeLessThan(w1);

    // 3. The same with typing: words typed into the filter while the box arrives stay in the filter.
    await page.reload();
    const filter = page.getByTestId("list-filter");
    await filter.click();
    await page.keyboard.type("Self fo");
    expect(await box.count(), "the message box is not drawn yet").toBe(0);
    await expect(box).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(400);
    await page.keyboard.type("cus");
    await expect(filter).toHaveValue("Self focus");
    await expect(box).toHaveValue("");
    expect(await active(page)).toBe("list-filter");
    await filter.fill("");
    await page.unrouteAll({ behavior: "ignoreErrors" });

    // 4. The owner's own act opens a session: its box takes the keyboard from the row they pressed.
    const rowB = page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${b}"]`);
    await rowB.click();
    await expect(page).toHaveURL(new RegExp(`/s/${b}$`));
    await expect(box).toBeFocused();
    await page.keyboard.type("typed after a press on the row");
    await expect(box).toHaveValue("typed after a press on the row");
    await box.fill("");
    // By the keyboard too: Enter on a row.
    const rowA = page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${a}"]`);
    await rowA.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/s/${a}$`));
    await expect(box).toBeFocused();
    // The palette, opened from its button in the list: the session picked there gets the keyboard,
    // not the button the palette gives it back to as it closes.
    await page.getByTestId("open-palette").click();
    await page.getByTestId("palette-input").fill("Self focus: another");
    await expect(page.getByRole("option").filter({ hasText: "Self focus: another session" }).first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/s/${b}$`));
    await expect(box).toBeFocused();
    // And the New session button: the start box takes it.
    await page.getByTestId("new-session").click();
    await expect(page.getByTestId("new-composer").getByTestId("composer")).toBeFocused();
  } finally {
    await page.evaluate(() => localStorage.removeItem("keel.listW")).catch(() => {});
    for (const id of made) await request.delete(`/api/sessions/${id}`).catch(() => {});
  }
});
