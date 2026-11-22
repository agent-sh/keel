import { expect, test } from "./isolate.ts";
import { HAIKU, shoot, openPanel } from "./shots.ts";

// Feature: the session's Tokens panel lists every turn with what it sent
// (read from cache, written, full price), its output and cost, and the
// session totals; the second turn reads the first one's prefix from cache.
test("tokens panel per turn", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");
  for (const [i, text] of ["Reply with only the word one.", "Reply with only the word two."].entries()) {
    await composer.fill(text);
    await composer.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(i + 1, { timeout: 90_000 });
  }

  await openPanel(page, "usage");
  const panel = page.getByTestId("tokens-panel");
  await expect(panel.getByTestId("usage-turn")).toHaveCount(2);
  await expect(panel.getByTestId("usage-turn").nth(1)).toContainText("two");
  await expect(panel.getByTestId("usage-read")).toContainText("%");
  await expect(panel.getByTestId("usage-cost")).toContainText("$");

  // The second turn's first request read the conversation from cache.
  const { events } = await (await request.get(`/api/sessions/${session.id}`)).json();
  const replies = events.filter((e: any) => e.kind === "assistant");
  expect(replies.at(-1).data.usage.cache_read).toBeGreaterThan(0);
  await shoot(page, "tokens-01-panel");

  // The answer first, in the page's own type (the header's meter has its own).
  await expect(panel.getByTestId("usage-cost")).toContainText(/This session cost\s*\$/);
  await expect(panel.getByTestId("usage-cost")).toContainText("2 turns, 2 requests");
  expect(await panel.evaluate((el) => getComputedStyle(el).fontFamily)).not.toContain("Martian Mono");
  // A turn opens its requests as a table, one row a request; no tooltip of lines.
  const turn = panel.getByTestId("usage-turn").nth(1);
  expect(await turn.getAttribute("title")).toBeNull();
  await turn.getByRole("button").click();
  await expect(turn.getByTestId("usage-requests").locator("th")).toHaveText(["Request", "Cost", "Read", "Written", "New", "Out"]);
  await expect(turn.getByTestId("usage-requests").locator("tbody tr")).toHaveCount(1);
  await shoot(page, "tokens-02-requests");
  // The split is in money, each part beside its tokens, and its shares say what they are of.
  await expect(panel.getByRole("heading", { name: "Where the money went" })).toBeVisible();
  await expect(panel.getByTestId("usage-split")).toContainText("of cost");
  await expect(panel.getByTestId("usage-full")).toContainText(/New input, full price\s*\$/);
  // One percentage for what was read from cache: the split's.
  expect(((await panel.innerText()).match(/read from cache/gi) ?? []).length).toBe(1);

  // A compaction's own request is spend of the turn it ran in: a row of that turn, counted in
  // the cost. The cost is the session's, the figure the header shows.
  await request.post(`/api/sessions/${session.id}/compact`, { data: {} });
  const cost = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.usage.cost as number;
  await expect(turn.getByTestId("usage-requests").locator('tbody tr[data-what="compaction"]')).toHaveCount(1);
  await expect(turn.getByTestId("usage-compacted")).toBeVisible();
  // The reason is short, and the turn it names is a link to that turn.
  await expect(panel.getByTestId("usage-why")).toContainText(/Turn 2 is \d+% of it, .*with a compaction in it\./);
  expect(((await panel.getByTestId("usage-why").innerText()).match(/\./g) ?? []).length).toBeLessThanOrEqual(2);
  await turn.getByRole("button").first().click();
  await expect(turn.getByTestId("usage-requests")).toHaveCount(0);
  await panel.getByTestId("usage-why-turn").click();
  await expect(turn.getByTestId("usage-requests")).toBeVisible();
  // The headline is the header's figure, digit for digit, and the session's own cost.
  const shownText = await panel.getByTestId("usage-total").innerText();
  await expect(page.getByTestId("session-cost")).toHaveText(shownText);
  expect(Math.abs(Number(shownText.replace(/[^0-9.]/g, "")) - (await cost()))).toBeLessThan(0.00006);
  // The counts agree: the headline counts every row the turns list, a compaction's included.
  await expect(panel.getByTestId("usage-cost")).toContainText("2 turns, 3 requests");
  await expect(panel.getByTestId("usage-cost")).not.toContainText("a turn.");
  const rows = await turn.getByTestId("usage-requests").locator("tbody tr td:nth-child(2)").allInnerTexts();
  expect(rows.length).toBe(2);
  expect(rows.every((c) => c.startsWith("$") || c.startsWith("<$"))).toBe(true);
  await shoot(page, "tokens-04-why");
  // Money spent beside the turns (a side question here) is a row of its own under them, so the rows add up to the headline.
  await expect(panel.getByTestId("usage-beside")).toHaveCount(0);
  await request.post(`/api/sessions/${session.id}/side`, { data: { question: "In one word: which word came second?" } });
  await expect(panel.getByTestId("usage-beside")).toContainText("Beside the turns", { timeout: 60_000 });
  const usd = (t: string) => Number(t.replace(/[^0-9.]/g, ""));
  const parts = [...(await panel.getByTestId("usage-turn-cost").allInnerTexts()), await panel.getByTestId("usage-beside-cost").innerText()].map(usd);
  expect(usd(await panel.getByTestId("usage-beside-cost").innerText())).toBeGreaterThan(0);
  // (Each row is shown rounded: to the cent at most.)
  expect(Math.abs(parts.reduce((a, b) => a + b, 0) - usd(await panel.getByTestId("usage-total").innerText()))).toBeLessThan(0.0051 * parts.length);
  await panel.getByTestId("usage-beside").scrollIntoViewIfNeeded();
  await shoot(page, "tokens-05-beside");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(turn.getByTestId("usage-requests")).toBeVisible();
  // On a phone the request table is whole, its cost beside the request: nothing is cut off to the side.
  expect(await turn.getByTestId("usage-requests").locator(".k-scroll-x").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(turn.getByTestId("usage-requests").locator("th").nth(1)).toHaveText("Cost");
  for (const i of [1, 5]) await expect(turn.getByTestId("usage-requests").locator("th").nth(i)).toBeInViewport({ ratio: 1 });
  await shoot(page, "tokens-03-phone");
  await page.setViewportSize({ width: 1920, height: 1040 });

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// A page holds the few models it shows (the default, the ones its sessions
// run on). A session's earlier turn may have run on a model no session runs
// on any more: its price comes with the whole listing, which the panel reads.
// Without it the turn was unpriced and the panel fell back to tokens.
test("the tokens panel prices a turn that ran on a model the page does not hold", async ({ page, request }) => {
  const FIRST = "scripted:stand-in-text", THEN = "scripted:stand-in";
  const listed = ((await (await request.get("/api/models")).json()).models as { id: string }[]).map((m) => m.id);
  test.skip(!listed.includes(FIRST) || !listed.includes(THEN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: FIRST, title: "Two models, one bill" } })).json();
  const ends = async () => ((await (await request.get(`/api/sessions/${session.id}`)).json()).events as { kind: string }[]).filter((e) => e.kind === "turn_end").length;
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "One line." } });
  await expect.poll(ends, { timeout: 30_000 }).toBe(1);
  expect((await request.patch(`/api/sessions/${session.id}`, { data: { model: THEN } })).ok()).toBe(true);
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "Another line." } });
  await expect.poll(ends, { timeout: 30_000 }).toBe(2);
  // The page's first read holds the model the session runs on now, not the one it ran on.
  const brief = ((await (await request.get("/api/models?brief")).json()).models as { id: string }[]).map((m) => m.id);
  expect(brief).toContain(THEN);

  await page.goto(`/s/${session.id}`);
  await openPanel(page, "usage");
  const panel = page.getByTestId("tokens-panel");
  await expect(panel.getByTestId("usage-turn")).toHaveCount(2);
  await expect(panel.getByRole("heading", { name: "Where the money went" })).toBeVisible();
  await expect(panel.getByTestId("usage-split")).toContainText("of cost");
  await expect(panel.getByTestId("usage-full")).toContainText(/New input, full price\s*<?\$/);
});
