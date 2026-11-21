import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the page inside the desktop shell (desktop/). The shell puts one
// small object on the window before the page's scripts run; the page reads
// it, never its user agent. With it the page tells the shell its colors and
// text size (the title bar wears them), goes where the shell asks without a
// reload (a keel:// link, a notification's click), opens a session in a
// window of its own, and in such a window shows that session alone. A
// browser tab has no such object and nothing changes for it. The shell
// itself is checked in a hidden desktop by desktop/test/e2e.sh.

const MODEL = "scripted:stand-in";
const scripted = async (request: APIRequestContext) => (await (await request.get("/api/models")).json()).models.some((m: any) => m.id === MODEL);
const make = async (request: APIRequestContext, title: string) => (await (await request.post("/api/sessions", { data: { model: MODEL, title, text: "One line." } })).json()).session;
const ended = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).events.some((e: any) => e.kind === "turn_end" || e.kind === "error");

// What the shell injects (desktop/src/page.rs), with its way out kept on the page for the test to read.
const shellObject = (kind: "main" | "session") => `
  window.__posted = [];
  Object.defineProperty(window, "keelShell", { value: Object.freeze({
    name: "keel-desktop", version: "test", engine: "webkit", platform: "linux", window: "${kind}",
    can: Object.freeze({ titlebar: true, windows: true, links: true, notifications: true, tray: true }),
    post: (m) => window.__posted.push(m),
  }) });`;
const posted = (page: Page, t: string) => page.evaluate((t) => (window as any).__posted.filter((m: any) => m.t === t), t);
const tell = (page: Page, detail: unknown) => page.evaluate((d) => void dispatchEvent(new CustomEvent("keel-shell", { detail: d })), detail);

test("shell: the page tells its look, goes where the shell asks without a reload, and asks for a session's own window", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const a = await make(request, "Shell: the first session");
  const b = await make(request, "Shell: the second session");
  for (const s of [a, b]) await expect.poll(() => ended(request, s.id), { timeout: 60_000 }).toBe(true);
  try {
    await page.addInitScript(shellObject("main"));
    await page.goto(`/s/${a.id}`);
    await expect(page.getByTestId("transcript")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dataset.shell)).toBe("main");

    // The look: plain colors the title bar can wear, and the text size.
    await expect.poll(async () => (await posted(page, "look")).length).toBeGreaterThan(0);
    const light = (await posted(page, "look")).at(-1);
    expect(light.dark).toBe(false);
    for (const k of ["bg", "panel", "fg", "muted", "line", "need"]) expect(light[k], k).toMatch(/^#[0-9a-f]{6}$/);
    expect(light.scale).toBe(1);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(async () => (await posted(page, "look")).at(-1)?.dark).toBe(true);
    const dark = (await posted(page, "look")).at(-1);
    expect(dark.panel).not.toBe(light.panel);
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(async () => (await posted(page, "look")).at(-1)?.dark).toBe(false);

    // A draft in the box, then the shell asks for another session: no reload, so the page is the same page.
    await page.evaluate(() => { (window as any).__same = true; });
    await tell(page, { open: `/s/${b.id}` });
    await page.waitForURL(new RegExp(`/s/${b.id}$`));
    await expect(page.getByTestId("session-header")).toContainText("Shell: the second session");
    expect(await page.evaluate(() => (window as any).__same)).toBe(true);

    // A click that names no session opens the inbox.
    await tell(page, { open: "/?inbox=1" });
    await expect(page.getByTestId("inbox-panel")).toBeVisible();
    expect(await page.evaluate(() => (window as any).__same)).toBe(true);
    await page.keyboard.press("Escape");

    // The session on screen, in a window of its own: the page asks the shell for it.
    await tell(page, { open: `/s/${a.id}` });
    await page.waitForURL(new RegExp(`/s/${a.id}$`));
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("own window");
    await page.keyboard.press("Enter");
    await expect.poll(() => posted(page, "window")).toEqual([{ t: "window", path: `/s/${a.id}` }]);
    await shoot(page, "shell-01-main");
  } finally {
    for (const s of [a, b]) await request.delete(`/api/sessions/${s.id}`).catch(() => {});
  }
});

test("shell: a session's own window shows that session alone and keeps the main window's panes", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const a = await make(request, "Shell: alone in its window");
  const b = await make(request, "Shell: a pane of the main window");
  for (const s of [a, b]) await expect.poll(() => ended(request, s.id), { timeout: 60_000 }).toBe(true);
  try {
    // The main window's layout: two panes.
    const kept = JSON.stringify({ count: 2, slots: [b.id, a.id], sizes: {}, active: 0 });
    await page.addInitScript((k) => { if (!localStorage.getItem("keel.panes")) localStorage.setItem("keel.panes", k); }, kept);
    await page.addInitScript(shellObject("session"));
    await page.goto(`/s/${a.id}`);
    await expect(page.getByTestId("transcript")).toBeVisible();
    await expect(page.locator("[data-station]")).toHaveCount(1);
    await expect(page.getByTestId("session-header")).toContainText("Shell: alone in its window");
    await expect(page.getByTestId("session-list")).toBeHidden();
    // It asks for no window of its own again, and wrote nothing over the main window's panes.
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("own window");
    await expect(page.getByText("Open in its own window")).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => localStorage.getItem("keel.panes"))).toBe(kept);
    await shoot(page, "shell-02-session-window");
  } finally {
    for (const s of [a, b]) await request.delete(`/api/sessions/${s.id}`).catch(() => {});
  }
});

test("shell: a browser tab has no shell", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const a = await make(request, "Shell: in a browser tab");
  await expect.poll(() => ended(request, a.id), { timeout: 60_000 }).toBe(true);
  try {
    await page.goto(`/s/${a.id}`);
    await expect(page.getByTestId("transcript")).toBeVisible();
    expect(await page.evaluate(() => "shell" in document.documentElement.dataset)).toBe(false);
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("own window");
    await expect(page.getByText("Open in its own window")).toHaveCount(0);
    // The shell's routes are the desk's own: a call that came through a proxy is refused.
    expect((await request.get("/api/shell", { headers: { "x-forwarded-for": "203.0.113.9" } })).status()).toBe(403);
    expect((await (await request.get("/api/shell")).json()).attached).toBe(false);
  } finally {
    await request.delete(`/api/sessions/${a.id}`).catch(() => {});
  }
});
