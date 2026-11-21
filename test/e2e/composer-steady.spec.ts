import { expect, test, type Page } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { shoot } from "./shots.ts";

// Feature: the message box and the conversation above it hold still while the
// owner types. On one line nothing moves: not the box, not its row of tools,
// not the conversation's scroll. A new line grows the box upward and the
// conversation that follows its end keeps its last line in view. A draft of
// several lines does not pull the conversation up at each key, also while a
// reply streams. The scripted stand-in writes the replies.
const STAND_IN = "scripted:stand-in";
const WS = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws`;
const SENTENCE = "The quick brown fox jumps over the lazy dog and keeps on going"; // 62 keys, one line in a wide box

// What the page shows of the box and the conversation, in px as laid out.
const read = (page: Page) => page.evaluate(() => {
  const ta = document.activeElement as HTMLTextAreaElement;
  const box = ta.closest<HTMLElement>(".k-composer-box")!;
  const view = ta.closest(".k-session")!.querySelector<HTMLElement>(".k-reading")!;
  const tools = box.querySelector<HTMLElement>(".k-compose-tools")!;
  const r = (el: Element) => { const b = el.getBoundingClientRect(); return [b.top, b.bottom].map((x) => Math.round(x * 100) / 100); };
  return { box: r(box), text: r(ta), tools: r(tools), view: r(view), top: view.scrollTop, gap: view.scrollHeight - view.scrollTop - view.clientHeight, lines: ta.scrollHeight, bar: ta.scrollHeight > ta.clientHeight };
});
// Two frames: what the key changed is laid out and painted.
const settle = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
// Types one key at a time; while the text stays on its lines nothing may move.
async function typeSteady(page: Page, text: string, what: string) {
  let was = await read(page);
  for (const [i, ch] of [...text].entries()) {
    await page.keyboard.type(ch);
    await settle(page);
    const now = await read(page);
    if (now.lines === was.lines) expect.soft({ ...now, gap: 0 }, `${what}: key ${i + 1} "${ch}" moved something`).toEqual({ ...was, gap: 0 });
    expect.soft(now.bar, `${what}: a scroll bar in the box at key ${i + 1}`).toBe(false);
    was = now;
  }
  return was;
}

test("typing moves neither the message box nor the conversation", async ({ page, request, browser, baseURL }) => {
  mkdirSync(WS, { recursive: true });
  const made: string[] = [];
  const mk = async (title: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title, workspace: WS } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    made.push(session.id);
    return session.id as string;
  };
  const idle = async (id: string) => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; };
  const say = async (id: string, text: string) => {
    await request.post(`/api/sessions/${id}/messages`, { data: { text } });
    await expect.poll(() => idle(id), { timeout: 30_000 }).toBe(true);
  };
  const para = "A reply of some length that fills the conversation so that it scrolls. ".repeat(12);
  const long = async (title: string) => {
    const id = await mk(title);
    await say(id, `script:replies ${JSON.stringify([para, para, para])}`);
    await say(id, "go on");
    await say(id, "go on");
    return id;
  };
  try {
    const a = await long("A long conversation to type under");
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`/s/${a}`);
    const box = page.getByTestId("composer");
    await expect(box).toBeVisible();
    await expect(page.getByTestId("turn-end").last()).toBeVisible();
    await box.click();
    await settle(page);
    expect((await read(page)).gap, "the conversation rests at its end").toBeLessThan(2);

    // 1. One line: 62 keys, nothing moves.
    const one = await typeSteady(page, SENTENCE, "one line");
    expect(one.lines).toBe((await read(page)).lines);

    // 2. A new line grows the box upward, by a line; its foot stays, and the end of the conversation stays in view.
    await page.keyboard.press("Shift+Enter");
    await settle(page);
    const two = await read(page);
    expect(two.lines).toBeGreaterThan(one.lines);
    expect(two.box[1], "the box's foot stays").toBe(one.box[1]);
    expect(one.box[0]! - two.box[0]!, "the box grows by the line").toBeCloseTo(two.lines - one.lines, 0);
    expect.soft(two.gap, "the last line of the conversation is still in view").toBeLessThan(2);
    await typeSteady(page, "and a second line under it", "two lines");
    await page.keyboard.press("Shift+Enter");
    await settle(page);
    await typeSteady(page, "then a third", "three lines");
    await shoot(page, "composer-steady-01-three-lines");

    // 3. The draft is kept across a reload: the first key typed under it moves nothing.
    await page.reload();
    await expect(box).toHaveValue(/then a third$/);
    await expect(page.getByTestId("turn-end").last()).toBeVisible();
    await box.focus();
    await page.keyboard.press("Control+End");
    await page.waitForTimeout(500);
    expect.soft((await read(page)).gap, "the conversation rests at its end over a kept draft").toBeLessThan(2);
    await typeSteady(page, " line of it", "a kept draft");

    // 4. While a reply streams, a key under a draft of three lines never pulls the conversation up.
    await request.post(`/api/sessions/${a}/messages`, { data: { text: "script:render" } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${a}`)).json()).running, { timeout: 15_000 }).toBe(true);
    let top = (await read(page)).top;
    for (const ch of " and more while it streams") {
      await page.keyboard.type(ch);
      await settle(page);
      const now = (await read(page)).top;
      expect.soft(now, `the conversation went up at "${ch}" while the reply streamed`).toBeGreaterThanOrEqual(top);
      top = now;
    }
    await expect.poll(() => idle(a), { timeout: 60_000 }).toBe(true);

    // 5. Narrow panes, a larger text size and a fractional device scale: rows are parts of a
    // pixel high there, and the first key must not grow the box by the rest.
    const others = [await long("Second pane"), await long("Third pane"), await long("Fourth pane")];
    for (const c of [{ scale: 1, dsf: 1, panes: 4 }, { scale: 1.35, dsf: 1.5, panes: 3 }, { scale: 1.1, dsf: 1.25, panes: 2 }]) {
      const ctx = await browser.newContext({
        viewport: { width: 1920, height: 1040 },
        deviceScaleFactor: c.dsf,
        storageState: { cookies: [], origins: [{ origin: new URL(baseURL!).origin, localStorage: [
          { name: "keel.focus", value: "false" },
          { name: "keel.textScale", value: JSON.stringify(c.scale) },
          { name: "keel.panes", value: JSON.stringify({ count: c.panes, slots: [others[0], a, others[1], others[2]].slice(0, c.panes), sizes: {}, active: 0 }) },
        ] }] },
      });
      const p = await ctx.newPage();
      await p.goto(`/s/${others[0]}`);
      const b = p.locator(`[data-station="${others[0]}"]`).getByTestId("composer");
      await expect(b).toBeVisible();
      await expect(p.locator(`[data-station="${others[0]}"]`).getByTestId("turn-end").last()).toBeVisible();
      await p.waitForTimeout(800);
      await b.click();
      await settle(p);
      await typeSteady(p, SENTENCE.slice(0, 24), `${c.panes} panes, text size ${c.scale}, device scale ${c.dsf}`);
      if (c.panes === 4) await shoot(p, "composer-steady-02-four-panes");
      await ctx.close();
    }
  } finally {
    for (const id of made) { await request.post(`/api/sessions/${id}/interrupt`).catch(() => {}); await request.delete(`/api/sessions/${id}`).catch(() => {}); }
  }
});
