import { expect, test } from "./isolate.ts";
import { create, folder, row } from "./answering.ts";
import { shoot, WORKBENCH } from "./shots.ts";

test.use({ storageState: WORKBENCH, viewport: { width: 1920, height: 1040 } });

test("Page Up and Page Down jump between visible session groups without opening them", async ({ page, request }) => {
  const folders: string[] = [];
  try {
    const ws = folder("group-keys");
    for (const name of ["Design", "Drafts", "Review", "Shipping"]) {
      const r = await request.post("/api/session-folders", { data: { name } });
      folders.push((await r.json()).folder.id);
    }
    const session = async (title: string, i: number) => {
      const id = await create(request, title, ws);
      expect((await request.patch(`/api/sessions/${id}`, { data: { folder_id: folders[i] } })).ok()).toBe(true);
      return row(page, id);
    };
    await session("Keep: second draft", 0);
    const start = await session("Keep: outline", 0);
    const folded = await session("Keep: old draft", 1);
    const middle = await session("Keep: review", 2);
    const last = await session("Ship the changes", 3);
    await request.patch(`/api/session-folders/${folders[1]}`, { data: { collapsed: true } });
    // The layout setting is kept in the page, not in the daemon.
    await page.goto("/");
    await page.getByTestId("list-arrange").click();
    await page.getByTestId("arrange-group-mine").click();
    await page.keyboard.press("Escape");
    await expect(folded).toHaveCount(0);
    await start.click();
    const url = page.url();
    const jump = async (key: string, to: typeof start) => {
      await page.keyboard.press(key);
      await expect(to).toBeFocused();
      expect(page.url()).toBe(url);
    };
    await start.focus();
    await jump("PageDown", middle);
    await jump("PageDown", last);
    await jump("PageDown", last);
    await jump("PageUp", middle);
    await jump("PageUp", start);
    await jump("PageUp", start);
    await shoot(page, "session-group-keys");
    // Filtering opens matching folders but removes the group without a match.
    await page.getByTestId("list-filter").fill("Keep:");
    await expect(last).toHaveCount(0);
    await middle.focus();
    await jump("PageDown", middle);
    const composer = page.getByTestId("composer");
    await composer.focus();
    await page.keyboard.press("PageUp");
    await expect(composer).toBeFocused();
  } finally {
    for (const id of folders) await request.delete(`/api/session-folders/${id}`);
  }
});
