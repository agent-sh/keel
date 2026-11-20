import { expect, test } from "./isolate.ts";
import { openPanel, shoot } from "./shots.ts";

// Feature: the list and the panes stay the owner's to arrange. A second pane
// is never forced: a kept layout with an empty pane opens as one pane, and
// opening a session opens it in the pane worked in. A second pane opens when
// asked for: the row's "open beside" button (or Ctrl click), or a session
// dropped on a pane's edge. The agents a session started are folded under
// it to a count (a turning mark while one works) until he opens them, and
// that choice is kept per session. One field filters the list by title or
// folder, and its menu groups (by folder or one list), sorts (recent, state,
// name) and hides finished sessions; the arrangement is kept. The side
// panel starts closed in every session and on load; one he opened in a
// session comes back with that session only.
const MODEL = "scripted:stand-in";
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1700, height: 980 } });

test("panes on request, agents folded, the list filtered and arranged", async ({ page, request }) => {
  const tag = Date.now().toString(36);
  const mk = async (title: string, text = "Done.") => {
    const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title } })).json()).session;
    await request.post(`/api/sessions/${s.id}/messages`, { data: { text } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).events.some((e: any) => e.kind === "turn_end" || e.kind === "error"), { timeout: 30_000 }).toBe(true);
    return s.id as string;
  };
  const a = await mk(`Rotate the staging credentials ${tag}`);
  const b = await mk(`Draft the release notes ${tag}`);
  const c = await mk(`Profile the cold start ${tag}`);

  const bridge = page.getByTestId("bridge");
  const panes = bridge.locator(":scope > [data-slot]");
  const pane = (i: number) => bridge.locator(`:scope > [data-slot="${i}"]`);
  const entry = (id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);

  // His kept layout: two panes, the second left empty. It opens as one pane.
  await page.addInitScript((id) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("keel.panes", JSON.stringify({ count: 2, slots: [id, null], sizes: {}, active: 1 }));
  }, a);
  await page.goto(`/s/${a}`);
  await expect(panes).toHaveCount(1);
  await expect(pane(0)).toHaveAttribute("data-station", a);
  await expect(page.getByTestId("panes-1")).toHaveAttribute("aria-checked", "true");

  // Opening another session opens it in the same pane.
  await entry(b).click();
  await expect(panes).toHaveCount(1);
  await expect(pane(0)).toHaveAttribute("data-station", b);

  // Open beside: the row's button adds a pane to the right of the one worked in.
  await entry(a).hover();
  await entry(a).getByTestId("row-beside").click();
  await expect(panes).toHaveCount(2);
  await expect(pane(0)).toHaveAttribute("data-station", b);
  await expect(pane(1)).toHaveAttribute("data-station", a);
  await shoot(page, "arrange-01-open-beside");
  // Closing a session closes its pane.
  await pane(1).getByTestId("station-close").click();
  await expect(panes).toHaveCount(1);

  // A session dragged onto a pane's right edge opens beside it; onto its middle, in it.
  const data = await page.evaluateHandle((id) => { const dt = new DataTransfer(); dt.setData("application/x-keel-session", id); return dt; }, c);
  const box = (await pane(0).boundingBox())!;
  await pane(0).dispatchEvent("dragover", { dataTransfer: data, clientX: box.x + box.width * 0.5, clientY: box.y + 300 });
  await expect(pane(0)).toHaveAttribute("data-drop", "in");
  await pane(0).dispatchEvent("dragover", { dataTransfer: data, clientX: box.x + box.width - 20, clientY: box.y + 300 });
  await expect(pane(0)).toHaveAttribute("data-drop", "right");
  await shoot(page, "arrange-02-drop-beside");
  await pane(0).dispatchEvent("drop", { dataTransfer: data, clientX: box.x + box.width - 20, clientY: box.y + 300 });
  await expect(panes).toHaveCount(2);
  await expect(pane(1)).toHaveAttribute("data-station", c);
  await pane(1).getByTestId("station-close").click();
  await expect(panes).toHaveCount(1);

  // Agents: a session that starts two shows them folded to a count.
  const parent = await mk(`Audit the dependency tree ${tag}`, "Hold on.");
  await request.put(`/api/sessions/${parent}/permissions`, { data: { mode: "full-auto" } });
  const spawn = (message: string) => ({ name: "spawn_agent", input: { message, isolation: "none" } });
  await request.post(`/api/sessions/${parent}/messages`, { data: { text: `script:batch ${JSON.stringify([spawn("script:long-tool"), spawn("Say ok.")])}` } });
  await page.goto(`/s/${b}`);
  const kids = entry(parent).locator("xpath=..").getByTestId("session-children");
  await expect(kids.getByTestId("children-toggle")).toContainText("2 agents", { timeout: 30_000 });
  await expect(kids.getByTestId("children-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(kids.getByTestId("child-session")).toHaveCount(0);
  await expect(kids.getByTestId("children-toggle").locator('.k-mark[data-watch="work"]')).toBeVisible({ timeout: 30_000 });
  await shoot(page, "arrange-03-agents-folded");
  await kids.getByTestId("children-toggle").click();
  await expect(kids.getByTestId("child-session")).toHaveCount(2);
  await shoot(page, "arrange-04-agents-open");
  await page.reload();
  await expect(kids.getByTestId("child-session")).toHaveCount(2); // his choice, kept
  await kids.getByTestId("children-toggle").click();
  await expect(kids.getByTestId("child-session")).toHaveCount(0);

  // Filter: words of the title or the folder.
  const filter = page.getByTestId("list-filter");
  await filter.fill(`release ${tag}`);
  await expect(entry(b)).toBeVisible();
  await expect(entry(a)).toHaveCount(0);
  await shoot(page, "arrange-05-filtered");
  await filter.fill(`nothing-like-this ${tag}`);
  await expect(page.getByTestId("filter-empty")).toBeVisible();
  await filter.press("Escape");
  await expect(filter).toHaveValue("");
  await expect(entry(a)).toBeVisible();

  // Arrange: one list sorted by name, finished sessions hidden; kept over a reload.
  await page.getByTestId("list-arrange").click();
  await expect(page.getByTestId("arrange-menu")).toBeVisible();
  await page.getByTestId("arrange-group-flat").click();
  await page.getByTestId("arrange-sort-name").click();
  await shoot(page, "arrange-06-menu");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("flat-group")).toBeVisible();
  await filter.fill(tag);
  const titles = await page.getByTestId("flat-group").locator(".k-row-title").allTextContents();
  expect(titles).toEqual([...titles].sort((x, y) => x.localeCompare(y)));
  await expect(entry(a).getByTestId("row-folder")).toBeVisible();
  await filter.fill("");
  await page.getByTestId("list-arrange").click();
  await page.getByTestId("arrange-hide-done").click();
  await page.keyboard.press("Escape");
  await expect(entry(a)).toHaveCount(0); // finished
  await expect(entry(b)).toBeVisible(); // the one open stays
  await expect(page.getByTestId("hidden-done")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("flat-group")).toBeVisible();
  await expect(entry(a)).toHaveCount(0);
  await expect(pane(0).getByTestId("composer")).toBeVisible();
  await shoot(page, "arrange-07-flat-by-name-hide-finished");
  await page.getByTestId("list-arrange").click();
  await page.getByTestId("arrange-reset").click();
  await expect(page.getByTestId("flat-group")).toHaveCount(0);
  await expect(entry(a)).toBeVisible();

  // The side panel: closed on load, even when an old global choice kept it open.
  await page.evaluate(() => localStorage.setItem("keel.panel", JSON.stringify("files")));
  await page.goto(`/s/${a}`);
  await expect(page.getByTestId("side-panel")).toHaveCount(0);
  await openPanel(page, "session");
  await expect(page.getByTestId("side-panel")).toBeVisible();
  await entry(b).click();
  await expect(page.getByTestId("side-panel")).toHaveCount(0); // not opened there
  await shoot(page, "arrange-08-panel-closed");
  await entry(a).click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "session");
  await page.reload();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "session");
  await entry(c).click();
  await expect(page.getByTestId("side-panel")).toHaveCount(0);
  await request.post(`/api/sessions/${parent}/interrupt`).catch(() => {});
});
