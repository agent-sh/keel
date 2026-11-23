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
    can: Object.freeze({ titlebar: true, windows: true, links: true, notifications: true, tray: true, shortcuts: ${kind === "main"} }),
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

    // The desktop has global shortcuts for apps: the page offers to ask for the app's own, and the app does the asking.
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("global shortcuts");
    await page.keyboard.press("Enter");
    await expect.poll(() => posted(page, "shortcuts")).toEqual([{ t: "shortcuts" }]);
    // And the key every desktop app has for a new one, which a browser tab cannot take.
    await page.keyboard.press("Control+n");
    await page.waitForURL((u) => u.pathname === "/");
    expect(await page.evaluate(() => (window as any).__same)).toBe(true);
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

// The review's case: a keel:// link raised the window on a session with a request waiting,
// the card took the keyboard on "Allow once" by itself, and one Return ran the command.
test("shell: a link or a launch never lands the keyboard on an answer; a notification's own click does", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const a = await make(request, "Shell: where the owner was");
  await expect.poll(() => ended(request, a.id), { timeout: 60_000 }).toBe(true);
  const asks = (await (await request.post("/api/sessions", { data: { model: MODEL, title: "Shell: asks before it runs" } })).json()).session;
  await request.put(`/api/sessions/${asks.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${asks.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "touch answered-by-a-link.txt" } }])}` } });
  const pending = async () => ((await (await request.get(`/api/sessions/${asks.id}/approvals?all`)).json()).approvals as any[]).filter((x) => x.state === "pending");
  await expect.poll(async () => (await pending()).length, { timeout: 30_000 }).toBe(1);
  const approval = (await pending())[0].id as string;
  try {
    await page.addInitScript(shellObject("main"));
    await page.goto(`/s/${a.id}`);
    await expect(page.getByTestId("transcript")).toBeVisible();

    // A link (or a second launch, or the tray) brings the owner to the session.
    await tell(page, { open: `/s/${asks.id}`, from: "link" });
    await page.waitForURL(new RegExp(`/s/${asks.id}$`));
    const once = page.getByTestId("allow-once");
    await expect(once).toBeVisible();
    // Past the time a new card waits before it takes the keyboard by itself.
    await expect(page.getByTestId("approvals")).toBeFocused({ timeout: 10_000 });
    await page.waitForTimeout(1500);
    await expect(once).not.toBeFocused();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);
    expect((await pending()).map((x) => x.id)).toEqual([approval]);
    await shoot(page, "shell-03-link-arrival");

    // The owner then puts the keyboard on the answer; another link takes it off again.
    await once.focus();
    await tell(page, { open: `/s/${asks.id}`, from: "link" });
    await expect(page.getByTestId("approvals")).toBeFocused();

    // A link cannot name a request either: an approval in a path that was not clicked is "card".
    await tell(page, { open: `/s/${asks.id}?approval=${approval}` });
    await page.waitForTimeout(500);
    await expect(once).not.toBeFocused();

    // The click on that request's own notification is the owner's choice of it.
    await tell(page, { open: `/s/${asks.id}?approval=${approval}`, from: "click" });
    await expect(once).toBeFocused();
  } finally {
    for (const s of [a, asks]) await request.delete(`/api/sessions/${s.id}`).catch(() => {});
  }
});

// The review's case: the band was hidden whenever the app has a title bar, so a loss only the
// page sees (its socket cut while the daemon answers) was said nowhere.
test("shell: the page says the daemon is away unless the app's title bar does, and the text size keys are the page's setting", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const a = await make(request, "Shell: the socket is cut");
  await expect.poll(() => ended(request, a.id), { timeout: 60_000 }).toBe(true);
  const live: { ws?: import("@playwright/test").WebSocketRoute; cut: boolean } = { cut: false };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (live.cut) return void ws.close({ code: 4000, reason: "cut by the test" });
    ws.connectToServer();
    live.ws = ws;
  });
  try {
    await page.addInitScript(shellObject("main"));
    await page.goto(`/s/${a.id}`);
    await expect(page.getByTestId("transcript")).toBeVisible();
    const band = page.getByTestId("daemon-away");
    await expect(band).toHaveCount(0);

    live.cut = true;
    await live.ws!.close({ code: 4000, reason: "cut by the test" });
    // The app sees the daemon answer, so its title bar says nothing: the page must.
    await expect(band).toBeVisible({ timeout: 10_000 });
    await shoot(page, "shell-04-socket-cut");
    // The app's title bar says it: one place, not two.
    await tell(page, { daemon: "away" });
    await expect(band).toHaveCount(0);
    // The app sees the daemon back while the page is still cut off: the page says so again.
    await tell(page, { daemon: "up" });
    await expect(band).toBeVisible({ timeout: 10_000 });
    live.cut = false;
    await tell(page, { daemon: "up" });
    await expect(band).toHaveCount(0, { timeout: 15_000 });

    // Ctrl plus, minus and zero in the app are the page's text size: one scale.
    const scale = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim());
    expect(await scale()).toBe("1");
    await tell(page, { scale: "up" });
    await expect.poll(scale).toBe("1.1");
    await expect.poll(async () => (await posted(page, "look")).at(-1)?.scale).toBe(1.1);
    await tell(page, { scale: "down" });
    await tell(page, { scale: "down" });
    await expect.poll(scale).toBe("0.9");
    await tell(page, { scale: "reset" });
    await expect.poll(scale).toBe("1");
  } finally {
    await request.delete(`/api/sessions/${a.id}`).catch(() => {});
  }
});

// The review's case: the app let the engine grant one clipboard read after the page's paste,
// and a sandboxed frame could take it. The page now has no clipboard of its own in the app: it
// asks the app, by number, and the app answers at the owner's press (desktop/src/clip.rs).
test("shell: a paste and a copy go through the app, and a browser tab asks no clipboard for a paste", async ({ page, request, context }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const a = await make(request, "Shell: the clipboard");
  await expect.poll(() => ended(request, a.id), { timeout: 60_000 }).toBe(true);
  // Every read of the browser's own clipboard is counted.
  const counted = () => {
    (window as any).__reads = 0;
    const c = navigator.clipboard;
    if (c) for (const name of ["read", "readText"] as const) { const real = (c as any)[name]?.bind(c); (c as any)[name] = (...args: unknown[]) => { (window as any).__reads++; return real ? real(...args) : Promise.reject(new Error("none")); }; }
  };
  // The owner's paste key with nothing a paste event can carry: what the engine of the app hands for a copied picture.
  const pasteNothing = async () => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await page.evaluate(() => navigator.clipboard.writeText("").catch(() => {}));
    await context.clearPermissions().catch(() => {});
    await page.evaluate(() => { (window as any).__reads = 0; (window as any).__paste = null; addEventListener("paste", (e) => { (window as any).__paste = { trusted: e.isTrusted, types: [...(e as ClipboardEvent).clipboardData!.types] }; }, true); });
    await page.getByTestId("composer").focus();
    await page.keyboard.press("Control+v");
    await expect.poll(() => page.evaluate(() => (window as any).__paste)).toEqual({ trusted: true, types: [] });
    await page.waitForTimeout(500);
  };
  try {
    // In a browser tab: nothing is asked of the clipboard.
    await page.addInitScript(counted);
    await page.goto(`/s/${a.id}`);
    await expect(page.getByTestId("composer")).toBeVisible();
    await pasteNothing();
    expect(await page.evaluate(() => (window as any).__reads)).toBe(0);
    await expect(page.getByTestId("attachments")).toHaveCount(0);

    // In the app: the page asks the app, and takes the picture the app hands it.
    await page.addInitScript(shellObject("main"));
    await page.reload();
    await expect(page.getByTestId("composer")).toBeVisible();
    await pasteNothing();
    await expect.poll(async () => (await posted(page, "paste")).length).toBe(1);
    expect(await page.evaluate(() => (window as any).__reads)).toBe(0);
    const asked = (await posted(page, "paste"))[0];
    expect(asked.id).toBeGreaterThan(0);
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    // An answer with another number is not this paste's.
    await tell(page, { pasted: { id: asked.id + 100, images: [{ type: "image/png", data: png }] } });
    await page.waitForTimeout(300);
    await expect(page.getByTestId("attachments")).toHaveCount(0);
    await tell(page, { pasted: { id: asked.id, text: null, images: [{ type: "image/png", data: png }] } });
    await expect(page.getByTestId("attachments").locator("img")).toHaveCount(1);
    await shoot(page, "shell-05-pasted-picture");
    // The page names the size it keeps a picture at: the app hands a larger one over at that size.
    expect(asked.edge).toBe(1568);
    // A picture the app could not make ready is said, not dropped in silence.
    await pasteNothing();
    await expect.poll(async () => (await posted(page, "paste")).length).toBe(2);
    await tell(page, { pasted: { id: (await posted(page, "paste"))[1].id, text: null, images: [], failed: true } });
    await expect(page.getByText("The picture on the clipboard could not be read.")).toBeVisible();
    await expect(page.getByTestId("attachments").locator("img")).toHaveCount(1);

    // A copy is announced at the press, sent with its text, and shown as copied only when the app says so.
    const copy = page.getByTestId("copy-reply").first();
    await copy.hover();
    await copy.click();
    await expect.poll(async () => (await posted(page, "copy")).length).toBe(1);
    expect((await posted(page, "copying")).length).toBeGreaterThan(0);
    const sent = (await posted(page, "copy"))[0];
    expect(typeof sent.text).toBe("string");
    expect(sent.text.length).toBeGreaterThan(0);
    await expect(copy).not.toHaveAttribute("data-copied", "true");
    await tell(page, { copied: { id: sent.id, ok: true } });
    await expect(copy).toHaveAttribute("data-copied", "true");
    // The app refuses one (no press it could tie it to): the button says the copy failed.
    await page.waitForTimeout(1600);
    await copy.click();
    await expect.poll(async () => (await posted(page, "copy")).length).toBe(2);
    await tell(page, { copied: { id: (await posted(page, "copy"))[1].id, ok: false } });
    await expect(copy).toHaveAttribute("data-failed", "true");
  } finally {
    await request.delete(`/api/sessions/${a.id}`).catch(() => {});
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
    await page.getByTestId("palette-input").fill("global shortcuts");
    await expect(page.getByText("Global shortcuts: show Keel, new session")).toHaveCount(0);
    // The shell's routes are the desk's own: a call that came through a proxy is refused.
    expect((await request.get("/api/shell", { headers: { "x-forwarded-for": "203.0.113.9" } })).status()).toBe(403);
    expect((await (await request.get("/api/shell")).json()).attached).toBe(false);
  } finally {
    await request.delete(`/api/sessions/${a.id}`).catch(() => {});
  }
});
