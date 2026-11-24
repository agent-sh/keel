import { expect, test, type Locator, type Page } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { daemon, exited, ROOT, seeded, sessionsFolder, specEnv } from "./own-daemon.ts";
import { shoot } from "./shots.ts";

// Feature: a long session costs what its end costs. Rows of finished turns are
// made and rendered once: a reply that streams below them, and the events it
// stores, leave them alone. The page holds the session in parts: it opens with
// the newest events of its branch and reads older ones, another branch or the
// part around an event when the reader goes there.

// A press of Enter on a control that may leave the page meanwhile (the button
// for earlier messages goes when the last part is in): not waited on then.
const pressIfThere = async (page: Page, target: Locator) => {
  if (await target.focus({ timeout: 1500 }).then(() => true, () => false)) await page.keyboard.press("Enter");
};

// What the page downloads of a session's history: the snapshot and each part asked for after it.
type Part = { url: string; events: number; bytes: number };
function parts(page: Page, id: string) {
  const got: Part[] = [];
  page.on("response", async (r) => {
    const u = new URL(r.url());
    if (r.request().method() !== "GET" || ![`/api/sessions/${id}`, `/api/sessions/${id}/page`, `/api/sessions/${id}/events`].includes(u.pathname)) return;
    const body = await r.text().catch(() => "");
    let events = -1;
    try { events = JSON.parse(body).events?.length ?? -1; } catch {}
    got.push({ url: u.pathname.replace(`/api/sessions/${id}`, "") + u.search, events, bytes: body.length });
  });
  return got;
}

test("a reply under a long transcript renders only its own rows", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const EVENTS = 2000;
  const { state, ids: [id] } = seeded("rows", EVENTS, "turns", "Two thousand events");
  // A development build of the page: it has the row counters.
  const d = await daemon(state, 0, true);
  try {
    const stored = async () => ((await (await fetch(`${d.url}/api/sessions/${id}/events`)).json()) as any).events as { id: string; kind: string; data: any }[];
    const before = await stored();
    const prompts = before.filter((e) => e.kind === "user").length;
    await page.goto(`${d.url}/s/${id}`);
    await expect(page.getByTestId("compacted")).toBeVisible({ timeout: 30_000 });
    // The page opened with the newest part: its prompts are on it, not the session's.
    const part = ((await (await fetch(`${d.url}/api/sessions/${id}?page=200`)).json()) as any).events as { kind: string; data: any }[];
    // (A prompt far from the view is held, not drawn: lib/window.ts. It is on the page all the same.)
    const shown = () => page.locator('[data-testid="transcript"] :is([data-testid="user-message"], .k-hold [data-kind="user"])').count();
    const opened = part.filter((e) => e.kind === "user" && !e.data.origin).length;
    expect(opened).toBeGreaterThan(20);
    expect(opened).toBeLessThan(prompts - 3);
    await expect.poll(shown).toBe(opened);

    // From here on: every row model made and every row rendered, by event id.
    const count = () => page.evaluate(() => {
      const w = window as any;
      w.__made = []; w.__rendered = [];
      w.__keelRows.made = (id: string) => w.__made.push(id);
      w.__keelRows.rendered = (id: string) => w.__rendered.push(id);
    });
    const counted = () => page.evaluate(() => ({ made: (window as any).__made as string[], rendered: (window as any).__rendered as string[] }));
    const reqs: string[] = [];
    page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith(`/api/sessions/${id}`)) reqs.push(u.pathname.replace(`/api/sessions/${id}`, "") + u.search); });
    await count();
    await page.getByTestId("composer").fill("script:render");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("draft")).toBeVisible({ timeout: 15_000 });
    await shoot(page, "long-transcript-01-streaming");
    await expect.poll(async () => ((await (await fetch(`${d.url}/api/sessions/${id}?events=0`)).json()) as any).running, { timeout: 60_000 }).toBe(false);
    await expect(page.getByTestId("working")).toHaveCount(0, { timeout: 30_000 });

    let after = await stored();
    const fresh = new Set(after.slice(before.length).map((e) => e.id));
    expect(fresh.size).toBeGreaterThanOrEqual(4);
    const first = await counted();
    // Nothing of the history was read for the page's own prompt.
    expect(reqs.filter((r) => r.includes("/page"))).toEqual([]);
    // Rows were made and rendered for the turn's events only. The footer that
    // stopped being the last one changed by itself: its Answer again went.
    expect(first.made.length).toBeGreaterThan(0);
    expect(first.made.filter((x) => !fresh.has(x))).toEqual([]);
    expect(first.rendered.filter((x) => fresh.has(x)).length).toBeGreaterThan(0);
    expect([...new Set(first.rendered.filter((x) => !fresh.has(x)))]).toEqual([]);
    await expect(page.getByTestId("retry")).toHaveCount(1);

    // An earlier part is read in above (the rows already there are not rendered
    // for it), and a finished turn's footer copies its reply.
    // (The rows drawn: a held block's rows are drawn when the view comes to them.)
    const onPage = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="transcript"] [data-event-id]')].filter((x) => !x.closest(".k-hold")).map((x) => x.dataset.eventId!));
    const there = new Set(await onPage());
    await count();
    await page.getByTestId("load-earlier").click();
    await expect.poll(shown, { timeout: 30_000 }).toBeGreaterThan(opened + 1);
    const more = await shown();
    const above = await counted();
    expect(above.rendered.length).toBeGreaterThan(0);
    expect([...new Set(above.rendered.filter((x) => there.has(x)))]).toEqual([]);
    await page.getByTestId("copy-reply").nth(4).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toMatch(/Looking at \*\*step \d+\*\*\./);
    expect(clip).toMatch(/Reply \d+ ends here\./);

    // Back at the end, what a pane that follows it holds is bounded: the next
    // reply's first event lets the oldest part go. The rows that stay are not
    // rendered again for it.
    await page.getByTestId("jump-latest").click();
    await expect(page.getByTestId("turn-end").last()).toBeInViewport();
    await expect(page.getByTestId("jump-latest")).toHaveCount(0);
    await count();
    const kept = after.map((e) => e.id);
    await page.getByTestId("composer").fill("script:render");
    await page.getByTestId("composer").press("Enter");
    await expect.poll(async () => (await stored()).length, { timeout: 30_000 }).toBeGreaterThan(after.length);
    await expect.poll(async () => ((await (await fetch(`${d.url}/api/sessions/${id}?events=0`)).json()) as any).running, { timeout: 60_000 }).toBe(false);
    await expect(page.getByTestId("working")).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(shown, { timeout: 30_000 }).toBeLessThan(more);
    await expect(page.getByTestId("load-earlier")).toBeVisible();
    after = await stored();
    const second = new Set(after.filter((e) => !kept.includes(e.id)).map((e) => e.id));
    expect(second.size).toBeGreaterThanOrEqual(4);
    const trimmed = await counted();
    expect([...new Set(trimmed.rendered.filter((x) => !second.has(x)))]).toEqual([]);
    await expect(page.getByTestId("turn-end").last()).toBeInViewport();
    await shoot(page, "long-transcript-02-after-reply");

    // Previous prompt from the message box says its place in the whole branch, not in the part held.
    await page.getByTestId("composer").focus();
    await page.keyboard.press("Alt+ArrowUp");
    await expect(page.getByTestId("prompt-place")).toHaveText(`Prompt ${prompts - 3 + 2} of ${prompts - 3 + 2}`);
  } finally {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    rmSync(state, { recursive: true, force: true });
  }
});

test("a long session opens with its newest part and reads the rest as asked", async ({ page }) => {
  const EVENTS = 3000;
  const { state, ids: [id] } = seeded("paged", EVENTS, "turns", "Three thousand events");
  const d = await daemon(state);
  try {
    const all = ((await (await fetch(`${d.url}/api/sessions/${id}/events`)).json()) as any).events as { id: string; seq: number; kind: string; parent: string | null; data: any }[];
    const session = async () => ((await (await fetch(`${d.url}/api/sessions/${id}?events=0`)).json()) as any).session as { head: string };
    let main = (await session()).head;
    const got = parts(page, id!);
    const sockets: number[] = [];
    page.on("websocket", (ws) => ws.on("framereceived", ({ payload }) => { const f = JSON.parse(String(payload)); if (f.t === "event" && f.event.session_id === id) sockets.push(f.event.seq); }));
    const held = () => page.evaluate(() => document.querySelectorAll('[data-testid="transcript"] [data-event-id]').length);

    // Opening reads the newest part only: a fraction of the 3,000 events.
    await page.goto(`${d.url}/s/${id}`);
    await expect(page.getByTestId("compacted")).toBeVisible({ timeout: 30_000 });
    expect(got.map((g) => g.url)).toEqual(["?page=200"]);
    expect(got[0]!.events).toBeGreaterThanOrEqual(200);
    expect(got[0]!.events).toBeLessThan(420);
    expect(got[0]!.bytes).toBeLessThan(400_000);
    await expect(page.getByText("Prompt 1:")).toHaveCount(0);
    await expect(page.getByTestId("load-earlier")).toBeVisible();
    await shoot(page, "long-transcript-03-newest-part");

    // Scrolling up reads the part before, and what was read stays where it was on screen.
    const scroller = page.getByTestId("transcript").locator("xpath=..");
    const first = page.locator(`#${await page.getByTestId("user-message").first().getAttribute("id")}`);
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await page.route(`**/api/sessions/${id}/page?*`, async (route) => { await gate; await route.fallback(); });
    await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
    await expect(page.getByTestId("load-earlier")).toHaveText("Loading earlier messages");
    const before = await first.boundingBox();
    const rows = await held();
    release();
    await expect.poll(held).toBeGreaterThan(rows);
    await page.unroute(`**/api/sessions/${id}/page?*`);
    await expect.poll(async () => Math.abs((await first.boundingBox())!.y - before!.y)).toBeLessThan(2);
    expect(got.at(-1)!.url).toMatch(/^\/page\?limit=200&head=[\w-]+&before=\d+$/);
    await shoot(page, "long-transcript-04-earlier-part");

    // The button reads a part too, by keyboard.
    const n = got.length;
    await page.getByTestId("load-earlier").focus({ timeout: 5000 });
    await page.keyboard.press("Enter");
    await expect.poll(() => got.length).toBeGreaterThan(n);

    // A jump to an event far up (a link, the timeline, a search hit) reads the
    // part around it; the end is one press away and the part read is let go.
    const far = all.find((e) => e.kind === "user" && String(e.data.text).startsWith("Prompt 3:"))!;
    await page.goto(`${d.url}/s/${id}?e=${far.id}`);
    await expect(page.locator(`#e-${far.id}`)).toBeInViewport({ timeout: 30_000 });
    await expect(page.getByTestId("branch-preview")).toHaveCount(0);
    expect(got.at(-1)!.url).toBe(`/page?limit=200&around=${far.id}`);
    // The part stops short of the end: its last turn is not the session's last,
    // and what acts on the session where it stands is not offered on it.
    await expect(page.getByTestId("turn-end").first()).toBeVisible();
    await expect(page.getByTestId("retry")).toHaveCount(0);
    // The find key opens the page's own Find, which reaches the messages not loaded too (find.spec.ts).
    await page.keyboard.press("Control+f");
    await expect(page.getByTestId("find-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    // A turn that somebody else starts (another tab, the command line, an
    // agent's report) leaves the reader in the part: only this page's own send moves them.
    const idle = () => expect.poll(async () => ((await (await fetch(`${d.url}/api/sessions/${id}?events=0`)).json()) as any).running, { timeout: 30_000 }).toBe(false);
    await fetch(`${d.url}/api/sessions/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "script:render sent from elsewhere" }) });
    // The way to the end says a reply is being written there.
    await expect(page.getByTestId("jump-latest")).toContainText("A reply is being written");
    await idle();
    await expect(page.getByTestId("jump-latest")).toContainText("Latest");
    await expect(page.locator(`#e-${far.id}`)).toHaveCount(1);
    await expect(page.getByTestId("later-messages")).toHaveCount(1);
    // The strip that says later messages are not shown stands clear of the Latest pill.
    await page.getByTestId("later-messages").scrollIntoViewIfNeeded();
    const strip = (await page.getByTestId("load-later").boundingBox())!;
    const pill = (await page.getByTestId("jump-latest").boundingBox())!;
    expect(strip.y + strip.height <= pill.y || pill.y + pill.height <= strip.y).toBe(true);
    await expect(page.getByTestId("jump-latest")).toHaveCount(1);
    await shoot(page, "long-transcript-05-part-around-a-jump");
    // This page's own prompt goes to the end, and so does the transcript.
    await page.getByTestId("composer").fill("script:render sent from here");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("later-messages")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(`#e-${far.id}`)).toHaveCount(0);
    await expect(page.getByTestId("user-message").last()).toContainText("sent from here");
    await idle();
    main = (await session()).head;

    // The other version of the edited prompt: its branch is read when it is
    // chosen, and the transcript opens at the prompt.
    const fork = all.find((e) => e.kind === "user" && String(e.data.text).includes("(edited)"))!;
    const firstVersion = all.find((e) => e.kind === "user" && String(e.data.text).includes("(first version)"))!;
    await page.goto(`${d.url}/s/${id}?e=${fork.id}`);
    const edited = page.locator(`#e-${fork.id}`);
    await expect(edited).toBeInViewport({ timeout: 30_000 });
    await expect(edited.getByTestId("branch-pos")).toHaveText("2/2");
    await edited.getByRole("button", { name: "Previous version" }).click();
    const older = page.locator(`#e-${firstVersion.id}`);
    await expect(older).toBeInViewport({ timeout: 30_000 });
    await expect(older.getByTestId("branch-pos")).toHaveText("1/2");
    expect((await session()).head).not.toBe(main);
    await shoot(page, "long-transcript-06-other-version");
    await older.getByRole("button", { name: "Next version" }).click();
    await expect(edited).toBeInViewport({ timeout: 30_000 });
    expect((await session()).head).toBe(main);

    // A reply at the end: its events arrive once each, in order, and the page
    // never read the session whole (no part was as large as the session).
    const base = ((await (await fetch(`${d.url}/api/sessions/${id}?events=0`)).json()) as any).seq as number;
    await page.getByTestId("composer").fill("script:render at the end");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("user-message").last()).toContainText("at the end", { timeout: 30_000 });
    await idle();
    await expect(page.getByTestId("assistant-text").last()).toContainText("The parser, moved", { timeout: 30_000 });
    await expect(page.getByTestId("working")).toHaveCount(0);
    const fresh = ((await (await fetch(`${d.url}/api/sessions/${id}/events?after=${base}`)).json()) as any).events.map((e: any) => e.seq);
    expect(fresh.length).toBeGreaterThanOrEqual(4);
    expect(sockets.filter((s) => s > base)).toEqual(fresh);
    expect(Math.max(...got.map((g) => g.events))).toBeLessThan(700);
    expect(got.some((g) => g.url.startsWith("/events"))).toBe(false);
    expect(await held()).toBeLessThan(1500);

    // A new version of a prompt far back, made elsewhere while this page shows
    // the end: the page reads the part around it, and the prompt stands with its
    // versions (2 of 2) without a reload.
    const early = all.find((e) => e.kind === "user" && String(e.data.text).startsWith("Prompt 5:"))!;
    await fetch(`${d.url}/api/sessions/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Prompt 5, asked again from elsewhere. script:render", edit_of: early.id }) });
    const again = page.getByTestId("user-message").filter({ hasText: "asked again from elsewhere" });
    await expect(again).toHaveCount(1, { timeout: 30_000 });
    await expect(again.getByTestId("branch-pos")).toHaveText("2/2", { timeout: 15_000 });
    await expect(page.getByTestId("station-word")).not.toHaveText(/Failed/);
  } finally {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    rmSync(state, { recursive: true, force: true });
  }
});

// The reader's place (the row at the top of the view, kept there while the
// transcript changes size above it) is found by halving over the rows where
// they are: a scroll reaches a handful of them, however many are mounted, and
// never walks or copies the list.
// A part that does not load is a state the page says where the part would
// have come in, with a way to ask again: it is not asked for over and over
// by the scroll that asked for it, the reconnect asks again by itself, and
// nothing lands in the error table for a daemon that could not be reached or
// for a session that was deleted meanwhile (its view says it is gone).
test("a part that does not load says so and can be asked for again", async ({ page }) => {
  const { state, ids: [id] } = seeded("part-fails", 2000, "turns", "A part that fails");
  const d = await daemon(state);
  try {
    const posted: string[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/errors") posted.push(r.postData() ?? ""); });
    // The page's socket can be cut, and kept from opening again.
    const live: { ws?: import("@playwright/test").WebSocketRoute; down: boolean } = { down: false };
    await page.routeWebSocket(/\/ws$/, (ws) => { if (live.down) return void ws.close({ code: 4000, reason: "down for the test" }); ws.connectToServer(); live.ws = ws; });
    let cut: boolean | "other" = true, asked = 0;
    await page.route(`**/api/sessions/${id}/page?*`, (r) => {
      asked++;
      // "other": the daemon answers 404 for something that is not the session (an event the branch no longer has).
      return cut === "other" ? r.fulfill({ status: 404, json: { error: "no such event in this session" } }) : cut ? r.abort("connectionrefused") : r.fallback();
    });
    await page.goto(`${d.url}/s/${id}`);
    const button = page.getByTestId("load-earlier");
    await expect(button).toBeVisible({ timeout: 30_000 });
    const held = () => page.evaluate(() => document.querySelectorAll('[data-testid="transcript"] [data-event-id]').length);
    const scroller = page.getByTestId("transcript").locator("xpath=..");

    // Scrolling up asks for the part before; the read is cut.
    await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
    const said = page.getByTestId("earlier-failed");
    await expect(said).toHaveText("Earlier messages did not load: Keel is not reachable.");
    await expect(button).toHaveText("Try again");
    await expect(button).toBeEnabled();
    // The scroll that asked does not ask again while it stands.
    const once = asked;
    await scroller.evaluate((el) => { el.scrollTo({ top: 400 }); el.scrollTo({ top: 0 }); });
    await page.waitForTimeout(500);
    expect(asked).toBe(once);
    await shoot(page, "long-transcript-08-part-did-not-load");

    // Asked for again by the owner, and still cut: said again.
    await button.click();
    await expect.poll(() => asked).toBe(once + 1);
    await expect(said).toBeVisible();
    // The connection comes back: the part is read without being asked for.
    const rows = await held();
    cut = false;
    await live.ws!.close({ code: 4000, reason: "cut by the test" });
    await expect.poll(held, { timeout: 15_000 }).toBeGreaterThan(rows);
    await expect(said).toHaveCount(0);
    await expect(button).toHaveText("Load earlier messages");

    // A 404 that is not about the session is a failure like any other: said, not taken for a deleted session.
    cut = "other";
    const twice = asked;
    await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
    await expect(said).toHaveText("Earlier messages did not load: no such event in this session");
    await expect(page.getByTestId("session-missing")).toHaveCount(0);
    await scroller.evaluate((el) => { el.scrollTo({ top: 400 }); el.scrollTo({ top: 0 }); });
    await page.waitForTimeout(300);
    expect(asked).toBe(twice + 1);

    // The other direction: reading a part far up, the part after it does not load, and says so.
    cut = false;
    const all = ((await (await fetch(`${d.url}/api/sessions/${id}/events`)).json()) as any).events as { id: string; kind: string; data: any }[];
    const far = all.find((e) => e.kind === "user" && String(e.data.text).startsWith("Prompt 3:"))!;
    await page.goto(`${d.url}/s/${id}?e=${far.id}`);
    await expect(page.locator(`#e-${far.id}`)).toBeInViewport({ timeout: 30_000 });
    const later = page.getByTestId("load-later");
    await expect(later).toHaveText("Load later messages");
    cut = true;
    await later.click();
    await expect(page.getByTestId("later-failed")).toHaveText("Later messages did not load: Keel is not reachable.");
    await expect(later).toHaveText("Try again");
    await shoot(page, "long-transcript-09-later-part-did-not-load");
    cut = false;
    const before = await held();
    await later.click();
    await expect.poll(held).toBeGreaterThan(before);
    await expect(page.getByTestId("later-failed")).toHaveCount(0);

    // The session is deleted while the page is cut off: the next part's read finds it gone.
    await page.goto(`${d.url}/s/${id}`);
    await expect(button).toBeVisible({ timeout: 30_000 });
    live.down = true;
    await live.ws!.close({ code: 4000, reason: "cut by the test" });
    expect((await fetch(`${d.url}/api/sessions/${id}`, { method: "DELETE" })).ok).toBe(true);
    await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
    await expect(page.getByTestId("session-missing")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(3_500); // a network failure is posted 3 s after it happened
    expect(posted).toEqual([]);
  } finally {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    rmSync(state, { recursive: true, force: true });
  }
});

test("the reader's place is found by halving and holds under the branch banner", async ({ page }) => {
  const { state, ids: [id] } = seeded("anchor", 3000, "turns", "Anchored");
  const d = await daemon(state);
  try {
    const all = ((await (await fetch(`${d.url}/api/sessions/${id}/events`)).json()) as any).events as { id: string; kind: string; data: any }[];
    // How the transcript's rows are reached: one at a time by index, or all of them walked.
    await page.addInitScript(() => {
      const w = window as any;
      w.__rows = { item: 0, walked: 0 };
      const mine = (c: HTMLCollection) => c[0]?.parentElement?.getAttribute("data-testid") === "transcript";
      const item = HTMLCollection.prototype.item;
      HTMLCollection.prototype.item = function (i: number) { if (mine(this)) w.__rows.item++; return item.call(this, i); };
      const walk = (HTMLCollection.prototype as any)[Symbol.iterator];
      (HTMLCollection.prototype as any)[Symbol.iterator] = function () { if (mine(this)) w.__rows.walked++; return walk.call(this); };
    });
    await page.goto(`${d.url}/s/${id}`);
    await expect(page.getByTestId("compacted")).toBeVisible({ timeout: 30_000 });
    const transcript = page.getByTestId("transcript");
    const scroller = transcript.locator("xpath=..");
    const mounted = () => transcript.evaluate((el) => el.children.length);
    // One scroll by the reader is one lookup: the rows it reached (the fewest of three scrolls).
    const lookup = async () => {
      const seen: { item: number; walked: number }[] = [];
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => Object.assign((window as any).__rows, { item: 0, walked: 0 }));
        await scroller.evaluate((el) => new Promise<void>((done) => {
          el.addEventListener("scroll", () => requestAnimationFrame(() => done()), { once: true });
          el.scrollTop -= 240;
        }));
        seen.push(await page.evaluate(() => ({ ...(window as any).__rows })));
      }
      return seen.sort((x, y) => x.item - y.item)[0]!;
    };
    const few = await mounted();
    const first = await lookup();
    // Eight times the rows, read in by keyboard.
    await expect.poll(async () => {
      await pressIfThere(page, page.getByTestId("load-earlier"));
      return mounted();
    }, { timeout: 90_000, intervals: [200] }).toBeGreaterThanOrEqual(few * 8);
    const many = await mounted();
    const second = await lookup();
    expect(first.walked + second.walked).toBe(0);
    expect(first.item).toBeGreaterThan(0);
    expect(first.item).toBeLessThanOrEqual(Math.ceil(Math.log2(few)) + 5);
    expect(second.item).toBeLessThanOrEqual(Math.ceil(Math.log2(many)) + 5);
    expect(second.item - first.item).toBeLessThanOrEqual(4); // three halvings more for eight times the rows

    // Another branch read in place: the banner sticks above the rows, and the
    // prompt read keeps its place when an earlier part comes in above it.
    const side = all.find((e) => e.kind === "user" && String(e.data.text).includes("(first version)"))!;
    await expect.poll(async () => ((await (await fetch(`${d.url}/api/search?q=${encodeURIComponent('"first version"')}`)).json()) as any).hits?.some((h: any) => h.event_id === side.id), { timeout: 60_000 }).toBe(true);
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill('"first version"');
    await page.getByRole("option").filter({ has: page.locator("mark") }).first().click();
    const prompt = page.locator(`#e-${side.id}`);
    await expect(prompt).toBeInViewport({ timeout: 30_000 });
    await expect(page.getByTestId("branch-preview")).toBeVisible();
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await page.route(`**/api/sessions/${id}/page?*`, async (route) => { await gate; await route.fallback(); });
    await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
    await expect(page.getByTestId("load-earlier")).toHaveText("Loading earlier messages");
    // (The rows the view came to are drawn first: a block held there takes its height when it is.)
    await expect.poll(() => scroller.evaluate((el) => { const v = el.getBoundingClientRect(); return [...el.querySelectorAll(".k-hold")].some((h) => { const r = h.getBoundingClientRect(); return r.bottom > v.top && r.top < v.bottom; }); })).toBe(false);
    const top = page.locator(`#${await page.getByTestId("user-message").first().getAttribute("id")}`);
    const before = (await top.boundingBox())!.y;
    const n = await mounted();
    release();
    await expect.poll(mounted).toBeGreaterThan(n);
    await expect.poll(async () => Math.abs((await top.boundingBox())!.y - before)).toBeLessThan(2);
    expect(await page.getByTestId("user-message").first().getAttribute("id")).not.toBe(await top.getAttribute("id")); // rows came in above it
    await expect(page.getByTestId("branch-preview")).toBeInViewport();
    await shoot(page, "long-transcript-07-place-kept-under-the-banner");
  } finally {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    rmSync(state, { recursive: true, force: true });
  }
});

test("reading up through a run of calls longer than a part keeps the reader at the step they read", async ({ page }) => {
  // One turn of 300 calls with a short line before each: the page holds its newest part, and the run begins before it.
  const { state, ids: [id] } = seeded("run", 300, "run", "A run of three hundred calls");
  const d = await daemon(state);
  try {
    await page.goto(`${d.url}/s/${id}`);
    const said = page.locator('[data-testid="work"] .k-said');
    await expect(said.last()).toContainText("Step 300:", { timeout: 30_000 });
    const firstStep = async () => Number((await said.first().textContent())!.match(/Step (\d+):/)![1]);
    const opened = await firstStep();
    // The page holds the newest part and no more: a run of a hundred steps fills the view many times over,
    // though it is one row.
    await page.waitForTimeout(1200);
    expect(await firstStep()).toBe(opened);
    expect(opened).toBeGreaterThan(195);
    // What was said stands in one column down the run, as wide as the longest of them and no wider than its bound.
    const column = await page.evaluate(() => {
      const steps = [...document.querySelectorAll<HTMLElement>('[data-testid="work"] > .k-step')];
      const at = (el: Element) => Math.round(el.getBoundingClientRect().left);
      const did = [...new Set(steps.map((st) => at(st.querySelector(".k-did")!)))];
      const said = steps.map((st) => st.querySelector(".k-said")!.getBoundingClientRect());
      const widest = Math.max(...steps.map((st) => st.querySelector(".k-said p")!.getBoundingClientRect().width));
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      return { did, cell: Math.round(said[0]!.width), widest: Math.round(widest), bound: 15 * rem };
    });
    expect(column.did).toHaveLength(1);
    expect(column.cell).toBeGreaterThanOrEqual(column.widest);
    expect(column.cell).toBeLessThanOrEqual(Math.min(column.bound, column.widest + 24));
    const run = page.locator('[data-testid="work"]').last();
    const name = await run.getAttribute("data-run");
    // The reader goes to a step in the upper part of what is held, and reads up from it.
    const marker = opened + 20;
    const place = () => page.evaluate((m) => {
      const sc = document.querySelector(".k-reading")!;
      const el = [...document.querySelectorAll('[data-testid="work"] .k-said')].find((x) => x.textContent!.startsWith(`Step ${m}:`));
      return el ? Math.round(el.getBoundingClientRect().top - sc.getBoundingClientRect().top) : null;
    }, marker);
    await page.evaluate((m) => {
      const sc = document.querySelector(".k-reading")!;
      const el = [...document.querySelectorAll('[data-testid="work"] .k-said')].find((x) => x.textContent!.startsWith(`Step ${m}:`))!;
      sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 200;
    }, marker);
    await page.waitForTimeout(600);
    const before = (await place())!;
    expect(Math.abs(before - 200)).toBeLessThan(4);
    const box = (await page.locator(".k-reading").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 300);
    let wheel = 0;
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -60); wheel += 60; await page.waitForTimeout(200); }
    // The older part of the run is read in above.
    await expect.poll(firstStep, { timeout: 20_000 }).toBeLessThan(opened);
    await page.waitForTimeout(1200);
    // The step is where the wheel left it: it moved by the wheel and by nothing else, and the reader is not at the end.
    const after = await place();
    expect(after).not.toBeNull();
    expect(Math.abs(after! - (before + wheel))).toBeLessThan(24);
    await expect(page.getByTestId("jump-latest")).toBeVisible();
    // The run is the row it was, with its older steps in it, not another row put in its place.
    await expect(page.locator('[data-testid="work"]')).toHaveCount(1);
    expect(await run.getAttribute("data-run")).toBe(name);
    await shoot(page, "long-transcript-04-run-read-up");
  } finally {
    d.proc.kill();
    await exited(d.proc);
  }
});

// Rows far from the view are not drawn: each block of them stands as one light box as tall as it
// was, holding its rows' words and event ids (lib/window.ts). Find reaches the words and brings
// the rows back with what it found still selected, a selection keeps the rows it spans drawn, a
// jump draws its row, a call the owner opened is open again when its row comes back (in its own
// session only), forced colors keep the held words unseen, a page printed draws every block, and a
// phone holds rows the same way.
test("rows far from the view are held as light boxes that Find, a selection and a jump still reach", async ({ page }) => {
  // (Two sessions of the same turns: their calls have the same ids.)
  const { state, ids: [id, twin] } = seeded("held", 180, "turns", "Held rows", "Held rows again");
  const d = await daemon(state);
  try {
    const all = ((await (await fetch(`${d.url}/api/sessions/${id}/events`)).json()) as any).events as { id: string; kind: string; data: any }[];
    const prompt = (n: number) => all.find((e) => e.kind === "user" && String(e.data.text).startsWith(`Prompt ${n}:`))!;
    await page.goto(`${d.url}/s/${id}`);
    await expect(page.getByTestId("turn-end").last()).toBeInViewport({ timeout: 30_000 });
    const transcript = page.getByTestId("transcript");
    const scroller = transcript.locator("xpath=..");
    const prompts = all.filter((e) => e.kind === "user" && !e.data.origin).length;
    // (Prompts 4 to 6 are on the other branch: the one shown goes from 3 to 7, edited.)
    const shownIds = all.filter((e) => e.kind === "user" && /^Prompt (\d+)/.exec(e.data.text) && Number(/^Prompt (\d+)/.exec(e.data.text)![1]) > 7).map((e) => e.id);
    // The whole session is on the page (one part), and most of it is held.
    await expect(page.getByTestId("load-earlier")).toHaveCount(0);
    await expect.poll(() => transcript.locator(":scope > .k-hold").count()).toBeGreaterThan(5);
    expect(await page.getByTestId("user-message").count()).toBeLessThan(prompts / 3);
    expect(await transcript.locator("[data-event-id]").evaluateAll((els, ids) => ids.every((x) => els.some((el) => (el as HTMLElement).dataset.eventId === x)), shownIds)).toBe(true);
    await shoot(page, "long-transcript-10-held-rows");

    // Find reaches a held prompt's words and its rows are drawn where Find took the view.
    const third = prompt(8);
    expect(await transcript.locator(`#e-${third.id}`).getAttribute("data-testid")).toBeNull(); // held
    // (Searching on from the end round to the top, as the find bar does.)
    expect(await page.evaluate((w) => (window as any).find(w, false, false, true), String(third.data.text).slice(0, 24))).toBe(true);
    expect(await page.evaluate(() => getSelection()!.getRangeAt(0).startContainer.parentElement!.closest(".k-hold") !== null)).toBe(true);
    // The find bar takes the view to what it found (window.find selects it and leaves the view):
    // the rows there are drawn, the found one in view.
    await page.evaluate(() => getSelection()!.getRangeAt(0).startContainer.parentElement!.scrollIntoView({ block: "center" }));
    await expect(page.locator(`[data-testid="user-message"]#e-${third.id}`)).toBeInViewport({ timeout: 10_000 });
    // What Find found is still selected, in the drawn prompt (the next search goes on from there).
    expect(await page.evaluate((at) => { const s = getSelection()!; return { text: s.toString(), drawn: !!s.anchorNode?.parentElement?.closest(`[data-testid="user-message"]#${at}`) }; }, `e-${third.id}`)).toEqual({ text: String(third.data.text).slice(0, 24), drawn: true });

    // A selection from that prompt to one two blocks on, made as a drag makes it (the view goes down
    // to its end), keeps every row it spans drawn, also when the view goes on to the end, and copies
    // their words as they are shown.
    const sixth = prompt(11);
    await scroller.evaluate((el, at) => { const t = document.getElementById(at)!; el.scrollTop += t.getBoundingClientRect().top - el.getBoundingClientRect().top - 100; }, `e-${sixth.id}`);
    await expect(page.locator(`[data-testid="user-message"]#e-${sixth.id}`)).toBeInViewport();
    await page.evaluate(([a, b]) => {
      const r = document.createRange();
      r.setStartBefore(document.getElementById(`e-${a}`)!);
      r.setEndAfter(document.getElementById(`e-${b}`)!);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
    }, [third.id, sixth.id]);
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(page.getByTestId("turn-end").last()).toBeInViewport();
    await page.waitForTimeout(400);
    await expect(page.locator(`[data-testid="user-message"]#e-${third.id}`)).toHaveCount(1);
    const copied = await page.evaluate(() => getSelection()!.toString());
    for (const n of [8, 9, 10, 11]) expect(copied).toContain(`Prompt ${n}:`);
    expect(copied).toContain("Reply 9 ends here.");
    expect(copied).not.toContain("**");
    // Let go, the rows far from the view are held again.
    await page.evaluate(() => getSelection()!.removeAllRanges());
    await expect(page.locator(`[data-testid="user-message"]#e-${third.id}`)).toHaveCount(0);

    // A run of work the owner opened is open again when its row comes back.
    const ninth = prompt(14);
    await page.goto(`${d.url}/s/${id}?e=${ninth.id}`);
    const jumped = page.locator(`[data-testid="user-message"]#e-${ninth.id}`);
    await expect(jumped).toBeInViewport({ timeout: 30_000 });
    const line = page.locator(`[data-events~="${all[all.indexOf(ninth) + 2]!.id}"] .k-line`).first();
    await line.click();
    await expect(line).toHaveAttribute("aria-expanded", "true");
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(jumped).toHaveCount(0);
    await scroller.evaluate((el, at) => { const t = document.getElementById(at)!; el.scrollTop += t.getBoundingClientRect().top - el.getBoundingClientRect().top - 100; }, `e-${ninth.id}`);
    await expect(jumped).toBeInViewport();
    await expect(page.locator(`[data-events~="${all[all.indexOf(ninth) + 2]!.id}"] .k-line`).first()).toHaveAttribute("aria-expanded", "true");

    // A screen reader reaches a held run of work by the name it has drawn.
    await expect(transcript.locator('.k-hold [role="group"][aria-label="What the model did"]').first()).toBeAttached();

    // The call opened is this session's: the other session's call of the same id stays closed.
    const twinAll = ((await (await fetch(`${d.url}/api/sessions/${twin}/events`)).json()) as any).events as { id: string; kind: string; data: any }[];
    const twinPrompt = twinAll.find((e) => e.kind === "user" && String(e.data.text).startsWith("Prompt 14:"))!;
    await page.goto(`${d.url}/s/${twin}?e=${twinPrompt.id}`);
    await expect(page.locator(`[data-testid="user-message"]#e-${twinPrompt.id}`)).toBeInViewport({ timeout: 30_000 });
    await expect(page.locator(`[data-events~="${twinAll[twinAll.indexOf(twinPrompt) + 2]!.id}"] .k-line`).first()).toHaveAttribute("aria-expanded", "false");

    // In forced colors the held words stay unseen (the system's text color would show them).
    await expect.poll(() => transcript.locator(":scope > .k-hold").count()).toBeGreaterThan(5);
    const heldColor = () => transcript.locator(".k-hold > p").first().evaluate((el) => getComputedStyle(el).color);
    await page.emulateMedia({ forcedColors: "active" });
    expect(await heldColor()).toBe("rgba(0, 0, 0, 0)");
    await page.emulateMedia({ forcedColors: "none" });
    // A page printed draws every block, and holds them again after.
    await page.evaluate(() => dispatchEvent(new Event("beforeprint")));
    expect(await transcript.locator(":scope > .k-hold").count()).toBe(0);
    await page.evaluate(() => dispatchEvent(new Event("afterprint")));
    await expect.poll(() => transcript.locator(":scope > .k-hold").count()).toBeGreaterThan(5);

    // A phone holds the rows the same way.
    await page.setViewportSize({ width: 390, height: 844 });
    // (It opens where the owner was: the prompt jumped to.)
    await page.goto(`${d.url}/s/${id}`);
    await expect(jumped).toBeInViewport({ timeout: 30_000 });
    await expect.poll(() => transcript.locator(":scope > .k-hold").count()).toBeGreaterThan(5);
    await shoot(page, "long-transcript-11-held-rows-phone");
  } finally {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    rmSync(state, { recursive: true, force: true });
  }
});

// The reader's line holds in every frame while the view goes up a long transcript by the wheel:
// a block drawn at its real height above the line, a reply's math set once it is drawn, and an
// earlier part read in at the top move nothing the reader sees, not even for one frame. (Held
// in the same task as the change, before the frame is painted, not by the size observer after.)
// A selection over rows that are not drawn copies what the drawn rows copy: a table's rows as cells
// and tabs, a prompt's images by the words they are drawn with, a run of work by its lines.
test("held rows copy as the drawn ones do", async ({ page }) => {
  const state = join(ROOT, `held-copy-${Date.now()}`);
  mkdirSync(state, { recursive: true });
  const [id] = JSON.parse(execFileSync("bun", [join(import.meta.dirname, "fixtures/mixed-transcript.ts"), state, sessionsFolder(state), "40", "Mixed copy"], { encoding: "utf8", env: specEnv(state) })) as string[];
  const d = await daemon(state);
  try {
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${d.url}/s/${id}`);
    await expect(page.getByTestId("turn-end").last()).toBeInViewport({ timeout: 30_000 });
    const transcript = page.getByTestId("transcript");
    await expect.poll(() => transcript.locator(":scope > .k-hold").count()).toBeGreaterThan(3);
    // From the first held box to the last, read before anything could draw them.
    const held = await page.evaluate(() => {
      const boxes = document.querySelectorAll('[data-testid="transcript"] > .k-hold');
      const r = document.createRange();
      r.setStartBefore(boxes[0]!);
      r.setEndAfter(boxes[boxes.length - 1]!);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
      const text = getSelection()!.toString();
      getSelection()!.removeAllRanges();
      return text;
    });
    expect(held).toMatch(/^col a\tcol b\tcol c$/m);
    expect(held).toMatch(/^\d+\tx\ty$/m);
    expect(held).toMatch(/Marker Zorblax\d*[05]x$/m);
    expect(held).not.toContain("Attached image");
    expect(held).toMatch(/^Ran rg -n "token \d+" src \| head -20$/m);
    expect(held).not.toContain("**");
  } finally {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    rmSync(state, { recursive: true, force: true });
  }
});

test("reading up by the wheel holds the reader's line in every frame", async ({ page }) => {
  test.setTimeout(240_000);
  const state = join(ROOT, `wheel-${Date.now()}`);
  mkdirSync(state, { recursive: true });
  const [id] = JSON.parse(execFileSync("bun", [join(import.meta.dirname, "fixtures/mixed-transcript.ts"), state, sessionsFolder(state), "160", "Mixed"], { encoding: "utf8", env: specEnv(state) })) as string[];
  const d = await daemon(state);
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    // A part asked for and not yet in: the frames are watched until it is, and a few after.
    await page.addInitScript(() => {
      const w = window as any, f = w.fetch.bind(w);
      w.__parts = 0;
      w.fetch = (u: RequestInfo | URL, o?: RequestInit) => {
        if (!String(u instanceof Request ? u.url : u).includes("/page?")) return f(u, o);
        w.__parts++;
        return f(u, o).finally(() => setTimeout(() => w.__parts--, 300));
      };
    });
    await page.goto(`${d.url}/s/${id}`);
    await expect(page.getByTestId("compacted")).toBeVisible({ timeout: 60_000 });
    const scroller = page.getByTestId("transcript").locator("xpath=..");
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    const box = (await scroller.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const jolts: { step: number; px: number }[] = [];
    let parts = 0;
    page.on("response", (r) => { if (new URL(r.url()).pathname === `/api/sessions/${id}/page`) parts++; });
    for (let step = 0; step < 160; step++) {
      // A drawn line under the view's top: where it stands in each frame after one wheel step.
      const picked = await scroller.evaluate((s) => {
        const r = s.getBoundingClientRect(), c = s.firstElementChild!;
        for (let y = r.top + r.height * 0.4; y < r.bottom - 10; y += 6) {
          const el = document.elementFromPoint(r.left + r.width / 2, y);
          if (el && el.children.length === 0 && !el.closest(".k-hold") && c.contains(el)) { (window as any).__line = el; return true; }
        }
        return false;
      });
      await page.mouse.wheel(0, -350);
      const tops = await page.evaluate(() => new Promise<(number | null)[]>((done) => {
        const el = (window as any).__line as Element, out: (number | null)[] = [], t0 = performance.now();
        const f = () => { out.push(el.isConnected ? el.getBoundingClientRect().top : null); if (performance.now() - t0 < 220 || ((window as any).__parts > 0 && performance.now() - t0 < 15_000)) requestAnimationFrame(f); else done(out); };
        requestAnimationFrame(f);
      }));
      // (The first frames carry the wheel's own move.)
      const seen = tops.filter((x): x is number => x !== null);
      for (let k = 3; k < seen.length; k++) if (picked && Math.abs(seen[k]! - seen[k - 1]!) > 2) jolts.push({ step, px: Math.round(Math.abs(seen[k]! - seen[k - 1]!)) });
      if (parts > 0 && (await scroller.evaluate((el) => el.scrollTop)) < 2000) break;
    }
    expect(parts).toBeGreaterThan(0); // an earlier part was read in on the way
    expect(jolts).toEqual([]);
  } finally {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    rmSync(state, { recursive: true, force: true });
  }
});
