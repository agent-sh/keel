import { expect, test } from "./isolate.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, openPanel, shoot } from "./shots.ts";
import type { ErrorRecord } from "../../src/core/types.ts";

// Feature: the error tracker folds a failure that repeats into one row with a
// count, links it to the session it happened in, and a resolved kind leaves
// the Open list (and comes back if it happens again). A kind marked read
// stays on the list but leaves the badge, across a reload; happening again
// makes it unread.
test("errors fold, link to their session and resolve", async ({ page, request }) => {
  const s = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Error tracker check" } })).json()).session;
  const tag = `e2e failure ${Date.now().toString(36)}`;
  // (Two other failures beside it: under three open errors the panel is a popover without the Unread filter.)
  for (const other of ["first", "second"]) await request.post("/api/errors", { data: { message: `filler ${other} kind of thing broke before the check` } });
  for (let i = 1; i <= 3; i++) {
    await request.post("/api/errors", { data: { message: `${tag}: request ${i} timed out after ${i * 100} ms`, context: { url: `/s/${s.id}` } } });
  }

  await page.goto("/");
  await page.getByTestId("errors-button").click();
  const panel = page.getByTestId("errors-panel");
  const row = panel.getByTestId("error-row").filter({ hasText: tag });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("error-count")).toHaveText("3x");
  // One age a row, no clock beside it; the time itself is its tooltip.
  await expect(row.getByTestId("error-time")).toHaveText(/^now$/);
  await expect(row.getByTestId("error-time")).toHaveAttribute("title", /\d\d:\d\d/);
  // The row says it opens: a marker in a token color, turned once it has.
  const marker = row.getByTestId("error-marker");
  const isOpen = () => row.evaluate((d) => (d as HTMLDetailsElement).open);
  const turned = () => marker.evaluate((m) => getComputedStyle(m).rotate);
  await expect(marker).toBeVisible();
  expect(await isOpen()).toBe(false);
  expect(await turned()).toBe("none");
  expect(await marker.evaluate((m) => { const probe = Object.assign(document.createElement("i"), { className: "text-faint" }); m.parentElement!.append(probe); const same = getComputedStyle(m).color === getComputedStyle(probe).color; probe.remove(); return same; })).toBe(true);
  await row.locator("summary").click();
  expect(await isOpen()).toBe(true);
  await expect.poll(turned).toBe("90deg");
  // Each session it happened in, with that session's own count: all three were in this one.
  await expect(row.getByTestId("error-site")).toHaveCount(1);
  await expect(row.getByTestId("error-site")).toContainText("Error tracker check");
  await expect(row.getByTestId("error-site-count")).toHaveText("3x");
  await shoot(page, "errors-01-open");

  // Mark read: out of the badge, still listed, hidden by Unread only; kept by the daemon.
  const badge = async () => Number((await page.getByTestId("errors-button").getAttribute("aria-label"))?.match(/(\d+) errors? in Keel you have not looked at/)?.[1] ?? 0);
  const before = await badge();
  await row.getByTestId("error-read").click();
  await expect(row).toHaveAttribute("data-read", "1");
  await expect.poll(badge).toBe(before - 1);
  // Marking read is not opening: the row stays as it was, and so does its marker.
  expect(await isOpen()).toBe(true);
  expect(await turned()).toBe("90deg");
  await panel.getByTestId("errors-unread-only").check();
  await expect(panel.getByTestId("error-row").filter({ hasText: tag })).toHaveCount(0);
  await panel.getByTestId("errors-unread-only").uncheck();
  await page.reload();
  await page.getByTestId("errors-button").click();
  await expect(row).toHaveAttribute("data-read", "1");
  await expect.poll(badge).toBe(before - 1);
  // A closed row stays closed when its read state is changed, either way.
  expect(await isOpen()).toBe(false);
  await row.getByTestId("error-read").click();
  await expect(row).not.toHaveAttribute("data-read", "1");
  await row.getByTestId("error-read").click();
  await expect(row).toHaveAttribute("data-read", "1");
  expect(await isOpen()).toBe(false);
  expect(await turned()).toBe("none");
  await expect.poll(badge).toBe(before - 1);
  await shoot(page, "errors-01b-read");
  // It happens again: unread, in the badge again.
  await request.post("/api/errors", { data: { message: `${tag}: request 4 timed out after 400 ms`, context: { url: `/s/${s.id}` } } });
  await expect(row).not.toHaveAttribute("data-read", "1");
  await expect(row.getByTestId("error-count")).toHaveText("4x");
  await expect.poll(badge).toBe(before);
  // Mark all read clears the badge.
  await panel.getByTestId("errors-read-all").click();
  await expect.poll(badge).toBe(0);
  await expect(row).toHaveAttribute("data-read", "1");
  await row.locator("summary").click();

  await row.getByTestId("error-resolve").click();
  await expect(panel.getByTestId("error-row").filter({ hasText: tag })).toHaveCount(0);
  await panel.getByRole("tab", { name: /Resolved/ }).click();
  await expect(panel.getByTestId("error-row").filter({ hasText: tag })).toHaveCount(1);
  await shoot(page, "errors-02-resolved");

  // It happens again: back on the Open list with the count going on.
  await request.post("/api/errors", { data: { message: `${tag}: request 9 timed out after 900 ms`, context: { url: `/s/${s.id}` } } });
  await panel.getByRole("tab", { name: /Open/ }).click();
  const again = panel.getByTestId("error-row").filter({ hasText: tag });
  await expect(again.getByTestId("error-count")).toHaveText("5x");

  await again.locator("summary").click();
  await again.getByTestId("error-site-open").click();
  await expect(page).toHaveURL(new RegExp(`/s/${s.id}`));

  // Resolve all resolves what was seen: a kind that happened again since
  // stays open and is named.
  const id = (await (await request.get("/api/errors?resolved=0")).json()).errors.find((e: any) => e.message.startsWith(tag)).id;
  await request.post("/api/errors", { data: { message: `${tag}: request 10 timed out after 1000 ms`, context: { url: `/s/${s.id}` } } });
  const stale = await (await request.post("/api/errors/resolve-all", { data: { seen: [{ id, count: 5 }] } })).json();
  expect(stale).toEqual({ resolved: 0, changed: [id] });
  expect((await (await request.post("/api/errors/resolve-all", { data: { seen: [{ id, count: 6 }] } })).json()).resolved).toBe(1);
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
  // (The box is drawn: on a desk its mode and model are behind its +.)
  await expect(page.getByTestId("composer-box").getByTestId("box-more")).toBeVisible();
  // The listing is there after all: the socket's open loaded it again.
  await expect.poll(() => listings).toBeGreaterThanOrEqual(2);

  // Cut off, the session is deleted; the page hears of it only on reconnect.
  await live.ws!.close({ code: 4000, reason: "cut by the test" });
  await request.delete(`/api/sessions/${s.id}`);
  await expect(page.getByTestId("session-missing")).toBeVisible({ timeout: 15_000 });
  // Inside its station: the station's head and band, in steel.
  await expect(page.locator(".k-station[data-missing]").getByTestId("station-head")).toContainText("Not here");
  await shoot(page, "errors-03-deleted-while-away");

  // A link opened while the daemon cannot be reached (a phone's notification
  // on a cold page) says so, and opens its session once the connection is back.
  const s2 = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Opened while away" } })).json()).session;
  let blocked = true;
  // (The session's first read names the part it wants: /api/sessions/<id>?page=N.)
  await page.route(new RegExp(`/api/sessions/${s2.id}(\\?|$)`), (r) => (blocked ? r.abort("connectionrefused") : r.continue()));
  await page.goto(`/s/${s2.id}`);
  await expect(page.getByTestId("session-unreached").first()).toBeVisible({ timeout: 15_000 });
  await shoot(page, "errors-04-opened-while-away");
  blocked = false;
  await live.ws!.close({ code: 4000, reason: "cut by the test" });
  await expect(page.getByTestId("station-head").first()).toContainText("Opened while away", { timeout: 15_000 });

  // A side panel reads its session again on a reconnect too, and finds it deleted.
  await openPanel(page, "changes");
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "changes");
  await live.ws!.close({ code: 4000, reason: "cut by the test" });
  await request.delete(`/api/sessions/${s2.id}`);
  await expect(page.getByTestId("session-missing")).toBeVisible({ timeout: 15_000 });
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
  // (The turn's closing snapshot is recorded a moment after its end is visible: the diff is read once it is whole.)
  let diffBefore: any;
  await expect.poll(async () => !!(diffBefore = await (await request.get(diffUrl)).json()).incomplete, { timeout: 15_000 }).toBe(false);
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
  await expect(page.getByTestId("station-head").first().locator(".k-gone"), "the head does not show the folder is gone").toBeVisible();
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

test("manual compaction is tracked once and archived refusals stay visible", async ({ page, request }) => {
  const base = "/api/sessions";
  const created = await request.post(base, { data: { model: "scripted:stand-in", title: "Error catch fixture" } });
  expect(created.ok()).toBe(true);
  const { session: s } = await created.json();
  const path = `${base}/${s.id}`;
  const errors = async () => (await (await request.get("/api/errors")).json()).errors as ErrorRecord[];
  const baseline = new Map((await errors()).map((e) => [e.id, e.count ?? 1]));
  const occurrences = async () => (await errors()).filter((e) => e.session_id === s.id).map((e) => ({
    ...e, count: (e.count ?? 1) - (baseline.get(e.id) ?? 0),
  }));
  const posted: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/errors") posted.push(r.postDataJSON().message); });
  try {
    expect((await request.post(`${path}/messages`, { data: { text: "A fixture prompt" } })).ok()).toBe(true);
    await expect.poll(async () => (await (await request.get(path)).json()).events.some((e: any) => e.kind === "turn_end")).toBe(true);
    await page.goto(`/s/${s.id}`);
    const composer = page.getByTestId("composer");
    const notice = page.getByTestId("composer-notice");
    const mime = "Scripted: HTTP 400: fixture image MIME type rejected";
    const compact = async (scenario: string, message: string | RegExp) => {
      const command = `/compact script:${scenario}`;
      await composer.fill(command);
      const compacted = page.waitForResponse((r) => new URL(r.url()).pathname === `${path}/compact` && r.request().method() === "POST", { timeout: 5000 });
      await composer.press("Enter");
      const refusal = await compacted;
      expect(refusal.status()).toBe(502);
      await expect(notice).toHaveText(message);
      await expect(composer).toHaveValue(command);
      const { error_id } = await refusal.json();
      expect(typeof error_id).toBe("string");
      expect((await occurrences()).find((e) => e.id === error_id)).toMatchObject({
        source: "provider", message: typeof message === "string" ? message : expect.stringMatching(message), count: 1,
      });
    };
    await compact("compact-error", mime);
    // A 15-minute retry-after must come back immediately with the wait guidance.
    await compact("rate-limit-long", /asked to wait until \d\d:\d\d UTC([+-]\d\d:\d\d)?, longer than a turn waits; resume after that/);
    expect(await occurrences()).toHaveLength(2);
    expect(posted).toEqual([]);

    // Not every conflict is an expected archive refusal.
    const other = "fixture unexpected session conflict";
    await page.route(`${path}/messages`, (r) => r.fulfill({ status: 409, json: { error: other } }), { times: 1 });
    await page.getByTestId("retry").click();
    await expect.poll(async () => (await occurrences()).find((e) => e.source === "client")).toMatchObject({ message: other, count: 1 });
    expect(posted).toEqual([other]);

    // Archiving stops the current turn and holds its queue. Neither of the
    // two queue controls can send it on an archived session.
    expect((await request.post(`${path}/messages`, { data: { text: "script:slow" } })).ok()).toBe(true);
    expect((await request.post(`${path}/messages`, { data: { text: "A queued prompt", mode: "queue" } })).ok()).toBe(true);
    expect((await request.patch(path, { data: { archived: true } })).ok()).toBe(true);
    const resumed = page.waitForResponse((r) => new URL(r.url()).pathname === `${path}/queue/resume`);
    await page.getByTestId("queue-held").getByRole("button", { name: "Resume" }).click();
    expect((await resumed).status()).toBe(409);
    await expect(notice).toHaveText("Restore this session before working in it again.");
    await expect(composer).toHaveValue("/compact script:rate-limit-long");
    await expect(page.getByTestId("archived-refusal")).toHaveCount(0);
    await shoot(page, "errors-05-archived-refusal");

    // The actual queue Send Now refusal reaches the browser after its
    // composer unmounts. It still has a place to be shown.
    const fetched = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    await page.route(new RegExp(`${path}/queue/[^/]+/send$`), async (r) => {
      const response = await r.fetch();
      fetched.resolve(response.status());
      await release.promise;
      await r.fulfill({ response });
    }, { times: 1 });
    try {
      await page.getByTestId("queue-send-now").click();
      expect(await fetched.promise).toBe(409);
      await page.getByTestId("settings-button").click();
      await expect(composer).toHaveCount(0);
    } finally {
      release.resolve();
    }
    await expect(page.getByTestId("archived-refusal")).toHaveText("Action not taken: restore the archived session first.");
    await shoot(page, "errors-06-archived-fallback");
    expect(await occurrences()).toHaveLength(3);
    expect(posted).toEqual([other]);
  } finally {
    await request.delete(path);
  }
});

// A failure the store could not take (its disk is full, or it takes no writes) is kept by the daemon in
// memory and leads the list all the same. The panel shows it as a row like the others and says that it
// is not saved yet. (The daemon's list is the real one; the kept row is put in front of it here, since a
// spec cannot fill the daemon's disk.)
test("a failure the store could not take is listed, and the panel says it is only in memory", async ({ page }) => {
  const kept: ErrorRecord = { id: "unwritten-1", ts: Date.now() - 4000, first_ts: Date.now() - 9000, count: 3, source: "server", message: "the store's disk is full: a prompt could not be stored", unwritten: "database or disk is full" };
  await page.route(/\/api\/errors(\?|$)/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const answer = await route.fetch();
    const body = await answer.json();
    await route.fulfill({ response: answer, json: { ...body, errors: [kept, ...body.errors] } });
  });
  await page.goto("/");
  await page.getByTestId("errors-button").click();
  const row = page.getByTestId("errors-panel").getByTestId("error-row").filter({ hasText: "the store's disk is full" });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("error-count")).toHaveText("3x");
  await row.locator("summary").click();
  await expect(row.getByTestId("error-unwritten")).toContainText("Kept in memory: the store did not take this row (database or disk is full)");
  await shoot(page, "errors-07-kept-in-memory");
  // A row the store took has no such line.
  await page.getByTestId("errors-panel").getByTestId("error-row").filter({ hasNotText: "the store's disk is full" }).first().locator("summary").click().catch(() => {});
  await expect(page.getByTestId("error-unwritten")).toHaveCount(1);
});

// A row offers what fits its failure on the row itself, folded or not. A
// provider's failure gets the acts of its session's own failure box: the page
// that fixes it (Open billing for a refused billing) and, while the session is
// stopped on it, Try again and another model. Fix this, which hands the bundle
// to an agent, goes only where an agent could fix the cause. The raw context
// and stack fold under Details. The scripted provider plays the refused billing
// (a 402), the same every run.
test("a row offers the acts that fit its failure, and Fix this only where an agent can fix it", async ({ page, request }) => {
  const STAND_IN = "scripted:stand-in";
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "needs the scripted provider (KEEL_SCRIPTED_PROVIDER=1): a refused billing the same every run");
  const tag = Date.now().toString(36);
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: `Nightly report ${tag}` } })).json();
  const broken = `e2e acts ${tag}: TypeError: the plan is undefined`;
  try {
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "Write the nightly report.\nscript:billing" } });
    const stopped = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.settings.failed_ms ?? 0;
    await expect.poll(stopped, { timeout: 20_000 }).toBeGreaterThan(0);
    await request.post("/api/errors", { data: { message: broken } });

    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto("/");
    // The keys the owner uses, counted: the panel, then the act.
    await page.keyboard.press("Alt+r");
    const panel = page.getByTestId("errors-panel");
    const row = panel.getByTestId("error-row").filter({ hasText: "credit balance is too low" }).first();
    const isOpen = () => row.evaluate((d) => (d as HTMLDetailsElement).open);
    const acts = row.getByTestId("error-acts");
    // Folded, the row carries the failure box's acts, and no Fix this: the account's credit is not an agent's to mend.
    await expect(acts.getByTestId("failure-fix")).toHaveText("Open billing");
    await expect(acts.getByTestId("failure-fix")).toHaveAttribute("href", "https://example.com/billing");
    await expect(acts.getByTestId("failure-fix")).toHaveAttribute("target", "_blank");
    await expect(acts.getByTestId("try-again")).toBeVisible();
    await expect(acts.getByTestId("failure-switch")).toHaveText("Switch model");
    await expect(row.getByTestId("error-fix")).toHaveCount(0);
    expect(await isOpen()).toBe(false);
    // One primary action a row: Open billing has the fill, Try again and Switch model are text. The row names its
    // session (a link) and its model; the link opens the session.
    const filled = (loc: import("@playwright/test").Locator) => loc.evaluate((el) => [...el.querySelectorAll<HTMLElement>("a, button")].filter((b) => { const c = getComputedStyle(b).backgroundColor; return c !== "rgba(0, 0, 0, 0)" && c !== "transparent"; }).map((b) => b.dataset.testid));
    await page.mouse.move(0, 0);
    expect(await filled(acts)).toEqual(["failure-fix"]);
    // The session and the model are the row's tooltip, not a line of it.
    await expect(row.getByTestId("error-head")).toHaveAttribute("title", new RegExp(`^in Nightly report ${tag} · \\S`));
    await expect(row.getByTestId("error-where")).toBeHidden();
    // And the folded line names the session, so the owner need not open the row or hover it to know which failed.
    await expect(row.getByTestId("error-in")).toHaveText(`in Nightly report ${tag}`);
    // The message has the width: at least half of the folded line, and where it came from is said once the row is open.
    await expect(row.getByTestId("error-source")).toBeHidden();
    {
      const msg = (await row.getByTestId("error-message").boundingBox())!, head = (await row.getByTestId("error-head").boundingBox())!;
      expect(msg.width / head.width, "the message takes half the line or more").toBeGreaterThanOrEqual(0.5);
    }
    // The acts show on the row when it is hovered or a key is in it, and are in the tab order meanwhile.
    const shown = () => acts.evaluate((el) => getComputedStyle(el).opacity);
    expect(await shown()).toBe("0");
    await row.hover();
    await expect.poll(shown).toBe("1");
    await shoot(page, "errors-acts-00-hover");
    await page.mouse.move(0, 0);
    await expect.poll(shown).toBe("0");
    await acts.getByTestId("try-again").focus();
    await expect.poll(shown).toBe("1");
    await acts.getByTestId("try-again").blur();
    await page.mouse.move(0, 0);
    // A failure of the page's own code is an agent's to fix: Fix this on its row, folded.
    const own = panel.getByTestId("error-row").filter({ hasText: broken });
    await expect(own.getByTestId("error-fix")).toBeVisible();
    await expect(own.getByTestId("failure-fix")).toHaveCount(0);
    // Fix this is text: a row with no page to fix it has no dark button.
    expect(await filled(own.getByTestId("error-acts"))).toEqual([]);
    await shoot(page, "errors-acts-01-rows");

    // Unfolded: the stack is not shown until Details is pressed.
    await row.getByTestId("error-marker").click();
    expect(await isOpen()).toBe(true);
    await expect(row.getByTestId("error-sites")).toBeVisible();
    await expect(row.getByTestId("error-stack")).toHaveCount(0);
    await row.getByTestId("error-details").click();
    await expect(row.getByTestId("error-details")).toHaveAttribute("aria-expanded", "true");
    await expect(row.getByTestId("error-stack")).toContainText('"status": 402');
    await expect(row.getByTestId("error-stack")).toContainText("credit balance is too low");
    await shoot(page, "errors-acts-02-details");
    await row.getByTestId("error-details").click();
    await row.getByTestId("error-marker").click();

    // On a phone a folded row is one line: its acts and where it happened come with the row opened, and wrap inside the
    // panel; nothing runs off its side.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(acts.getByTestId("try-again")).toBeHidden();
    await expect(row.getByTestId("error-where")).toBeHidden();
    await row.getByTestId("error-marker").click();
    await expect(acts.getByTestId("try-again")).toBeInViewport();
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await expect(row.getByTestId("error-where")).toBeVisible();
    await shoot(page, "errors-acts-03-narrow-open");
    await row.getByTestId("error-marker").click();
    await expect(row.getByTestId("error-where")).toBeHidden();
    await shoot(page, "errors-acts-03-narrow");
    await page.setViewportSize({ width: 1920, height: 1040 });

    // Another model, from the row: the session takes the request again on it, and the row then
    // offers only the page (the session is no longer stopped on this failure).
    await acts.getByTestId("failure-switch").click();
    const pick = acts.getByTestId("failure-models");
    await pick.getByTestId("model-picker").click();
    await page.getByPlaceholder("Search models").fill("Scripted backup");
    await page.getByRole("option", { name: /Scripted backup/ }).first().click();
    await pick.getByRole("button", { name: "Try on it" }).click();
    const confirm = page.getByTestId("confirm").getByRole("button", { name: "Switch" });
    const answered = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "assistant").flatMap((e: any) => e.data.blocks).map((b: any) => b.text ?? "").join(" ");
    await Promise.race([confirm.click(), expect.poll(answered, { timeout: 30_000 }).toContain("The backup model took the request.")]).catch(() => {});
    await expect.poll(answered, { timeout: 30_000 }).toContain("The backup model took the request.");
    expect((await (await request.get(`/api/sessions/${session.id}`)).json()).session.model).toBe("scripted:stand-in-backup");
    await expect(acts.getByTestId("try-again")).toHaveCount(0);
    await expect(acts.getByTestId("failure-fix")).toHaveText("Open billing");
    await shoot(page, "errors-acts-04-after-switch");
  } finally {
    await request.delete(`/api/sessions/${session.id}`);
    const left = (await (await request.get("/api/errors?resolved=0")).json()).errors.filter((e: any) => e.message === broken);
    for (const e of left) await request.patch(`/api/errors/${e.id}`, { data: { resolved: true } }).catch(() => {});
  }
});

// Feature: a few open errors are a popover by the corner they are reached from, not a drawer of the page's height:
// under three open errors the panel is as tall as its rows, the tabs that hold nothing are not drawn (so no strip
// with one tab), and the row names the session it happened in. Three open errors make it the drawer again, with its
// note and its filter.
test("under three open errors the panel is a popover with no empty tabs", async ({ page, request }) => {
  const tag = Date.now().toString(36);
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: `Popover check ${tag}` } })).json();
  const open = async () => (await (await request.get("/api/errors?resolved=0")).json()).errors as ErrorRecord[];
  // (This daemon's earlier errors are marked resolved first: the panel's mode is a function of what is open.)
  const resolveAll = async () => { const list = await open(); if (list.length) await request.post("/api/errors/resolve-all", { data: { seen: list.map((e) => ({ id: e.id, count: e.count ?? 1 })) } }); };
  try {
    await resolveAll();
    await request.post("/api/errors", { data: { message: `popover one ${tag}: the first thing broke`, context: { url: `/s/${session.id}` } } });
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto("/");
    await page.getByTestId("errors-button").click();
    const panel = page.getByTestId("errors-panel");
    await expect(panel).toHaveAttribute("data-mode", "popover");
    await expect(panel.getByTestId("error-row")).toHaveCount(1);
    // A tab that holds nothing is not drawn (Recovered and Resolved show only when the daemon has some); the panel is
    // as tall as its row, not the page.
    const held = async (state: "recovered" | "resolved") => ((await (await request.get("/api/errors")).json()).errors as ErrorRecord[]).filter((e) => (state === "resolved" ? !!e.resolved_ts : !e.resolved_ts && !!e.recovered_ts)).length;
    const tabs = async () => { for (const state of ["recovered", "resolved"] as const) await expect(panel.getByRole("tab", { name: new RegExp(state, "i") })).toHaveCount((await held(state)) > 0 ? 1 : 0); };
    await tabs();
    await expect(panel.getByTestId("errors-note")).toHaveCount(0);
    expect((await panel.boundingBox())!.height).toBeLessThan(300);
    // It stands by the corner of the Errors button, above it.
    const at = (await panel.boundingBox())!, from = (await page.getByTestId("errors-button").boundingBox())!;
    expect(at.x).toBeLessThan(from.x + from.width);
    expect(at.y + at.height).toBeLessThanOrEqual(from.y);
    // The row names its session in its tooltip, and opens a link to it.
    await expect(panel.getByTestId("error-head")).toHaveAttribute("title", new RegExp(`^in Popover check ${tag}`));
    // It stands clear of the label that opened it: a gap, not touching.
    expect(from.y - (at.y + at.height), "the popover is above the Errors button with a gap").toBeGreaterThanOrEqual(4);
    await page.mouse.move(0, 0);
    await shoot(page, "errors-popover-01-one");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel).toBeInViewport();
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await shoot(page, "errors-popover-02-phone");
    await page.setViewportSize({ width: 1920, height: 1040 });
    await panel.getByTestId("error-row").locator("summary").click();
    await panel.getByTestId("error-resolve").click();
    await expect(panel.getByTestId("error-row")).toHaveCount(0);
    await tabs();
    await request.post("/api/errors", { data: { message: `popover two ${tag}: the second thing broke`, context: { url: `/s/${session.id}` } } });
    await request.post("/api/errors", { data: { message: `popover three ${tag}: a third thing broke`, context: { url: `/s/${session.id}` } } });
    await request.post("/api/errors", { data: { message: `popover four ${tag}: and a fourth one broke`, context: { url: `/s/${session.id}` } } });
    await expect(panel.getByTestId("error-row")).toHaveCount(3);
    await expect(panel).toHaveAttribute("data-mode", "drawer");
    await tabs();
    await expect(panel.getByTestId("errors-note")).toBeVisible();
    await shoot(page, "errors-popover-03-three");
    // The session link opens the session.
    await panel.getByTestId("error-row").first().locator("summary").click();
    await panel.getByTestId("error-site-open").first().click();
    await expect(page).toHaveURL(new RegExp(`/s/${session.id}`));
  } finally {
    await request.delete(`/api/sessions/${session.id}`);
    await resolveAll().catch(() => {});
  }
});
