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
  await head(work).hover();
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
