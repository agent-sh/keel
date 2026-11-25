import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: a session's state is one small dot in its row. Working is a solid blue dot, the size of the others, with a soft
// glow that breathes slowly (no spin, and still under reduced motion); it is never a dot inside a ring, which reads as a
// selected radio button. Needs you is yellow, failed or declined red, done green (a success mark's hue); a finished row that was read steps
// back to a fainter dot. A session that only waits on its agents or on a command in the background wears a hollow ring
// of blue dashes and says so. News is a white dot at the row's end, in the time's place; every title has one weight.
// Every dot keeps its state word for a reader and
// in its tooltip. The sidebar says no number of agents: the row has a chevron that opens their tree, and the
// session itself says how many work, wait, failed or are done. Contrast of each dot on the rail is 3:1 or more.
const STAND_IN = "scripted:stand-in";
const WS = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/state-dots`;
const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;
const row = (page: Page, id: string) => page.locator(`[data-testid="session-row"][data-session="${id}"]`);
const states = async (request: APIRequestContext) => ((await (await request.get("/api/state")).json()).states ?? {}) as Record<string, { watch: string; why?: string }>;
const SIZES = [{ width: 1920, height: 1040 }, { width: 1366, height: 768 }, { width: 390, height: 844 }];

async function make(request: APIRequestContext, title: string, mode = "full-auto") {
  mkdirSync(WS, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title, workspace: WS } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode, sandbox: "off" } });
  return session.id as string;
}
const send = (request: APIRequestContext, id: string, text: string) => request.post(`/api/sessions/${id}/messages`, { data: { text } });
const rested = async (request: APIRequestContext, id: string) => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; };

// A color token as the browser paints it, and its contrast on the rail's grey (`--panel`), in the theme the page has.
async function paint(page: Page, token: string) {
  return page.evaluate((t) => {
    const probe = Object.assign(document.createElement("i"), { className: "k-rail" });
    probe.style.cssText = `position:fixed;width:0;height:0;color:var(${t})`;
    document.body.append(probe);
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    const rgb = (c: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lum = (c: number[]) => { const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
    const s = getComputedStyle(probe);
    const fg = rgb(s.color), bg = rgb(s.backgroundColor);
    const [x, y] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    const out = { color: s.color, rgb: fg, ratio: Math.round(((x! + 0.05) / (y! + 0.05)) * 100) / 100 };
    probe.remove();
    return out;
  }, token);
}
// The list at each size: where the page folds it away (a phone), its button shows it first.
async function shootList(page: Page, name: string, session: string, ready: () => Promise<void>) {
  for (const size of SIZES) {
    await page.setViewportSize(size);
    if (size.width < 500) await page.goto(`/s/${session}`);
    // A phone has no rail: the session header's button shows the list over the page.
    const show = page.getByTestId("show-sidebar");
    if (size.width < 500) await show.first().click();
    await ready();
    await expect(page.locator('[data-testid="session-row"]:visible').first()).toBeInViewport();
    await page.waitForTimeout(300);
    await shoot(page, `${name}-${size.width}x${size.height}`);
  }
  await page.setViewportSize(SIZES[0]!);
}
const dark = (page: Page, on: boolean) => page.evaluate((d) => document.documentElement.classList.toggle("dark", d), on);

test("a row's state is one dot, and a session that waits on what it left going has its own", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "requires the scripted provider");
  test.setTimeout(300_000);
  mkdirSync(WS, { recursive: true });
  const gate = join(WS, `gate-${Date.now().toString(36)}`);
  const hold = { name: "Bash", input: { command: `i=0; until [ -f ${gate} ] || [ $i -ge 330 ]; do i=$((i+1)); sleep 0.3; done; echo released` } };
  const made: string[] = [];
  const mk = async (title: string, mode?: string) => { const id = await make(request, title, mode); made.push(id); return id; };
  try {
    const working = await mk("Dots: one at work");
    const asking = await mk("Dots: one that asks", "ask");
    const failed = await mk("Dots: one that failed");
    const declined = await mk("Dots: one that was declined");
    const done = await mk("Dots: one that is done");
    const news = await mk("Dots: one with news");
    const command = await mk("Dots: a command in the background");
    const lead = await mk("Dots: waits on its agents");
    await send(request, working, script([{ name: "Bash", input: { command: "sleep 90; echo worked" } }]));
    await send(request, asking, script([{ name: "Bash", input: { command: "echo dots-asks > dots-asks.txt" } }]));
    await send(request, failed, "script:billing");
    await send(request, declined, "script:refuse");
    await send(request, done, "script:say Done.");
    await send(request, news, "script:say Done, and not read yet.");
    await send(request, command, script([{ name: "Bash", input: { command: "sleep 240", run_in_background: true, description: "the long migration" } }]));
    await send(request, lead, script([{ name: "spawn_agent", input: { message: `Hold the lane\nscript:calls ${JSON.stringify([hold])}`, isolation: "none" } }]));
    for (const id of [failed, declined, done, news]) await expect.poll(async () => ((await (await request.get(`/api/sessions/${id}`)).json()).events as { kind: string }[]).some((e) => e.kind === "turn_end"), { timeout: 60_000 }).toBe(true);
    await expect.poll(async () => { const st = await states(request); return [working, asking, failed, declined, done, news, command, lead].map((id) => st[id]?.watch).join(" "); }, { timeout: 60_000 })
      .toBe("work need fail declined done done work work");
    await request.post(`/api/sessions/${news}/marks`, { data: { unread: true } });
    await request.post(`/api/sessions/${done}/marks`, { data: { unread: false } });

    await page.setViewportSize(SIZES[0]!);
    await page.goto("/");
    for (const id of made) await expect(row(page, id)).toBeVisible();
    await expect(row(page, news)).toHaveAttribute("data-unread", "true");
    const mark = (id: string) => row(page, id).locator(".k-mark");

    // Each state is its own dot, with its word for a reader and in the tooltip.
    const words: [string, string, string][] = [[working, "work", "Working"], [asking, "need", "Needs you"], [failed, "fail", "Failed"], [declined, "declined", "Declined"], [done, "done", "Done"]];
    for (const [id, watch, word] of words) {
      await expect(mark(id)).toHaveAttribute("data-watch", watch);
      await expect(mark(id)).toHaveAttribute("role", "img");
      await expect(mark(id)).toHaveAttribute("aria-label", word);
      await expect(mark(id)).toHaveAttribute("title", word);
    }
    // Waiting on what it left going: a ring of blue dashes, and the word says what.
    await expect(mark(command)).toHaveAttribute("data-bg", "command");
    await expect(mark(command)).toHaveAttribute("aria-label", "Command in background");
    await expect(mark(command)).toHaveAttribute("title", "Command in background");
    await expect(mark(lead)).toHaveAttribute("data-bg", "agents");
    await expect(mark(lead)).toHaveAttribute("aria-label", "Waiting on agents");
    await expect(mark(lead)).toHaveAttribute("title", "Waiting on agents");
    for (const id of [working, asking, failed, declined, done]) await expect(mark(id)).not.toHaveAttribute("data-bg", /./);

    // Color is the state: the dot wears its token, in both themes, and each reads on the rail.
    const TOKENS: [string, string][] = [[working, "--dot-work"], [asking, "--dot-need"], [failed, "--dot-fail"], [done, "--dot-done"]];
    for (const isDark of [false, true]) {
      await dark(page, isDark);
      for (const [id, token] of TOKENS) {
        const want = (await paint(page, token)).color;
        expect(await mark(id).evaluate((el) => getComputedStyle(el).backgroundColor), `${token} ${isDark ? "dark" : "light"}`).toBe(want);
        expect(await mark(id).evaluate((el) => getComputedStyle(el).borderRadius), "a dot is round").toBe("50%");
        const { ratio } = await paint(page, token === "--dot-need" ? "--dot-need-edge" : token);
        expect(ratio, `${token} on the rail, ${isDark ? "dark" : "light"}`).toBeGreaterThanOrEqual(3);
      }
      expect((await paint(page, "--dot-unread")).ratio, `news on the rail, ${isDark ? "dark" : "light"}`).toBeGreaterThanOrEqual(7);
      // Declined is red too (a hollow dot), and a command that waits is a ring of the work dot's blue with nothing inside it.
      expect(await mark(declined).evaluate((el) => getComputedStyle(el).boxShadow)).toContain((await paint(page, "--dot-fail")).color);
      expect(await mark(command).evaluate((el) => ({ color: getComputedStyle(el).borderTopColor, style: getComputedStyle(el).borderTopStyle, inner: getComputedStyle(el, "::before").content }))).toEqual({ color: (await paint(page, "--dot-work")).color, style: "dashed", inner: "none" });
    }
    // The done dot still reads on the page's own ground (the phone's bar and tab strip
    // are on it, not on the rail): 3:1 on paper and 4.5:1 at night.
    for (const isDark of [false, true]) {
      await dark(page, isDark);
      const onBg = await page.evaluate(() => {
        const probe = document.createElement("i");
        probe.style.cssText = "position:fixed;width:0;height:0;color:var(--dot-done);background:var(--bg)";
        document.body.append(probe);
        const cv = document.createElement("canvas");
        cv.width = cv.height = 1;
        const ctx = cv.getContext("2d", { willReadFrequently: true })!;
        const rgb = (c: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
        const lum = (c: number[]) => { const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
        const s = getComputedStyle(probe);
        const [x, y] = [lum(rgb(s.color)), lum(rgb(s.backgroundColor))].sort((a, b) => b - a);
        probe.remove();
        return (x! + 0.05) / (y! + 0.05);
      });
      expect(onBg, `the done dot on the page, ${isDark ? "dark" : "light"}`).toBeGreaterThanOrEqual(isDark ? 4.5 : 3);
    }
    await dark(page, false);

    // Working is a solid dot the size of the others; its glow is a shadow that starts at the dot's edge (no gap, so no ring
    // around the dot), and it breathes (opacity and scale, never a turn), under reduced motion too.
    const motion = (id: string) => mark(id).evaluate((el) => {
      const a = getComputedStyle(el, "::after"), r = el.getBoundingClientRect();
      return { own: getComputedStyle(el).animationName, halo: a.animationName, haloOn: a.content !== "none" && a.display !== "none", glow: a.boxShadow !== "none" && a.backgroundImage === "none", same: Math.abs(parseFloat(a.width) - r.width) < 0.5, width: r.width };
    });
    const worked = await motion(working);
    expect(worked).toMatchObject({ own: "none", halo: "k-dot-breathe", haloOn: true, glow: true, same: true });
    expect(worked.width, "the working dot is the size of the others").toBe((await motion(done)).width);
    expect((await motion(done)).haloOn).toBe(false);
    expect((await motion(command)).haloOn, "a session that waits has no halo").toBe(false);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect((await motion(working)).halo, "it breathes under reduced motion too").not.toBe("none");
    await expect(mark(working)).toHaveAttribute("data-watch", "work");
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // Every row with news shows the white dot, and no other row does. A row that needs the owner or failed says more than
    // news, so it carries none.
    const fresh = page.getByTestId("session-list").locator('[data-testid="session-row"][data-news]');
    expect(await fresh.count()).toBeGreaterThanOrEqual(2);
    await expect.poll(() => page.getByTestId("session-list").evaluate((el) => [...el.querySelectorAll<HTMLElement>('[data-testid="session-row"]')]
      .filter((r) => { const d = r.querySelector<HTMLElement>('[data-testid="row-new"]'); return r.hasAttribute("data-news") !== (!!d && d.getBoundingClientRect().width > 0); }).map((r) => r.dataset.session)), { message: "the rows that say they are new and the rows that show the dot" }).toEqual([]);
    for (const id of [asking, failed, declined]) await expect(row(page, id)).not.toHaveAttribute("data-news", /./);
    // The foot: one count of what waits on the owner, and no dot after it.
    await expect(page.getByTestId("inbox-count")).toHaveText("1");
    await expect(page.getByTestId("inbox-button").locator(".k-inbox-dot")).toHaveCount(0);

    // News is a white dot at the row's end, in the time's place; the state keeps the row's one mark. A reader is told in words.
    await expect(row(page, news)).toHaveAttribute("data-news", "true");
    await expect(row(page, done)).not.toHaveAttribute("data-news", /./);
    expect(await page.getByTestId("session-list").getByTestId("row-unread").count(), "no old news dot in any row").toBe(0);
    await expect(row(page, news).locator(".k-mark")).toHaveCount(1);
    await expect(row(page, news).getByTestId("row-new")).toHaveText("New");
    await expect(row(page, news).getByTestId("row-new")).toBeVisible();
    await expect(row(page, news).getByTestId("row-time")).toBeHidden();
    await expect(row(page, done).getByTestId("row-new")).toHaveCount(0);
    const weight = (id: string) => row(page, id).locator(".k-row-title").evaluate((el) => Number(getComputedStyle(el).fontWeight));
    expect(await weight(news), "news is not a heavier title").toBe(await weight(done));
    // The done dot is green, a success mark's hue, on the news row too; the done row that was read steps back.
    for (const isDark of [false, true]) {
      await dark(page, isDark);
      const done_ = await paint(page, "--dot-done");
      expect(done_.color, `the done dot is the success green, ${isDark ? "dark" : "light"}`).toBe((await paint(page, "--ok")).color);
      expect(done_.rgb[1]!, `a done dot is green (${done_.rgb}), ${isDark ? "dark" : "light"}`).toBeGreaterThan(Math.max(done_.rgb[0]!, done_.rgb[2]!));
      for (const id of [done, news]) expect(await mark(id).evaluate((el) => getComputedStyle(el).backgroundColor), "the done dot wears that green").toBe(done_.color);
    }
    await dark(page, false);
    const fade = (id: string) => mark(id).evaluate((el) => Number(getComputedStyle(el).opacity));
    expect(await fade(news), "a finished row with news has its full dot").toBe(1);
    expect(await fade(done), "a finished row that was read steps back").toBeLessThan(1);

    await shootList(page, "state-dots-01-list", working, async () => {
      // (A page that has just loaded shows each row as its session record says, until the states it is told arrive and settle.)
      for (const [id, watch] of [[asking, "need"], [failed, "fail"], [declined, "declined"], [working, "work"]] as const) await expect(mark(id)).toHaveAttribute("data-watch", watch, { timeout: 15_000 });
    });
  } finally {
    for (const id of made) await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
    writeFileSync(gate, "go\n");
    for (const id of made) await request.delete(`/api/sessions/${id}`).catch(() => {});
  }
});

test("the sidebar counts no agents: the row's chevron opens their tree, and the session says how many work, wait, failed or are done", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "requires the scripted provider");
  test.setTimeout(240_000);
  mkdirSync(WS, { recursive: true });
  const gate = join(WS, `agents-${Date.now().toString(36)}`);
  const hold = { name: "Bash", input: { command: `i=0; until [ -f ${gate} ] || [ $i -ge 330 ]; do i=$((i+1)); sleep 0.3; done; echo released` } };
  const child = (title: string, body: string) => ({ name: "spawn_agent", input: { message: `${title}\n${body}`, isolation: "none" } });
  const lead = await make(request, "Dots: a coordinator");
  try {
    await send(request, lead, script([child("Hold lane one", script([hold])), child("Hold lane two", script([hold])), child("Summarize the issues", "script:say Report: 14 issues.")]));
    type Agent = { status: string };
    const agents = async () => (await (await request.get(`/api/sessions/${lead}/agents`)).json()).agents as Agent[];
    await expect.poll(async () => (await agents()).map((a) => a.status).sort().join(" "), { timeout: 90_000 }).toBe("completed running running");
    await expect.poll(() => rested(request, lead), { timeout: 60_000 }).toBe(true);

    await page.setViewportSize(SIZES[0]!);
    await page.goto("/");
    const wrap = row(page, lead).locator("xpath=..");
    // The row: its dot waits on agents, there is a chevron, and no line of counts under it.
    await expect(row(page, lead).locator(".k-mark")).toHaveAttribute("data-bg", "agents");
    const toggle = row(page, lead).getByTestId("children-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveAttribute("aria-label", "Show agents");
    // The chevron is left of the title, not in the row's end, which is one slot.
    expect((await toggle.boundingBox())!.x + (await toggle.boundingBox())!.width, "the chevron is left of the title").toBeLessThanOrEqual((await row(page, lead).locator(".k-row-title").boundingBox())!.x);
    await expect(row(page, lead).locator(".k-row-end").getByTestId("children-toggle")).toHaveCount(0);
    await expect(wrap.getByTestId("children-total")).toHaveCount(0);
    await expect(wrap.getByTestId("children-summary")).toHaveCount(0);
    expect(await wrap.innerText(), "the sidebar says no number of agents").not.toMatch(/\b\d+ agents?\b/);
    await expect(wrap.getByTestId("child-row")).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(wrap.getByTestId("child-row")).toHaveCount(3);
    expect(await wrap.innerText()).not.toMatch(/\b\d+ agents?\b/);
    // An agent's row is one line: what it does now, with its steps, time and cost, is its tooltip.
    await expect(wrap.getByTestId("agent-now")).toHaveCount(0);
    const working = wrap.getByTestId("child-session").filter({ hasText: "Hold lane one" });
    await expect(working).toHaveAttribute("title", /^Hold lane one: Working.*\bstep\b/, { timeout: 30_000 });
    for (const r of await wrap.getByTestId("child-row").all()) expect((await r.boundingBox())!.height, "an agent's row is one line").toBeLessThan(34);
    await shootList(page, "state-dots-02-tree", lead, () => expect(row(page, lead).locator(".k-mark")).toHaveAttribute("data-bg", "agents", { timeout: 15_000 }));
    await toggle.click();
    await expect(wrap.getByTestId("child-row")).toHaveCount(0);

    // The session itself: how many of each state, and a press opens the agents.
    await page.goto(`/s/${lead}`);
    const line = page.getByTestId("dock-agents");
    await expect(line).toBeVisible();
    await expect(line.getByTestId("dock-agents-part")).toHaveText(["2 working"]);
    await expect(line).toHaveAttribute("aria-label", "3 agents: 2 working, 1 done");
    await expect(line).toHaveAttribute("aria-description", "Waiting on agents");
    await expect(line.getByTestId("dock-agents-waiting")).toHaveText("Waiting on agents");
    for (const size of SIZES) { await page.setViewportSize(size); await shoot(page, `state-dots-03-session-agents-${size.width}x${size.height}`); }
    await page.setViewportSize(SIZES[0]!);
    // An agent that fails: it is counted, and the session reads Failed until looked at, so it no longer waits on its agents.
    await send(request, lead, script([child("Fetch the notes", "script:billing")]));
    await expect(line.getByTestId("dock-agents-part")).toHaveText(["1 failed", "2 working"], { timeout: 60_000 });
    await expect(line).toHaveAttribute("aria-label", "4 agents: 1 failed, 2 working, 1 done");
    await expect(line.getByTestId("dock-agents-waiting")).toHaveCount(0);
    for (const part of await line.getByTestId("dock-agents-part").all()) await expect(part.locator(".k-mark")).toBeVisible();
    await line.click();
    await expect(page.getByTestId("background-popup").getByTestId("bg-agent")).toHaveCount(4, { timeout: 30_000 });
    await shoot(page, "state-dots-04-agents-open");
    await page.keyboard.press("Escape");
  } finally {
    writeFileSync(gate, "go\n");
    await request.post(`/api/sessions/${lead}/interrupt`, { data: { by: "owner" } }).catch(() => {});
    await request.delete(`/api/sessions/${lead}`).catch(() => {});
  }
});
