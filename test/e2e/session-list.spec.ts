import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the session list a page loads carries the sessions it shows: the
// owner's own, and of the agents' sessions the ones that work, wait, failed
// unseen or are pinned. An agent at rest is counted under its session and
// read when that session's agents are opened. The agents line counts the same
// with the list trimmed and whole, a page reads the list once, and a link to
// an agent that was left out opens it. On the scripted stand-in.
const STAND_IN = "scripted:stand-in";
const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;
const child = (title: string, body: string) => ({ name: "spawn_agent", input: { message: `${title}\n${body}`, isolation: "none" } });
const row = (page: Page, id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);
type Row = { id: string; parent_id?: string | null; title: string };
const list = async (request: APIRequestContext, q = "") => {
  const r = await request.get(`/api/sessions${q}`);
  const text = await r.text();
  return { ...(JSON.parse(text) as { sessions: Row[]; agents_left?: Record<string, number> }), bytes: text.length };
};

test("agents at rest are counted, not listed; the agents line reads the same either way", async ({ page, request }) => {
  test.setTimeout(240_000);
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const tag = Date.now().toString(36);
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: `Many agents ${tag}` } })).json();
  const parent = session.id as string;
  try {
    await request.put(`/api/sessions/${parent}/permissions`, { data: { mode: "full-auto" } });
    // Six agents that finish at once, one that fails, and one that works on for minutes.
    const long = script([{ name: "Bash", input: { command: "sleep 99; echo one" } }, { name: "Bash", input: { command: "sleep 99; echo two" } }]);
    const calls = [...Array.from({ length: 6 }, (_, i) => child(`Finished helper ${i + 1} ${tag}`, "script:say Done.")), child(`Failing helper ${tag}`, "script:billing"), child(`Working helper ${tag}`, long)];
    await request.post(`/api/sessions/${parent}/messages`, { data: { text: script(calls) } });
    type Agent = { session_id: string; title: string; status: string };
    const agents = async () => (await (await request.get(`/api/sessions/${parent}/agents`)).json()).agents as Agent[];
    await expect.poll(async () => (await agents()).map((a) => a.status).sort().join(" "), { timeout: 90_000 }).toBe("completed completed completed completed completed completed failed running");
    const working = (await agents()).find((a) => a.status === "running")!.session_id;
    const failed = (await agents()).find((a) => a.status === "failed")!.session_id;
    const finished = (await agents()).filter((a) => a.status === "completed").map((a) => a.session_id);

    // The list: the working agent and the one whose failure nobody looked at are in it; the six at rest are a count under their session.
    const lean = await list(request), whole = await list(request, "?agents=all");
    const mine = (l: { sessions: Row[] }) => l.sessions.filter((s) => s.parent_id === parent).map((s) => s.id).sort();
    expect(mine(lean)).toEqual([working, failed].sort());
    expect(lean.agents_left?.[parent]).toBe(6);
    expect(mine(whole)).toEqual([working, failed, ...finished].sort());
    expect(whole.agents_left).toBeUndefined();
    expect(lean.sessions.length).toBe(whole.sessions.length - Object.values(lean.agents_left ?? {}).reduce((a, b) => a + b, 0));
    expect(lean.bytes).toBeLessThan(whole.bytes);
    // The ones under a session are read by its id, and each one by its own.
    expect((await list(request, `?agents_of=${parent}`)).sessions.map((s) => s.id).sort()).toEqual([working, failed, ...finished].sort());
    expect((await (await request.get(`/api/sessions/${finished[0]}?events=0`)).json()).session.parent_id).toBe(parent);

    // The page reads the list once, and the agents line counts every agent.
    const reads: string[] = [];
    page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname === "/api/sessions" && r.method() === "GET") reads.push(u.search); });
    await page.goto(`/s/${parent}`);
    const kids = row(page, parent).locator("xpath=..").getByTestId("session-children");
    const toggle = kids.getByTestId("children-toggle");
    const counts = async () => ({
      name: await toggle.getAttribute("aria-label"),
      total: await kids.getByTestId("children-total").innerText(),
      parts: await kids.getByTestId("children-summary").locator("[data-count]").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-watch")} ${e.getAttribute("data-count")}`)),
    });
    await expect(toggle).toHaveAccessibleName("8 agents: 1 failed, 1 working, 6 done", { timeout: 30_000 });
    const trimmed = await counts();
    expect(trimmed.parts).toEqual(["fail 1", "work 1", "done 6"]);
    expect(reads).toEqual([""]);
    // Three states are said in words, on one line: "8 agents 1 failed 1 working 6 done", not marks and figures.
    for (const [part, word] of [["fail", "failed"], ["work", "working"], ["done", "done"]] as const) {
      await expect(kids.getByTestId(`children-${part}`).locator(".k-kids-word")).toBeVisible();
      await expect(kids.getByTestId(`children-${part}`).locator(".k-kids-word")).toHaveText(word);
    }
    await shoot(page, "session-list-01-agents-line");
    expect((await toggle.boundingBox())!.height, "the agents line is one line").toBeLessThanOrEqual(30);

    // Opened: the rows of the ones at rest are read then, once, and every agent is in the tree.
    await toggle.click();
    await expect(kids.getByTestId("child-row")).toHaveCount(8);
    await expect.poll(() => reads).toEqual(["", `?agents_of=${parent}`]);
    await expect(kids.getByTestId("child-title").filter({ hasText: `Finished helper 3 ${tag}` })).toHaveCount(1);
    await shoot(page, "session-list-02-agents-open");
    await toggle.click();
    await toggle.click();
    await expect(kids.getByTestId("child-row")).toHaveCount(8);
    expect(reads).toEqual(["", `?agents_of=${parent}`]);

    // The palette finds a finished agent by its title, whether the page holds its row or not (the daemon's
    // search answers for what the page does not hold, as for an archived session), and opens it. The tree
    // is folded and the page loaded again first: the rows of the agents at rest are not read for it.
    await toggle.click();
    await expect(kids.getByTestId("child-row")).toHaveCount(0);
    await page.goto(`/s/${parent}`);
    await expect(toggle).toHaveAccessibleName("8 agents: 1 failed, 1 working, 6 done", { timeout: 30_000 });
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill(`Finished helper 1 ${tag}`);
    const found = page.locator('[role="option"][id^="palette-opt-t_"], [role="option"][id^="palette-opt-s_"]').filter({ hasText: `Finished helper 1 ${tag}` });
    await expect(found).toHaveCount(1, { timeout: 15_000 });
    await shoot(page, "session-list-03-palette");
    await found.click();
    await expect(page.getByTestId("transcript")).toContainText("Finished helper 1", { timeout: 30_000 });
    expect(new URL(page.url()).pathname.split("/").pop()).toBe((await agents()).find((a) => a.title.startsWith("Finished helper 1 "))!.session_id);

    // A link to an agent that the list left out opens its session.
    await page.goto(`/s/${finished[1]}`);
    await expect(page.getByTestId("transcript")).toContainText(`Finished helper`, { timeout: 30_000 });
    await expect(page.getByTestId("session-missing")).toHaveCount(0);

    // The same page with the whole list, as it was before the trimming: the line counts the same.
    await page.route("**/api/sessions", async (r) => {
      if (r.request().method() !== "GET") return r.continue();
      const all = await (await request.get("/api/sessions?agents=all")).json();
      await r.fulfill({ json: all });
    });
    await page.goto(`/s/${parent}`);
    await expect(toggle).toHaveAccessibleName("8 agents: 1 failed, 1 working, 6 done", { timeout: 30_000 });
    expect(await counts()).toEqual(trimmed);
    await page.unroute("**/api/sessions");

    // At every desk width, the narrowest rail (232px at 1050) included: one line, nothing cut, else marks and figures.
    for (const [width, listW] of [[1050, 232], [1366, 232], [1920, 232], [1050, 0], [1920, 0]] as const) {
      await page.setViewportSize({ width, height: 1040 });
      await page.evaluate((w) => { if (w) localStorage.setItem("keel.listW", String(w)); else localStorage.removeItem("keel.listW"); }, listW);
      await page.goto(`/s/${parent}`);
      await expect(toggle).toHaveAccessibleName("8 agents: 1 failed, 1 working, 6 done", { timeout: 30_000 });
      const fit = () => toggle.evaluate((el) => {
        const sum = el.getBoundingClientRect(), cut = [...el.querySelectorAll<HTMLElement>(".k-kids-part, .k-kids-total")].filter((e) => e.getClientRects().length).map((e) => e.getBoundingClientRect());
        return { h: Math.round(sum.height), over: Math.max(0, ...cut.map((r) => Math.round(r.right - sum.right))), words: el.hasAttribute("data-words") };
      });
      await expect.poll(async () => { const f = await fit(); return f.h <= 30 && f.over <= 0; }, { message: `the agents line at ${width}, list ${listW || "default"}: ${JSON.stringify(await fit())}` }).toBe(true);
      await shoot(page, `session-list-01-agents-line-${width}-${listW || "wide"}`);
    }
    await page.evaluate(() => localStorage.removeItem("keel.listW"));
  } finally {
    await request.post(`/api/sessions/${parent}/interrupt`, { data: { by: "owner" } }).catch(() => {});
    await request.delete(`/api/sessions/${parent}`).catch(() => {});
  }
});
