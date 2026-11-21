import { expect, test, type Locator, type Page } from "./isolate.ts";
import { rmSync } from "node:fs";
import { daemon, exited, seeded } from "./own-daemon.ts";
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
    // The page opened with the newest part: its prompts and turn ends are on it, not the session's.
    const part = ((await (await fetch(`${d.url}/api/sessions/${id}?page=200`)).json()) as any).events as { kind: string; data: any }[];
    const shown = () => page.getByTestId("user-message").count();
    const opened = part.filter((e) => e.kind === "user" && !e.data.origin).length;
    const ends = part.filter((e) => e.kind === "turn_end").length;
    expect(opened).toBeGreaterThan(20);
    expect(opened).toBeLessThan(prompts - 3);
    await expect(page.getByTestId("user-message")).toHaveCount(opened);
    await expect(page.getByTestId("turn-end")).toHaveCount(ends);

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
    await expect(page.getByTestId("turn-end")).toHaveCount(ends + 1, { timeout: 60_000 });
    await expect(page.getByTestId("working")).toHaveCount(0);

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
    const onPage = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="transcript"] [data-event-id]')].map((x) => x.dataset.eventId!));
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
    // The browser's own Find reaches only what is loaded: its key says so and offers the search of the whole conversation.
    await page.keyboard.press("Control+f");
    await expect(page.getByTestId("find-note")).toContainText("reaches only the messages loaded here");
    await page.getByTestId("find-note-search").click();
    await expect(page.getByTestId("palette-input")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("find-note")).toHaveCount(0);
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
