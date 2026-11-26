import { expect, test, type Route } from "./isolate.ts";
import { openPanel, shoot } from "./shots.ts";

// Feature: a panel that lists a session's agents shows what is live (working, needs the owner, waits, queued)
// and what ended lately or since the owner looked, then one row, "N earlier", that opens the rest a page at a
// time. A coordinator with 40 agents at rest and 3 at work lists the 3, the two that ended a moment ago and the
// failure nobody has seen, and "36 earlier"; the agents line above keeps counting all 43. The same fold is in
// the session's Background popover and the work board. On the scripted stand-in; the page is told the old
// agents ended hours ago (the daemon cannot make time pass).
const STAND_IN = "scripted:stand-in";
const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;
const child = (title: string, body: string) => ({ name: "spawn_agent", input: { message: `${title}\n${body}`, isolation: "none" } });
const HOUR = 3_600_000;

test("a coordinator's agents list shows what is live and recent, and folds the rest behind 'N earlier'", async ({ page, request }) => {
  test.setTimeout(300_000);
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "needs KEEL_SCRIPTED_PROVIDER=1: the scripted model starts the agents");
  const tag = Date.now().toString(36);
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: `Coordinator ${tag}` } })).json();
  const { session: other } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: `Elsewhere ${tag}` } })).json();
  const parent = session.id as string;
  try {
    await request.put(`/api/sessions/${parent}/permissions`, { data: { mode: "full-auto" } });
    await request.patch(`/api/sessions/${parent}/agents`, { data: { limit: 60 } });
    const long = script([{ name: "Bash", input: { command: "sleep 300; echo one" } }]);
    const calls = [
      ...Array.from({ length: 36 }, (_, i) => child(`Old helper ${i + 1} ${tag}`, "script:say Done.")),
      child(`Unseen failure ${tag}`, "script:billing"),
      ...Array.from({ length: 2 }, (_, i) => child(`Recent helper ${i + 1} ${tag}`, "script:say Done.")),
      child(`Old failure ${tag}`, "script:billing"),
      ...Array.from({ length: 3 }, (_, i) => child(`Live helper ${i + 1} ${tag}`, long)),
    ];
    await request.post(`/api/sessions/${parent}/messages`, { data: { text: script(calls) } });
    type Agent = { title: string; status: string };
    const agents = async () => (await (await request.get(`/api/sessions/${parent}/agents`)).json()).agents as Agent[];
    await expect.poll(async () => (await agents()).filter((a) => a.status === "running").length, { timeout: 180_000 }).toBe(3);
    await expect.poll(async () => (await agents()).filter((a) => a.status !== "running").length, { timeout: 180_000 }).toBe(40);

    // The page is told when each ended: the old ones before the owner first looked (3 hours ago), the
    // unseen failure after it but not lately, the two recent ones a moment ago.
    // (Fixed times: the page marks an end seen by its time, and the board and the list must say the same one.)
    const t0 = Date.now();
    const endedAt = (title: string, real: number | null | undefined) =>
      title.startsWith("Old ") ? t0 - 4 * HOUR : title.startsWith("Unseen ") ? t0 - HOUR : real;
    const age = async (route: Route, pick: (j: any) => any[]) => {
      const res = await route.fetch();
      const j = await res.json();
      for (const a of pick(j)) if (a.ended) a.ended = endedAt(a.title, a.ended);
      await route.fulfill({ response: res, json: j });
    };
    await page.route("**/api/automation", (r) => (r.request().method() === "GET" ? age(r, (j) => j.agents) : r.continue()));
    await page.route("**/api/sessions/*/board*", (r) => age(r, (j) => j.rows));
    await page.addInitScript(([since, key, id]) => {
      localStorage.setItem("keel.agentsSeen", JSON.stringify({ since, seen: {} }));
      localStorage.setItem("keel.agentsOpen", JSON.stringify({ [key]: true }));
      void id;
    }, [t0 - 3 * HOUR, parent, ""] as const);

    // Elsewhere: the coordinator's row is in the list but not in view, so its failure stays unseen.
    await page.goto(`/s/${other.id}`);
    const row = page.locator(`[data-testid="session-row"][data-session="${parent}"]`);
    const kids = row.locator("xpath=..").getByTestId("session-children");
    const toggle = row.getByTestId("children-toggle");
    await expect(toggle).toHaveAccessibleName("Hide agents", { timeout: 60_000 });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await shoot(page, "agents-live-01-open");

    // Listed: the 3 at work, the 2 that ended a moment ago and the failure not seen; the other 37 are one row.
    const rows = kids.getByTestId("child-row");
    await expect(rows).toHaveCount(6);
    const titles = () => kids.getByTestId("child-title").allInnerTexts();
    expect((await titles()).filter((t) => t.startsWith("Live helper")).length).toBe(3);
    expect((await titles()).filter((t) => t.startsWith("Recent helper")).length).toBe(2);
    expect((await titles()).filter((t) => t.startsWith("Unseen failure")).length).toBe(1);
    const earlier = kids.getByTestId("agents-earlier");
    await expect(earlier).toHaveAttribute("data-count", "37");
    await expect(earlier).toContainText("37 earlier");
    await shoot(page, "agents-live-02-folded");

    // A page of the earlier ones at a time, the newest first.
    await earlier.click();
    await expect(rows).toHaveCount(26);
    await expect(earlier).toHaveAttribute("data-count", "17");
    await earlier.click();
    await expect(rows).toHaveCount(43);
    await expect(earlier).toHaveCount(0);
    await shoot(page, "agents-live-03-all");
    // Folded and opened again, the list is folded again.
    await toggle.click();
    await toggle.click();
    await expect(rows).toHaveCount(6);
    await expect(earlier).toHaveAttribute("data-count", "37");

    // At a laptop's width and a phone's, the row fits its line.
    for (const [width, height] of [[1366, 768], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(`/s/${other.id}`);
      if (width < 500) await page.getByTestId("show-sidebar").click();
      await expect(earlier).toBeVisible();
      const fit = await earlier.evaluate((el) => { const r = el.getBoundingClientRect(), p = el.parentElement!.getBoundingClientRect(); return { h: Math.round(r.height), over: Math.round(r.right - p.right) }; });
      expect(fit.h, `the earlier row at ${width}`).toBeLessThanOrEqual(30);
      expect(fit.over, `the earlier row at ${width} fits its list`).toBeLessThanOrEqual(0);
      await shoot(page, `agents-live-06-folded-${width}`);
    }
    await page.setViewportSize({ width: 1920, height: 1040 });

    // The session's own view: its Background popover and the work board fold the same way.
    await page.goto(`/s/${parent}`);
    const tally = page.getByTestId("dock-agents");
    await expect(tally).toHaveAccessibleName("Agents: 43 agents: 2 failed, 3 working, 38 done");
    await tally.click();
    const bg = page.getByTestId("background-popup");
    await expect.poll(() => bg.getByTestId("bg-agent").count()).toBe(5); // (the failure is seen now: this session is in view)
    await expect(bg.getByTestId("bg-agents-earlier")).toHaveAttribute("data-count", "38");
    await shoot(page, "agents-live-04-background");
    await bg.getByTestId("bg-agents-earlier").click();
    await expect(bg.getByTestId("bg-agent")).toHaveCount(25);
    await page.keyboard.press("Escape");
    await expect(bg).toBeHidden();
    await page.goto(`/s/${parent}`);

    await openPanel(page, "board");
    const cards = page.getByTestId("board-rows").locator("li[data-agent]");
    await expect.poll(() => cards.count(), { timeout: 30_000 }).toBe(5);
    await expect(page.getByTestId("board-earlier")).toHaveAttribute("data-count", "38");
    await expect(page.getByTestId("work-board")).toContainText("43 agents");
    await shoot(page, "agents-live-05-board");
    await page.getByTestId("board-earlier").click();
    await expect.poll(() => cards.count()).toBe(25);
  } finally {
    await request.post(`/api/sessions/${parent}/interrupt`, { data: { by: "owner" } }).catch(() => {});
    await request.delete(`/api/sessions/${parent}`).catch(() => {});
    await request.delete(`/api/sessions/${other.id}`).catch(() => {});
  }
});
