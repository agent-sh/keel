import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { openPanel, shoot } from "./shots.ts";

// Feature: the list and the panes stay the owner's to arrange. A second pane
// is never forced: a kept layout with an empty pane opens as one pane, and
// opening a session opens it in the pane worked in. A second pane opens when
// asked for: the row's "open beside" button (or Ctrl click), or a session
// dropped on a pane's edge. The agents a session started are folded under
// it to a count (a turning mark while one works) until they open them, and
// that choice is kept per session. One field filters the list by title or
// folder, and its menu groups (by folder or one list), sorts (recent, state,
// name) and hides finished sessions; the arrangement is kept. The side
// panel starts closed in every session and on load; one they opened in a
// session comes back with that session only. The pane's top line moves
// between state colours smoothly, and breathes while a turn works.
const MODEL = "scripted:stand-in";
// The spec's sessions run in a folder of their own: the list shows a folder's
// newest rows at rest and folds the others, so in a folder other work fills
// (the daemon's default one) the spec's own rows may not be in the page.
const ownFolder = (name: string) => {
  const dir = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `${name}-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1700, height: 980 } });

// What a test here started is stopped when it ends, passed or failed. A session that starts
// agents goes with them: one agent runs a 30 s command on, and its report starts the parent on
// another. The other sessions are interrupted: one of them runs the same command for the working
// line. A later spec that counts the running turns would see any of them.
const started: string[] = [];
let withAgents: string | undefined;
test.afterEach(async ({ request }) => {
  const parent = withAgents, mine = started.splice(0);
  withAgents = undefined;
  const sessions = (await (await request.get("/api/sessions?agents=all")).json()).sessions as { id: string; parent_id?: string | null }[];
  const family = parent ? [...sessions.filter((s) => s.parent_id === parent).map((s) => s.id), parent] : [];
  for (const id of mine) if (!family.includes(id)) await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
  for (const id of family) await request.delete(`/api/sessions/${id}`);
  const all = [...mine, ...family];
  await expect.poll(async () => (await (await request.get("/api/daemon")).json()).running.filter((id: string) => all.includes(id)), { timeout: 15_000 }).toEqual([]);
});

test("panes on request, agents folded, the list filtered and arranged", async ({ page, request }) => {
  const tag = Date.now().toString(36);
  const workspace = ownFolder("arrange");
  const mk = async (title: string, text = "Done.") => {
    const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title, workspace } })).json()).session;
    started.push(s.id);
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

  // Their kept layout: two panes, the second left empty. It opens as one pane.
  await page.addInitScript((id) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("keel.panes", JSON.stringify({ count: 2, slots: [id, null], sizes: {}, active: 1 }));
  }, a);
  await page.goto(`/s/${a}`);
  await expect(panes).toHaveCount(1);
  await expect(pane(0)).toHaveAttribute("data-station", a);
  await page.getByTestId("list-arrange").click();
  await expect(page.getByTestId("panes-1")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

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
  withAgents = parent;
  await request.put(`/api/sessions/${parent}/permissions`, { data: { mode: "full-auto" } });
  const spawn = (message: string) => ({ name: "spawn_agent", input: { message, isolation: "none" } });
  await request.post(`/api/sessions/${parent}/messages`, { data: { text: `script:batch ${JSON.stringify([spawn("script:long-tool"), spawn("Say ok.")])}` } });
  await page.goto(`/s/${b}`);
  const wrap = entry(parent).locator("xpath=..");
  const kids = wrap.getByTestId("session-children");
  const toggle = wrap.getByTestId("children-toggle");
  // The row has the chevron of its agents and says no number of them.
  await expect(toggle).toHaveAttribute("aria-expanded", "false", { timeout: 30_000 });
  await expect(kids.getByTestId("child-session")).toHaveCount(0);
  expect(await wrap.innerText()).not.toMatch(/\b\d+ agents?\b/);
  await shoot(page, "arrange-03-agents-folded");
  await toggle.click();
  await expect(kids.getByTestId("child-session")).toHaveCount(2);
  await shoot(page, "arrange-04-agents-open");
  await page.reload();
  await expect(kids.getByTestId("child-session")).toHaveCount(2); // their choice, kept
  await toggle.click();
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

  // The top line: a working turn breathes in the header's working line; the pane's top strip says no state.
  await request.put(`/api/sessions/${c}/permissions`, { data: { mode: "full-auto" } });
  await request.post(`/api/sessions/${c}/messages`, { data: { text: "script:long-tool" } });
  const band = pane(0).locator(".k-band");
  await expect(pane(0)).toHaveAttribute("data-watch", "work", { timeout: 15_000 });
  expect(await band.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  await expect(page.getByTestId("wake-line")).toBeVisible();
  await shoot(page, "arrange-09-working-line");
  await request.post(`/api/sessions/${c}/interrupt`, { data: { by: "owner" } });
  await expect(pane(0)).not.toHaveAttribute("data-watch", "work", { timeout: 15_000 });
  await request.post(`/api/sessions/${parent}/interrupt`, { data: { by: "owner" } }).catch(() => {});
});

// The archive tab asks the daemon for its list when it opens and when a
// session is archived, restored or deleted, not on every change of a
// session; an answer that a newer one overtook does not bring an old list back.
test("the archive list is read again only when the archive changed", async ({ page, request }) => {
  const tag = Date.now().toString(36);
  const workspace = ownFolder("archive");
  const mk = async (title: string) => (await (await request.post("/api/sessions", { data: { model: MODEL, title, workspace } })).json()).session.id as string;
  const patch = (id: string, data: unknown) => request.patch(`/api/sessions/${id}`, { data });
  const old = await mk(`Archived before the page ${tag}`);
  const next = await mk(`Archived while it is open ${tag}`);
  const later = await mk(`Archived a little later ${tag}`);
  const last = await mk(`Archived last ${tag}`);
  const busy = await mk(`Still worked on ${tag}`);
  const away = await mk(`Archived while the page was cut off ${tag}`);
  const stale = await mk(`Deleted while the page was cut off ${tag}`);
  await patch(old, { archived: true });
  await patch(stale, { archived: true });
  const made = [old, next, later, last, busy, away, stale];
  // The page's socket, to cut and to keep out for a while.
  let hold: Promise<void> | undefined;
  let cut: (() => void) | undefined;
  await page.routeWebSocket(/\/ws$/, async (ws) => {
    await hold;
    const server = ws.connectToServer();
    cut = () => { ws.close({ code: 4000, reason: "cut by the test" }); server.close({ code: 1000 }); };
  });
  try {
    // Every read of the archive, as the daemon answered it.
    let reads = 0;
    page.on("request", (r) => { if (r.method() === "GET" && /\/api\/sessions\?archived/.test(r.url())) reads++; });
    const list = page.getByTestId("session-list");
    const row = (id: string) => list.locator(`[data-testid="session-row"][data-session="${id}"]`);
    await page.goto(`/s/${busy}`);
    await page.getByTestId("tab-archived").click();
    await expect(row(old)).toBeVisible();
    await expect(row(next)).toHaveCount(0);
    expect(reads).toBe(1);

    // A turn and a rename of the session worked on, and a rename of another
    // active one: the page shows them, and the archive is not read again.
    await request.post(`/api/sessions/${busy}/messages`, { data: { text: "Say something." } });
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
    await patch(busy, { title: `Renamed while worked on ${tag}` });
    await patch(later, { title: `Renamed and not archived yet ${tag}` });
    await expect(page.getByTestId("session-title")).toHaveText(`Renamed while worked on ${tag}`);
    await page.getByTestId("tab-active").click();
    await expect(row(later)).toContainText(`Renamed and not archived yet ${tag}`);
    await page.getByTestId("tab-archived").click();
    await expect(row(old)).toBeVisible();
    expect(reads).toBe(2); // the tab opened again; nothing between

    // Archived: it joins the list. Renamed there: the list follows without a read.
    await patch(next, { archived: true });
    await expect(row(next)).toBeVisible();
    expect(reads).toBe(3);
    await patch(next, { title: `Renamed in the archive ${tag}` });
    await expect(row(next)).toContainText(`Renamed in the archive ${tag}`);
    expect(reads).toBe(3);
    await shoot(page, "sidebar-arrange-archive-list");

    // Two archived one after the other, the first answer held back: when it
    // lands after the second it does not take the newer session off the list.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let first = true;
    await page.route(/\/api\/sessions\?archived/, async (route) => {
      if (!first) return route.fallback();
      first = false;
      const answer = await route.fetch();
      await held;
      await route.fulfill({ response: answer });
    });
    await patch(later, { archived: true });
    await expect.poll(() => reads).toBe(4);
    await patch(last, { archived: true });
    await expect(row(last)).toBeVisible();
    await expect(row(later)).toBeVisible();
    release();
    await page.waitForTimeout(500);
    await expect(row(last)).toBeVisible();
    await page.unroute(/\/api\/sessions\?archived/);

    // Restored: it leaves the list. Deleted: gone from it too.
    await patch(old, { archived: false });
    await expect(row(old)).toHaveCount(0);
    await request.delete(`/api/sessions/${next}`);
    await expect(row(next)).toHaveCount(0);
    await expect(row(later)).toBeVisible();
    await expect(row(last)).toBeVisible();

    // Cut off: one session is archived and an archived one deleted, and no
    // frame of either reaches the page. Back, it reads the archive again.
    // (The page is loaded anew first: it then holds no archived row of its
    // own, whose loss to the list reload would be a change it sees.)
    await page.reload();
    await page.getByTestId("tab-archived").click();
    await expect(row(stale)).toBeVisible();
    await expect(row(last)).toBeVisible();
    let back!: () => void;
    hold = new Promise<void>((r) => (back = r));
    cut!();
    await expect(page.getByTestId("sync-state")).toHaveText("Reconnecting", { timeout: 10_000 });
    await patch(away, { archived: true });
    await request.delete(`/api/sessions/${stale}`);
    back();
    await expect(row(away)).toBeVisible({ timeout: 15_000 });
    await expect(row(stale)).toHaveCount(0);
    await expect(row(last)).toBeVisible();
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
  }
});
