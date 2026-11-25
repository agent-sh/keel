import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { openPanel, shoot } from "./shots.ts";

// Feature: a side panel popped out into a window of its own and docked back. The place /s/ID?panel=NAME
// shows that panel alone (no conversation, no list) with the session's title in the window's bar. The
// panel's header has a Pop out button: in the desktop app it asks the shell for a window of that place, in
// a browser it opens a tab. While it is out the pane says "In its own window" with Dock back, and closing
// the window docks the panel back. The desktop shell itself is checked by desktop/test/e2e.sh.

const MODEL = "scripted:stand-in";
const scripted = async (request: APIRequestContext) => (await (await request.get("/api/models")).json()).models.some((m: any) => m.id === MODEL);
const make = async (request: APIRequestContext, title: string) => (await (await request.post("/api/sessions", { data: { model: MODEL, title, text: "One line." } })).json()).session;
const ended = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).events.some((e: any) => e.kind === "turn_end" || e.kind === "error");

const shellObject = (kind: "main" | "session") => `
  window.__posted = [];
  Object.defineProperty(window, "keelShell", { value: Object.freeze({
    name: "keel-desktop", version: "test", engine: "webkit", platform: "linux", window: "${kind}",
    can: Object.freeze({ titlebar: true, windows: true, links: true, notifications: true, tray: true }),
    post: (m) => window.__posted.push(m),
  }) });`;
const posted = (page: Page, t: string) => page.evaluate((t) => (window as any).__posted.filter((m: any) => m.t === t), t);

test("panel window: the place shows one panel alone, a tab pops out and docks back, a shell is asked for a window", async ({ page, request, context }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const s = await make(request, "Panel window: the changes");
  await expect.poll(() => ended(request, s.id), { timeout: 60_000 }).toBe(true);
  try {
    // The place: the panel and nothing of the conversation.
    await page.goto(`/s/${s.id}?panel=changes`);
    const win = page.getByTestId("panel-window");
    await expect(win).toHaveAttribute("data-panel", "changes");
    await expect(win.locator(".k-surface-title")).toHaveText("Changes");
    await expect(page.getByTestId("panel-window-session")).toHaveText("Panel window: the changes");
    await expect(page).toHaveTitle(/Panel window: the changes - Changes/);
    await expect(page.getByTestId("transcript")).toHaveCount(0);
    await expect(page.getByTestId("session-header")).toHaveCount(0);
    await expect(page.getByTestId("session-list")).toHaveCount(0);
    await expect(page.getByTestId("side-panel")).toHaveCount(0);
    await shoot(page, "panel-window-01-alone");
    // A panel that is not there says so.
    await page.goto(`/s/${s.id}?panel=nothing-of-that-name`);
    await expect(page.getByTestId("panel-window-none")).toBeVisible();

    // The pane: Pop out opens the place in a tab of its own; the pane says so, and Dock back closes the tab.
    await page.goto(`/s/${s.id}`);
    await expect(page.getByTestId("transcript")).toBeVisible();
    await openPanel(page, "changes");
    const pane = page.getByTestId("side-panel");
    await expect(pane).toHaveAttribute("data-panel", "changes");
    await shoot(page, "panel-window-02-pane");
    const opened = context.waitForEvent("page");
    await page.getByTestId("panel-popout").click();
    const tab = await opened;
    await expect(tab.getByTestId("panel-window")).toHaveAttribute("data-panel", "changes");
    await expect(page.getByTestId("panel-popped")).toContainText("In its own window");
    await expect(page.getByTestId("panel-popout")).toHaveCount(0);
    await shoot(page, "panel-window-03-popped");
    await page.getByTestId("panel-dock").click();
    await expect(page.getByTestId("panel-popped")).toHaveCount(0);
    await expect.poll(() => tab.isClosed()).toBe(true);
    await expect(page.getByTestId("panel-popout")).toBeVisible();

    // Closing the window docks the panel back.
    const again = context.waitForEvent("page");
    await page.getByTestId("panel-popout").click();
    const second = await again;
    await expect(second.getByTestId("panel-window")).toBeVisible();
    await expect(page.getByTestId("panel-popped")).toBeVisible();
    await second.close();
    await expect(page.getByTestId("panel-popped")).toHaveCount(0, { timeout: 10_000 });
    await expect(pane).toHaveAttribute("data-panel", "changes");

    // The window's Dock back docks the panel too.
    const third = context.waitForEvent("page");
    await page.getByTestId("panel-popout").click();
    const last = await third;
    await expect(page.getByTestId("panel-popped")).toBeVisible();
    await last.getByTestId("panel-dock-here").click();
    await expect(page.getByTestId("panel-popped")).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => last.isClosed()).toBe(true);
  } finally {
    await request.delete(`/api/sessions/${s.id}`).catch(() => {});
  }
});

test("panel window: in the desktop shell Pop out asks the shell for a window", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const s = await make(request, "Panel window: in the shell");
  await expect.poll(() => ended(request, s.id), { timeout: 60_000 }).toBe(true);
  try {
    await page.addInitScript(shellObject("main"));
    await page.goto(`/s/${s.id}`);
    await expect(page.getByTestId("transcript")).toBeVisible();
    await openPanel(page, "changes");
    await page.getByTestId("panel-popout").click();
    await expect.poll(() => posted(page, "window")).toEqual([{ t: "window", path: `/s/${s.id}?panel=changes` }]);
    // (The pane says so while it waits for the window to hold its lock.)
    await expect(page.getByTestId("panel-popped")).toBeVisible();
    await shoot(page, "panel-window-04-shell");
  } finally {
    await request.delete(`/api/sessions/${s.id}`).catch(() => {});
  }
});

test("panel window: a session's own window does not read the panel the main window kept", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const s = await make(request, "Panel window: its own choice");
  await expect.poll(() => ended(request, s.id), { timeout: 60_000 }).toBe(true);
  try {
    const kept = JSON.stringify({ [s.id]: "changes" });
    await page.addInitScript((k) => { if (!localStorage.getItem("keel.stationPanel")) localStorage.setItem("keel.stationPanel", k); }, kept);
    await page.addInitScript(shellObject("session"));
    await page.goto(`/s/${s.id}`);
    await expect(page.getByTestId("transcript")).toBeVisible();
    await expect(page.getByTestId("side-panel")).toHaveCount(0);
    await openPanel(page, "files");
    await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "files");
    // What this window chose stays in this window.
    expect(await page.evaluate(() => localStorage.getItem("keel.stationPanel"))).toBe(kept);
  } finally {
    await request.delete(`/api/sessions/${s.id}`).catch(() => {});
  }
});
