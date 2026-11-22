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
// The bar's sentence about the pane's own session: which of its parts show, and how much of the name.
const barSays = (page: Page, i: number) => slot(page, i).getByTestId("look-says").evaluate((p) => {
  const box = p.getBoundingClientRect();
  const shown = (el: Element | null) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1; };
  const title = p.querySelector<HTMLElement>('[data-testid="look-title"]')!, state = p.querySelector<HTMLElement>('[data-testid="look-state"]');
  return {
    first: shown(p.querySelector(".k-look-this")), lead: shown(p.querySelector(".k-look-lead")), state: shown(state),
    name: Math.round(title.clientWidth), cut: title.scrollWidth > title.clientWidth + 1,
    gap: state ? Math.round(state.getBoundingClientRect().left - title.getBoundingClientRect().right) : 0,
  };
});
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
  await request.post(`/api/sessions/${coord}/interrupt`, { data: { by: "owner" } });
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
      // The bar says what this is and whose pane it is, then the two acts with their keys.
      const bar = slot(page, 0).getByTestId("look-bar");
      await expect(bar.getByTestId("look-says")).toHaveText("Looking at Standup notes for Thursday. This pane holds Spike: full-text search over the notes.");
      await expect(bar.getByTestId("look-back")).toHaveText("BackEsc");
      await expect(bar.getByTestId("look-keep")).toHaveText("Keep hereAltK");
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
  await expect(home.getByTestId("look-says")).toHaveText("The start page. This pane holds Spike: full-text search over the notes.");
  // What needs the owner comes first, above the start box, as in an empty pane.
  expect((await home.getByTestId("home-attention").boundingBox())!.y).toBeLessThan((await home.getByTestId("new-composer").boundingBox())!.y);
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
  await slot(page, 0).getByTestId("look-back").click();
  await expect(slot(page, 0)).toHaveAttribute("data-station", reader);
  // Left unanswered, the pane says where what still waits went.
  await expect(slot(page, 0).getByTestId("pane-note")).toHaveText("Standup notes for Thursday still needs you, in the list");
  // A look over the coordinator, which needs the owner, in a pane this narrow: the bar still names it. "This pane
  // holds" gives way before the name does, the state is said after the name, and nothing stands between the two.
  await slot(page, 1).getByTestId("composer").click();
  await expect(slot(page, 1)).toHaveAttribute("data-helm", "true");
  await row(page, q).click();
  await expect(slot(page, 1)).toHaveAttribute("data-station", q);
  // (The pointer still on the row of the session now shown: the bar keeps its sentences.)
  await expect(slot(page, 1).getByTestId("look-state")).toHaveText("needs you.");
  const narrow = await barSays(page, 1);
  expect((await slot(page, 1).boundingBox())!.width).toBeLessThan(450);
  expect(narrow.state, "the bar does not say that the pane's session needs the owner").toBe(true);
  expect(narrow.lead, "the words stay while the name is cut short").toBe(false);
  expect(narrow.name, "the name of the pane's session is cut to under eight characters").toBeGreaterThan(64);
  expect(narrow.gap).toBeLessThan(7);
  await shoot(page, "panes-stay-16-narrow-bar-needs-you");
  await slot(page, 1).getByTestId("look-back").click();
  await expect(slot(page, 1)).toHaveAttribute("data-station", coord);
  await slot(page, 0).getByTestId("composer").click();

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
  // Opened there, its title is read whole: beside the tools, on a second line when it is long. The reason has the line under it.
  await page.goto(`/s/${q}`);
  const phone = page.locator(`section.k-station[data-station="${q}"]`);
  await expect.poll(async () => Math.round((await phone.boundingBox())!.x)).toBe(0);
  expect(await phone.getByTestId("station-title").evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1), "the title is cut on a phone").toBe(true);
  expect(await phone.getByTestId("station-head").evaluate((h) => h.querySelector('[data-testid="station-why"]')!.getBoundingClientRect().top >= h.querySelector('[data-testid="station-title"]')!.getBoundingClientRect().bottom - 1)).toBe(true);
  await shoot(page, "panes-stay-10-phone");
  await page.goto("/");
  await expect(page.getByTestId("home-count-need")).toContainText("2 need you");
  await shoot(page, "panes-stay-11-phone-home");
  await drop(request, reader, coord, bench, port, q);
});

// A session at work until the test ends it: its turn holds for a file that never comes.
async function works(request: APIRequestContext, id: string, ws: string) {
  await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:hold ${ws}/never-${id.slice(-6)}` } });
  await expect.poll(() => phase(request, id), { timeout: 30_000 }).toBe("working");
}
const phase = async (request: APIRequestContext, id: string) => ((await (await request.get("/api/sessions")).json()).sessions as { id: string; phase: string }[]).find((s) => s.id === id)?.phase;
const tip = (page: Page) => page.locator(".k-tip");
// What a held Escape says: within the settle time of the pane showing again, and from then on.
const SOON = "Esc stops the turn in a moment", AGAIN = "Esc again stops the turn";
const HELD = /^Esc (again stops the turn|stops the turn in a moment)$/;

test("Escape goes back in a look and never stops the pane's own turn right after", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("panes-stay-esc");
  const coord = await long(request, "Coordinator: release train 2.4", ws);
  const reader = await long(request, "Spike: full-text search over the notes", ws);
  const other = await long(request, "Draft the 2.4 changelog", ws);
  await works(request, coord, ws);
  await works(request, other, ws);
  await open(page, [coord, reader]);

  // A look over the working coordinator; the look works too. Escape leaves the look and stops neither.
  // The next Escape, at each gap, stops nothing: it says how to stop.
  for (const gap of [150, 400, 1000, 2500]) {
    await row(page, other).click();
    await expect(slot(page, 0)).toHaveAttribute("data-station", other);
    await expect(slot(page, 0).locator('.k-view[data-view="look"]').getByTestId("composer")).toBeFocused();
    // Stop is the same mark in a look as in any pane, with no words of its own.
    await expect(slot(page, 0).locator('.k-view[data-view="look"]').getByTestId("stop")).toHaveText("");
    await expect(slot(page, 0).locator('.k-view[data-view="look"]').getByTestId("stop")).toHaveAttribute("aria-label", "Stop the turn");
    await page.keyboard.press("Escape");
    await expect(slot(page, 0)).toHaveAttribute("data-station", coord);
    // The look's turn goes on, and the pane says where it went, in the room under the message box and clear of it.
    await expect(slot(page, 0).getByTestId("pane-note")).toHaveText("Draft the 2.4 changelog keeps working, in the list");
    if (gap === 150) {
      expect(await slot(page, 0).evaluate((p) => {
        const box = [...p.querySelectorAll('[data-testid="composer-box"]')].find((x) => !x.closest("[inert]"))!;
        return p.querySelector('[data-testid="pane-note"]')!.getBoundingClientRect().top - box.getBoundingClientRect().bottom;
      }), "the note touches the message box").toBeGreaterThanOrEqual(3);
      await shoot(page, "panes-stay-17-note-under-the-box");
    }
    await page.waitForTimeout(gap);
    await page.keyboard.press("Escape");
    await expect(tip(page)).toHaveText(gap >= 1000 ? AGAIN : HELD);
    await page.waitForTimeout(700);
    expect(await phase(request, coord), `Escape ${gap} ms after the look was left`).toBe("working");
    expect(await phase(request, other)).toBe("working");
  }
  await expect(page.getByTestId("announce-status")).toHaveCount(1);

  // After an answer the look leaves by itself and the keyboard is in the coordinator's box: Escape there stops nothing either.
  for (const gap of [300, 800, 1500]) {
    const q = await asksWhich(request, `Standup notes ${gap}`, ws);
    await expect(row(page, q)).toHaveAttribute("data-watch", "need");
    await row(page, q).click();
    await pick(page, q, 0);
    await expect(slot(page, 0)).toHaveAttribute("data-station", coord);
    await expect(slot(page, 0).getByTestId("composer")).toBeFocused();
    await page.waitForTimeout(gap);
    await page.keyboard.press("Escape");
    await expect(tip(page)).toHaveText(gap >= 1000 ? AGAIN : HELD);
    await page.waitForTimeout(700);
    expect(await phase(request, coord), `Escape ${gap} ms after the answered look left`).toBe("working");
    await drop(request, q);
  }
  // A key that was on its way when the pane came back ends nothing (the owner did not go to that pane): a letter
  // as the keyboard arrives in the coordinator's box, then Escape a quarter of a second later, stops nothing.
  {
    const q = await asksWhich(request, "Standup notes, a letter first", ws);
    await expect(row(page, q)).toHaveAttribute("data-watch", "need");
    await row(page, q).click();
    await pick(page, q, 0);
    await page.waitForFunction((id) => { const p = document.querySelector<HTMLElement>('[data-testid="bridge"] > [data-slot="0"]'); return p?.dataset.station === id && document.activeElement?.getAttribute("data-testid") === "composer" && p.contains(document.activeElement); }, coord, { polling: "raf" });
    await page.keyboard.type("a");
    await page.waitForTimeout(250);
    await page.keyboard.press("Escape");
    await expect(tip(page)).toHaveText(HELD);
    await page.waitForTimeout(700);
    expect(await phase(request, coord), "a letter, then Escape, after the answered look left").toBe("working");
    await expect(slot(page, 0).getByTestId("composer")).toHaveValue("a");
    await page.keyboard.press("Backspace");
    await drop(request, q);
  }

  // The start page over the working coordinator's pane: Escape leaves it, Escape again stops nothing.
  await page.keyboard.press("Control+Shift+o");
  await expect(slot(page, 0).getByTestId("new-composer")).toBeVisible();
  await page.keyboard.press("Escape");
  // Escape again and again, at once: nothing stops, and what it says is true while it shows. Within the settle time
  // Escape does not stop the turn yet, and the words say so; they change by themselves at the moment it does.
  for (let i = 0; i < 3; i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(120); }
  await expect(tip(page)).toHaveText(SOON);
  await expect(slot(page, 0)).toHaveAttribute("data-station", coord);
  expect(await phase(request, coord)).toBe("working");
  await expect(tip(page)).toHaveText(AGAIN, { timeout: 3000 });
  expect(await phase(request, coord)).toBe("working");
  // Said, and meant: the next Escape stops the turn, as it does in any pane.
  await page.keyboard.press("Escape");
  await expect.poll(() => phase(request, coord), { timeout: 15_000 }).not.toBe("working");

  // On a card of a look Escape is the card's key, from the first moment: the look stays, and its bar does not offer
  // that key. It names the one that leads back from a card instead: Shift Escape.
  const run = await asksToRun(request, "Rotate the staging certificates", ws, "certs");
  await expect(row(page, run)).toHaveAttribute("data-watch", "need");
  await row(page, run).click();
  const card = cardIn(page, run, "approval");
  const escKey = slot(page, 0).getByTestId("look-back").locator(".k-look-esc"), shiftKey = slot(page, 0).getByTestId("look-back").locator(".k-look-shift");
  await expect(card).toBeFocused();
  await expect(escKey).toBeHidden();
  await expect(shiftKey).toBeVisible();
  await expect(shiftKey).toHaveText("ShiftEsc");
  await shoot(page, "panes-stay-18-bar-names-shift-esc");
  await page.keyboard.press("Escape");
  await expect(slot(page, 0)).toHaveAttribute("data-station", run);
  await expect(card.getByTestId("approval")).toHaveAttribute("data-live", "true");
  await page.keyboard.press("Escape");
  await expect(slot(page, 0)).toHaveAttribute("data-station", run);
  expect(await waiting(request, run)).toBe(1);
  // From the look's message box Escape goes back, and the bar says so.
  await slot(page, 0).locator('.k-view[data-view="look"]').getByTestId("composer").click();
  await expect(escKey).toBeVisible();
  await expect(shiftKey).toBeHidden();
  // The bar offers Escape only where it leads back. Not while the keyboard is in a field that keeps Escape for
  // itself: in the list's filter Escape leaves the look where it is.
  await page.getByTestId("list-filter").focus();
  await expect(escKey).toBeHidden();
  await expect(shiftKey).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(slot(page, 0)).toHaveAttribute("data-station", run);
  await slot(page, 0).locator('.k-view[data-view="look"]').getByTestId("composer").click();
  await expect(escKey).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(slot(page, 0)).toHaveAttribute("data-station", coord);
  // From a card, the key the bar names leads back in one press, and the request still waits.
  await row(page, run).click();
  await expect(card).toBeFocused();
  await expect(shiftKey).toBeVisible();
  await page.keyboard.press("Shift+Escape");
  await expect(slot(page, 0)).toHaveAttribute("data-station", coord);
  await expect(slot(page, 0).getByTestId("look-bar")).toHaveCount(0);
  expect(await waiting(request, run)).toBe(1);
  // And from its reason field, once the denial was begun.
  await row(page, run).click();
  await expect(card).toBeFocused();
  await card.getByTestId("deny").click();
  await expect(card.getByTestId("deny-reason")).toBeFocused();
  await expect(shiftKey).toBeVisible();
  await page.keyboard.press("Shift+Escape");
  await expect(slot(page, 0)).toHaveAttribute("data-station", coord);
  expect(await waiting(request, run)).toBe(1);
  await drop(request, coord, reader, other, run);
});

// Escape that follows the close of a palette, a menu or the slash menu by a key is the same double
// press: within the settle time it stops nothing and says how to stop. So is the first Escape after
// a press that brought another pane to the helm to read it: it says how first. Once said, the next
// Escape after the settle time stops the turn, as in any pane.
test("Escape right after a palette, a menu or the slash menu closed, or a click to read another pane, stops nothing and says how", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("panes-stay-esc-close");
  const mine = await long(request, "The pane I am in", ws);
  const beside = await long(request, "The other pane", ws);
  await works(request, mine, ws);
  await works(request, beside, ws);
  await open(page, [mine, beside]);
  const box = slot(page, 0).getByTestId("composer");
  await box.click();
  // The palette, with words typed, closed by Escape; Escape again 200 ms later.
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("palette-input")).toBeVisible();
  await page.keyboard.type("abc");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette-input")).toBeHidden();
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await expect(tip(page)).toHaveText(HELD);
  await page.waitForTimeout(700);
  expect(await phase(request, mine), "Escape 200 ms after the palette closed").toBe("working");
  expect(await phase(request, beside)).toBe("working");
  await shoot(page, "panes-stay-19-esc-after-palette");
  // Said, and meant: after the settle time the next Escape stops the turn.
  await expect(tip(page)).toHaveText(AGAIN, { timeout: 3000 });
  await page.keyboard.press("Escape");
  await expect.poll(() => phase(request, mine), { timeout: 15_000 }).not.toBe("working");
  expect(await phase(request, beside)).toBe("working");
  // The slash menu of the message box, closed by Escape; Escape again 200 ms later.
  await works(request, mine, ws);
  await box.click();
  await page.keyboard.type("/");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("slash-menu")).toBeHidden();
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await expect(tip(page)).toHaveText(HELD);
  await page.waitForTimeout(700);
  expect(await phase(request, mine), "Escape 200 ms after the slash menu closed").toBe("working");
  await expect(box).toHaveValue("/");
  await box.fill("");
  // A menu (the session's) closed by Escape, then Escape again.
  await slot(page, 0).getByTestId("session-menu").click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await expect(tip(page)).toHaveText(HELD);
  await page.waitForTimeout(700);
  expect(await phase(request, mine), "Escape 200 ms after a menu closed").toBe("working");
  // A click in the other pane's conversation, to read it: its first Escape says how to stop, and stops nothing.
  await page.waitForTimeout(1200);
  const reading = slot(page, 1).locator(".k-reading").first();
  const r = (await reading.boundingBox())!;
  await page.mouse.click(r.x + r.width / 2, r.y + Math.min(300, r.height / 2));
  await expect(slot(page, 1)).toHaveAttribute("data-helm", "true");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await expect(tip(page)).toHaveText(HELD);
  await page.waitForTimeout(700);
  expect(await phase(request, beside), "Escape after a click to read the other pane").toBe("working");
  expect(await phase(request, mine)).toBe("working");
  // A press on its message box is going there to work: Escape stops its turn.
  await page.waitForTimeout(1200);
  await slot(page, 1).getByTestId("composer").click();
  await page.keyboard.press("Escape");
  await expect.poll(() => phase(request, beside), { timeout: 15_000 }).not.toBe("working");
  expect(await phase(request, mine)).toBe("working");
  await drop(request, mine, beside);
});

test("the first pane is drawn once, a double click places only the row it began on, and what the owner starts is placed", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("panes-stay-first");
  const reader = await long(request, "Spike: full-text search over the notes", ws);
  const coord = await long(request, "Coordinator: release train 2.4", ws);
  const a = await long(request, "Draft the 2.4 changelog", ws);
  const b = await long(request, "Bench the cache under load", ws);

  // A browser with no kept layout: the session is asked for once.
  const asked: string[] = [];
  page.on("request", (r) => { if (r.method() === "GET" && new URL(r.url()).pathname === `/api/sessions/${reader}`) asked.push(r.url()); });
  await page.goto("/api/daemon");
  await page.evaluate(() => { localStorage.removeItem("keel.panes"); localStorage.setItem("keel.focus", "false"); });
  await page.goto(`/s/${reader}`);
  await expect(slot(page, 0).locator(".k-reading")).toContainText("lorem ipsum");
  await page.waitForTimeout(1500);
  expect(asked.length, "the session was asked for more than once").toBe(1);

  // The list moved between the two clicks of a double click: the second hit another row. Nothing is placed; that row is a look.
  await open(page, [reader, coord]);
  const at = async (id: string) => { const r = (await row(page, id).boundingBox())!; return { x: r.x + 60, y: r.y + r.height / 2 }; };
  const pa = await at(a), pb = await at(b);
  await page.mouse.click(pa.x, pa.y);
  await page.mouse.move(pb.x, pb.y);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await expect(slot(page, 0)).toHaveAttribute("data-station", b);
  await expect(slot(page, 0)).toHaveAttribute("data-holds", reader);
  await expect(slot(page, 0).getByTestId("look-bar")).toBeVisible();
  // Both clicks on one row place it.
  await row(page, a).dblclick();
  await expect(slot(page, 0)).toHaveAttribute("data-holds", a);
  await expect(slot(page, 0).getByTestId("look-bar")).toHaveCount(0);

  // A session started from the start page over a pane is that pane's session: no look, and the pane says where the former one is.
  await open(page, [reader, coord]);
  await page.keyboard.press("Control+Shift+o");
  const box = slot(page, 0).getByTestId("new-composer").getByTestId("composer");
  await box.fill("Write the release notes");
  await box.press("Enter");
  await expect(slot(page, 0)).not.toHaveAttribute("data-holds", reader);
  await expect(slot(page, 0).getByTestId("look-bar")).toHaveCount(0);
  await expect(slot(page, 0)).toHaveAttribute("data-station", /./);
  await expect(slot(page, 0).getByTestId("pane-note")).toHaveText("Spike: full-text search over the notes is in the list");
  await expect(slot(page, 1)).toHaveAttribute("data-station", coord);
  const made = (await slot(page, 0).getAttribute("data-station"))!;
  expect(await slot(page, 0).getAttribute("data-holds")).toBe(made);
  // A fork takes the pane of the session it was made from.
  await idle(request, made);
  await slot(page, 0).getByTestId("session-menu").click();
  await page.getByTestId("menu-fork").click();
  await expect(slot(page, 0)).not.toHaveAttribute("data-station", made);
  const fork = (await slot(page, 0).getAttribute("data-station"))!;
  expect(await slot(page, 0).getAttribute("data-holds")).toBe(fork);
  await expect(slot(page, 0).getByTestId("look-bar")).toHaveCount(0);
  await drop(request, reader, coord, a, b, made, fork);
});

test("answering leaves a look only when the owner came to answer, and the bar says what waits under it", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  test.setTimeout(240_000);
  const ws = folder("panes-stay-read");
  const reader = await long(request, "Spike: full-text search over the notes", ws);
  const coord = await long(request, "Coordinator: release train 2.4", ws);
  const start = await reading(page, reader, coord);
  // What the owner did in the look before answering, and whether the pane then returns by itself.
  const cases: [string, (id: string) => Promise<void>][] = [
    ["scrolled its conversation with the wheel", async () => { const b = (await slot(page, 0).boundingBox())!; await page.mouse.move(b.x + b.width / 2, b.y + 300); await page.mouse.wheel(0, -200); }],
    ["pressed in its conversation", async () => { await slot(page, 0).locator('.k-view[data-view="look"] .k-reading').click({ position: { x: 40, y: 40 } }); }],
    ["scrolled it with a key from its empty box", async () => { await slot(page, 0).locator('.k-view[data-view="look"]').getByTestId("composer").focus(); await page.keyboard.press("PageUp"); }],
    ["selected text in it", async () => { await page.evaluate(() => { const el = document.querySelector('[data-view="look"] [data-testid="transcript"]')!; const r = document.createRange(); r.selectNodeContents(el); getSelection()!.removeAllRanges(); getSelection()!.addRange(r); }); }],
    ["read for ten seconds once it could be answered", async () => { await page.waitForTimeout(11_500); }],
  ];
  for (const [what, act] of cases) {
    const q = await asksWhich(request, `Standup notes: ${what}`, ws);
    await expect(row(page, q)).toHaveAttribute("data-watch", "need");
    await row(page, q).click();
    await expect(cardIn(page, q, "question")).toBeVisible();
    await act(q);
    await pick(page, q, 0);
    await expect.poll(() => waiting(request, q)).toBe(0);
    await page.waitForTimeout(600);
    expect(await slot(page, 0).getAttribute("data-station"), `the look was left although the owner ${what}`).toBe(q);
    // Left by its bar, the pane is as it was.
    await slot(page, 0).getByTestId("look-back").click();
    await expect(slot(page, 0)).toHaveAttribute("data-station", reader);
    expect(Math.abs((await look(page)).panes[0]!.top! - start.panes[0]!.top!)).toBeLessThan(4);
    await slot(page, 0).getByTestId("composer").click();
    await drop(request, q);
  }
  // The coordinator's own pane, gone to by its row, then a press in its conversation: answered, the owner stays there.
  await request.post(`/api/sessions/${coord}/messages`, { data: { text: calls([question]) } });
  await expect(row(page, coord)).toHaveAttribute("data-watch", "need");
  await row(page, coord).click();
  await slot(page, 1).locator(".k-reading").click({ position: { x: 40, y: 40 } });
  await pick(page, coord, 0);
  await expect.poll(() => waiting(request, coord)).toBe(0);
  await page.waitForTimeout(600);
  await expect(slot(page, 1)).toHaveAttribute("data-helm", "true");
  expect((await look(page)).panes[0]!.draft).toBe("draft: keep me");

  // The coordinator asks while a look lies over it: the bar says so in words, and the bridge counts it for whoever sums up what waits.
  await idle(request, coord);
  await slot(page, 1).getByTestId("composer").click();
  await row(page, reader).hover();
  const other = await long(request, "Draft the 2.4 changelog", ws);
  await row(page, other).click();
  await expect(slot(page, 1)).toHaveAttribute("data-station", other);
  await expect(slot(page, 1).getByTestId("look-state")).toHaveCount(0);
  await request.post(`/api/sessions/${coord}/messages`, { data: { text: calls([question]) } });
  await expect(slot(page, 1).getByTestId("look-says")).toHaveText("Looking at Draft the 2.4 changelog. This pane holds Coordinator: release train 2.4, needs you.");
  await expect(slot(page, 1).getByTestId("look-back")).toHaveAttribute("aria-label", /Coordinator: release train 2\.4, needs you/);
  await expect(bridge(page)).toHaveAttribute("data-need-under", "1");
  await shoot(page, "panes-stay-12-needs-you-under-a-look");
  await drop(request, reader, coord, other);
});

test("the row tab is said, stays out of the bar's way and points at a pane out of view; the header is one line when it fits", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("ps");
  const reader = await long(request, "Spike: full-text search", ws);
  const coord = await create(request, "Coordinator: release train 2.4", ws);
  await ask(request, coord, "approval", "release");
  const other = await long(request, "Draft the 2.4 changelog", ws);
  const more = [await long(request, "Bench the cache under load", ws), await long(request, "Port the parser", ws), await long(request, "Review pull request 212", ws), await long(request, "Wait for the staging deploy", ws)];
  await open(page, [reader, coord]);

  // 800 px panes. The helm's header is one line: the title, the state and the tools side by side.
  const head = (i: number) => slot(page, i).getByTestId("station-head").first();
  const oneLine = async (i: number) => { const t = (await head(i).getByTestId("station-title").boundingBox())!, w = (await head(i).getByTestId("station-word").boundingBox())!; return Math.abs(t.y + t.height / 2 - (w.y + w.height / 2)) < 6; };
  expect(await oneLine(0), "the state stands under a short title in a wide pane").toBe(true);
  // The coordinator: title whole; where room is short the folder gives way before the reason is cut.
  const cut = await head(1).evaluate((h) => {
    const why = h.querySelector<HTMLElement>('[data-testid="station-why"]')!, meta = h.querySelector<HTMLElement>(".k-station-meta")!, title = h.querySelector<HTMLElement>('[data-testid="station-title"]')!;
    return { title: title.scrollWidth > title.clientWidth + 1, why: why.scrollWidth > why.clientWidth + 1, meta: Math.round(meta.getBoundingClientRect().width) };
  });
  expect(cut.title).toBe(false);
  expect(cut.why && cut.meta > 0, "the reason is cut while the folder still shows").toBe(false);
  // The coordinator's pane worked in, from a narrow pane to a wide one: a wider pane is never the taller one, the
  // title is whole, and the reason shows sixteen characters or all it has (beside the title when that much fits,
  // else on the line under it).
  await slot(page, 1).getByTestId("composer").click();
  await expect(slot(page, 1)).toHaveAttribute("data-helm", "true");
  const sweep: { pane: number; height: number; why: number; whole: number; title: boolean }[] = [];
  for (let width = 1240; width <= 1900; width += 30) {
    await page.setViewportSize({ width, height: 1040 });
    sweep.push(await head(1).evaluate((h) => {
      const why = h.querySelector<HTMLElement>('[data-testid="station-why"]')!, title = h.querySelector<HTMLElement>('[data-testid="station-title"]')!;
      return { pane: Math.round(h.getBoundingClientRect().width), height: Math.round(h.getBoundingClientRect().height), why: why.clientWidth, whole: why.scrollWidth, title: title.scrollWidth <= title.clientWidth + 1 };
    }));
  }
  const said = sweep.map((x) => `${x.pane}: ${x.height} px, reason ${x.why} of ${x.whole}`).join("; ");
  for (const [i, x] of sweep.entries()) {
    expect(x.title, `the title is cut at ${x.pane} px`).toBe(true);
    expect(x.why, `the reason has no room at ${x.pane} px (${said})`).toBeGreaterThanOrEqual(Math.min(x.whole, 96) - 1);
    if (i) expect(x.height, `a wider pane has the taller header (${said})`).toBeLessThanOrEqual(sweep[i - 1]!.height + 1);
  }
  await page.setViewportSize({ width: 1920, height: 1040 });
  // The keys on a header tool: the header keeps its height, and a note under it shows the title and the reason whole.
  await slot(page, 0).getByTestId("composer").click();
  const h0 = (await head(0).boundingBox())!.height;
  await head(0).getByTestId("station-pin").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(head(0).getByTestId("station-pin")).toBeFocused();
  expect((await head(0).boundingBox())!.height).toBe(h0);
  expect(await head(0).evaluate((h) => getComputedStyle(h, "::after").content)).toContain("Spike: full-text search");

  // The keys on a row: the row is described by what a press there will do.
  await page.keyboard.press("Alt+l");
  await row(page, other).focus();
  await expect(row(page, other)).toHaveAttribute("aria-describedby", "k-aim-says");
  await expect(page.locator("#k-aim-says")).toHaveText("Opens here for a look, in pane 1");
  await expect(slot(page, 0).getByTestId("pane-aim")).toHaveText("Opens here for a look");
  // The pointer crossing the folder's heading between rows: the tab stays.
  await row(page, other).hover();
  await page.getByTestId("session-list").locator(".k-group-head").first().hover();
  await expect(slot(page, 0).getByTestId("pane-aim")).toHaveText("Opens here for a look");
  // Off the list, it goes.
  await slot(page, 1).hover();
  await expect(slot(page, 0).getByTestId("pane-aim")).toHaveCount(0);
  // A pane with a look says it in its bar, in place of the sentences: nothing lies over the bar's keys or over the
  // header under the bar. At 800 and at 560 px.
  for (const width of [1920, 1440]) {
    await page.setViewportSize({ width, height: 1040 });
    await row(page, other).click();
    await expect(slot(page, 0).getByTestId("look-bar")).toBeVisible();
    await row(page, more[0]!).hover();
    const aim = slot(page, 0).getByTestId("look-bar").getByTestId("pane-aim");
    await expect(aim).toHaveText("Opens here for a look");
    await expect(slot(page, 0).getByTestId("pane-aim")).toHaveCount(1);
    const tab = (await aim.boundingBox())!, bar = (await slot(page, 0).getByTestId("look-bar").boundingBox())!, back = (await slot(page, 0).getByTestId("look-back").boundingBox())!;
    expect(tab.x + tab.width, `the words lie over the way back in a pane of ${Math.round(bar.width)} px`).toBeLessThanOrEqual(back.x);
    expect(tab.y + tab.height).toBeLessThanOrEqual(bar.y + bar.height);
    if (width === 1920) await shoot(page, "panes-stay-13-tab-under-the-bar");
    await slot(page, 0).getByTestId("look-back").click();
    await expect(slot(page, 0)).toHaveAttribute("data-station", reader);
  }
  // A look in a pane that is not worked in is as compact as any other pane: no row of tools.
  await page.setViewportSize({ width: 1920, height: 1040 });
  await row(page, other).click();
  await expect(slot(page, 0).locator('.k-view[data-view="look"] .k-session-header')).toHaveCount(1);
  await slot(page, 1).getByTestId("composer").click();
  await expect(slot(page, 1)).toHaveAttribute("data-helm", "true");
  await expect(slot(page, 0)).toHaveAttribute("data-station", other);
  await expect(slot(page, 0).locator('.k-view[data-view="look"] .k-session-header')).toHaveCount(0);

  // A window narrowed to a phone's width and widened again: each pane's look is where it was.
  await row(page, more[1]!).click();
  await expect(slot(page, 1)).toHaveAttribute("data-station", more[1]!);
  const wide = (await look(page)).panes.map((p) => [p.holds, p.shows]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("look-bar")).toHaveCount(0);
  await page.waitForTimeout(800);
  await page.setViewportSize({ width: 1920, height: 1040 });
  await expect.poll(async () => (await look(page)).panes.map((p) => [p.holds, p.shows])).toEqual(wide);

  // Six panes: the row of panes scrolls sideways. A row whose pane is out of view shows its tab at that edge, with the pane's number.
  await open(page, [reader, coord, other, ...more.slice(0, 3)]);
  await expect(bridge(page).locator(":scope > [data-slot]")).toHaveCount(6);
  const scrolls = await bridge(page).evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  if (scrolls) {
    await bridge(page).evaluate((el) => { el.scrollLeft = 0; });
    await row(page, more[2]!).hover();
    await expect(page.getByTestId("pane-aim-edge")).toHaveText("Is here, pane 6");
    await expect(page.getByTestId("pane-aim-edge")).toHaveAttribute("data-side", "right");
  }
  await shoot(page, "panes-stay-14-six-panes");

  // The start page in a pane at the largest text size: the list is above the start box, in view.
  await open(page, [reader, coord]);
  await page.evaluate(() => localStorage.setItem("keel.textScale", "1.5"));
  await page.reload();
  await expect(slot(page, 0)).toHaveAttribute("data-station", reader);
  await page.getByRole("button", { name: "New session" }).first().click();
  const home = slot(page, 0);
  await expect(home.getByTestId("home-session").first()).toBeVisible();
  const first = (await home.getByTestId("home-session").first().boundingBox())!, start = (await home.getByTestId("new-composer").boundingBox())!;
  expect(first.y + first.height).toBeLessThan(start.y);
  expect(first.y + first.height).toBeLessThan(1040);
  expect(await bridge(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await shoot(page, "panes-stay-15-text-size-150");
  await page.evaluate(() => localStorage.setItem("keel.textScale", "1"));
  await drop(request, reader, coord, other, ...more);
});

test("a waiting session opened from the palette is answered and left in about ten keys", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("panes-stay-palette");
  const reader = await long(request, "Spike: full-text search over the notes", ws);
  const coord = await long(request, "Coordinator: release train 2.4", ws);
  const run = await asksToRun(request, "Rotate the staging certificates", ws, "certs");
  const before = await reading(page, reader, coord);
  await expect(row(page, run)).toHaveAttribute("data-watch", "need");
  let keys = 0;
  const press = async (k: string) => { keys++; await page.keyboard.press(k); };
  const t0 = Date.now();
  await press("Control+k");
  await page.getByTestId("palette-input").waitFor();
  for (const ch of "rotate") await press(ch);
  await expect(page.getByRole("option").first()).toContainText("Rotate the staging certificates");
  await press("Enter");
  // The keyboard is on the card's list of requests, on no answer; one deliberate key goes to Allow once.
  const card = cardIn(page, run, "approval");
  await expect(card).toBeFocused();
  await expect(card).toHaveAttribute("data-keys", "ready");
  await press("ArrowDown");
  await expect(card.getByTestId("allow-once")).toBeFocused();
  await expect(card.getByTestId("approval")).toHaveAttribute("data-live", "true");
  await press("Enter");
  await expect.poll(() => waiting(request, run)).toBe(0);
  // Answered: the look is left by itself and everything is as it was.
  await same(page, before);
  console.log(`TRIAGE palette: 1 approval, ${keys} keys, ${Date.now() - t0} ms; as before with no further key`);
  expect(keys).toBeLessThanOrEqual(11);

  // The answering sequence started inside a look leaves that look when nothing else waits.
  const q = await asksWhich(request, "Standup notes for Thursday", ws);
  await expect(row(page, q)).toHaveAttribute("data-watch", "need");
  await slot(page, 0).getByTestId("composer").click();
  await row(page, q).click();
  await expect(slot(page, 0)).toHaveAttribute("data-station", q);
  await slot(page, 0).locator('.k-view[data-view="look"]').getByTestId("composer").click();
  await page.keyboard.press("Alt+a");
  const asked = cardIn(page, q, "question");
  await expect(asked).toHaveAttribute("data-keys", "ready");
  await page.keyboard.press("2");
  await expect.poll(() => waiting(request, q)).toBe(0);
  await expect(slot(page, 0)).toHaveAttribute("data-station", reader);
  await expect(slot(page, 0).getByTestId("look-bar")).toHaveCount(0);
  await drop(request, reader, coord, run, q);
});
