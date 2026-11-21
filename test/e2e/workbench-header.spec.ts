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

// A session that fills the toolbar: it runs in a worktree, has a loop in the
// background and a second machine to move to, beside the actions every session has.
const SECONDARY = ["machine-chip", "background-button", "worktree-chip", "permission-menu", "snooze-button", "header-action-export", "header-action-voice"];
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
      await more.tap();
      await expect(menu).toBeVisible();
      for (const t of phone.inMenu) await expect(menu.getByTestId(t)).toBeInViewport({ ratio: 1 });
      await shoot(page, "workbench-toolbar-390-more");
      // A control in the menu works as it does in the row, and its whole row is the target:
      // a tap on the name opens it.
      const rows = [["worktree-chip", "Worktree", "worktree-popup"], ["background-button", "Background work", "background-popup"], ["machine-chip", "Runs on", "move-popup"]] as const;
      const row = rows.find(([t]) => phone.inMenu.includes(t))!;
      await menu.getByText(row[1], { exact: true }).tap();
      await expect(page.getByTestId(row[2])).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(row[2])).toBeHidden();
      await expect(menu).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      // The permission modes open from wherever the control is.
      if (phone.inMenu.includes("permission-menu")) await more.tap();
      await (phone.inMenu.includes("permission-menu") ? menu : station).getByTestId("permission-menu").tap();
      await expect(page.getByTestId("mode-full-auto")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("mode-full-auto")).toBeHidden();
      if (phone.inMenu.includes("permission-menu")) await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();

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
      const last = narrow.inMenu.find((t) => t === "snooze-button") ?? narrow.inMenu[0]!;
      const target = menu.getByTestId(last);
      for (let i = 0; i < 12 && !(await target.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
      await expect(target).toBeFocused();
      if (last === "snooze-button") {
        await page.keyboard.press("Enter");
        await expect(page.getByTestId("snooze-menu")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("snooze-menu")).toBeHidden();
      }
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
      expect(await errors()).toBe(errorsBefore);
    } finally { await drop(); }
  });
});
