import { expect, test } from "./isolate.ts";
import { openPanel, shoot } from "./shots.ts";
import { CRITICAL_RULE, mostlyInferred, sourcesPhrase } from "../../src/admin/hours-rows.ts";

// Feature: where a session's and its agents' time went. A session starts an
// agent that runs a command; the session waits for its report. The timeline
// says the tree's bottleneck in one line, and opened, the wall time by class
// along the critical path (the agent's own time, where the session waited
// for it) and each agent's own split. The same answer is a route and a text
// form a coordinator reads in a few lines.
test("where the time went", async ({ page, request }) => {
  const STAND_IN = "scripted:stand-in";
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "needs the scripted provider: the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Hours tree" } })).json();
  try {
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    const child = [{ name: "Bash", input: { command: "sleep 3; echo hours-child" } }];
    const calls = [{ name: "spawn_agent", input: { message: `Hours lane\nscript:calls ${JSON.stringify(child)}`, isolation: "none" } }, { name: "wait_agent", input: {} }];
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
    const agentsOf = async () => (await (await request.get(`/api/sessions/${session.id}/agents`)).json()).agents;
    await expect.poll(async () => (await agentsOf())[0]?.status, { timeout: 90_000 }).toBe("completed");
    const idle = async () => { const d = await (await request.get(`/api/sessions/${session.id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; };
    await expect.poll(idle, { timeout: 60_000 }).toBe(true);
    // The owner's next prompt: the time before it no record covers, read from what started that turn.
    const turns = async () => ((await (await request.get(`/api/sessions/${session.id}`)).json()).events as { kind: string }[]).filter((e) => e.kind === "turn_end").length;
    const before = await turns();
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:say the owner again" } });
    await expect.poll(async () => (await idle()) && (await turns()) > before, { timeout: 60_000 }).toBe(true);

    const t = await (await request.get(`/api/sessions/${session.id}/hours`)).json();
    expect(t.agents).toBe(1);
    const sum = Object.values(t.classes as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(sum).toBe(t.wall_ms);
    expect(t.accounted).toBeGreaterThanOrEqual(0.95);
    // What came from records and what was inferred from what started a next turn, apart.
    expect(t.recorded + t.inferred).toBeCloseTo(t.accounted, 9);
    expect(t.classes.owner).toBeGreaterThan(0);
    expect(mostlyInferred(t, "owner")).toBe(true);
    // The agent's command is on the critical path: the session waited for it.
    expect(t.classes.tools).toBeGreaterThanOrEqual(3000);
    const lane = t.members.find((m: any) => m.depth === 1);
    expect(lane.title).toBe("Hours lane");
    expect(lane.classes.tools).toBeGreaterThanOrEqual(3000);
    // Read by its agent id too, as the agent's own tree.
    const own = await (await request.get(`/api/sessions/${lane.agent_id}/hours`)).json();
    expect(own.root).toBe(lane.session_id);
    const text = await (await request.get(`/api/sessions/${session.id}/hours?format=text`)).text();
    expect(text).toContain('"Hours tree" and 1 agent');
    expect(text).toContain("Along the critical path: ");
    expect(text).toContain('"Hours lane"');
    expect(text).toContain(CRITICAL_RULE);
    expect(text).toContain(`Of the wall time: ${sourcesPhrase(t)}`);
    expect(text.length).toBeLessThan(2000);

    await page.goto(`/s/${session.id}`);
    await openPanel(page, "timeline");
    const hours = page.getByTestId("hours");
    await expect(hours.getByTestId("hours-line")).toHaveText(t.line);
    // The closed line says how a tree is read, on hover.
    await expect(hours.getByTestId("hours-line")).toHaveAttribute("title", `${t.line} ${CRITICAL_RULE}`);
    await hours.getByTestId("hours-toggle").click();
    await expect(hours.getByTestId("hours-class").first()).toBeVisible();
    await expect(hours.locator('[data-testid="hours-class"][data-class="tools"]')).toContainText("Commands and tools");
    await expect(hours.getByTestId("hours-agent")).toContainText("Hours lane");
    await expect(hours.getByTestId("hours-accounted")).toHaveText(sourcesPhrase(t));
    await expect(hours.getByTestId("hours-rule")).toContainText("the time counts as the agent that ends last");
    // A class mostly inferred is marked as such, and only such a class.
    for (const c of Object.keys(t.classes)) {
      const row = hours.locator(`[data-testid="hours-class"][data-class="${c}"]`);
      if (mostlyInferred(t, c as any)) await expect(row).toContainText(", inferred");
      else await expect(row.getByTestId("hours-class-inferred")).toHaveCount(0);
    }
    await expect(hours.getByTestId("hours-bar-inferred").first()).toBeVisible();
    await shoot(page, "hours-01-timeline");
    await page.setViewportSize({ width: 390, height: 844 });
    await openPanel(page, "timeline");
    await expect(page.getByTestId("hours-detail")).toBeVisible();
    await shoot(page, "hours-02-phone");
    await page.setViewportSize({ width: 1920, height: 1040 });
  } finally {
    await request.delete(`/api/sessions/${session.id}`);
  }
});
