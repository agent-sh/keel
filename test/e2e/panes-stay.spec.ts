import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { ask, asksToRun, calls, cardIn, create, drop, folder, idle, open, row, scripted, settle } from "./answering.ts";
import { shoot } from "./shots.ts";

// Feature: a pane holds the session the owner put in it. Opening another
// session never takes that away: beside other panes it lies over the pane
// worked in as a look, with a bar that names the pane's session and leads back
// to it, and it is the pane's session only once it is placed (Keep here, a
// double click on its row, a drop, the menu of panes). What needs the owner is
// answered and left: by mouse (a row, the card, and the pane is back by
// itself) and by keyboard (the answering sequence ends where it began). After
// it both panes hold what they held, at the place in the conversation they
// were at, with the draft and the keyboard where they were. The start page
// lists what needs the owner in every layout, in a pane's width. A pane says
// before the click what a click on a row will do to it, and its header keeps
// the title readable beside the reason. No pane changes its session by itself.
test.use({ storageState: { cookies: [], origins: [] } });

const bridge = (page: Page) => page.getByTestId("bridge");
const slot = (page: Page, i: number) => bridge(page).locator(`:scope > [data-slot="${i}"]`);
// What each pane holds and shows, where its conversation is scrolled to, what its message box holds; and where the keyboard is.
type Pane = { holds: string | null; shows: string | null; top: number | null; draft: string | null; helm: boolean };
const look = (page: Page) => page.evaluate(() => {
  const on = (el: Element) => !el.closest("[inert]");
  const panes = [...document.querySelectorAll<HTMLElement>('[data-testid="bridge"] > [data-slot]')];
  const at = document.activeElement as HTMLElement | null;
  return {
    panes: panes.map((p): Pane => ({
      holds: p.dataset.holds ?? p.dataset.station ?? null,
      shows: p.dataset.station ?? null,
      top: (() => { const t = [...p.querySelectorAll<HTMLElement>(".k-reading")].find(on); return t ? Math.round(t.scrollTop) : null; })(),
      draft: [...p.querySelectorAll<HTMLTextAreaElement>('textarea[data-testid="composer"]')].find(on)?.value ?? null,
      helm: p.hasAttribute("data-helm"),
    })),
    keys: at && at !== document.body ? `${at.dataset.testid ?? at.tagName}@${panes.findIndex((p) => p.contains(at))}` : "nothing",
  };
});
// The same panes, the same places, the same drafts, the keyboard where it was.
async function same(page: Page, before: Awaited<ReturnType<typeof look>>) {
  await expect.poll(async () => (await look(page)).panes.map((p) => [p.holds, p.shows, p.helm]), { timeout: 15_000 }).toEqual(before.panes.map((p) => [p.holds, p.shows, p.helm]));
  await expect.poll(async () => (await look(page)).keys).toBe(before.keys);
  const after = await look(page);
  expect(after.panes.map((p) => p.draft)).toEqual(before.panes.map((p) => p.draft));
  for (const [i, p] of after.panes.entries()) expect(Math.abs((p.top ?? 0) - (before.panes[i]!.top ?? 0)), `pane ${i + 1} is at ${p.top}, it was at ${before.panes[i]!.top}`).toBeLessThan(4);
}
// A session with a long conversation, at rest.
async function long(request: APIRequestContext, title: string, ws: string) {
  const id = await create(request, title, ws);
  await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:fill" } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 30_000 }).toBe(true);
  return id;
}
// Scrolls a pane's conversation up with the wheel, as a reader does (no press: the helm stays where it is).
async function wheelUp(page: Page, i: number, by = 1400) {
  const b = (await slot(page, i).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, -by);
  await expect.poll(async () => { const p = (await look(page)).panes[i]!; return p.top; }).toBeGreaterThan(200);
  await page.waitForTimeout(400);
}
// Two panes: a session being read (scrolled up, a draft in its box, the keyboard there) and the coordinator.
async function reading(page: Page, reader: string, coord: string) {
  await open(page, [reader, coord]);
  await wheelUp(page, 0);
  await wheelUp(page, 1, 900);
  const box = slot(page, 0).getByTestId("composer");
  await box.click();
  await box.pressSequentially("draft: keep me");
  return look(page);
}
const question = { name: "AskUserQuestion", input: { questions: [{ header: "Order", question: "Which item goes first in the standup?", options: [{ label: "The importer" }, { label: "The release branch" }], multiSelect: false }] } };
async function asksWhich(request: APIRequestContext, title: string, ws: string) {
  const id = await create(request, title, ws);
  await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([question]) } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}/questions`)).json()).pending.length, { timeout: 30_000 }).toBe(1);
  return id;
}
// The question is answered with the pointer: an option, then Answer.
async function pick(page: Page, id: string, n: number) {
  const card = cardIn(page, id, "question");
  await card.getByTestId("question-option").nth(n).click();
  await card.getByTestId("question-submit").click();
  return 2;
}
const waiting = async (request: APIRequestContext, id: string) =>
  (await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals.length + (await (await request.get(`/api/sessions/${id}/questions`)).json()).pending.length;

test("three waiting sessions are answered by mouse and both panes are as they were", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("panes-stay-mouse");
  const reader = await long(request, "Spike: full-text search over the notes", ws);
  const coord = await long(request, "Coordinator: release train 2.4", ws);
  const before = await reading(page, reader, coord);
  expect(before.panes.map((p) => p.holds)).toEqual([reader, coord]);
  expect(before.keys).toBe("composer@0");

  // Typing in one pane while a card arrives in the other loses no character, and no pane changes by itself.
  const typed = " and the index is rebuilt nightly";
  for (const [i, ch] of [...typed].entries()) {
    if (i === 6) void request.post(`/api/sessions/${coord}/messages`, { data: { text: calls([question]) } });
    await page.keyboard.type(ch);
    await page.waitForTimeout(40);
  }
  await expect(cardIn(page, coord, "question")).toBeVisible();
  const during = await look(page);
  expect(during.panes[0]!.draft).toBe(`draft: keep me${typed}`);
  expect(during.keys).toBe("composer@0");
  expect(during.panes.map((p) => [p.holds, p.shows])).toEqual([[reader, reader], [coord, coord]]);
  await request.post(`/api/sessions/${coord}/interrupt`);
  await idle(request, coord);
  await expect(cardIn(page, coord, "question")).toHaveCount(0);
  const start = await look(page);

  // Three sessions wait: two questions and a command.
  const q1 = await asksWhich(request, "Standup notes for Thursday", ws);
  const run = await asksToRun(request, "Rotate the staging certificates", ws, "certs");
  const q2 = await asksWhich(request, "Fix the flaky upload test", ws);
  for (const id of [q1, run, q2]) await expect(row(page, id)).toHaveAttribute("data-watch", "need");

  // Before the click, the pane a row will change says so; one that is on screen says it is there.
  await row(page, q1).hover();
  await expect(slot(page, 0).getByTestId("pane-aim")).toHaveText("Opens here for a look");
  await expect(slot(page, 1).getByTestId("pane-aim")).toHaveCount(0);
  await shoot(page, "panes-stay-01-aim");
  await row(page, coord).hover();
  await expect(slot(page, 1).getByTestId("pane-aim")).toHaveText("Is here");

  // Each is opened from its row, answered on its card, and the pane is back by itself.
  let clicks = 0;
  const t0 = Date.now();
  for (const [n, id] of [q1, run, q2].entries()) {
    await row(page, id).click(); clicks++;
    if (n === 0) {
      // A look: the pane still holds its session and names it, with the way back and the way to keep the look.
      await expect(slot(page, 0)).toHaveAttribute("data-station", id);
      await expect(slot(page, 0)).toHaveAttribute("data-holds", reader);
      const bar = slot(page, 0).getByTestId("look-bar");
      await expect(bar.getByTestId("look-back")).toContainText("Back to");
      await expect(bar.getByTestId("look-back")).toContainText("Spike: full-text search over the notes");
      await expect(bar.getByTestId("look-keep")).toHaveText("Keep here");
      await expect(slot(page, 1)).toHaveAttribute("data-station", coord);
      await expect(cardIn(page, id, "question")).toBeVisible();
      await shoot(page, "panes-stay-02-look");
    }
    if (id === run) {
      const card = cardIn(page, id, "approval");
      await expect(card.getByTestId("approval")).toHaveAttribute("data-live", "true");
      await card.getByTestId("allow-once").click(); clicks++;
    } else {
      clicks += await pick(page, id, 1);
    }
    await expect.poll(() => waiting(request, id)).toBe(0);
    await expect(row(page, id)).not.toHaveAttribute("data-watch", "need");
  }
  const ms = Date.now() - t0;
  const shown = (await look(page)).panes.map((p) => p.shows);
  console.log(`TRIAGE mouse: 3 items, ${clicks} clicks${shown[0] === reader ? "" : " + 1 to come back"}, ${ms} ms; panes show [${shown.map((x) => (x === reader ? "reader" : x === coord ? "coordinator" : "another session")).join(", ")}]`);

  // Nothing else was pressed: the panes hold and show what they did, where they were, the draft and the keyboard with them.
  await same(page, start);
  await expect(slot(page, 0).getByTestId("look-bar")).toHaveCount(0);
  // Enter right after sends nothing by itself having been aimed at a card: the draft is still a draft.
  expect((await look(page)).panes[0]!.draft).toBe(`draft: keep me${typed}`);
  await shoot(page, "panes-stay-03-after");

  // The coordinator itself asks, in its own pane. Gone to from its row and answered there, the owner is
  // back in the reader's pane, the keyboard in its box: a session that waits is one to answer and leave.
  await request.post(`/api/sessions/${coord}/messages`, { data: { text: calls([question]) } });
  await expect(row(page, coord)).toHaveAttribute("data-watch", "need");
  await row(page, coord).click();
  await expect(slot(page, 1)).toHaveAttribute("data-helm", "true");
  await pick(page, coord, 0);
  await expect.poll(() => waiting(request, coord)).toBe(0);
  await expect(slot(page, 0)).toHaveAttribute("data-helm", "true");
  await expect.poll(async () => (await look(page)).keys).toBe("composer@0");
  expect((await look(page)).panes.map((p) => [p.holds, p.shows, p.draft])).toEqual(start.panes.map((p) => [p.holds, p.shows, p.draft]));
  expect(Math.abs((await look(page)).panes[0]!.top! - start.panes[0]!.top!)).toBeLessThan(4);
  // Answered by a press in its own pane instead, they stay there: they went to that pane themselves.
  await idle(request, coord);
  await request.post(`/api/sessions/${coord}/messages`, { data: { text: calls([question]) } });
  await expect(cardIn(page, coord, "question")).toBeVisible();
  await pick(page, coord, 1);
  await expect.poll(() => waiting(request, coord)).toBe(0);
  await expect(slot(page, 1)).toHaveAttribute("data-helm", "true");
  await expect(slot(page, 0)).toHaveAttribute("data-station", reader);
  await drop(request, reader, coord, q1, run, q2);
});

test("the answering sequence ends where it began", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("panes-stay-keys");
  const reader = await long(request, "Spike: full-text search over the notes", ws);
  const coord = await long(request, "Coordinator: release train 2.4", ws);
  const a = await asksToRun(request, "Build the docs", ws, "docs");
  const q = await asksWhich(request, "Pick the standup order", ws);
  const b = await asksToRun(request, "Tag the release", ws, "tag");
  const before = await reading(page, reader, coord);
  for (const id of [a, q, b]) await expect(row(page, id)).toHaveAttribute("data-watch", "need");

  // Only the keyboard from here. One key goes to the one that waited longest; each answer opens the next.
  let keys = 0;
  const press = async (k: string) => { keys++; await page.keyboard.press(k); };
  const t0 = Date.now();
  await press("Alt+a");
  for (const id of [a, q, b]) {
    await expect(page).toHaveURL(new RegExp(`/s/${id}$`));
    // Each is a look over the pane the sequence began in; the coordinator keeps its pane.
    await expect(slot(page, 0)).toHaveAttribute("data-station", id);
    await expect(slot(page, 0)).toHaveAttribute("data-holds", reader);
    await expect(slot(page, 1)).toHaveAttribute("data-station", coord);
    if (id === q) {
      const card = cardIn(page, id, "question");
      await expect(card).toBeFocused();
      await expect(card).toHaveAttribute("data-keys", "ready");
      await press("2");
    } else {
      const card = cardIn(page, id, "approval");
      await expect(card.getByTestId("allow-once")).toBeFocused();
      await expect(card.getByTestId("approval")).toHaveAttribute("data-live", "true");
      await press("Enter");
    }
    await expect.poll(() => waiting(request, id)).toBe(0);
  }
  await expect(page.locator(".k-tip")).toHaveText("Nothing else waits for you.");
  const ms = Date.now() - t0;
  const shown = (await look(page)).panes.map((p) => p.shows);
  console.log(`TRIAGE keys: 3 items, ${keys} keys, ${ms} ms; panes show [${shown.map((x) => (x === reader ? "reader" : x === coord ? "coordinator" : "another session")).join(", ")}]`);
  expect(keys).toBe(4);

  // Where it began: the same panes, the place in each conversation, the draft, and the keyboard in the reader's box.
  await same(page, before);
  await expect(page).toHaveURL(new RegExp(`/s/${reader}$`));
  // One step back in the browser does not lead into the sequence again.
  await shoot(page, "panes-stay-04-sequence-ended");
  await drop(request, reader, coord, a, q, b);
});

test("a look is left by Escape and by Back, and kept only when it is placed", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("panes-stay-place");
  const reader = await long(request, "Spike: full-text search over the notes", ws);
  const coord = await long(request, "Coordinator: release train 2.4", ws);
  const other = await long(request, "Draft the 2.4 changelog", ws);
  const more = await long(request, "Bench the cache under load", ws);
  const before = await reading(page, reader, coord);

  // A row opens a look; Escape leaves it, and the pane is as it was.
  await page.evaluate(() => { (window as any).__swaps = []; addEventListener("keel:pane-swap", (e) => (window as any).__swaps.push((e as CustomEvent).detail)); });
  await row(page, other).click();
  await expect(slot(page, 0)).toHaveAttribute("data-station", other);
  await expect(slot(page, 0)).toHaveAttribute("data-look", "");
  await expect(slot(page, 0).locator('.k-view[data-view="look"]').getByTestId("composer")).toBeFocused();
  // Nothing spills from the row of panes while a look lies over one.
  expect(await bridge(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await page.keyboard.press("Escape");
  await same(page, before);
  // The page is told when a pane's session goes under a look and when it shows again (for whoever keeps a place per session).
  expect(await page.evaluate(() => (window as any).__swaps)).toEqual([{ session: reader, slot: 0, state: "covered" }, { session: reader, slot: 0, state: "restored" }]);
  // The browser's Back undoes it too.
  await row(page, other).click();
  await expect(slot(page, 0)).toHaveAttribute("data-station", other);
  await page.goBack();
  await expect(slot(page, 0)).toHaveAttribute("data-station", reader);
  await expect(slot(page, 0).getByTestId("look-bar")).toHaveCount(0);
  expect((await look(page)).panes.map((p) => [p.holds, p.top])).toEqual(before.panes.map((p) => [p.holds, p.top]));
  // So does its bar; and the next look takes the place of the one before it, never of the pane's session.
  await row(page, other).click();
  await row(page, more).click();
  await expect(slot(page, 0)).toHaveAttribute("data-station", more);
  await expect(slot(page, 0)).toHaveAttribute("data-holds", reader);
  // A press in the other pane leaves the look where it is: a pane changes only by an act on it.
  await slot(page, 1).getByTestId("composer").click();
  await expect(slot(page, 1)).toHaveAttribute("data-helm", "true");
  await expect(slot(page, 0)).toHaveAttribute("data-station", more);
  await slot(page, 0).getByTestId("look-back").click();
  await expect(slot(page, 0)).toHaveAttribute("data-station", reader);
  expect((await look(page)).panes.map((p) => [p.holds, p.shows, p.top, p.draft])).toEqual(before.panes.map((p) => [p.holds, p.shows, p.top, p.draft]));

  // Keep here places it: the pane holds the look from now on, at the place the look was read at.
  await row(page, other).click();
  await wheelUp(page, 0, 700);
  const at = (await look(page)).panes[0]!.top!;
  await slot(page, 0).getByTestId("look-keep").click();
  await expect(slot(page, 0)).toHaveAttribute("data-holds", other);
  await expect(slot(page, 0)).not.toHaveAttribute("data-look", "");
  await expect(slot(page, 0).getByTestId("look-bar")).toHaveCount(0);
  expect(Math.abs((await look(page)).panes[0]!.top! - at)).toBeLessThan(4);
  // A double click on a row places it as well; the key does too.
  await row(page, more).dblclick();
  await expect(slot(page, 0)).toHaveAttribute("data-holds", more);
  await expect(slot(page, 0).getByTestId("look-bar")).toHaveCount(0);
  await row(page, reader).click();
  await expect(slot(page, 0)).toHaveAttribute("data-look", "");
  await page.keyboard.press("Alt+k");
  await expect(slot(page, 0)).toHaveAttribute("data-holds", reader);
  await expect(slot(page, 0).getByTestId("look-bar")).toHaveCount(0);
  // Kept over a reload: the layout, and a look with the session under it.
  await row(page, other).click();
  await expect(slot(page, 0)).toHaveAttribute("data-look", "");
  await page.reload();
  await expect(slot(page, 0)).toHaveAttribute("data-station", other);
  await expect(slot(page, 0)).toHaveAttribute("data-holds", reader);
  await expect(slot(page, 1)).toHaveAttribute("data-station", coord);
  await expect(slot(page, 0).locator(".k-reading")).toContainText("lorem ipsum");
  expect(await bridge(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await slot(page, 0).getByTestId("look-back").click();
  await expect(slot(page, 0)).toHaveAttribute("data-station", reader);
  await drop(request, reader, coord, other, more);
});

test("the start page lists what needs the owner in a pane beside others, and a pane's header keeps its title", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("panes-stay-home");
  const reader = await long(request, "Spike: full-text search over the notes", ws);
  const coord = await create(request, "Coordinator: release train 2.4", ws);
  await ask(request, coord, "approval", "release");
  const q = await asksWhich(request, "Standup notes for Thursday", ws);
  const run = await asksToRun(request, "Rotate the staging certificates", ws, "certs");
  // Panes of about 480 px: the narrowest a pane gets beside the list.
  await page.setViewportSize({ width: 1290, height: 900 });
  await open(page, [reader, coord]);
  await wheelUp(page, 0);
  const before = await look(page);

  // The coordinator's header: its title whole, the reason beside or under it, cut where the pane ends.
  const head = slot(page, 1).getByTestId("station-head");
  await expect(head.getByTestId("station-why")).toBeVisible();
  expect(await head.getByTestId("station-title").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "the title is cut").toBe(true);
  expect(await head.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

  // The start page over the reader's pane: the same headline and rows as with one pane, in the pane's width.
  await page.getByRole("button", { name: "New session" }).first().click();
  const home = slot(page, 0);
  await expect(home.getByTestId("new-composer")).toBeVisible();
  await expect(home.getByTestId("home-count-need")).toContainText("3 need you");
  await expect(home.getByTestId("home-session")).toHaveCount(3);
  await expect(home.locator(`[data-testid="home-session"][data-session="${run}"]`).getByTestId("home-allow")).toBeVisible();
  await expect(home.locator(`[data-testid="home-session"][data-session="${q}"]`).getByTestId("home-review")).toHaveText("Answer");
  const fits = await home.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const out = [...el.querySelectorAll<HTMLElement>('.k-view:not([inert]) [data-testid="home-lists"] *, .k-view:not([inert]) [data-testid="home-start"] *')].filter((x) => { const r = x.getBoundingClientRect(); return r.width > 1 && (r.left < box.left - 1 || r.right > box.right + 1); });
    return { width: Math.round(box.width), out: out.map((x) => `${x.tagName.toLowerCase()}.${x.className} ${Math.round(x.getBoundingClientRect().left - box.left)}..${Math.round(x.getBoundingClientRect().right - box.left)}`) };
  });
  expect(fits.width).toBeLessThan(500);
  expect(fits.out).toEqual([]);
  // The pane still holds the reader, and says so.
  await expect(home).toHaveAttribute("data-holds", reader);
  await expect(home.getByTestId("look-back")).toContainText("Spike: full-text search over the notes");
  await shoot(page, "panes-stay-05-home-pane-480");

  // A row's Answer opens that session as a look; answering leads back to the list, which has one row fewer.
  const answer = home.locator(`[data-testid="home-session"][data-session="${q}"]`).getByTestId("home-review");
  await expect(answer).not.toHaveAttribute("aria-disabled", "true");
  await answer.click();
  await expect(slot(page, 0)).toHaveAttribute("data-station", q);
  await pick(page, q, 0);
  await expect(page).toHaveURL(/\/$/);
  await expect(home.getByTestId("home-session")).toHaveCount(2);
  // Escape leaves the start page: the pane shows the reader where it was read.
  await page.keyboard.press("Escape");
  await expect(slot(page, 0)).toHaveAttribute("data-station", reader);
  expect(Math.abs((await look(page)).panes[0]!.top! - before.panes[0]!.top!)).toBeLessThan(4);

  // An empty pane says the same: the headline and the rows, answered from there.
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.getByTestId("panes-3").click();
  const empty = page.getByTestId("pane-empty");
  await expect(empty.getByTestId("home-count-need")).toContainText("2 need you");
  await expect(empty.getByTestId("home-session")).toHaveCount(2);
  await shoot(page, "panes-stay-06-empty-pane");
  await drop(request, reader, coord, q, run);
});

test("four panes, a smaller window and a phone", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("panes-stay-sizes");
  const reader = await long(request, "Spike: full-text search over the notes", ws);
  const coord = await create(request, "Coordinator: release train 2.4", ws);
  await ask(request, coord, "approval", "release");
  const bench = await long(request, "Bench the cache under load", ws);
  const port = await long(request, "Port the parser to the new tokenizer", ws);
  const q = await asksWhich(request, "Standup notes for Thursday", ws);

  // Four panes: the helm is the one with the rule; a look lies over it, and the other three hold what they held.
  await open(page, [reader, coord, bench, port]);
  await row(page, q).click();
  await expect(slot(page, 0)).toHaveAttribute("data-station", q);
  expect((await look(page)).panes.map((p) => p.holds)).toEqual([reader, coord, bench, port]);
  expect((await look(page)).panes.map((p) => p.helm)).toEqual([true, false, false, false]);
  expect(await bridge(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const headsFit = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="station-head"]')].filter((h) => !h.closest("[inert]")).every((h) => {
    const box = h.getBoundingClientRect();
    return [...h.querySelectorAll<HTMLElement>("*")].every((x) => { const r = x.getBoundingClientRect(); return r.width === 0 || (r.left >= box.left - 1 && r.right <= box.right + 1); });
  }));
  expect(await headsFit(), "a header spills from its pane").toBe(true);
  // The bar fits a narrow pane: the way back and Keep here are whole, the title is cut.
  const bar = slot(page, 0).getByTestId("look-bar");
  expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await expect(bar.getByTestId("look-keep")).toBeVisible();
  await row(page, bench).hover();
  await expect(slot(page, 2).getByTestId("pane-aim")).toHaveText("Is here");
  await shoot(page, "panes-stay-07-four-panes");
  await page.keyboard.press("Escape");
  await expect(slot(page, 0)).toHaveAttribute("data-station", reader);

  // Two panes of 800 px: the coordinator's title is whole beside a long reason.
  await open(page, [reader, coord]);
  const head = slot(page, 1).getByTestId("station-head");
  await expect(head.getByTestId("station-why")).toContainText("Approve Bash");
  expect(await head.getByTestId("station-title").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "the title is cut").toBe(true);
  // The whole reason is its tooltip, and the keys on the header's tools show both whole.
  expect(await head.getByTestId("station-why").getAttribute("title")).toContain("echo release > release.txt");
  await row(page, q).click();
  await expect(slot(page, 0)).toHaveAttribute("data-look", "");
  expect(await headsFit(), "a header spills from its pane").toBe(true);
  await shoot(page, "panes-stay-08-two-panes-look");

  // A smaller window.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(slot(page, 0)).toHaveAttribute("data-station", q);
  expect(await bridge(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await headsFit(), "a header spills from its pane").toBe(true);
  await shoot(page, "panes-stay-09-1440");

  // A phone has pages, not panes: no look, the session itself.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(`section.k-station[data-station="${q}"]`)).toBeVisible();
  await expect(page.getByTestId("look-bar")).toHaveCount(0);
  await shoot(page, "panes-stay-10-phone");
  await page.goto("/");
  await expect(page.getByTestId("home-count-need")).toContainText("2 need you");
  await shoot(page, "panes-stay-11-phone-home");
  await drop(request, reader, coord, bench, port, q);
});
