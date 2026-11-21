import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

test.use({ storageState: { cookies: [], origins: [] } });

test("the active pane has a single identity line and a background pane keeps its preview", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string; provider: string; context: number }[];
  const model = models.filter((m) => m.provider === "scripted").sort((a, b) => b.context - a.context)[0];
  test.skip(!model, "requires a scripted scratch daemon");
  const made: string[] = [];
  const create = async (title: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { title, model: model!.id } })).json();
    made.push(session.id);
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "Review the release checklist." } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events.some((e: { kind: string }) => e.kind === "turn_end")).toBe(true);
    return session.id as string;
  };
  const pane = (id: string) => page.getByTestId("station").and(page.locator(`[data-station="${id}"]`));
  try {
    const first = await create("Review the release checklist");
    const second = await create("Check the app update");
    await page.goto(`/s/${first}`);
    await expect(pane(first)).toHaveAttribute("data-helm", "true");
    await expect(pane(first).getByTestId("composer")).toBeVisible();
    const other = page.getByTestId("session-list").locator(`[data-session="${second}"]`);
    await other.hover();
    await other.getByTestId("row-beside").click();
    const active = pane(second);
    const background = pane(first);
    await expect(active).toHaveAttribute("data-helm", "true");
    await expect(active.getByTestId("station-word")).toHaveText("Done");
    await expect(active.getByTestId("session-menu")).toBeVisible();
    await expect(background.locator(".k-station-line")).toBeVisible();
    await shoot(page, "workbench-head");
    await expect(active.locator(".k-station-line")).toBeHidden();
    const title = (await active.getByRole("heading", { name: "Check the app update", level: 2 }).boundingBox())!;
    const state = (await active.getByTestId("station-word").boundingBox())!;
    expect(Math.abs(title.y + title.height / 2 - state.y - state.height / 2)).toBeLessThan(5);
    await active.getByTestId("session-menu").click();
    await page.getByTestId("menu-rename").click({ timeout: 5000 });
    const name = active.getByRole("textbox", { name: "Session title" });
    await name.fill("App update ready");
    await name.press("Enter");
    await expect(active.getByRole("heading", { name: "App update ready", level: 2 })).toBeVisible();
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
  }
});

test("a narrow running composer keeps Stop and Send on screen", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string; provider: string; context: number }[];
  const model = models.filter((m) => m.provider === "scripted").sort((a, b) => b.context - a.context)[0];
  test.skip(!model, "requires a scripted scratch daemon");
  const { session } = await (await request.post("/api/sessions", { data: { title: "Narrow composer", model: model!.id } })).json();
  try {
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/s/${session.id}`);
    // A phone keeps other sessions as pages beside this one: every control is read in its own pane.
    const pane = page.getByTestId("station").and(page.locator(`[data-station="${session.id}"]`));
    await expect(pane.getByTestId("composer")).toBeVisible();
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:long-tool" } });
    await pane.getByTestId("composer").fill("Follow up after the command");
    await expect(pane.getByTestId("stop")).toBeInViewport({ ratio: 1 });
    await expect(pane.getByTestId("queue-button")).toBeInViewport({ ratio: 1 });
    await expect(pane.getByTestId("send")).toBeInViewport({ ratio: 1 });
    await shoot(page, "workbench-narrow-composer");
    await pane.getByTestId("stop").click();
    await expect(pane.getByTestId("stop")).toHaveCount(0);
  } finally { await request.delete(`/api/sessions/${session.id}`); }
});

// Everything above the message box (the plan, requests that wait, messages
// kept after a failed send) and the box itself share the pane's height: the
// box and its Send and Stop stay on screen, the rest scrolls.
test("a small window keeps the message box on screen under a full stack", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string; provider: string; context: number }[];
  const model = models.filter((m) => m.provider === "scripted").sort((a, b) => b.context - a.context)[0];
  test.skip(!model, "requires a scripted scratch daemon");
  const { session } = await (await request.post("/api/sessions", { data: { title: "Full stack", model: model!.id } })).json();
  const id = session.id as string;
  const idle = () => expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).session.phase, { timeout: 30_000 }).toBe("idle");
  const errors = async () => ((await (await request.get("/api/errors")).json()).errors as { count?: number }[]).reduce((n, e) => n + (e.count ?? 1), 0);
  const errorsBefore = await errors();
  try {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask" } });
    // A plan with work left, then three commands that each wait for an answer.
    const todos = ["Read the release notes", "Check the changelog against the tags", "List what changed for people who upgrade", "Write the summary", "Read it once more", "Send it for review"]
      .map((content, i) => ({ content, activeForm: content, status: i === 0 ? "completed" : i === 1 ? "in_progress" : "pending" }));
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "TodoWrite", input: { todos } }])}` } });
    await idle();
    const writes = ["one", "two", "three"].map((n) => ({ name: "Bash", input: { command: `echo ${n} > ${n}.txt` } }));
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:batch ${JSON.stringify(writes)}` } });
    // Two messages kept in this browser after sends that did not go.
    const kept = [
      { id: "kept-1", text: "An earlier message the daemon refused.", images: [], queue: false, state: "refused", error: "The session was busy." },
      { id: "kept-2", text: "A draft set aside for a restored one.", images: [], queue: false, state: "parked" },
    ];
    await page.addInitScript(([key, value]) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("keel.textScale", "1.5");
      localStorage.setItem(key!, value!);
    }, [`keel.sends.${id}`, JSON.stringify(kept)]);
    await page.setViewportSize({ width: 390, height: 600 });
    await page.goto(`/s/${id}`);
    const pane = page.getByTestId("station").and(page.locator(`[data-station="${id}"]`));
    const box = pane.getByTestId("composer");
    await expect(pane.getByTestId("approval")).toHaveCount(3);
    await expect(pane.getByTestId("saved-draft")).toHaveCount(2);
    // The oldest request took the focus (the box is empty): the control Enter would press is
    // in the part of the region that shows, not above or below it.
    const tray = pane.getByTestId("composer-tray");
    const focusShown = () => page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      const view = a?.closest('[data-testid="composer-tray"]')?.getBoundingClientRect();
      if (!a || !view) return null;
      const r = a.getBoundingClientRect();
      return { testid: a.dataset.testid, shown: r.top >= view.top - 0.5 && r.bottom <= view.bottom + 0.5 && r.height > 0 };
    });
    await expect(pane.getByTestId("approval").first().getByTestId("allow-once")).toBeFocused();
    expect(await tray.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
    await expect.poll(focusShown).toEqual({ testid: "allow-once", shown: true });
    // The next request by Tab, and the last one's Allow: each is shown when it has the focus.
    await pane.getByTestId("approval").last().getByTestId("allow-once").focus();
    await expect.poll(focusShown).toEqual({ testid: "allow-once", shown: true });
    await shoot(page, "composer-stack-390x600-focused-request");
    await pane.getByTestId("dock-plan").click();
    await expect(pane.getByTestId("session-dock").getByText("Send it for review")).toBeVisible();
    // What the box says about itself has a line of its own over the one-row tools, cut where the room ends and whole in its tip.
    await request.post(`/api/sessions/${id}/draft`, { data: { text: "A note from elsewhere.", origin: "the capture tool on another desk" } });
    const notice = pane.getByTestId("composer-notice");
    await expect(notice).toBeInViewport({ ratio: 1 });
    await expect(notice).toHaveAttribute("title", "Text added from the capture tool on another desk.");
    // (Once it has come in: it slides a few pixels as it appears.)
    await expect.poll(() => notice.evaluate((el) => { const tools = el.parentElement!.querySelector('[data-testid="composer-tools"]')!.getBoundingClientRect(); const r = el.getBoundingClientRect(); return r.bottom <= tools.top + 1 && r.left >= el.parentElement!.getBoundingClientRect().left; })).toBe(true);
    await shoot(page, "composer-stack-390x600-notice");
    const draft = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long draft that wraps on a narrow screen.`).join("\n");
    await box.fill(draft);

    // On screen whole, and not under anything else.
    const onScreen = async (el: Locator) => {
      await expect(el).toBeInViewport({ ratio: 1 });
      expect(await el.evaluate((e) => {
        const r = e.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!at && (e === at || e.contains(at));
      })).toBe(true);
    };
    const controls = async () => {
      for (const t of ["stop", "queue-button", "send"]) await onScreen(pane.getByTestId(t));
      await onScreen(box);
      // Room to read what is being typed: two lines of the draft at least.
      expect(await box.evaluate((e) => e.clientHeight / parseFloat(getComputedStyle(e).lineHeight))).toBeGreaterThanOrEqual(2);
    };
    await controls();
    await shoot(page, "composer-stack-390x600-large-text");
    // Every card above is reached by scrolling, and the box stays where it is.
    const cards = [pane.getByTestId("session-dock").getByText("Send it for review"), ...(await pane.getByTestId("approval").all()), ...(await pane.getByTestId("saved-draft").all())];
    for (const card of cards) {
      // A card taller than the room above the box is read from its first line to its last.
      for (const edge of ["start", "end"] as const) {
        expect(await card.evaluate((el, edge) => {
          el.scrollIntoView({ block: edge });
          const r = el.getBoundingClientRect();
          const at = document.elementFromPoint(r.left + r.width / 2, edge === "start" ? r.top + 2 : r.bottom - 2);
          return !!at && el.contains(at);
        }, edge)).toBe(true);
      }
      await controls();
    }
    // By keyboard too: Shift Tab from the box walks back through the cards' controls.
    await box.focus();
    await page.keyboard.press("Shift+Tab");
    await expect.poll(async () => (await focusShown())?.shown).toBe(true);
    await controls();
    await shoot(page, "composer-stack-390x600-scrolled");

    // The draft is the same after the window grows and shrinks again.
    await page.setViewportSize({ width: 1920, height: 1040 });
    await expect(box).toHaveValue(draft);
    await controls();
    await shoot(page, "composer-stack-1920");
    await page.setViewportSize({ width: 390, height: 600 });
    await expect(box).toHaveValue(draft);
    await controls();

    // At the default text size, with the long draft still in the box: what waits on the owner
    // is what the region shows. The oldest request is whole on screen with its buttons, on a
    // desk and on a phone, and the draft has given way to it.
    await page.evaluate(() => localStorage.setItem("keel.textScale", "1"));
    for (const [width, height, name] of [[1920, 1040, "composer-stack-1920-requests"], [390, 844, "composer-stack-390x844-requests"]] as const) {
      await page.setViewportSize({ width, height });
      await page.reload();
      await expect(pane.getByTestId("approval")).toHaveCount(3);
      await expect(box).toHaveValue(draft);
      const oldest = pane.getByTestId("approval").first();
      await expect(oldest).toBeInViewport({ ratio: 1 });
      for (const t of ["approval-summary", "allow-once", "allow-always", "deny"]) await onScreen(oldest.getByTestId(t));
      await controls();
      await shoot(page, name);
    }
    expect(await errors()).toBe(errorsBefore);
  } finally { await request.delete(`/api/sessions/${id}`); }
});

// The keyboard is never left on nothing: the last request answered from the keys, and Stop
// pressed with the pointer, both hand the focus to the message box.
test("the focus goes to the message box when a request or Stop goes away", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string; provider: string; context: number }[];
  const model = models.filter((m) => m.provider === "scripted").sort((a, b) => b.context - a.context)[0];
  test.skip(!model, "requires a scripted scratch daemon");
  const { session } = await (await request.post("/api/sessions", { data: { title: "Focus handoff", model: model!.id } })).json();
  const id = session.id as string;
  try {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask" } });
    await page.goto(`/s/${id}`);
    const pane = page.getByTestId("station").and(page.locator(`[data-station="${id}"]`));
    const box = pane.getByTestId("composer");
    await expect(box).toBeFocused();
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "echo one > one.txt" } }])}` } });
    // The request takes the focus (the box is empty); Enter allows it; the card and its list go.
    await expect(pane.getByTestId("allow-once")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(pane.getByTestId("approval")).toHaveCount(0);
    await expect(box).toBeFocused();
    await expect(pane.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
    // Stop by the pointer: the button goes with the turn, the focus is in the box.
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto" } });
    await box.fill("script:long-tool");
    await page.keyboard.press("Enter");
    await pane.getByTestId("stop").click();
    await expect(pane.getByTestId("stop")).toHaveCount(0);
    await expect(box).toBeFocused();
  } finally { await request.delete(`/api/sessions/${id}`); }
});

// A session that fills the toolbar: it runs in a worktree, has a loop in the
// background and a second machine to move to, beside the actions every session has.
const SECONDARY = ["machine-chip", "background-button", "worktree-chip", "permission-menu", "snooze-button", "header-action-export", "header-action-voice"];
// The same tools, the one that stays in the row longest first, and what each opens.
const RANKED = ["permission-menu", "worktree-chip", "machine-chip", "background-button", "snooze-button", "header-action-export", "header-action-voice"];
const OPENS: Record<string, string> = { "permission-menu": "mode-full-auto", "worktree-chip": "worktree-popup", "machine-chip": "move-popup", "background-button": "background-popup", "snooze-button": "snooze-menu" };
async function crowded(request: import("@playwright/test").APIRequestContext, model: string) {
  const repo = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `toolbar-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), "# Notes\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const { session } = await (await request.post("/api/worktrees", { data: { workspace: repo, model, title: "Crowded toolbar" } })).json();
  const loop = await (await request.post("/api/loops", { data: { session_id: session.id, name: "Nightly check", prompt: "Reply ok.", schedule: "1d" } })).json();
  const machine = await (await request.post("/api/fleet/machines", { data: { name: "buildbox", daemon_url: "http://127.0.0.1:9", workspace_root: "/srv/work" } })).json();
  const drop = async () => {
    await request.delete(`/api/loops/${loop.id}`);
    await request.delete(`/api/fleet/machines/${machine.id}`);
    await request.delete(`/api/sessions/${session.id}`);
    rmSync(repo, { recursive: true, force: true });
  };
  return { id: session.id as string, drop };
}

// The toolbar never scrolls sideways: Session actions and Panels are whole on
// screen, and every action the session has is in the row or in the More menu.
async function reachable(page: Page, station: Locator) {
  const header = station.getByTestId("session-header");
  await expect(station.getByTestId("permission-menu").or(page.getByTestId("header-more").getByTestId("permission-menu"))).toBeAttached();
  await expect(station.getByTestId("session-menu")).toBeInViewport({ ratio: 1 });
  await expect(station.getByTestId("panel-menu")).toBeInViewport({ ratio: 1 });
  expect(await header.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  const inRow: string[] = [], inMenu: string[] = [];
  for (const id of SECONDARY) ((await header.getByTestId(id).count()) ? inRow : inMenu).push(id);
  for (const id of inRow) await expect(header.getByTestId(id)).toBeInViewport({ ratio: 1 });
  // The row keeps the highest ranks: nothing folded outranks a tool that stayed.
  expect([...inRow].sort((x, y) => RANKED.indexOf(x) - RANKED.indexOf(y))).toEqual(RANKED.slice(0, inRow.length));
  return { inRow, inMenu };
}

test.describe("a crowded toolbar", () => {
  test.use({ hasTouch: true });

  test("keeps Session actions and Panels on screen and folds the rest into a labeled menu", async ({ page, request }) => {
    const models = (await (await request.get("/api/models")).json()).models as { id: string; provider: string; context: number }[];
    const model = models.filter((m) => m.provider === "scripted").sort((a, b) => b.context - a.context)[0];
    test.skip(!model, "requires a scripted scratch daemon");
    const errors = async () => ((await (await request.get("/api/errors")).json()).errors as { count?: number }[]).reduce((n, e) => n + (e.count ?? 1), 0);
    const errorsBefore = await errors();
    const { id, drop } = await crowded(request, model!.id);
    const station = page.getByTestId("station").and(page.locator(`[data-station="${id}"]`));
    const more = station.getByRole("button", { name: "More actions" });
    const menu = page.getByTestId("header-more");
    try {
      // A phone, by touch.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/s/${id}`);
      await expect(station.getByTestId("composer")).toBeVisible();
      const phone = await reachable(page, station);
      expect(phone.inMenu.length).toBeGreaterThan(0);
      await expect(more).toBeInViewport({ ratio: 1 });
      await shoot(page, "workbench-toolbar-390");
      // The button says how many it holds, and that folded background work is running.
      await expect(more).toHaveAccessibleName(/^\d+ more actions$/);
      await expect(more.getByTestId("more-live")).toBeVisible();
      await more.tap();
      await expect(menu).toBeVisible();
      for (const t of phone.inMenu) await expect(menu.getByTestId(t)).toBeInViewport({ ratio: 1 });
      await expect(menu.getByRole("group", { name: "Worktree" }).getByTestId("worktree-chip")).toBeVisible();
      await shoot(page, "workbench-toolbar-390-more");
      // A control in the menu works as it does in the row, and its whole row is the target:
      // a tap on the name opens it, and its own popup is then used like any other.
      await menu.getByText("Worktree", { exact: true }).tap();
      const worktree = page.getByTestId("worktree-popup");
      await expect(worktree).toBeVisible();
      await page.getByTestId("pr-open").tap();
      await expect(page.getByTestId("pr-title")).toBeVisible();
      await page.getByTestId("pr-title").tap();
      await page.getByTestId("pr-title").fill("Toolbar");
      await expect(page.getByTestId("pr-title")).toHaveValue("Toolbar");
      await worktree.click({ position: { x: 3, y: 3 } });
      await expect(worktree).toBeVisible();
      await shoot(page, "workbench-toolbar-390-nested");
      await page.keyboard.press("Escape");
      await expect(worktree).toBeHidden();
      await expect(menu).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      // A press outside closes the control's popup and the menu together, and both stay closed.
      await more.tap();
      await menu.getByTestId("worktree-chip").tap();
      await expect(worktree).toBeVisible();
      await station.getByTestId("station-word").tap();
      await expect(worktree).toBeHidden();
      await expect(menu).toBeHidden();
      // The permission modes open from wherever the control is.
      if (phone.inMenu.includes("permission-menu")) await more.tap();
      await (phone.inMenu.includes("permission-menu") ? menu : station).getByTestId("permission-menu").tap();
      await expect(page.getByTestId("mode-full-auto")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("mode-full-auto")).toBeHidden();
      if (phone.inMenu.includes("permission-menu")) await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();

      // Larger text folds Permissions too: its row says the mode, a pick keeps its popup open,
      // and /permissions opens it in the menu, not detached from it.
      await page.evaluate(() => localStorage.setItem("keel.textScale", "1.5"));
      await page.reload();
      await expect(more).toBeVisible();
      const large = await reachable(page, station);
      expect(large.inMenu).toContain("permission-menu");
      await station.getByTestId("composer").fill("/permissions");
      await page.keyboard.press("Enter");
      await expect(menu).toBeVisible();
      await expect(menu.getByTestId("permission-mode")).toBeInViewport({ ratio: 1 });
      const modes = page.getByTestId("mode-ask");
      await expect(modes).toBeInViewport({ ratio: 1 });
      expect((await modes.boundingBox())!.y).toBeGreaterThan((await menu.getByTestId("permission-menu").boundingBox())!.y);
      await page.getByTestId("mode-auto-edits").tap();
      await expect(modes).toBeVisible();
      await expect(menu.getByTestId("permission-mode")).toHaveText("Auto edits");
      await page.getByTestId("mode-ask").tap();
      await expect(modes).toBeVisible();
      await shoot(page, "workbench-toolbar-390-large-text");
      await page.keyboard.press("Escape");
      await expect(modes).toBeHidden();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await page.evaluate(() => localStorage.setItem("keel.textScale", "1"));
      await page.reload();
      await expect(station.getByTestId("composer")).toBeVisible();

      // A narrow desktop pane, by keyboard.
      await page.setViewportSize({ width: 900, height: 1040 });
      const narrow = await reachable(page, station);
      expect(narrow.inMenu.length).toBeGreaterThan(0);
      await more.focus();
      await page.keyboard.press("Enter");
      await expect(menu).toBeVisible();
      for (const t of narrow.inMenu) await expect(menu.getByTestId(t)).toBeVisible();
      await shoot(page, "workbench-toolbar-900-more");
      // Tab walks the menu's controls; Enter opens the one it stops on.
      const focused = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");
      for (let i = 0; i < 6 && !OPENS[await focused()]; i++) await page.keyboard.press("Tab");
      const stop = await focused();
      expect(narrow.inMenu).toContain(stop);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId(OPENS[stop]!)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(OPENS[stop]!)).toBeHidden();
      await expect(menu).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(more).toBeFocused();

      // A wide pane holds them all: no menu, and the session is named once.
      await page.setViewportSize({ width: 1920, height: 1040 });
      await expect(more).toHaveCount(0);
      const wide = await reachable(page, station);
      expect(wide.inMenu).toEqual([]);
      await expect(station.getByRole("heading", { name: "Crowded toolbar", level: 2 })).toBeVisible();
      await expect(station.locator(".k-station-line")).toBeHidden();
      expect(await station.getByTestId("session-title").evaluate((el) => getComputedStyle(el).clipPath)).toBe("inset(50%)");
      await shoot(page, "workbench-toolbar-1920");
      // A row that just got narrower and is not measured again yet clips its foldable tools, not the two that stay.
      const past = await station.getByTestId("session-header").evaluate((el) => {
        const h = el as HTMLElement;
        h.style.width = "30rem";
        const edge = h.getBoundingClientRect().right;
        const over = Math.max(...["session-menu", "panel-menu"].map((t) => h.querySelector(`[data-testid="${t}"]`)!.getBoundingClientRect().right - edge));
        h.style.width = "";
        return over;
      });
      expect(past).toBeLessThanOrEqual(0);
      expect(await errors()).toBe(errorsBefore);
    } finally { await drop(); }
  });
});
