import { expect, test, type Page } from "./isolate.ts";
import { rmSync } from "node:fs";
import { daemon, exited, seeded } from "./own-daemon.ts";
import { shoot } from "./shots.ts";

// Feature: a long session costs what its end costs. Rows of finished turns are
// made and rendered once: a reply that streams below them, and the events it
// stores, leave them alone. The page holds the session in parts: it opens with
// the newest events of its branch and reads older ones, another branch or the
// part around an event when the reader goes there.

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
  const d = await daemon(state);
  try {
    const stored = async () => ((await (await fetch(`${d.url}/api/sessions/${id}/events`)).json()) as any).events as { id: string; kind: string; data: any }[];
    const before = await stored();
    const prompts = before.filter((e) => e.kind === "user").length;
    await page.goto(`${d.url}/s/${id}`);
    await expect(page.getByTestId("compacted")).toBeVisible({ timeout: 30_000 });
    // The whole branch is read into the page, part by part (the side branch's three prompts are not on it).
    while (await page.getByTestId("load-earlier").count()) {
      const n = await page.getByTestId("user-message").count();
      await page.getByTestId("load-earlier").click();
      await expect.poll(() => page.getByTestId("user-message").count()).toBeGreaterThan(n);
    }
    await expect(page.getByTestId("user-message")).toHaveCount(prompts - 3, { timeout: 60_000 });

    // From here on: every row model made and every row rendered, by event id.
    await page.evaluate(() => {
      const w = window as any;
      w.__made = []; w.__rendered = [];
      w.__keelRows.made = (id: string) => w.__made.push(id);
      w.__keelRows.rendered = (id: string) => w.__rendered.push(id);
    });
    await page.getByTestId("composer").fill("script:render");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("draft")).toBeVisible({ timeout: 15_000 });
    await shoot(page, "long-transcript-01-streaming");
    await expect(page.getByTestId("turn-end")).toHaveCount(prompts - 3 + 1, { timeout: 60_000 });
    await expect(page.getByTestId("working")).toHaveCount(0);

    const fresh = new Set((await stored()).slice(before.length).map((e) => e.id));
    expect(fresh.size).toBeGreaterThanOrEqual(4);
    const { made, rendered } = await page.evaluate(() => ({ made: (window as any).__made as string[], rendered: (window as any).__rendered as string[] }));
    // Rows were made and rendered for the turn's events only. The footer that
    // stopped being the last one changed by itself: its Answer again went.
    expect(made.length).toBeGreaterThan(0);
    expect(made.filter((x) => !fresh.has(x))).toEqual([]);
    expect(rendered.filter((x) => fresh.has(x)).length).toBeGreaterThan(0);
    expect([...new Set(rendered.filter((x) => !fresh.has(x)))]).toEqual([]);
    await expect(page.getByTestId("retry")).toHaveCount(1);

    // The history is still all there: the page's own find reaches the first
    // prompt, and a finished turn's footer copies its reply.
    expect(await page.evaluate(() => (window as any).find("Prompt 1:", false, true, true))).toBe(true);
    await page.getByTestId("copy-reply").nth(4).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain("Looking at **step 5**.");
    expect(clip).toContain("Reply 5 ends here.");
    await shoot(page, "long-transcript-02-after-reply");
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
    const main = (await session()).head;
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
    await page.getByTestId("load-earlier").focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => got.length).toBe(n + 1);

    // A jump to an event far up (a link, the timeline, a search hit) reads the
    // part around it; the end is one press away and the part read is let go.
    const far = all.find((e) => e.kind === "user" && String(e.data.text).startsWith("Prompt 3:"))!;
    await page.goto(`${d.url}/s/${id}?e=${far.id}`);
    await expect(page.locator(`#e-${far.id}`)).toBeInViewport({ timeout: 30_000 });
    await expect(page.getByTestId("branch-preview")).toHaveCount(0);
    expect(got.at(-1)!.url).toBe(`/page?limit=200&around=${far.id}`);
    await page.getByTestId("later-messages").scrollIntoViewIfNeeded();
    await shoot(page, "long-transcript-05-part-around-a-jump");
    await page.getByTestId("window-latest").click();
    await expect(page.getByTestId("compacted")).toBeInViewport();
    await expect(page.getByTestId("later-messages")).toHaveCount(0);
    await expect(page.locator(`#e-${far.id}`)).toHaveCount(0);

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
    await page.getByTestId("composer").fill("script:render");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("assistant-text").last()).toContainText("The parser, moved", { timeout: 30_000 });
    await expect(page.getByTestId("working")).toHaveCount(0);
    const fresh = ((await (await fetch(`${d.url}/api/sessions/${id}/events?after=${all.at(-1)!.seq}`)).json()) as any).events.map((e: any) => e.seq);
    expect(fresh.length).toBeGreaterThanOrEqual(4);
    expect(sockets.filter((s) => s > all.at(-1)!.seq)).toEqual(fresh);
    expect(Math.max(...got.map((g) => g.events))).toBeLessThan(700);
    expect(got.some((g) => g.url.startsWith("/events"))).toBe(false);
    expect(await held()).toBeLessThan(1500);
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
    while ((await mounted()) < few * 8) {
      const n = await mounted();
      await page.getByTestId("load-earlier").focus();
      await page.keyboard.press("Enter");
      await expect.poll(mounted).toBeGreaterThan(n);
    }
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
