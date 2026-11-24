import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: a session's state is one small dot in its row. Working is blue with a soft halo that breathes slowly
// (no spin; still under reduced motion); needs you is yellow, failed or declined red, done green. A session that
// only waits on its agents or on a command in the background wears the blue dot inside a ring and says so. News is
// a white dot at the row's right end (the ink in the light theme). Every dot keeps its state word for a reader and
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
async function shootList(page: Page, name: string, session: string) {
  for (const size of SIZES) {
    await page.setViewportSize(size);
    if (size.width < 500) await page.goto(`/s/${session}`);
    // A phone has no rail: the session header's button shows the list over the page.
    const show = page.getByTestId("show-sidebar");
    if (size.width < 500) await show.first().click();
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
    // Waiting on what it left going: the same blue dot in a ring, and the word says what.
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
      // Declined is red too (a hollow dot), and a command that waits is the work dot's blue.
      expect(await mark(declined).evaluate((el) => getComputedStyle(el).boxShadow)).toContain((await paint(page, "--dot-fail")).color);
      expect(await mark(command).evaluate((el) => getComputedStyle(el).boxShadow)).toContain((await paint(page, "--dot-work")).color);
      expect(await mark(command).evaluate((el) => getComputedStyle(el, "::before").backgroundColor)).toBe((await paint(page, "--dot-work")).color);
    }
    await dark(page, false);

    // Working breathes (opacity and scale of a halo, never a turn); under reduced motion it stands still.
    const motion = (id: string) => mark(id).evaluate((el) => ({ own: getComputedStyle(el).animationName, halo: getComputedStyle(el, "::after").animationName, haloOn: getComputedStyle(el, "::after").content !== "none" && getComputedStyle(el, "::after").display !== "none" }));
    expect(await motion(working)).toEqual({ own: "none", halo: "k-dot-breathe", haloOn: true });
    expect((await motion(done)).haloOn).toBe(false);
    expect((await motion(command)).haloOn, "a session that waits has no halo").toBe(false);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect((await motion(working)).halo).toBe("none");
    await expect(mark(working)).toHaveAttribute("data-watch", "work");
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // News: a white dot at the row's right end, outside the row's end slot; read, it is gone.
    const unread = row(page, news).getByTestId("row-unread");
    await expect(unread).toBeVisible();
    await expect(row(page, done).getByTestId("row-unread")).toHaveCount(0);
    const at = async () => { const r = await row(page, news).boundingBox(), d = await unread.boundingBox(); return { gap: r!.x + r!.width - (d!.x + d!.width), mid: d!.y + d!.height / 2 - r!.y }; };
    const where = await at();
    expect(where.gap, "at the row's right end").toBeLessThan(10);
    expect(where.mid, "on the title's line").toBeLessThan(24);
    expect(await row(page, news).locator(".k-row-end").getByTestId("row-unread").count(), "not in the end slot").toBe(0);
    await dark(page, true);
    const white = await paint(page, "--dot-unread");
    expect(await unread.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(white.color);
    expect(Math.min(...white.rgb), "white in the dark theme").toBeGreaterThan(235);
    await dark(page, false);
    const ink = await paint(page, "--dot-unread");
    expect(await unread.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(ink.color);
    expect(Math.max(...ink.rgb), "the ink in the light theme").toBeLessThan(90);

    await shootList(page, "state-dots-01-list", working);
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
    await expect(wrap.getByTestId("children-total")).toHaveCount(0);
    await expect(wrap.getByTestId("children-summary")).toHaveCount(0);
    expect(await wrap.innerText(), "the sidebar says no number of agents").not.toMatch(/\b\d+ agents?\b/);
    await expect(wrap.getByTestId("child-row")).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(wrap.getByTestId("child-row")).toHaveCount(3);
    expect(await wrap.innerText()).not.toMatch(/\b\d+ agents?\b/);
    await shootList(page, "state-dots-02-tree", lead);
    await toggle.click();
    await expect(wrap.getByTestId("child-row")).toHaveCount(0);

    // The session itself: how many of each state, and a press opens the agents.
    await page.goto(`/s/${lead}`);
    const line = page.getByTestId("dock-agents");
    await expect(line).toBeVisible();
    await expect(line.getByTestId("dock-agents-part")).toHaveText(["2 working", "1 done"]);
    await expect(line).toHaveAttribute("aria-label", "3 agents: 2 working, 1 done");
    await expect(line).toHaveAttribute("aria-description", "Waiting on agents");
    await expect(line.getByTestId("dock-agents-waiting")).toHaveText("Waiting on agents");
    for (const size of SIZES) { await page.setViewportSize(size); await shoot(page, `state-dots-03-session-agents-${size.width}x${size.height}`); }
    await page.setViewportSize(SIZES[0]!);
    // An agent that fails: it is counted, and the session reads Failed until looked at, so it no longer waits on its agents.
    await send(request, lead, script([child("Fetch the notes", "script:billing")]));
    await expect(line.getByTestId("dock-agents-part")).toHaveText(["1 failed", "2 working", "1 done"], { timeout: 60_000 });
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
