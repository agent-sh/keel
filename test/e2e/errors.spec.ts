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
  for (let i = 1; i <= 3; i++) {
    await request.post("/api/errors", { data: { message: `${tag}: request ${i} timed out after ${i * 100} ms`, context: { url: `/s/${s.id}` } } });
  }

  await page.goto("/");
  await page.getByTestId("errors-button").click();
  const panel = page.getByTestId("errors-panel");
  const row = panel.getByTestId("error-row").filter({ hasText: tag });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("error-count")).toHaveText("3x");
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
  // The link is where it last happened, not where all three did.
  await expect(row.getByTestId("error-session")).toContainText("Last in Error tracker check");
  await shoot(page, "errors-01-open");

  // Mark read: out of the badge, still listed, hidden by Unread only; kept by the daemon.
  const badge = async () => Number((await page.getByTestId("errors-button").getAttribute("aria-label"))?.match(/^(\d+) unread/)?.[1] ?? 0);
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
  await again.getByTestId("error-session").click();
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

  // A link opened while the daemon cannot be reached (a phone's notification
  // on a cold page) says so, and opens its session once the connection is back.
  const s2 = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Opened while away" } })).json()).session;
  let blocked = true;
  await page.route(new RegExp(`/api/sessions/${s2.id}$`), (r) => (blocked ? r.abort("connectionrefused") : r.continue()));
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
    await compact("rate-limit-long", /asked to wait until \d\d:\d\d, longer than a turn waits; Continue after that/);
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
