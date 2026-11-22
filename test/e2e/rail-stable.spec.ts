import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the session list stays where the owner left it. By default a row's
// place comes from when its session was made, so no turn that starts or ends
// anywhere moves it; what a session needs is its mark, its word and a count
// on the line above the list, where a press goes to the next one's row.
// Every row is as high at rest as at work. Under the pointer or the keyboard
// nothing moves in any order: a session that arrives waits at the list's end
// and one that leaves stays as a dimmed row until the hand has left. With
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
test.setTimeout(300_000);

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
async function seen(page: Page) {
  const frames = await page.evaluate(() => { const w = window as any; const f = w.__rail.frames; w.__rail.frames = []; return f; }) as Frame[];
  let moves = 0, resized = 0, jump = 0;
  const heights = new Set<number>(), under = new Set<string | null>();
  for (let i = 0; i < frames.length; i++) {
    under.add(frames[i]!.under);
    for (const [id, [y, h]] of Object.entries(frames[i]!.rows)) {
      heights.add(h);
      const was = frames[i - 1]?.rows[id];
      if (!was) continue;
      if (was[0] !== y) { moves++; jump = Math.max(jump, Math.abs(y - was[0])); }
      if (was[1] !== h) resized++;
    }
  }
  return { frames: frames.length, moves, jump, resized, heights: [...heights], under: [...under] };
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
    // The storm is on: a row of it says working at some point.
    await page.waitForFunction((ticks) => ticks.some((id) => document.querySelector(`[data-testid="session-list"] [data-session="${id}"]`)?.getAttribute("data-watch") === "work"), day.ticks, { polling: "raf", timeout: 20_000 });
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
    await page.mouse.move(at.x + 120, at.y + at.height / 2);
    await expect(list).toHaveAttribute("data-held", "true");
    await page.waitForTimeout(300);
    await seen(page);
    await page.waitForTimeout(6000);
    const held = await seen(page);
    expect({ moves: held.moves, resized: held.resized, under: held.under }, "by recent activity, under the pointer").toEqual({ moves: 0, resized: 0, under: [ids.idle] });

    // 5. Still held: a session made elsewhere waits at the list's end and one archived elsewhere
    // stays as a dimmed row, so nothing moved. Both take their place when the pointer has left.
    const made = (await (await request.post("/api/sessions", { data: { model: MODEL, title: "Made on another device", workspace: `${day.root}/api` } })).json()).session.id as string;
    await expect(page.getByTestId("late-group").locator(`[data-session="${made}"]`)).toBeVisible();
    await request.patch(`/api/sessions/${ids.fail}`, { data: { archived: true } });
    await expect(row(ids.fail!)).toHaveAttribute("data-gone", "true");
    await expect(row(ids.fail!).getByTestId("row-gone")).toHaveText("Archived");
    await page.waitForTimeout(300);
    const came = await seen(page);
    expect({ moves: came.moves, under: came.under }, "a session arriving and one leaving, under the pointer").toEqual({ moves: 0, under: [ids.idle] });
    await page.mouse.move(1200, 500);
    await expect(list).not.toHaveAttribute("data-held", "true");
    await expect(page.getByTestId("late-group")).toHaveCount(0);
    await expect(row(ids.fail!)).toHaveCount(0);
    await expect(row(made)).toBeVisible();
    await request.patch(`/api/sessions/${ids.fail}`, { data: { archived: false } });
    await request.delete(`/api/sessions/${made}`);
    await page.getByTestId("list-arrange").click();
    await page.getByTestId("arrange-reset").click();
    await expect(row(ids.fail!)).toBeVisible();
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
  const hide = (id: string) => list.evaluate((nav, sid) => {
    const r = nav.querySelector<HTMLElement>(`[data-session="${sid}"]`)!.getBoundingClientRect(), n = nav.getBoundingClientRect();
    nav.scrollTop = r.top - n.top + nav.scrollTop > nav.clientHeight ? 0 : nav.scrollHeight;
  }, id);
  await hide(ids.need!);
  await expect(row(ids.need!)).not.toBeInViewport();
  await page.getByTestId("sum-need").click();
  await expect(row(ids.need!)).toBeFocused();
  await expect(row(ids.need!)).toBeInViewport({ ratio: 0.95 });
  await hide(ids.fail!);
  await page.getByTestId("composer").click();
  // By keyboard: the count is a button; pressed again with nothing else needing them, the same row.
  await hide(ids.need!);
  await page.getByTestId("sum-need").focus();
  await page.keyboard.press("Enter");
  await expect(row(ids.need!)).toBeFocused();
  await expect(row(ids.need!)).toBeInViewport({ ratio: 0.95 });
  await page.getByTestId("sum-fail").click();
  await expect(row(ids.fail!)).toBeFocused();
  await expect(row(ids.fail!)).toBeInViewport({ ratio: 0.95 });
  await page.setViewportSize({ width: 1920, height: 1040 });

  // 7. The message queued behind the working turn shows on its row.
  await expect(row(ids.work!).getByTestId("row-queued")).toHaveText("1 queued");
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
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(row(ids.idle!).getByTestId("row-archive")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(row(ids.idle!)).toHaveCount(0);
  await expect(row(after)).toBeFocused();
  await page.getByTestId("composer").focus();

  // 10. The default changed once for a browser that kept the old one: its menu says so, once.
  await page.evaluate(() => localStorage.setItem("keel.listArrange", JSON.stringify({ group: "folder", sort: "recent", hideDone: false })));
  await page.reload();
  await page.getByTestId("list-arrange").click();
  await expect(page.getByTestId("arrange-note")).toBeVisible();
  await expect(page.getByTestId("arrange-sort-created")).toHaveAttribute("aria-checked", "true");
  await shoot(page, "rail-stable-02-arrange-note");
  await page.keyboard.press("Escape");
  await page.getByTestId("list-arrange").click();
  await expect(page.getByTestId("arrange-menu")).toBeVisible();
  await expect(page.getByTestId("arrange-note")).toHaveCount(0);
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

    // Four panes at 1920: no room for the list at its width, room for titles.
    await panes([ids.reader!, ids.work!, ids.need!, ids.wait!]);
    await page.reload();
    await expect(page.locator("section.k-station")).toHaveCount(4);
    await expect(side).toHaveAttribute("data-narrow", "true");
    await expect(list.getByTestId("rail-code")).toHaveCount(0);
    const mine = Object.values(ids);
    const rows = await list.locator('[data-testid="session-row"]').evaluateAll((els, own) => els.filter((e) => own.includes(e.getAttribute("data-session")!)).map((e) => {
      const t = e.querySelector<HTMLElement>(".k-row-title")!;
      return { title: t.textContent, shown: t.getBoundingClientRect().width, cut: getComputedStyle(t).textOverflow, height: e.getBoundingClientRect().height, lines: Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight)) };
    }), mine);
    expect(rows).toHaveLength(12);
    const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    for (const r of rows) {
      expect(r.title, "a row names its session").toBeTruthy();
      expect(r.shown, `the title of "${r.title}" has room to be read`).toBeGreaterThan(4.5 * rem);
      expect([r.cut, r.lines]).toEqual(["ellipsis", 1]);
    }
    expect(new Set(rows.map((r) => Math.round(r.height))).size, "rows of one height").toBe(1);
    expect(rows[0]!.height).toBeLessThan(2 * rem);
    // The panes keep their narrowest width and nothing scrolls sideways for the list.
    expect(await fits()).toBe(true);
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
    await expect(row(ids.need!).getByTestId("row-state")).toBeVisible();
    await expect(page.getByTestId("sum-need")).toBeVisible();
    await shoot(page, "rail-stable-05-phone");
  } finally {
    writeFileSync(day.gate, "");
  }
});
