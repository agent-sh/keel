import { expect, test } from "./isolate.ts";
import { choose, openPanel, shoot } from "./shots.ts";

test.use({ viewport: { width: 1700, height: 980 } });

// Feature: the owner's folders of sessions. Made, renamed, a folder inside a
// folder, sessions dragged in, folded, reordered by drag, a session filed
// from its panel, and a deleted folder that leaves its sessions unfiled.
test("folders of sessions: make, rename, nest, drag in, fold, reorder, delete", async ({ page, request }) => {
  const word = `fd${Date.now().toString(36)}`;
  const make = async (title: string) => (await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: `${title} ${word}` } })).json()).session.id as string;
  const [a, b, c] = [await make("Alpha"), await make("Beta"), await make("Gamma")];
  const folderOf = async (id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).session.settings.folder_id ?? null;
  const all = async () => (await (await request.get("/api/session-folders")).json()).folders as any[];
  const before = new Set((await all()).map((f) => f.id));

  await page.goto("/");
  await page.getByTestId("list-arrange").click();
  await page.getByTestId("arrange-group-mine").click();
  await page.keyboard.press("Escape");
  const list = page.getByTestId("session-list");
  const fresh = async () => (await all()).filter((f) => !before.has(f.id));
  const rename = async (id: string, name: string) => {
    await list.locator(`[data-testid="folder-head"][data-folder="${id}"] span[title="Double-click to rename"]`).dblclick();
    await page.getByTestId("folder-rename").fill(name);
    await page.getByTestId("folder-rename").press("Enter");
    await expect(list.locator(`[data-testid="folder-head"][data-folder="${id}"]`)).toContainText(name);
  };

  // Two folders, renamed.
  await page.getByTestId("folder-create").click();
  await expect.poll(async () => (await fresh()).length).toBe(1);
  await page.getByTestId("folder-create").click();
  await expect.poll(async () => (await fresh()).length).toBe(2);
  const [work, later] = (await fresh()).map((f) => f.id);
  await rename(work, `Work ${word}`);
  await rename(later, `Later ${word}`);
  const head = (id: string) => list.locator(`[data-testid="folder-head"][data-folder="${id}"]`);
  const group = (id: string) => list.locator(`[data-testid="folder-group"][data-folder="${id}"]`);

  // Drag a session in; a folder inside Work; drag another there.
  await list.locator(`[data-session="${a}"]`).dragTo(head(work));
  await expect.poll(() => folderOf(a)).toBe(work);
  // With a mouse the head's actions are quiet until it is hovered.
  await page.mouse.move(900, 500);
  const quiet = page.getByRole("button", { name: `New folder in Work ${word}` });
  await expect.poll(() => quiet.evaluate((b) => getComputedStyle(b).opacity)).toBe("0");
  await head(work).hover();
  await expect.poll(() => quiet.evaluate((b) => getComputedStyle(b).opacity)).toBe("1");
  await page.getByRole("button", { name: `New folder in Work ${word}` }).click();
  await expect.poll(async () => (await fresh()).length).toBe(3);
  const sub = (await fresh()).find((f) => f.parent_id === work)!.id;
  await rename(sub, `Review ${word}`);
  await list.locator(`[data-session="${b}"]`).dragTo(head(sub));
  await expect.poll(() => folderOf(b)).toBe(sub);
  await expect(group(work).locator(`[data-session="${a}"]`)).toBeVisible();
  await expect(group(sub).locator(`[data-session="${b}"]`)).toBeVisible();
  await expect(group("none").locator(`[data-session="${c}"]`)).toBeVisible();
  await shoot(page, "folders-01-filed");

  // Fold Work: its sessions and its folder go out of view; the count stays.
  await head(work).getByTestId("folder-toggle").click();
  await expect(list.locator(`[data-session="${a}"]`)).toHaveCount(0);
  await expect(list.locator(`[data-session="${b}"]`)).toHaveCount(0);
  await expect(head(work)).toContainText("2");
  expect((await all()).find((f) => f.id === work).collapsed).toBe(true);
  await shoot(page, "folders-02-folded");
  await head(work).getByTestId("folder-toggle").click();
  await expect(list.locator(`[data-session="${a}"]`)).toBeVisible();

  // Reorder: Later dragged onto the top half of Work's head goes before it.
  await head(later).dragTo(head(work), { targetPosition: { x: 40, y: 2 } });
  await expect.poll(async () => { const f = await all(); return f.findIndex((x) => x.id === later) < f.findIndex((x) => x.id === work); }).toBe(true);
  const order = await list.getByTestId("folder-head").evaluateAll((els) => els.map((e) => e.getAttribute("data-folder")));
  expect(order.indexOf(later)).toBeLessThan(order.indexOf(work));

  // File a session from its panel.
  await page.goto(`/s/${c}`);
  await openPanel(page, "session");
  await choose(page.getByTestId("session-folder"), later);
  await expect.poll(() => folderOf(c)).toBe(later);
  await expect(group(later).locator(`[data-session="${c}"]`)).toBeVisible();
  await shoot(page, "folders-03-panel");

  // Delete Work: Alpha is unfiled, Review moves up a level with Beta in it.
  await head(work).hover();
  await head(work).getByTestId("folder-delete").click();
  await page.getByTestId("confirm").getByRole("button", { name: "Delete folder" }).click();
  await expect.poll(() => folderOf(a)).toBe(null);
  expect((await all()).find((f) => f.id === sub).parent_id).toBe(null);
  await expect(group("none").locator(`[data-session="${a}"]`)).toBeVisible();
  expect((await request.patch(`/api/session-folders/${later}`, { data: { parent_id: later } })).status()).toBe(400);

  for (const f of await fresh()) await request.delete(`/api/session-folders/${f.id}`);
  for (const id of [a, b, c]) await request.delete(`/api/sessions/${id}`);
});

// Where nothing hovers, the actions of a folder's or a project's head show
// before it is touched: New folder inside, Delete, and New session in a project.
test.describe("on a touch screen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("folder and project head actions show in the drawer", async ({ page, request }) => {
    const word = `ft${Date.now().toString(36)}`;
    const s = (await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: `Filed ${word}` } })).json()).session;
    const folder = (await (await request.post("/api/session-folders", { data: { name: `Field notes ${word}` } })).json()).folder;
    const project = (await (await request.post("/api/projects", { data: { name: `Atlas ${word}` } })).json()).project;
    const shown = async (b: ReturnType<typeof page.getByRole>) => {
      await expect(b).toBeVisible();
      expect(await b.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
      const box = (await b.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24);
    };

    await page.goto(`/s/${s.id}`);
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    await page.getByTestId("show-sidebar").tap();
    await expect(page.getByTestId("sidebar")).toBeInViewport();
    await page.getByTestId("list-arrange").tap();
    await page.getByTestId("arrange-group-mine").tap();
    await page.keyboard.press("Escape");
    const head = page.locator(`[data-testid="folder-head"][data-folder="${folder.id}"]`);
    await expect(head).toBeVisible();
    await shown(head.getByRole("button", { name: `New folder in Field notes ${word}` }));
    await shown(head.getByRole("button", { name: `Delete Field notes ${word}` }));
    await shoot(page, "folders-05-touch-head-actions");
    // The first tap acts: a folder inside.
    await head.getByRole("button", { name: `New folder in Field notes ${word}` }).tap();
    await expect.poll(async () => (await (await request.get("/api/session-folders")).json()).folders.filter((f: any) => f.parent_id === folder.id).length).toBe(1);

    await page.getByTestId("list-arrange").tap();
    await page.getByTestId("arrange-group-project").tap();
    await page.keyboard.press("Escape");
    const phead = page.locator(`[data-testid="project-head"][data-project="${project.id}"]`);
    await expect(phead).toBeVisible();
    await shown(phead.getByRole("button", { name: `New session in Atlas ${word}` }));
    await shoot(page, "folders-06-touch-project-head");
    await phead.getByRole("button", { name: `New session in Atlas ${word}` }).tap();
    await expect(page.getByTestId("new-project-select")).toContainText(`Atlas ${word}`);

    await request.delete(`/api/projects/${project.id}`);
    for (const f of (await (await request.get("/api/session-folders")).json()).folders.filter((f: any) => f.id === folder.id || f.parent_id === folder.id)) await request.delete(`/api/session-folders/${f.id}`);
    await request.delete(`/api/sessions/${s.id}`);
  });
});
