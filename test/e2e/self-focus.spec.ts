import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { mkdirSync } from "node:fs";

// Feature: what focuses by itself never takes the keyboard from the owner.
// The message box takes the keyboard as its page or its session opens, and it
// is drawn when its session is in, which may be a while after the page shows.
// A control the owner went to meanwhile (the list's separator, the filter
// field) keeps the keyboard: its keys go on working and what is typed stays
// where it was typed. An act that opens a session (a press on its row, the New
// session button) still puts the keyboard in that session's message box, also
// when a key is pressed while the session is still being read, and the key
// that opened it leaves nothing in the box. When what held the keyboard goes
// away under the owner's hand (the palette, a panel, a pane, an archived row)
// the message box of the pane worked in takes it; not after a press on blank
// space, not while a request waits in that pane, and not on a phone.
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

const mkSessions = async (request: APIRequestContext, made: string[], titles: string[], mode = "full-auto") => {
  mkdirSync(WS, { recursive: true });
  const ids: string[] = [];
  for (const title of titles) {
    const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title, workspace: WS } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode } });
    made.push(session.id);
    ids.push(session.id);
  }
  return ids;
};
const rowOf = (page: Page, id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);

test("a key pressed while a session is opening leaves the keyboard for its box, and the key that opens one is spent", async ({ page, request }) => {
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  try {
    const [open, one, two] = await mkSessions(request, made, ["Opening: the session on screen", "Opening: archived one", "Opening: archived two"]) as [string, string, string];
    for (const id of [one, two]) await request.patch(`/api/sessions/${id}`, { data: { archived: true } });
    const box = page.getByTestId("composer");
    // The archived sessions are not in the page yet: each is read when it is opened, slowly here.
    await page.route(new RegExp(`/api/sessions/(${one}|${two})(\\?.*)?$`), async (route) => {
      if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, 1200));
      await route.continue().catch(() => {});
    });
    await page.goto(`/s/${open}`);
    await expect(box).toBeFocused();

    // A press on the row, then Shift alone while the session is read: the box takes the keyboard when it is drawn.
    await page.getByTestId("tab-archived").click();
    await rowOf(page, one).click();
    await page.keyboard.press("Shift");
    expect(await box.count(), "the message box is not drawn yet").toBe(0);
    await expect(box).toBeFocused({ timeout: 15_000 });
    await page.keyboard.type("typed after the wait");
    await expect(box).toHaveValue("typed after the wait");
    await box.fill("");

    // Enter on the row, then a letter while it is read: the letter went to the row, the box is empty and has the keyboard.
    await rowOf(page, two).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("h");
    expect(await box.count(), "the message box is not drawn yet").toBe(0);
    await expect(box).toBeFocused({ timeout: 15_000 });
    await expect(box).toHaveValue("");
    await page.keyboard.type("and on");
    await expect(box).toHaveValue("and on");
    await box.fill("");
    await page.unrouteAll({ behavior: "ignoreErrors" });

    // Enter on the row of a session already in the page: its box opens at once, with no new line from that Enter.
    await page.getByTestId("tab-active").click();
    await rowOf(page, open).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/s/${open}$`));
    await expect(box).toBeFocused();
    await expect(box).toHaveValue("");
    // The same from the New session button.
    await page.getByTestId("new-session").focus();
    await page.keyboard.press("Enter");
    const start = page.getByTestId("new-composer").getByTestId("composer");
    await expect(start).toBeFocused();
    await expect(start).toHaveValue("");
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`).catch(() => {});
  }
});

test("the keyboard goes to the message box when what held it goes away", async ({ page, request, browser, baseURL }) => {
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  try {
    const [a, b, c, d] = await mkSessions(request, made, ["Fall: the session on screen", "Fall: beside it", "Fall: to archive", "Fall: to delete"]) as [string, string, string, string];
    const box = page.getByTestId("composer");
    const nothing = async (what: string) => { await page.waitForTimeout(500); expect(await active(page), what).toBe("nothing"); };

    // 1. The palette opened before the box is drawn keeps the keyboard; closed with Escape, the box takes it.
    await slowSessions(page, 1500);
    await page.goto(`/s/${a}`);
    await page.getByTestId("list-grip").waitFor();
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("x");
    expect(await box.count(), "the message box is not drawn yet").toBe(0);
    await expect(box).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(300);
    expect(await active(page), "the keyboard while the palette is open").toBe("palette-input");
    await page.keyboard.press("Escape");
    await expect(box).toBeFocused();
    await page.unrouteAll({ behavior: "ignoreErrors" });

    // 2. The session already on screen picked in the palette, opened from its button.
    await page.getByTestId("open-palette").click();
    await page.getByTestId("palette-input").fill("Fall: the session on");
    await expect(page.getByRole("option").filter({ hasText: "Fall: the session on screen" }).first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(box).toBeFocused();

    // 3. A side panel closed by its key: the keyboard was in the panel.
    await page.keyboard.press("Control+Shift+E");
    await expect(page.getByTestId("files-panel")).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="side-panel"]'))).toBe(true);
    await page.keyboard.press("Control+\\");
    await expect(page.getByTestId("side-panel")).toHaveCount(0);
    await expect(box).toBeFocused();

    // 4. A session archived from its row: the button pressed goes with the row.
    await rowOf(page, c).hover();
    await rowOf(page, c).getByTestId("row-archive").click();
    await expect(rowOf(page, c)).toHaveCount(0);
    await expect(box).toBeFocused();

    // 5. A control with the keyboard that goes away by itself (its session was deleted elsewhere).
    await rowOf(page, d).focus();
    await request.delete(`/api/sessions/${d}`);
    await expect(rowOf(page, d)).toHaveCount(0);
    await expect(box).toBeFocused();

    // 6. A press on blank space puts the keyboard nowhere, and it stays there.
    await page.getByTestId("session-header").click({ position: { x: 600, y: 8 } });
    await nothing("after a press on blank space");
    // ... also when the control that had it before goes away later.
    await rowOf(page, b).focus();
    await page.getByTestId("session-header").click({ position: { x: 600, y: 8 } });
    await request.patch(`/api/sessions/${b}`, { data: { archived: true } });
    await expect(rowOf(page, b)).toHaveCount(0);
    await nothing("after a press on blank space and the row going away");
    await request.patch(`/api/sessions/${b}`, { data: { archived: false } });
    await expect(rowOf(page, b)).toHaveCount(1);

    // 7. A pane closed with its button: the box of the pane now worked in takes the keyboard.
    const two = await browser.newContext({ viewport: { width: 1920, height: 1040 }, storageState: { cookies: [], origins: [{ origin: new URL(baseURL!).origin, localStorage: [
      { name: "keel.focus", value: "false" },
      { name: "keel.panes", value: JSON.stringify({ count: 2, slots: [a, b], sizes: {}, active: 0 }) },
    ] }] } });
    const p2 = await two.newPage();
    await p2.goto(`${baseURL}/s/${a}`);
    const paneA = p2.locator(`[data-station="${a}"]`), paneB = p2.locator(`[data-station="${b}"]`);
    await expect(paneA.getByTestId("composer")).toBeFocused();
    await paneB.getByTestId("station-close").click();
    await expect(paneB).toHaveCount(0);
    await expect(paneA.getByTestId("composer")).toBeFocused();
    await two.close();

    // 8. While a request waits in the pane the cards have the keyboard's rule: the box does not take it.
    const [asking, gone] = await mkSessions(request, made, ["Fall: a request waits here", "Fall: deleted under the request"], "ask") as [string, string];
    await request.post(`/api/sessions/${asking}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "rsync -av --delete ./build/ deploy@staging:/srv/app/ && systemctl restart app" } }])}` } });
    await page.goto(`/s/${asking}`);
    await expect(page.getByTestId("approval")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500); // the card has taken the keyboard by now, if it was going to
    await rowOf(page, gone).focus();
    await request.delete(`/api/sessions/${gone}`);
    await expect(rowOf(page, gone)).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await active(page), "with a request waiting in the pane").not.toBe("composer");

    // 9. On a phone nothing takes the keyboard by itself (no on-screen keyboard opens).
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p3 = await phone.newPage();
    await p3.goto(`${baseURL}/s/${a}`);
    await expect(p3.locator(`[data-station="${a}"]`).getByTestId("composer")).toBeVisible();
    await p3.keyboard.press("Control+k");
    await p3.getByTestId("palette-input").waitFor();
    await p3.keyboard.press("Escape");
    await expect(p3.getByTestId("palette-input")).toHaveCount(0);
    await p3.waitForTimeout(500);
    expect(await p3.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "nothing"), "on a phone").not.toBe("composer");
    await phone.close();
  } finally {
    for (const id of made) { await request.post(`/api/sessions/${id}/interrupt`).catch(() => {}); await request.delete(`/api/sessions/${id}`).catch(() => {}); }
  }
});
