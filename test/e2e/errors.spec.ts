import { expect, test } from "./isolate.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, openPanel, shoot } from "./shots.ts";

// Feature: the error tracker folds a failure that repeats into one row with a
// count, links it to the session it happened in, and a resolved kind leaves
// the Open list (and comes back if it happens again).
test("errors fold, link to their session and resolve", async ({ page, request }) => {
  const s = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Error tracker check" } })).json()).session;
  const tag = `e2e failure ${Date.now().toString(36)}`;
  for (let i = 1; i <= 3; i++) {
    await request.post("/api/errors", { data: { message: `${tag}: request ${i} timed out after ${i * 100} ms`, context: { url: `/s/${s.id}` } } });
  }

  await page.goto("/");
  await page.getByTestId("errors-button").click();
  const panel = page.getByTestId("errors-panel");
  const row = panel.getByTestId("error-row").filter({ hasText: tag });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("error-count")).toHaveText("3x");
  await row.locator("summary").click();
  // The link is where it last happened, not where all three did.
  await expect(row.getByTestId("error-session")).toContainText("Last in Error tracker check");
  await shoot(page, "errors-01-open");

  await row.getByTestId("error-resolve").click();
  await expect(panel.getByTestId("error-row").filter({ hasText: tag })).toHaveCount(0);
  await panel.getByRole("tab", { name: /Resolved/ }).click();
  await expect(panel.getByTestId("error-row").filter({ hasText: tag })).toHaveCount(1);
  await shoot(page, "errors-02-resolved");

  // It happens again: back on the Open list with the count going on.
  await request.post("/api/errors", { data: { message: `${tag}: request 9 timed out after 900 ms`, context: { url: `/s/${s.id}` } } });
  await panel.getByRole("tab", { name: /Open/ }).click();
  const again = panel.getByTestId("error-row").filter({ hasText: tag });
  await expect(again.getByTestId("error-count")).toHaveText("4x");

  await again.locator("summary").click();
  await again.getByTestId("error-session").click();
  await expect(page).toHaveURL(new RegExp(`/s/${s.id}`));

  // Resolve all resolves what was seen: a kind that happened again since
  // stays open and is named.
  const id = (await (await request.get("/api/errors?resolved=0")).json()).errors.find((e: any) => e.message.startsWith(tag)).id;
  await request.post("/api/errors", { data: { message: `${tag}: request 10 timed out after 1000 ms`, context: { url: `/s/${s.id}` } } });
  const stale = await (await request.post("/api/errors/resolve-all", { data: { seen: [{ id, count: 4 }] } })).json();
  expect(stale).toEqual({ resolved: 0, changed: [id] });
  expect((await (await request.post("/api/errors/resolve-all", { data: { seen: [{ id, count: 5 }] } })).json()).resolved).toBe(1);
  await request.delete(`/api/sessions/${s.id}`);
});

// A session deleted while the page was cut off, and a page that loaded while
// the daemon was down, are states the page settles quietly: the reconnect
// drops the session (the station says it is gone) and loads what failed, and
// nothing lands in the error table.
test("a reconnect after a deletion or a failed first load records no error", async ({ page, request }) => {
  const posted: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/errors") posted.push(r.postData() ?? ""); });
  const live: { ws?: import("@playwright/test").WebSocketRoute } = {};
  await page.routeWebSocket(/\/ws$/, (ws) => { ws.connectToServer(); live.ws = ws; });
  // The first model listing fails as a daemon restart would cut it.
  let listings = 0;
  await page.route(/\/api\/models(\?|$)/, (r) => (++listings === 1 ? r.abort("connectionrefused") : r.continue()));
  const s = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Deleted while away" } })).json()).session;
  await page.goto(`/s/${s.id}`);
  await expect(page.getByTestId("station-head").first()).toContainText("Deleted while away");
  await expect(page.getByTestId("permission-menu")).toBeVisible();
  // The listing is there after all: the socket's open loaded it again.
  await expect.poll(() => listings).toBeGreaterThanOrEqual(2);

  // Cut off, the session is deleted; the page hears of it only on reconnect.
  await live.ws!.close({ code: 4000, reason: "cut by the test" });
  await request.delete(`/api/sessions/${s.id}`);
  await expect(page.getByTestId("session-missing")).toBeVisible({ timeout: 15_000 });
  // Inside its station: the station's head and band, in steel.
  await expect(page.locator(".k-station[data-missing]").getByTestId("station-head")).toContainText("Not here");
  await shoot(page, "errors-03-deleted-while-away");
  await page.waitForTimeout(3_500); // a network failure is posted 3 s after it happened
  expect(posted).toEqual([]);
});

// A session whose folder was deleted reads as before and says the folder is
// gone, with the way on (move it); its permissions and its checkpoints still
// load, and nothing lands in the error table.
test("a session whose folder is gone is a state, not a failure", async ({ page, request }) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `gone-${Date.now().toString(36)}`);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "notes.txt"), "one\n");
  const s = (await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", workspace: ws, title: "Folder that goes away" } })).json()).session;
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "full-auto" } });
  const calls = [{ name: "Read", input: { file_path: join(ws, "notes.txt") } }, { name: "Write", input: { file_path: join(ws, "notes.txt"), content: "one\ntwo\n" } }];
  await request.post(`/api/sessions/${s.id}/messages`, { data: { text: `Add a line. script:calls ${JSON.stringify(calls)}` } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 30_000 }).toBe(true);
  const errorsBefore = (await (await request.get("/api/errors?resolved=0")).json()).errors.map((e: any) => `${e.id}:${e.count}`);
  const turns = (await (await request.get(`/api/sessions/${s.id}/checkpoints`)).json()).turns;
  const diffUrl = `/api/sessions/${s.id}/checkpoints/diff?turn=${turns[0].turn}`;
  const diffBefore = await (await request.get(diffUrl)).json();
  rmSync(ws, { recursive: true, force: true });

  expect((await request.get(`/api/sessions/${s.id}/permissions`)).status()).toBe(200);
  expect((await (await request.get(`/api/sessions/${s.id}`)).json()).session.workspace_gone).toBe(true);
  // What the checkpoints hold still reads with the folder gone.
  const diff = await request.get(diffUrl);
  expect(diff.status()).toBe(200);
  expect(await diff.json()).toEqual(diffBefore);
  const posted: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/errors") posted.push(r.postData() ?? ""); });
  await page.goto(`/s/${s.id}`);
  await expect(page.getByTestId("folder-gone")).toBeVisible();
  await expect(page.getByTestId("station-head").first()).toContainText("gone");
  await openPanel(page, "changes");
  await expect(page.getByTestId("side-panel")).toContainText("notes.txt");
  // Nothing to put files back into: the reverts are not offered, and say why.
  await expect(page.getByTestId("revert-gone")).toBeVisible();
  await expect(page.getByTestId("revert-all")).toHaveCount(0);
  await expect(page.getByTestId("revert-file")).toHaveCount(0);
  expect((await request.post(`/api/sessions/${s.id}/rewind`, { data: { turn: turns[0].turn } })).status()).toBe(409);
  await shoot(page, "errors-04-folder-gone");
  await page.getByTestId("folder-gone-move").click();
  await expect(page.getByTestId("move-session")).toBeVisible();
  expect(posted).toEqual([]);
  const after = (await (await request.get("/api/errors?resolved=0")).json()).errors.map((e: any) => `${e.id}:${e.count}`);
  expect(after.filter((x: string) => !errorsBefore.includes(x))).toEqual([]);
  await request.delete(`/api/sessions/${s.id}`);
});

// A failure is recorded once: an answer the daemon recorded itself (it names
// the record) is not posted again by the page; one it did not record is
// posted once.
test("a failure the daemon recorded is not recorded again by the page", async ({ page }) => {
  const posted: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/errors") posted.push(r.postData() ?? ""); });
  let recorded = true;
  await page.route(/\/api\/providers(\?|$)/, (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify(recorded ? { error: "listing exploded", error_id: "rec-1" } : { error: "listing exploded" }) }));
  await page.goto("/settings/providers");
  await expect(page.getByTestId("providers-panel")).toBeVisible();
  await page.waitForTimeout(800);
  expect(posted.filter((p) => p.includes("listing exploded"))).toEqual([]);
  recorded = false;
  await page.reload();
  await expect.poll(() => posted.filter((p) => p.includes("listing exploded")).length).toBe(1);
  await page.waitForTimeout(800);
  expect(posted.filter((p) => p.includes("listing exploded")).length).toBe(1);
  await page.unroute(/\/api\/providers(\?|$)/);
});
