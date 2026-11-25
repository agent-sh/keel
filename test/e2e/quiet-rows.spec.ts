import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a session row says one state, and the bar above a session says its reason in words.
// The row's mark is its state, drawn only where it asks for the eye: a finished row draws no dot. Every title has
// one weight. The rows that call the owner (needs you, failed, declined) and what is new are in ink; what is new
// says "New" to a reader and has a small quiet dot at the row's end in the time's place, fainter than any state
// dot, so a row shows one dot at most; a session at work is in ink, the rest is quiet (reading it moves nothing);
// the open row is in ink. The row's end is one slot: the
// age of every row (where its bucket changes), with the word of a row that waits on the owner (you) or was
// declined before it. The time is in the text face, quiet. Nothing in the sidebar is set in capitals. The
// note that the list's order changed is a hint for one load. A background command with no description of its own
// is named in words in the bar, its shell text in the tooltip.

const scriptedModel = async (request: APIRequestContext) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string; provider: string }[];
  return models.find((m) => m.id === "scripted:stand-in")?.id ?? models.find((m) => m.provider === "scripted")?.id;
};
const turnEnds = (request: APIRequestContext, id: string) =>
  expect.poll(async () => ((await (await request.get(`/api/sessions/${id}`)).json()).events as { kind: string }[]).filter((e) => e.kind === "turn_end").length, { timeout: 30_000 }).toBeGreaterThan(0);
const row = (page: Page, id: string) => page.locator(`[data-testid="session-row"][data-session="${id}"]`);
const style = (page: Page, id: string, sel: string, prop: "fontWeight" | "fontFamily" | "backgroundColor" | "color") =>
  row(page, id).locator(sel).first().evaluate((el, p) => getComputedStyle(el)[p as "fontWeight"], prop);

test("a row says one state, in one weight, and news is a quiet dot in the time's place", async ({ page, request }) => {
  const model = await scriptedModel(request);
  test.skip(!model, "needs the scripted provider: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
  const made: string[] = [];
  const make = async (title: string) => { const { session } = await (await request.post("/api/sessions", { data: { model, title } })).json(); made.push(session.id); return session.id as string; };
  try {
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto("/");
    const seen = await make("Quiet rows: one that was read");
    const fresh = await make("Quiet rows: one with news");
    const asks = await make("Quiet rows: one that asks");
    const failed = await make("Quiet rows: one that failed");
    const declined = await make("Quiet rows: one that was declined");
    for (const id of [seen, fresh]) await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:say Done." } });
    await request.put(`/api/sessions/${asks}/permissions`, { data: { mode: "ask" } });
    await request.post(`/api/sessions/${asks}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "echo quiet-rows-asks > quiet-rows-asks.txt" } }])}` } });
    await request.post(`/api/sessions/${failed}/messages`, { data: { text: "script:billing" } });
    await request.post(`/api/sessions/${declined}/messages`, { data: { text: "script:refuse" } });
    for (const id of [seen, fresh, failed, declined]) await turnEnds(request, id);
    // One is opened and read; the other has news.
    await row(page, seen).click();
    await expect(page.getByTestId("station-head").first()).toBeVisible();
    await page.goto("/");
    await expect(row(page, fresh)).toHaveAttribute("data-unread", "true");
    await expect(row(page, seen)).not.toHaveAttribute("data-unread", "true");
    // News is its title's ink and a white dot at the row's end, in the time's place: the time gives way to it, and a reader hears "New".
    await expect(row(page, fresh)).toHaveAttribute("data-news", "true");
    await expect(row(page, seen)).not.toHaveAttribute("data-news", /./);
    await expect(row(page, fresh).getByTestId("row-unread")).toHaveCount(0);
    const dot = row(page, fresh).getByTestId("row-new");
    await expect(dot, "a row with news shows its dot").toBeVisible();
    await expect(dot, "a reader is not told the row is new").toHaveText("New");
    await expect(row(page, fresh).getByTestId("row-time"), "the dot takes the time's place").toBeHidden();
    // (A read row's age may be calm: one that repeats the bucket of the row above is not shown, news or not.)
    await expect(row(page, seen).getByTestId("row-new")).toHaveCount(0);
    expect(await dot.evaluate((el) => getComputedStyle(el).backgroundColor), "the dot is the news dot's colour").toBe(await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.cssText = "position:fixed;width:0;height:0;background:var(--dot-news)";
      document.body.append(probe);
      const c = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return c;
    }));
    {
      const at = (await dot.boundingBox())!, r = (await row(page, fresh).boundingBox())!, title = (await row(page, fresh).locator(".k-row-title").boundingBox())!;
      expect(at.x, "the dot is after the title").toBeGreaterThanOrEqual(title.x + title.width - 0.5);
      expect(r.x + r.width - (at.x + at.width), "the dot is at the row's end, past its padding alone").toBeLessThan(32);
    }
    await expect(row(page, asks)).toHaveAttribute("data-watch", "need", { timeout: 15_000 });
    await expect(row(page, failed)).toHaveAttribute("data-watch", "fail");
    expect(await style(page, fresh, ".k-row-title", "color"), "a row with news is in the ink").not.toBe(await style(page, seen, ".k-row-title", "color"));
    expect(await style(page, asks, ".k-row-title", "color"), "a row that needs the owner is in ink").not.toBe(await style(page, seen, ".k-row-title", "color"));
    expect(await style(page, failed, ".k-row-title", "color")).toBe(await style(page, asks, ".k-row-title", "color"));
    // One weight: quiet is the default; the dots and the ink say the state, the title's weight says nothing.
    await expect(row(page, declined)).toHaveAttribute("data-watch", "declined");
    const weights = await page.evaluate((ids) => ids.map((id) => getComputedStyle(document.querySelector(`[data-testid="session-row"][data-session="${id}"] .k-row-title`)!).fontWeight), [seen, fresh, asks, failed, declined]);
    expect(new Set(weights).size, `the titles of rows read, new, needing the owner, failed and declined have one weight: ${weights.join(",")}`).toBe(1);
    // The sidebar's rule: no label in it is set in capitals, and every row's title has the one weight.
    const sidebar = await page.getByTestId("sidebar").evaluate((el) => ({
      upper: [el, ...el.querySelectorAll<HTMLElement>("*")].filter((e) => getComputedStyle(e).textTransform === "uppercase").map((e) => `${e.tagName.toLowerCase()}.${e.className}`),
      titles: [...new Set([...el.querySelectorAll<HTMLElement>('[data-testid="session-row"] .k-row-title')].map((e) => getComputedStyle(e).fontWeight))],
    }));
    expect(sidebar.upper, "nothing in the sidebar is set in capitals").toEqual([]);
    expect(sidebar.titles, "the session rows' titles have one font weight").toHaveLength(1);
    // The row's end is one slot and it holds the age of every row. Before the age, the word of a row that waits on the
    // owner (you) or was declined; a failure's class is not in the slot (it is on the row's line and in the tooltip).
    const slot = (id: string) => row(page, id).locator(".k-row-end").getByTestId("row-time");
    await expect(slot(asks)).toHaveCount(1);
    // What waits on the owner is its yellow dot: the slot draws no "you" beside the age (a reader still has the words).
    await expect(slot(asks).getByTestId("row-on")).toHaveText("Needs you");
    expect((await slot(asks).getByTestId("row-on").boundingBox())!.width, "the word is not drawn").toBeLessThanOrEqual(1);
    await expect(slot(asks)).toHaveText(/^Needs you (now|\d+[smh])$/);
    // Its clock is the quiet ink of every other time: the yellow dot alone says it needs the owner.
    expect(await style(page, asks, '[data-testid="row-time"]', "color"), "a live clock of a row that asks is quiet").toBe(await style(page, failed, '[data-testid="row-time"]', "color"));
    await expect(slot(failed)).toHaveText(/^(now|\d+[smh])$/);
    await expect(slot(failed)).toHaveAttribute("title", /^Failed: billing, /);
    await expect(slot(failed).getByTestId("row-on")).toHaveCount(0);
    await expect(row(page, failed).locator(".k-row-end").getByTestId("row-class")).toHaveCount(0);
    // A declined row says so in the same slot, in the failure's ink.
    await expect(row(page, declined)).toHaveAttribute("data-watch", "declined");
    await expect(slot(declined).getByTestId("row-on")).toHaveText("declined");
    await expect(slot(declined)).toHaveText(/^declined (now|\d+[smh])$/);
    expect(await style(page, declined, ".k-row-title", "fontWeight")).toBe(await style(page, asks, ".k-row-title", "fontWeight"));
    // Each row's end shows one thing.
    const slots = await page.evaluate((ids) => ids.map((id) => document.querySelector<HTMLElement>(`[data-testid="session-row"][data-session="${id}"]`)!).map((r) => [...r.querySelectorAll<HTMLElement>(".k-row-end > *")].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden" && !e.classList.contains("sr-only")).length), made);
    expect(Math.max(...slots), `a row's end shows more than one thing: ${slots.join(",")}`).toBe(1);
    // One dot a row at most: a finished row draws no mark, read or not, and its news dot is smaller and fainter than a state dot.
    const clear = "rgba(0, 0, 0, 0)";
    expect(await style(page, fresh, ".k-mark", "backgroundColor"), "a finished row with news draws no state dot").toBe(clear);
    expect(await style(page, seen, ".k-mark", "backgroundColor"), "a finished row that was read draws no state dot").toBe(clear);
    await expect(row(page, fresh).locator(".k-mark"), "the mark keeps its word for a reader").toHaveAttribute("aria-label", /./);
    {
      const news = (await dot.boundingBox())!, mark = (await row(page, failed).locator(".k-mark").boundingBox())!;
      expect(news.width, "the news dot is smaller than a state dot").toBeLessThan(mark.width);
      // (Fainter: its contrast on the rail is under every state dot's, state-dots.spec.ts measures it.)
    }
    // The time is in the text face.
    const text = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(await style(page, seen, '[data-testid="row-time"]', "fontFamily")).toBe(text);
    await shoot(page, "quiet-rows-01-list");
    const working = await make("Quiet rows: one at work");
    await request.put(`/api/sessions/${working}/permissions`, { data: { mode: "full-auto" } });
    await request.post(`/api/sessions/${working}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "sleep 120" } }])}` } });
    // A session at work is in ink, not the grey of a row at rest: it reads before the rows that need nothing.
    await expect(row(page, working)).toHaveAttribute("data-watch", "work", { timeout: 15_000 });
    expect(await style(page, working, ".k-row-title", "color"), "a row at work is in ink").toBe(await style(page, fresh, ".k-row-title", "color"));
    expect(await style(page, working, ".k-row-title", "color"), "a row at work is not the grey of one at rest").not.toBe(await style(page, seen, ".k-row-title", "color"));
    await shoot(page, "quiet-rows-01b-working");
    // Read, the row steps back to the ink of a seen one, and its time comes back in the dot's place.
    await request.post(`/api/sessions/${fresh}/marks`, { data: { unread: false } });
    await expect(row(page, fresh)).not.toHaveAttribute("data-unread", "true");
    await expect(row(page, fresh)).not.toHaveAttribute("data-news", /./);
    await expect(row(page, fresh).getByTestId("row-new")).toHaveCount(0);
    const shown = (id: string) => row(page, id).getByTestId("row-time").evaluate((el) => getComputedStyle(el).display !== "none" || el.hasAttribute("data-calm"));
    await expect.poll(() => shown(fresh), { message: "read, the row's age is back in the dot's place (or calm, as a read row's may be)" }).toBe(true);
    expect(await style(page, fresh, ".k-row-title", "fontWeight")).toBe(await style(page, seen, ".k-row-title", "fontWeight"));
    expect(await style(page, fresh, ".k-row-title", "color")).toBe(await style(page, seen, ".k-row-title", "color"));

    // The note that the order changed is a hint for one load.
    await page.evaluate(() => localStorage.setItem("keel.listArrange", JSON.stringify({ group: "folder", sort: "recent", hideDone: false })));
    await page.reload();
    await expect(page.getByTestId("list-note")).toBeVisible();
    await page.reload();
    await expect(row(page, fresh)).toBeVisible();
    await expect(page.getByTestId("list-note")).toHaveCount(0);
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
  }
});

test("the bar names a background command in words and keeps its shell text for the tooltip", async ({ page, request }) => {
  const model = await scriptedModel(request);
  test.skip(!model, "needs the scripted provider: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "Quiet bar: a command in the background" } })).json();
  const command = "sleep 300; echo quiet-bar-done";
  try {
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command, run_in_background: true } }])}` } });
    await turnEnds(request, session.id);
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`/s/${session.id}`);
    const why = page.getByTestId("station-why");
    await expect(why).toHaveText(/^Command in background$/i, { timeout: 15_000 });
    await expect(why).toHaveAttribute("title", new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await shoot(page, "quiet-rows-02-bar");
  } finally {
    await request.delete(`/api/sessions/${session.id}`);
  }
});
