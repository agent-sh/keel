import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a session row says one state, and the bar above a session says its reason in words.
// The row's mark is its state. The rows that call the owner (needs you, failed, declined) are in ink
// and one step heavier; what is new is in ink at the row's own weight (reading it moves
// nothing), says "New" to a reader and has a dot at the row's right end (outside its end slot); the open row is in ink. The row's end is one
// slot: who a row that calls the owner waits on (you, the failure's class, declined), else its
// time where its bucket changes, read or not. The time and
// the counts above the list are in the text face, quiet. The note that the
// list's order changed is a hint for one load. A background command with no description of its own
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

test("a row says one state, in one weight, and the line above the list is one quiet sentence", async ({ page, request }) => {
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
    // News is its title's ink at the weight of a read row, and a dot in the right gutter: the row's end keeps its time, and a reader hears "New".
    await expect(row(page, fresh).getByTestId("row-unread")).toHaveCount(1);
    await expect(row(page, seen).getByTestId("row-unread")).toHaveCount(0);
    expect(await style(page, fresh, ".k-row-title", "fontWeight"), "a row with news is heavier than a read one: reading it reflows").toBe(await style(page, seen, ".k-row-title", "fontWeight"));
    await expect(row(page, fresh).getByTestId("row-time")).toHaveCount(1);
    await expect(row(page, fresh).getByTestId("row-new"), "a reader is not told the row is new").toHaveText("New");
    await expect(row(page, seen).getByTestId("row-new")).toHaveCount(0);
    await expect(row(page, asks)).toHaveAttribute("data-watch", "need", { timeout: 15_000 });
    await expect(row(page, failed)).toHaveAttribute("data-watch", "fail");
    expect(await style(page, fresh, ".k-row-title", "color"), "a row with news is in the ink").not.toBe(await style(page, seen, ".k-row-title", "color"));
    expect(await style(page, asks, ".k-row-title", "color"), "a row that needs the owner is in ink").not.toBe(await style(page, seen, ".k-row-title", "color"));
    expect(await style(page, failed, ".k-row-title", "color")).toBe(await style(page, asks, ".k-row-title", "color"));
    // What calls the owner is the heavier row, never lighter than news.
    expect(Number(await style(page, asks, ".k-row-title", "fontWeight")), "a row that needs the owner is not heavier than news").toBeGreaterThan(Number(await style(page, fresh, ".k-row-title", "fontWeight")));
    expect(await style(page, failed, ".k-row-title", "fontWeight")).toBe(await style(page, asks, ".k-row-title", "fontWeight"));
    // Who it waits on, in the time's place: the owner, or what failed. The time is the word's tooltip.
    await expect(row(page, asks).getByTestId("row-on")).toBeVisible();
    await expect(row(page, asks).getByTestId("row-on")).toHaveText("Needs you");
    await expect(row(page, asks).getByTestId("row-time")).toHaveCount(0);
    await expect(row(page, failed).locator(".k-row-end").getByTestId("row-class")).toHaveText("billing");
    await expect(row(page, failed).locator(".k-row-end").getByTestId("row-class")).toBeVisible();
    await expect(row(page, failed).getByTestId("row-time")).toHaveCount(0);
    // A declined row says so in the same slot, in the failure's ink.
    await expect(row(page, declined)).toHaveAttribute("data-watch", "declined");
    await expect(row(page, declined).getByTestId("row-on")).toHaveText("declined");
    await expect(row(page, declined).getByTestId("row-time")).toHaveCount(0);
    expect(await style(page, declined, ".k-row-title", "fontWeight")).toBe(await style(page, asks, ".k-row-title", "fontWeight"));
    // Each row's end shows one thing.
    const slots = await page.evaluate((ids) => ids.map((id) => document.querySelector<HTMLElement>(`[data-testid="session-row"][data-session="${id}"]`)!).map((r) => [...r.querySelectorAll<HTMLElement>(".k-row-end > *")].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden" && !e.classList.contains("sr-only")).length), made);
    expect(Math.max(...slots), `a row's end shows more than one thing: ${slots.join(",")}`).toBe(1);
    // One state signal: two finished rows wear the same mark, read or not (the title's weight says which is new).
    expect(await style(page, fresh, ".k-mark", "backgroundColor")).toBe(await style(page, seen, ".k-mark", "backgroundColor"));
    // The time is in the text face, and so is the line above the list.
    const text = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(await style(page, fresh, '[data-testid="row-time"]', "fontFamily")).toBe(text);
    const line = page.getByTestId("list-summary");
    await expect(line.locator(".k-sum-chip").first()).toBeVisible();
    for (const sel of [".k-sum-n", ".k-sum-word"]) expect(await line.locator(sel).first().evaluate((el) => getComputedStyle(el).fontFamily)).toBe(text);
    // No mark or dot of its own in the sentence: the rows' marks say each state.
    await expect(line.locator(".k-mark")).toHaveCount(0);
    await shoot(page, "quiet-rows-01-list");
    // Read, the row keeps its width: only its ink steps back.
    const wide = () => row(page, fresh).locator(".k-row-title").evaluate((el) => el.getBoundingClientRect().width);
    const before = await wide();
    await request.post(`/api/sessions/${fresh}/marks`, { data: { unread: false } });
    await expect(row(page, fresh)).not.toHaveAttribute("data-unread", "true");
    expect(await wide(), "reading the row changed its title's width").toBe(before);
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
