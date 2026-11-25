import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the session list stays where the owner left it. By default a row's
// place comes from when its session was made, so no turn that starts or ends
// anywhere moves it; what a session needs is its mark and a count on the
// line above the list, where a press goes to the next one's row and marks it.
// A row is one line (two is a choice) and as high at rest as at work. Under
// the pointer or the keyboard nothing moves in any order: a session that
// arrives waits at the list's end and one that leaves stays as a dimmed row
// until the hand has left. The owner's own new session takes its place at
// once, and a pointer that only lies in the list holds nothing. With
// four panes the list is still a list of titles, one line a session, and
// folds to codes only where a title could not be read. A message queued in a
// session shows on its row, and Enter on the row of a session a pane already
// shows puts the keyboard in that pane's message box.
//
// The storm is the one a coordinator and a dozen agents make: a turn in one
// of six sessions every 200 ms, for 20 s.
const MODEL = "scripted:stand-in";
const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1920, height: 1040 } });
test.setTimeout(420_000);

type Day = { root: string; gate: string; ids: Record<string, string>; ticks: string[] };
async function seed(request: APIRequestContext): Promise<Day> {
  const root = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/stable-${Date.now().toString(36)}`;
  const dirs = ["api", "site", "infra", "notes"].map((d) => `${root}/${d}`);
  for (const d of dirs) mkdirSync(d, { recursive: true });
  const gate = `${root}/go`;
  const ids: Record<string, string> = {};
  const mk = async (name: string, title: string, dir: number, mode = "full-auto") => {
    const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title, workspace: dirs[dir] } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode } });
    ids[name] = session.id;
    return session.id as string;
  };
  const send = (id: string, text: string, mode?: string) => request.post(`/api/sessions/${id}/messages`, { data: { text, ...(mode ? { mode } : {}) } });
  const ended = async (id: string) => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && ["turn_end", "error"].includes(d.events.at(-1)?.kind); };
  const state = async (id: string) => ((await (await request.get("/api/state")).json()).states ?? {})[id]?.watch as string | undefined;
  // Six that take the storm's turns, two at rest, one of each state that calls or goes on.
  const ticks: string[] = [];
  for (const [i, title] of ["Standup notes for Thursday", "Refactor the billing webhooks", "Pick the retry policy", "Draft the changelog", "Watch the canary deploy", "Rotate the staging certificates"].entries()) ticks.push(await mk(`tick${i}`, title, i % 4));
  await mk("reader", "Spike: search over the notes", 0);
  await mk("idle", "An old piece of work nobody touches", 1);
  for (const id of [...ticks, ids.reader!, ids.idle!]) await send(id, "script:say Done.");
  for (const id of [...ticks, ids.reader!, ids.idle!]) await expect.poll(() => ended(id), { timeout: 30_000 }).toBe(true);
  await send(await mk("need", "Clean the build output", 2, "ask"), script([{ name: "Bash", input: { command: "rm -rf dist build" } }]));
  await send(await mk("fail", "Bill the account for the month", 3), "script:billing");
  await send(await mk("wait", "Check the deploy in a quarter of an hour", 2), script([{ name: "wait_for", input: { kind: "timer", seconds: 900, note: "check the deploy" } }]));
  await send(await mk("work", "Migrate the job queue to the new schema", 3), script([{ name: "Bash", input: { command: `until [ -f ${gate} ]; do sleep 0.2; done; echo released` } }]));
  await expect.poll(() => state(ids.need!), { timeout: 30_000 }).toBe("need");
  await expect.poll(() => state(ids.fail!), { timeout: 30_000 }).toBe("fail");
  await expect.poll(() => state(ids.wait!), { timeout: 30_000 }).toBe("wait");
  await expect.poll(() => state(ids.work!), { timeout: 30_000 }).toBe("work");
  // A message of the owner's waits behind the working turn.
  await send(ids.work!, "Then run the smoke tests. script:say Smoke tests pass.", "queue");
  return { root, gate, ids, ticks };
}

// A log of the list, a frame at a time: where every row is and how high, the row under the pointer, the row with the keyboard.
const arm = (page: Page) => page.evaluate(() => {
  const w = window as any;
  if (w.__rail) { w.__rail.frames = []; return; }
  w.__rail = { frames: [] as unknown[], x: -1, y: -1 };
  document.addEventListener("mousemove", (e) => { w.__rail.x = e.clientX; w.__rail.y = e.clientY; }, true);
  const row = (el: Element | null) => el?.closest?.('[data-testid="session-row"]')?.getAttribute("data-session") ?? null;
  const tick = () => {
    const rows: Record<string, [number, number]> = {};
    for (const e of document.querySelectorAll('[data-testid="session-list"] [data-testid="session-row"]')) { const b = e.getBoundingClientRect(); rows[e.getAttribute("data-session")!] = [Math.round(b.y * 4) / 4, Math.round(b.height * 4) / 4]; }
    w.__rail.frames.push({ rows, under: row(document.elementFromPoint(w.__rail.x, w.__rail.y)), focus: row(document.activeElement) });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
type Frame = { rows: Record<string, [number, number]>; under: string | null; focus: string | null };
// What the frames since the last call saw: how often a row moved or changed height, and every row that was under the pointer.
// `watch`: a row whose every place in those frames is told (`at`).
async function seen(page: Page, watch?: string) {
  const frames = await page.evaluate(() => { const w = window as any; const f = w.__rail.frames; w.__rail.frames = []; return f; }) as Frame[];
  let moves = 0, resized = 0, jump = 0;
  const heights = new Set<number>(), under = new Set<string | null>(), at = new Set<number>();
  for (let i = 0; i < frames.length; i++) {
    under.add(frames[i]!.under);
    if (watch && frames[i]!.rows[watch]) at.add(frames[i]!.rows[watch]![0]);
    for (const [id, [y, h]] of Object.entries(frames[i]!.rows)) {
      heights.add(h);
      const was = frames[i - 1]?.rows[id];
      if (!was) continue;
      if (was[0] !== y) { moves++; jump = Math.max(jump, Math.abs(y - was[0])); }
      if (was[1] !== h) resized++;
    }
  }
  return { frames: frames.length, moves, jump, resized, heights: [...heights], under: [...under], at: [...at] };
}

test("no row moves or changes height while a dozen sessions take turns, under the pointer, under the keyboard and in any order", async ({ page, request }) => {
  test.skip(!((await (await request.get("/api/models")).json()).models as { id: string }[]).some((m) => m.id === MODEL), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const day = await seed(request);
  const { ids } = day;
  const list = page.getByTestId("session-list");
  const row = (id: string) => list.locator(`[data-testid="session-row"][data-session="${id}"]`);
  const order = () => list.locator('[data-testid="session-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-session")!));
  let storm = true, sent = 0;
  const run = (async () => {
    while (storm) {
      void request.post(`/api/sessions/${day.ticks[sent % day.ticks.length]}/messages`, { data: { text: `script:say tick ${sent}` } }).catch(() => {});
      sent++;
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  try {
    await page.goto(`/s/${ids.reader}`);
    await expect(row(ids.need!)).toHaveAttribute("data-watch", "need");
    await expect(page.getByTestId("composer")).toBeFocused();
    // The message queued behind the working turn shows on its row (looked at first: the command
    // that keeps the turn working is given two minutes).
    await expect(row(ids.work!).getByTestId("row-queued")).toHaveText("1");
    await expect(row(ids.work!).getByTestId("row-queued")).toHaveAttribute("aria-label", "1 queued");
    await expect(row(ids.work!).getByTestId("row-queued")).toBeInViewport({ ratio: 1 });
    // The storm is on: a turn of its own has ended in a session it sends to (asked of the daemon, not
    // read off a row: a turn this short may never be drawn as working on a busy machine).
    await expect.poll(async () => ((await (await request.get(`/api/sessions/${day.ticks[0]}`)).json()).events as { kind: string; data: { text?: string } }[]).some((e) => e.kind === "user" && /script:say tick \d+/.test(e.data.text ?? "")), { timeout: 60_000 }).toBe(true);
    const mine = Object.values(ids);
    const first = (await order()).filter((id) => mine.includes(id));
    expect(first).toHaveLength(12);
    await arm(page);

    // 1. A still pointer on one row for 20 s of the storm: the same row is under it the whole time,
    // and no row in the list moved or changed height.
    const box = (await row(ids.idle!).boundingBox())!;
    await page.mouse.move(box.x + 120, box.y + box.height / 2);
    await page.waitForTimeout(400);
    await seen(page);
    await page.waitForTimeout(20_000);
    const still = await seen(page);
    expect(still.frames).toBeGreaterThan(300);
    expect(still.under, "the row under a still pointer").toEqual([ids.idle]);
    expect({ moves: still.moves, resized: still.resized }, "rows that moved or changed height under the pointer").toEqual({ moves: 0, resized: 0 });
    // Every row is as high as every other: at rest, at work, waiting, failed, needing the owner.
    expect(still.heights, "row heights").toHaveLength(1);
    await shoot(page, "rail-stable-01-one-pane");

    // 2. The hand away from the list: by default the rows still stay where they are, since their
    // place does not come from what their sessions do.
    await page.mouse.move(1200, 500);
    await page.waitForTimeout(1200);
    await seen(page);
    await page.waitForTimeout(5000);
    const away = await seen(page);
    expect({ moves: away.moves, resized: away.resized }, "rows that moved with nobody near the list").toEqual({ moves: 0, resized: 0 });
    expect((await order()).filter((id) => mine.includes(id))).toEqual(first);

    // 3. The keyboard down the list during the storm: each row once, in the order they stand.
    await page.keyboard.press("Alt+l");
    await page.keyboard.press("Home");
    const all = await order();
    const visited = [await page.evaluate(() => document.activeElement?.getAttribute("data-session"))];
    for (let i = 1; i < all.length; i++) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(150);
      visited.push(await page.evaluate(() => document.activeElement?.getAttribute("data-session")));
    }
    expect(visited, "the rows ArrowDown visited").toEqual(all);
    await page.getByTestId("composer").click();

    // 4. Sorted by recent activity, the order that moves rows by design. With nobody near the list
    // it does move them; with the pointer in the list nothing moves, and the list says it is held.
    await page.getByTestId("list-arrange").click();
    // (A first visit has no changed default to be told of.)
    await expect(page.getByTestId("arrange-sort-created")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("arrange-note")).toHaveCount(0);
    await page.getByTestId("arrange-sort-recent").click();
    await page.keyboard.press("Escape");
    await page.mouse.move(1200, 500);
    await page.waitForTimeout(1000);
    await seen(page);
    await page.waitForTimeout(4000);
    expect((await seen(page)).moves, "by recent activity rows follow the work").toBeGreaterThan(0);
    const at = (await row(ids.idle!).boundingBox())!;
    // A hand on the list moves now and then (a pointer that only lies there is not one: see 5c).
    const stir = async (n = 0) => page.mouse.move(at.x + 120 + (n % 2), at.y + at.height / 2);
    await stir();
    await expect(list).toHaveAttribute("data-held", "true");
    await page.waitForTimeout(300);
    await seen(page);
    for (let i = 1; i <= 4; i++) { await page.waitForTimeout(1500); await stir(i); }
    const held = await seen(page);
    // (Whichever row the pointer came to rest on: the rows were still moving when it was aimed.)
    const rested = held.under[0]!;
    expect(rested).toBeTruthy();
    expect({ moves: held.moves, resized: held.resized, under: held.under }, "by recent activity, under the pointer").toEqual({ moves: 0, resized: 0, under: [rested] });

    // 5. Still held: a session made elsewhere waits at the list's end and one archived elsewhere
    // stays as a dimmed row, so nothing moved. Both take their place when the pointer has left.
    const made = (await (await request.post("/api/sessions", { data: { model: MODEL, title: "Made on another device", workspace: `${day.root}/api` } })).json()).session.id as string;
    await expect(page.getByTestId("late-group").locator(`[data-session="${made}"]`)).toBeVisible();
    await request.patch(`/api/sessions/${ids.fail}`, { data: { archived: true } });
    await expect(row(ids.fail!)).toHaveAttribute("data-gone", "true");
    await expect(row(ids.fail!).getByTestId("row-gone")).toHaveText(/^archived$/i);
    await stir(1);
    await page.waitForTimeout(300);
    const came = await seen(page);
    expect({ moves: came.moves, under: came.under }, "a session arriving and one leaving, under the pointer").toEqual({ moves: 0, under: [rested] });
    await page.mouse.move(1200, 500);
    await expect(list).not.toHaveAttribute("data-held", "true");
    await expect(page.getByTestId("late-group")).toHaveCount(0);
    await expect(row(ids.fail!)).toHaveCount(0);
    await expect(row(made)).toBeVisible();
    await request.patch(`/api/sessions/${ids.fail}`, { data: { archived: false } });
    await request.delete(`/api/sessions/${made}`);

    // 5a. Still by recent activity: the pointer left lying on a row for a minute of the storm, the
    // keyboard in the pane. After a few seconds the list lets go and follows the work again, but
    // around that row: the others take their places, the row under the pointer stays where it is.
    await page.getByTestId("composer").focus();
    // (The rows are still moving when the pointer is aimed: it is put down, then nudged onto a row if it came to rest between two.)
    let lying: string | null = null;
    for (const dy of [0, 16, -16, 32]) {
      await page.mouse.move(at.x + 118, at.y + at.height / 2 + dy);
      await expect(list).toHaveAttribute("data-held", "true");
      lying = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid="session-row"]')?.getAttribute("data-session") ?? null, [at.x + 118, at.y + at.height / 2 + dy] as const);
      if (lying) break;
    }
    expect(lying, "a row under the pointer").toBeTruthy();
    await page.waitForTimeout(300);
    await seen(page);
    await page.waitForTimeout(60_000);
    const minute = await seen(page, lying!);
    await expect(list).not.toHaveAttribute("data-held", "true");
    expect(minute.moves, "the list follows the work again under a pointer that only lies there").toBeGreaterThan(0);
    expect({ under: minute.under, at: minute.at.length }, "the row under the lying pointer, and the places it stood in").toEqual({ under: [lying], at: 1 });
    await page.mouse.move(1200, 500);
    await page.getByTestId("list-arrange").click();
    await page.getByTestId("arrange-reset").click();
    await page.keyboard.press("Escape");
    await expect(row(ids.fail!)).toBeVisible();

    // 5b. The owner's own new session, made with the pointer left in the list: a row pressed (the
    // keyboard goes to the message box, the pointer stays on the row), Ctrl Shift O, a message,
    // Enter. Its row takes its place at once, first in its folder, in view, while the list is held.
    await row(ids.reader!).click();
    await expect(page.getByTestId("composer")).toBeFocused();
    await page.keyboard.press("Control+Shift+O");
    await expect(page).toHaveURL(/\/$/);
    await page.getByTestId("composer").fill("script:say Made here.");
    const here = (await row(ids.reader!).boundingBox())!;
    await page.mouse.move(here.x + 121, here.y + here.height / 2);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/s\//);
    const own = page.url().split("/s/")[1]!;
    await expect(row(own)).toBeInViewport({ ratio: 1 });
    await expect(list).toHaveAttribute("data-held", "true");
    await expect(page.getByTestId("late-group")).toHaveCount(0);
    const group = page.locator(".k-group").filter({ has: page.locator(`[data-session="${ids.reader}"]`) });
    expect(await group.locator('[data-testid="session-row"]').first().getAttribute("data-session")).toBe(own);

    // 5c. A pointer that only lies in the list holds nothing: left where it is while the owner
    // types in the pane, the list lets go after a few seconds, and a session made elsewhere takes
    // its place without waiting for the pointer to leave. A move of the pointer holds it again.
    await page.getByTestId("composer").pressSequentially("typing in the pane", { delay: 30 });
    await expect(list).not.toHaveAttribute("data-held", "true", { timeout: 8000 });
    const other = (await (await request.post("/api/sessions", { data: { model: MODEL, title: "Made elsewhere, nobody near the list", workspace: `${day.root}/api` } })).json()).session.id as string;
    await expect(row(other)).toBeVisible();
    await expect(page.getByTestId("late-group")).toHaveCount(0);
    await page.mouse.move(here.x + 122, here.y + here.height / 2);
    await expect(list).toHaveAttribute("data-held", "true");
    await page.getByTestId("composer").fill("");
    await page.mouse.move(1200, 500);
    for (const id of [own, other]) { await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {}); await request.delete(`/api/sessions/${id}`); }
    await expect(row(other)).toHaveCount(0);
    await row(ids.reader!).click();
    await page.mouse.move(1200, 500);
  } finally {
    storm = false;
    await run;
  }

  // 6. What needs the owner is never out of reach: counted above the list, one press from its row,
  // also when the row is scrolled away.
  await page.setViewportSize({ width: 1920, height: 620 });
  await expect(page.getByTestId("sum-need")).toHaveText(/1\s*needs you/i);
  await expect(page.getByTestId("sum-fail")).toHaveText(/1\s*failed/i);
  await expect(page.getByTestId("sum-need")).toBeInViewport({ ratio: 1 });
  // The counts are one stop for Tab: the arrows move between them.
  const bar = page.getByTestId("list-summary");
  await expect(bar).toHaveAttribute("role", "toolbar");
  await expect(bar.locator('button[tabindex="0"]')).toHaveCount(1);
  await page.getByTestId("sum-need").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("sum-fail")).toBeFocused();
  await page.keyboard.press("End");
  await expect(bar.locator("button:not([hidden])").last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.getByTestId("sum-need")).toBeFocused();
  await expect(bar.locator('button[tabindex="0"]')).toHaveCount(1);
  await page.getByTestId("composer").focus();
  // A row has no tooltip of the browser's own: it would lie over the card beside the row, which says the title whole.
  expect(await row(ids.need!).evaluate((el) => [el, ...el.querySelectorAll(".k-row-title, .k-row-why")].map((x) => x.getAttribute("title")))).toEqual([null, null, null]);
  const hide = (id: string) => list.evaluate((nav, sid) => {
    const r = nav.querySelector<HTMLElement>(`[data-session="${sid}"]`)!.getBoundingClientRect(), n = nav.getBoundingClientRect();
    nav.scrollTop = r.top - n.top + nav.scrollTop > nav.clientHeight ? 0 : nav.scrollHeight;
  }, id);
  await hide(ids.need!);
  await expect(row(ids.need!)).not.toBeInViewport();
  await page.getByTestId("sum-need").click();
  await expect(row(ids.need!)).toBeFocused();
  await expect(row(ids.need!)).toBeInViewport({ ratio: 1 });
  // It is marked for a moment, also after this press of the pointer (which shows no focus ring), and
  // stands in the middle of the list, not at its edge, where the list can be scrolled that far.
  await expect(row(ids.need!)).toHaveAttribute("data-jump", "");
  expect(await row(ids.need!).evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
  const place = await row(ids.need!).evaluate((el) => {
    const nav = el.closest<HTMLElement>('[data-testid="session-list"]')!, r = el.getBoundingClientRect(), n = nav.getBoundingClientRect();
    return { off: Math.abs((r.top + r.bottom) / 2 - (n.top + n.bottom) / 2), room: n.height, atEnd: nav.scrollTop <= 1 || nav.scrollTop >= nav.scrollHeight - nav.clientHeight - 1 };
  });
  expect(place.atEnd || place.off < place.room / 4, `the row is ${Math.round(place.off)}px from the middle of a list ${Math.round(place.room)}px high`).toBe(true);
  await expect(row(ids.need!)).not.toHaveAttribute("data-jump", "", { timeout: 5000 });
  // Nothing was opened: the pane shows what it showed.
  await expect(page).toHaveURL(new RegExp(`/s/${ids.reader}$`));
  await hide(ids.fail!);
  await page.getByTestId("composer").click();
  // By keyboard: the count is a button; pressed again with nothing else needing them, the same row.
  await hide(ids.need!);
  await page.getByTestId("sum-need").focus();
  await page.keyboard.press("Enter");
  await expect(row(ids.need!)).toBeFocused();
  await expect(row(ids.need!)).toBeInViewport({ ratio: 1 });
  await page.getByTestId("sum-fail").click();
  await expect(row(ids.fail!)).toBeFocused();
  await expect(row(ids.fail!)).toBeInViewport({ ratio: 1 });
  // From the archive: the count's press shows the sessions again and goes to the row. The pane keeps its session.
  await page.getByTestId("tab-archived").click();
  await expect(row(ids.need!)).toHaveCount(0);
  await page.getByTestId("sum-need").click();
  await expect(row(ids.need!)).toBeFocused();
  await expect(page.getByTestId("tab-active")).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(new RegExp(`/s/${ids.reader}$`));
  await expect(page.locator("section.k-station")).toHaveAttribute("data-station", ids.reader!);
  await page.getByTestId("composer").focus();
  await page.setViewportSize({ width: 1920, height: 1040 });

  // 8. Enter on the row of the session this pane already shows: the keyboard is in its message box.
  await page.keyboard.press("Alt+l");
  await expect(row(ids.reader!)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer")).toBeFocused();
  await expect(page.getByTestId("composer")).toHaveValue("");

  // 9. A row archived from the keyboard: the keyboard goes on to the next row (the pointer's press leaves it to the message box).
  const rows = await list.locator('[data-testid="session-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-session")!));
  const after = rows[rows.indexOf(ids.idle!) + 1] ?? rows[rows.indexOf(ids.idle!) - 1]!;
  await row(ids.idle!).focus();
  // Right walks the row's actions: Pin, Open beside, Archive.
  for (const action of ["row-pin", "row-beside", "row-archive"]) {
    await page.keyboard.press("ArrowRight");
    await expect(row(ids.idle!).getByTestId(action)).toBeFocused();
  }
  await page.keyboard.press("Enter");
  await expect(row(ids.idle!)).toHaveCount(0);
  await expect(row(after)).toBeFocused();
  await page.getByTestId("composer").focus();

  // 10. The default changed once for a browser that kept the old one. A line under the counts says
  // so where it is seen, and leads to the Arrange menu, which says it too; both are gone once the menu was opened.
  await page.evaluate(() => localStorage.setItem("keel.listArrange", JSON.stringify({ group: "folder", sort: "recent", hideDone: false })));
  await page.reload();
  await expect(page.getByTestId("list-note")).toHaveText(/Sessions now keep their place\./);
  await expect(page.getByTestId("list-note")).toBeInViewport({ ratio: 1 });
  await page.getByTestId("list-note-arrange").click();
  await expect(page.getByTestId("arrange-menu")).toBeVisible();
  await expect(page.getByTestId("arrange-note")).toBeVisible();
  await expect(page.getByTestId("arrange-sort-created")).toHaveAttribute("aria-checked", "true");
  await shoot(page, "rail-stable-02-arrange-note");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("list-note")).toHaveCount(0);
  await page.getByTestId("list-arrange").click();
  await expect(page.getByTestId("arrange-menu")).toBeVisible();
  await expect(page.getByTestId("arrange-note")).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Dismissed by its own button, it does not come back; and one who chose the order by state is told nothing: nothing changed for them.
  await page.evaluate(() => localStorage.setItem("keel.listArrange", JSON.stringify({ group: "folder", sort: "recent", hideDone: false })));
  await page.reload();
  await page.getByTestId("list-note-dismiss").click();
  await expect(page.getByTestId("list-note")).toHaveCount(0);
  await page.reload();
  await expect(row(ids.need!)).toBeVisible();
  await expect(page.getByTestId("list-note")).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem("keel.listArrange", JSON.stringify({ group: "folder", sort: "state", hideDone: false })));
  await page.reload();
  await expect(row(ids.need!)).toBeVisible();
  await expect(page.getByTestId("list-note")).toHaveCount(0);
  await page.getByTestId("list-arrange").click();
  await expect(page.getByTestId("arrange-sort-state")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("arrange-note")).toHaveCount(0);
  await page.getByTestId("arrange-reset").click();
  await page.keyboard.press("Escape");
  writeFileSync(day.gate, "");
});

test("with four panes the list is still titles, one line a session, and folds to codes only where a title could not be read", async ({ page, request }) => {
  test.skip(!((await (await request.get("/api/models")).json()).models as { id: string }[]).some((m) => m.id === MODEL), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const day = await seed(request);
  const { ids } = day;
  const side = page.getByTestId("sidebar");
  const list = page.getByTestId("session-list");
  const row = (id: string) => list.locator(`[data-testid="session-row"][data-session="${id}"]`);
  const panes = (slots: string[]) => page.evaluate((s) => localStorage.setItem("keel.panes", JSON.stringify({ count: s.length, slots: s, sizes: {}, active: 0 })), slots);
  const fits = () => page.evaluate(() => { const s = document.querySelector<HTMLElement>(".k-stations")!; return s.scrollWidth <= s.clientWidth + 1; });
  try {
    await page.goto(`/s/${ids.reader}`);
    // Two panes: the list as it is with one.
    await panes([ids.reader!, ids.work!]);
    await page.reload();
    await expect(page.locator("section.k-station")).toHaveCount(2);
    await expect(side).toHaveAttribute("data-open", "true");
    await expect(side).not.toHaveAttribute("data-narrow", "true");
    await expect(row(ids.need!).getByTestId("row-state")).toHaveText("Needs you");
    await shoot(page, "rail-stable-03-two-panes");

    // Enter on the row of a session a pane already shows, where a card waits on the owner: the keyboard
    // goes to that card, by the cards' own rule (a region of it, never an answer).
    await panes([ids.reader!, ids.need!]);
    await page.reload();
    const asking = page.locator(`section.k-station[data-station="${ids.need}"]`);
    await expect(asking.getByTestId("approval")).toBeVisible();
    await expect(page.locator(`section.k-station[data-station="${ids.reader}"]`).getByTestId("composer")).toBeFocused();
    await row(ids.need!).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate((id) => { const a = document.activeElement; return !!a?.closest("[data-ask-card]") && a.closest("[data-station]")?.getAttribute("data-station") === id && !a.matches("button"); }, ids.need!)).toBe(true);

    // A look lies over the pane of the session that needs them (the pane shows another for now): its
    // row says so, and it is counted with what needs them.
    await page.evaluate(([own, other, look]) => localStorage.setItem("keel.panes", JSON.stringify({ count: 2, slots: [own, other], over: [look, null], sizes: {}, active: 0 })), [ids.need!, ids.work!, ids.reader!] as const);
    await page.goto(`/s/${ids.reader}`);
    await expect(page.getByTestId("look-bar")).toBeVisible();
    await expect(row(ids.need!).getByTestId("row-under")).toBeVisible();
    await expect(row(ids.work!).getByTestId("row-under")).toHaveCount(0);
    await expect(page.getByTestId("sum-need")).toHaveText(/^1/);
    await shoot(page, "rail-stable-08-need-under-a-look");

    // Four panes at 1920: no room for the list at its width, room for titles.
    await panes([ids.reader!, ids.work!, ids.need!, ids.wait!]);
    await page.reload();
    await expect(page.locator("section.k-station")).toHaveCount(4);
    await expect(side).toHaveAttribute("data-narrow", "true");
    await expect(list.getByTestId("rail-code")).toHaveCount(0);
    const mine = Object.values(ids);
    const rows = await list.locator('[data-testid="session-row"]').evaluateAll((els, own) => els.filter((e) => own.includes(e.getAttribute("data-session")!)).map((e) => {
      const t = e.querySelector<HTMLElement>(".k-row-title")!;
      return { title: t.textContent, shown: t.getBoundingClientRect().width, cut: getComputedStyle(t).textOverflow, height: e.getBoundingClientRect().height, lines: Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight)), reason: e.hasAttribute("data-reason") };
    }), mine);
    expect(rows).toHaveLength(12);
    const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    for (const r of rows) {
      expect(r.title, "a row names its session").toBeTruthy();
      expect(r.shown, `the title of "${r.title}" has room to be read`).toBeGreaterThan(4.5 * rem);
      expect([r.cut, r.lines]).toEqual(["ellipsis", 1]);
    }
    // Rows of one height: one line each, and a row that calls the owner keeps its reason on a second line of its own.
    const plain = rows.filter((r) => !r.reason);
    expect(new Set(plain.map((r) => Math.round(r.height))).size, "rows of one height").toBe(1);
    expect(plain[0]!.height).toBeLessThan(2 * rem);
    for (const r of rows.filter((x) => x.reason)) expect(r.height, `the reason of "${r.title}" has a line of its own`).toBeLessThan(3 * rem);
    // The panes keep their narrowest width and nothing scrolls sideways for the list.
    expect(await fits()).toBe(true);
    // Its words are whole: the filter's hint is the short one, and neither tab is cut.
    await expect(page.getByTestId("list-filter")).toHaveAttribute("placeholder", "Filter");
    expect(await page.getByTestId("list-filter").evaluate((el: HTMLInputElement) => { const c = document.createElement("canvas").getContext("2d")!; c.font = getComputedStyle(el).font; return c.measureText(el.placeholder).width <= el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(el).paddingRight); })).toBe(true);
    for (const t of ["tab-active", "tab-archived"]) expect(await page.getByTestId(t).evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); const w = r.getBoundingClientRect(), b = el.getBoundingClientRect(); return w.left >= b.left + 1 && w.right <= b.right - 1; }), `${t} keeps its word inside`).toBe(true);
    // The bar's own controls are still in it: the toggle, New session, the filter, the tabs, the foot.
    const edge = (await side.boundingBox())!;
    for (const t of ["rail-toggle", "new-session", "list-filter", "list-arrange", "tab-archived", "list-summary", "settings-button", "theme-toggle"]) {
      const b = (await page.getByTestId(t).boundingBox())!;
      expect(b.x, t).toBeGreaterThanOrEqual(edge.x);
      expect(b.x + b.width, t).toBeLessThanOrEqual(edge.x + edge.width + 0.5);
    }
    // The state a narrow row has no room to spell is on the card beside it.
    await row(ids.need!).hover();
    await expect(page.getByTestId("rail-card")).toContainText("Needs you");
    await page.mouse.move(1200, 500);
    await shoot(page, "rail-stable-04-four-panes");

    // A little narrower there is no room for a title: the marks with their codes, no two alike.
    await page.setViewportSize({ width: 1840, height: 1040 });
    await expect(side).not.toHaveAttribute("data-open", "true");
    const codes = await list.getByTestId("rail-code").allTextContents();
    expect(codes.length).toBeGreaterThanOrEqual(12);
    expect(new Set(codes).size).toBe(codes.length);
    expect(await fits()).toBe(true);
    await page.setViewportSize({ width: 1920, height: 1040 });
    await expect(side).toHaveAttribute("data-narrow", "true");

    // The phone: the same two-line rows in the drawer.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/s/${ids.reader}`);
    await page.getByTestId("show-sidebar").first().click();
    // The dot says it: the slot draws no word, and a reader has it.
    await expect(row(ids.need!).getByTestId("row-on")).toHaveText("Needs you");
    await expect(page.getByTestId("sum-need")).toBeVisible();
    await shoot(page, "rail-stable-05-phone");
  } finally {
    writeFileSync(day.gate, "");
  }
});

test("a count goes to a row that a fold hides and never changes a pane; what is unread is never folded away", async ({ page, request }) => {
  test.skip(!((await (await request.get("/api/models")).json()).models as { id: string }[]).some((m) => m.id === MODEL), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const root = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/folds-${Date.now().toString(36)}`;
  mkdirSync(root, { recursive: true });
  const mk = async (title: string, mode = "full-auto") => {
    const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title, workspace: root } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode } });
    return session.id as string;
  };
  const send = (id: string, text: string) => request.post(`/api/sessions/${id}/messages`, { data: { text } });
  const ended = async (id: string) => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && ["turn_end", "error"].includes(d.events.at(-1)?.kind); };
  const list = page.getByTestId("session-list");
  const row = (id: string) => list.locator(`[data-testid="session-row"][data-session="${id}"]`);
  const made: string[] = [];
  let folder: string | undefined;
  try {
    // A folder of ten at rest and read; the oldest of them finishes a turn while no page is open.
    const quiet: string[] = [];
    for (let i = 1; i <= 10; i++) { const id = await mk(`Piece of work ${i}`); quiet.push(id); made.push(id); await send(id, "script:say Done."); }
    for (const id of quiet) await expect.poll(() => ended(id), { timeout: 30_000 }).toBe(true);
    for (const id of quiet) await request.post("/api/alerts/read", { data: { session_id: id } });
    const reader = quiet.at(-1)!, oldest = quiet[0]!;
    await send(oldest, "script:say Finished while nobody looked.");
    await expect.poll(async () => ((await (await request.get("/api/alerts?limit=50&with_unread")).json()).alerts as { session_id: string; read: boolean }[]).some((a) => a.session_id === oldest && !a.read), { timeout: 30_000 }).toBe(true);
    await page.goto(`/s/${reader}`);
    // Its row is drawn, behind no fold: the six newest, and the one with something unread.
    await expect(row(oldest)).toBeVisible();
    await expect(row(oldest)).toHaveAttribute("data-unread", "true");
    await expect(row(quiet[1]!)).toHaveCount(0);
    await expect(list.locator(".k-more")).toHaveText("3 more");
    await expect(page.getByTestId("sum-unread")).toHaveText(/^1/);

    // One of the owner's folders, folded, holds a session that needs them: its head says so.
    const asks = await mk("Clean the build output", "ask");
    made.push(asks);
    await send(asks, `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "rm -rf dist build" } }])}`);
    await expect.poll(async () => ((await (await request.get("/api/state")).json()).states ?? {})[asks]?.watch, { timeout: 30_000 }).toBe("need");
    folder = (await (await request.post("/api/session-folders", { data: { name: "Chores" } })).json()).folder.id as string;
    await request.patch(`/api/sessions/${asks}`, { data: { folder_id: folder } });
    await request.patch(`/api/session-folders/${folder}`, { data: { collapsed: true } });
    await page.getByTestId("list-arrange").click();
    await page.getByTestId("arrange-group-mine").click();
    await page.keyboard.press("Escape");
    const head = list.locator(`[data-testid="folder-head"][data-folder="${folder}"]`);
    await expect(head).toBeVisible();
    await expect(row(asks)).toHaveCount(0);
    await expect(head.locator('.k-mark[data-watch="need"]')).toBeVisible();
    await shoot(page, "rail-stable-06-folded-head-mark");
    // The count's press opens the fold for that row and puts the keyboard on it. Twice: the pane never changes.
    for (let i = 0; i < 2; i++) {
      await page.getByTestId("sum-need").click();
      await expect(row(asks)).toBeFocused();
      await expect(page).toHaveURL(new RegExp(`/s/${reader}$`));
      await expect(page.locator("section.k-station")).toHaveAttribute("data-station", reader);
    }
    await expect(row(asks)).toHaveAttribute("data-jump", "");
    await shoot(page, "rail-stable-07-jumped-row");
    // What they chose for the folder is kept: it folds again when they have left the list.
    await page.getByTestId("composer").focus();
    await page.mouse.move(1200, 500);
    await expect(row(asks)).toHaveCount(0, { timeout: 8000 });
    expect(((await (await request.get("/api/session-folders")).json()).folders as { id: string; collapsed: boolean }[]).find((f) => f.id === folder)?.collapsed).toBe(true);
    await page.getByTestId("list-arrange").click();
    await page.getByTestId("arrange-reset").click();
    await page.keyboard.press("Escape");
  } finally {
    for (const id of made) { await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {}); await request.delete(`/api/sessions/${id}`).catch(() => {}); }
    if (folder) await request.delete(`/api/session-folders/${folder}`).catch(() => {});
  }
});

test("a session is pinned from its row by pointer, key and menu, and the pinned stand in the order the owner gave them", async ({ page, request }) => {
  test.skip(!((await (await request.get("/api/models")).json()).models as { id: string }[]).some((m) => m.id === MODEL), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const root = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/pins-${Date.now().toString(36)}`;
  mkdirSync(root, { recursive: true });
  const made: string[] = [];
  const mk = async (title: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title, workspace: root } })).json();
    made.push(session.id);
    return session.id as string;
  };
  const list = page.getByTestId("session-list");
  const row = (id: string) => list.locator(`[data-testid="session-row"][data-session="${id}"]`);
  const pinned = () => page.getByTestId("pinned-group").locator('[data-testid="session-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-session")));
  try {
    const a = await mk("Alpha: tidy the logs"), b = await mk("Bravo: review the patch"), c = await mk("Charlie: update the docs"), d = await mk("Delta: measure the cache");
    await page.goto(`/s/${a}`);
    await expect(row(d)).toBeVisible();
    await expect(page.getByTestId("pinned-group")).toHaveCount(0);

    // By the pointer: Pin is among the actions a row shows under it. One press, from the list; the row
    // takes its place among the pinned when the pointer has left the list (nothing moves under it).
    await row(a).hover();
    await row(a).getByTestId("row-pin").click();
    await page.mouse.move(1200, 500);
    await expect.poll(pinned).toEqual([a]);
    // From the keyboard: Right goes to the row's actions, and Pin is the first. The keyboard stays with the row, in the group it went to.
    await row(b).focus();
    await page.keyboard.press("ArrowRight");
    await expect(row(b).getByTestId("row-pin")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(pinned).toEqual([a, b]);
    await expect(row(b)).toBeFocused();
    // From the row's own menu (a right click).
    await row(c).click({ button: "right" });
    await expect(page.getByTestId("row-menu")).toBeVisible();
    await shoot(page, "rail-stable-09-row-menu");
    await page.getByTestId("row-menu-pin").click();
    await expect.poll(pinned).toEqual([a, b, c]);
    // A row the owner sent to the pinned went there: the list is not held around where it stood (no gap above its first group).
    expect(await list.evaluate((nav) => [nav.style.paddingTop, nav.scrollTop])).toEqual(["", 0]);
    expect(await page.getByTestId("pinned-group").evaluate((el) => el.getBoundingClientRect().top - el.parentElement!.getBoundingClientRect().top)).toBeLessThan(12);

    // The pinned are reordered from the keyboard: Alt Up and Alt Down on a pinned row. The keyboard stays on it.
    await row(c).focus();
    await page.keyboard.press("Alt+ArrowUp");
    await expect.poll(pinned).toEqual([a, c, b]);
    await expect(row(c)).toBeFocused();
    await page.keyboard.press("Alt+ArrowUp");
    await expect.poll(pinned).toEqual([c, a, b]);
    await expect(row(c)).toBeFocused();
    await page.keyboard.press("Alt+ArrowUp"); // already the first: nothing moves
    await page.keyboard.press("Alt+ArrowDown");
    await expect.poll(pinned).toEqual([a, c, b]);
    await expect(row(c)).toBeFocused();
    // And by a drag inside the group: the last one dropped on the first's upper half goes before it.
    await row(b).dragTo(row(a), { targetPosition: { x: 80, y: 4 } });
    await expect.poll(pinned).toEqual([b, a, c]);
    // A session that is not pinned, dropped among the pinned, is pinned at that place.
    await row(d).dragTo(row(c), { targetPosition: { x: 80, y: 26 } });
    await expect.poll(pinned).toEqual([b, a, c, d]);
    await page.mouse.move(1200, 500);
    await shoot(page, "rail-stable-10-pinned-order");

    // The order is stored with the pins: the same after a reload, and the daemon holds their marks in it.
    await page.reload();
    await expect.poll(pinned).toEqual([b, a, c, d]);
    const marks = await Promise.all([b, a, c, d].map(async (id) => (await (await request.get(`/api/sessions/${id}?events=0`)).json()).session.settings.pinned_ms as number));
    expect(marks).toEqual([...marks].sort((x, y) => x - y));
    expect(new Set(marks).size).toBe(4);
    // Unpinned from its row, the same way: it leaves the pinned when the pointer has left the list.
    await row(d).hover();
    await expect(row(d).getByTestId("row-pin")).toHaveAttribute("aria-pressed", "true");
    await row(d).getByTestId("row-pin").click();
    await expect(row(d).getByTestId("row-pin")).toHaveAttribute("aria-pressed", "false");
    await page.mouse.move(1200, 500);
    await expect.poll(pinned).toEqual([b, a, c]);
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`).catch(() => {});
  }
});

test("what changes elsewhere waits for the hand, is said at the list's foot, and settles around the row the hand was on", async ({ page, request }) => {
  test.skip(!((await (await request.get("/api/models")).json()).models as { id: string }[]).some((m) => m.id === MODEL), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const root = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/settle-${Date.now().toString(36)}`;
  const dirs = { first: `${root}/a-first`, mid: `${root}/m-mid`, wait: `${root}/z-wait` };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const made: string[] = [];
  let folder: string | undefined;
  const mk = async (title: string, workspace: string, text?: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title, workspace } })).json();
    made.push(session.id);
    if (text) {
      await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text } });
    }
    return session.id as string;
  };
  const list = page.getByTestId("session-list");
  const row = (id: string) => list.locator(`[data-testid="session-row"][data-session="${id}"]`);
  const state = async (id: string) => ((await (await request.get("/api/state")).json()).states ?? {})[id]?.watch as string | undefined;
  try {
    const reader = await mk("Reading: design notes", dirs.mid), r1 = await mk("Mid task 1: tidy the logs", dirs.mid), r2 = await mk("Mid task 2: review the patch", dirs.mid), r3 = await mk("Mid task 3: update the docs", dirs.mid);
    // Fourteen that wait on a timer (each may hold a queued message).
    const waiting: string[] = [];
    for (let i = 1; i <= 14; i++) waiting.push(await mk(`Wait ${i}: check the deploy`, dirs.wait, script([{ name: "wait_for", input: { kind: "timer", seconds: 900, note: "check the deploy" } }])));
    await expect.poll(() => state(waiting.at(-1)!), { timeout: 30_000 }).toBe("wait");

    // A page load gets the counts with its states, without reading any waiting session.
    const bare: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (r.method() === "GET" && u.searchParams.get("events") === "0" && waiting.some((id) => u.pathname === `/api/sessions/${id}`)) bare.push(u.pathname);
    });
    await page.goto(`/s/${reader}`);
    await expect(row(waiting[0]!)).toHaveAttribute("data-watch", "wait");

    // 1. One of the owner's folders, folded on another device while the pointer is in the list
    // ("By my folders"): no row moves under the hand. It folds when the hand has left.
    folder = (await (await request.post("/api/session-folders", { data: { name: "Chores" } })).json()).folder.id as string;
    await request.patch(`/api/sessions/${r1}`, { data: { folder_id: folder } });
    await page.getByTestId("list-arrange").click();
    await page.getByTestId("arrange-group-mine").click();
    await page.keyboard.press("Escape");
    await expect(list.locator(`[data-testid="folder-head"][data-folder="${folder}"]`)).toBeVisible();
    await expect(row(r1)).toBeVisible();
    await arm(page);
    // (The pointer rests on the open session's row: by their folders the other rows at rest may be behind "N more".)
    const under = (await row(reader).boundingBox())!;
    const stir = (n = 0) => page.mouse.move(under.x + 120 + (n % 2), under.y + under.height / 2);
    await stir();
    await expect(list).toHaveAttribute("data-held", "true");
    await page.waitForTimeout(300);
    await seen(page);
    await request.patch(`/api/session-folders/${folder}`, { data: { collapsed: true } });
    await page.waitForTimeout(700);
    await stir(1);
    await page.waitForTimeout(500);
    const folded = await seen(page);
    expect({ moves: folded.moves, under: folded.under }, "a folder folded elsewhere, under the pointer").toEqual({ moves: 0, under: [reader] });
    await expect(row(r1)).toBeVisible();
    await page.mouse.move(1200, 300);
    await expect(row(r1)).toHaveCount(0);
    await request.patch(`/api/session-folders/${folder}`, { data: { collapsed: false } });
    await page.getByTestId("list-arrange").click();
    await page.getByTestId("arrange-reset").click();
    await page.keyboard.press("Escape");
    await expect(row(r1)).toBeVisible();

    // 2. Eight sessions made elsewhere while the pointer is in the list of a short window: nothing
    // moves; they wait at the list's end, the first of them (the rest behind "N more"); and since
    // that is below what the list shows, a line at its foot says so. A press on it goes to them.
    await page.setViewportSize({ width: 1920, height: 620 });
    await list.evaluate((nav) => { nav.scrollTop = 0; });
    const at = (await row(r2).boundingBox())!;
    const hand = (n = 0) => page.mouse.move(at.x + 120 + (n % 2), at.y + at.height / 2);
    await hand();
    await expect(list).toHaveAttribute("data-held", "true");
    await page.waitForTimeout(300);
    await seen(page);
    const came: string[] = [];
    for (let i = 1; i <= 8; i++) came.push(await mk(`Arrival ${i}: made on another device`, dirs.first));
    const late = page.getByTestId("late-group");
    await expect(late.locator('[data-testid="session-row"]')).toHaveCount(6);
    await expect(late.locator(".k-more")).toHaveText("2 more");
    await hand(1);
    const arrived = await seen(page, r2);
    expect({ moves: arrived.moves, under: arrived.under, at: arrived.at.length }, "eight arrivals, under the pointer").toEqual({ moves: 0, under: [r2], at: 1 });
    await expect(late).not.toBeInViewport();
    const line = page.getByTestId("late-line");
    await expect(line).toHaveText("8 just arrived, below");
    await expect(line).toBeInViewport({ ratio: 1 });
    await shoot(page, "rail-stable-11-arrivals-wait-below");
    await line.click();
    await expect(late).toBeInViewport();
    await expect(line).toHaveCount(0);
    await expect(list).toHaveAttribute("data-held", "true");

    // 3. The hand goes back to its row, then leaves for less than a second: the arrivals take their
    // places above it (a folder of their own, first in the list), and the row is where it was when
    // the pointer comes back.
    await list.evaluate((nav) => { nav.scrollTop = 0; });
    await hand();
    await page.waitForTimeout(300);
    const before = (await row(r2).boundingBox())!;
    await page.mouse.move(1200, 300);
    await expect(late).toHaveCount(0, { timeout: 3000 });
    await expect(row(came.at(-1)!)).toHaveCount(1);
    const after = (await row(r2).boundingBox())!;
    expect(Math.abs(after.y - before.y), `the row the hand was on moved ${after.y - before.y}px when the list settled`).toBeLessThan(1);
    await hand();
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid="session-row"]')?.getAttribute("data-session"), [at.x + 120, at.y + at.height / 2] as const)).toBe(r2);
    // The arrivals are above it now, in their folder, first in the list.
    expect(await list.locator('[data-testid="session-row"]').evaluateAll((els, id) => els.findIndex((e) => e.getAttribute("data-session") === id), came.at(-1)!)).toBe(0);
    await shoot(page, "rail-stable-12-settled-around-the-row");
    expect(bare, "requests for a row's queue after the page loaded").toEqual([]);
    void r3;
  } finally {
    for (const id of made) { await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {}); await request.delete(`/api/sessions/${id}`).catch(() => {}); }
    if (folder) await request.delete(`/api/session-folders/${folder}`).catch(() => {});
  }
});

// Feature: the list is quiet while sessions take short turns. A turn of a second is not a flash on
// its row, and the line above the list, the filter box and the message boxes are not written again
// for nothing: outside the conversations the page changes a few times a second at most. And a row
// pinned with the pointer stays where it is, the others too, until the pointer leaves the list.
test("a busy list is quiet, and a row pinned with the pointer moves when the pointer has left", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === MODEL), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const root = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/quiet-${Date.now().toString(36)}`;
  mkdirSync(root, { recursive: true });
  const made: string[] = [];
  const mk = async (title: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title, workspace: root } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    made.push(session.id);
    return session.id as string;
  };
  try {
    const busy: string[] = [];
    for (let i = 0; i < 5; i++) busy.push(await mk(`Quick turns ${i + 1}`));
    const reader = await mk("Reading the notes");
    const other = await mk("Notes for later");
    for (const id of [reader, other]) await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:say The notes are long." } });
    // Set from a page of this origin that runs none of the app: an open page writes its own panes back over them.
    await page.goto("/api/daemon");
    await page.evaluate((slots) => localStorage.setItem("keel.panes", JSON.stringify({ count: 2, slots, sizes: {}, active: 0 })), [reader, other]);
    await page.goto(`/s/${reader}`);
    await expect(page.locator("section.k-station")).toHaveCount(2);
    await page.waitForTimeout(1500);
    // Count what changes outside the conversations while a short turn starts somewhere every 500 ms (two quiet panes).
    await page.evaluate(() => {
      const w = window as unknown as { __muts: number; __by: Record<string, number> };
      w.__muts = 0; w.__by = {};
      new MutationObserver((recs) => {
        for (const r of recs) {
          const el = (r.target.nodeType === 1 ? r.target : r.target.parentElement) as HTMLElement | null;
          if (!el || el.closest('[data-testid="transcript"]')) continue;
          w.__muts++;
          const k = el.closest("[data-testid]")?.getAttribute("data-testid") ?? el.tagName;
          w.__by[k] = (w.__by[k] ?? 0) + 1;
          const said = (w as unknown as { __said: Record<string, string[]> }).__said ??= {};
          if ((said[k] ??= []).length < 3) said[k]!.push(`${r.type}${r.attributeName ? `[${r.attributeName}]` : ""} <${el.className.toString().slice(0, 20)}> ${(el.textContent ?? "").slice(0, 30)}`);
        }
      }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    let n = 0, on = true;
    const t0 = Date.now();
    const storm = (async () => { while (on) { void request.post(`/api/sessions/${busy[n++ % busy.length]}/messages`, { data: { text: `script:say Tick ${n}.` } }).catch(() => {}); await new Promise((r) => setTimeout(r, 500)); } })();
    await page.waitForTimeout(10_000);
    on = false;
    await storm;
    const { muts, by, said } = await page.evaluate(() => { const w = window as unknown as { __muts: number; __by: Record<string, number>; __said: Record<string, string[]> }; return { muts: w.__muts, by: w.__by, said: w.__said ?? {} }; });
    const secs = (Date.now() - t0) / 1000;
    const why = JSON.stringify(Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => [k, n, said[k]]));
    // A row says Working for a turn that ran longer than the list waits (on a busy machine a short turn can):
    // what such a turn costs its row is allowed for, and nothing else of the list moves at all for the turns.
    const long = (await Promise.all(busy.map(async (id) => ((await (await request.get(`/api/sessions/${id}`)).json()).events as { kind: string; ts: number; data: { ms?: number } }[]).filter((e) => e.kind === "turn_end" && e.ts >= t0 && (e.data.ms ?? 0) >= 1500).length))).reduce((a, b) => a + b, 0);
    const rows = Object.entries(by).filter(([k]) => k === "session-row" || k === "row-time").reduce((n, [, v]) => n + v, 0);
    expect(rows, why).toBeLessThanOrEqual(Math.max(8 * long, 3 * n) + 6);
    // (A count that comes or gains a figure is fitted to its line again: a few writes, now and then.)
    expect((muts - rows) / secs, why).toBeLessThanOrEqual(4);

    // Pin a row with the pointer: nothing in the list moves while the pointer is on it.
    await page.waitForTimeout(2000);
    const rowOf = (id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);
    const target = rowOf(busy[3]!);
    await target.scrollIntoViewIfNeeded();
    const tops = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid="session-list"] [data-testid="session-row"]')].map((e) => [e.getAttribute("data-session"), Math.round(e.getBoundingClientRect().top)])));
    await target.hover();
    const before = await tops();
    await target.getByTestId("row-pin").click();
    await expect(target).toHaveAttribute("data-pinned", "true");
    await page.waitForTimeout(800);
    const during = await tops();
    for (const [id, y] of Object.entries(before)) if (id in during) expect(during[id], `row ${id}`).toBe(y);
    await expect(page.getByTestId("pinned-group").locator(`[data-session="${busy[3]}"]`)).toHaveCount(0);
    // The pointer leaves the list: the row takes its place among the pinned.
    await page.mouse.move(1200, 500);
    await expect(page.getByTestId("pinned-group").locator(`[data-session="${busy[3]}"]`)).toHaveCount(1, { timeout: 5000 });
    await shoot(page, "rail-stable-09-pinned-after");
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
  }
});
