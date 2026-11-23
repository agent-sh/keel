import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: agents are named by their task's title. A coordinator starts
// three agents in one step whose messages begin alike and differ in one digit
// mid-line: one sent with Codex's `task_name`, two with the message alone. The
// step's line, each agent's card and the sidebar's tree name them "Harness N
// cache study" (the task name, else the message's first sentence), never the
// first 80 characters of the message.
test("agents are named by their task's title, not their message's first 80 characters", async ({ page, request }) => {
  test.setTimeout(120_000);
  const model = "scripted:stand-in";
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === model), "needs the scripted provider: the stand-in starts agents on demand");
  const study = (n: number) => `Harness ${n} cache study. Study how harness ${n} saves prompt-cache tokens. Report the numbers with sources and the files you read.`;
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "Cache studies" } })).json();
  const id = session.id as string;
  try {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto" } });
    await page.goto(`/s/${id}`);
    const spawns = [
      { name: "spawn_agent", input: { task_name: "harness_1_cache_study", message: study(1), isolation: "none" } },
      { name: "spawn_agent", input: { message: study(2), isolation: "none" } },
      { name: "spawn_agent", input: { message: study(3), isolation: "none" } },
    ];
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:batch ${JSON.stringify(spawns)}` } });
    const names = ["Harness 1 cache study", "Harness 2 cache study", "Harness 3 cache study"];

    // What the daemon calls them.
    const titles = async () => ((await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as { title: string }[]).map((a) => a.title).sort();
    await expect.poll(titles, { timeout: 30_000 }).toEqual(names);

    // The step's line names the three, each card by its title.
    const step = page.locator('[data-testid="work-step"][data-family="agents"]').first();
    await expect(step).toBeVisible({ timeout: 30_000 });
    for (const n of names) await expect(step).toContainText(n);
    await expect(step).not.toContainText("saves prompt-cache");
    await step.locator("button.k-line").first().click();
    const cards = page.getByTestId("agent-call-title");
    await expect(cards).toHaveCount(3);
    for (const n of names) await expect(cards.filter({ hasText: n })).toHaveCount(1);
    await expect(cards.filter({ hasText: "saves prompt-cache" })).toHaveCount(0);

    // The sidebar's tree: one row each, by the same name.
    const row = page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`).locator("xpath=..");
    const toggle = row.getByTestId("children-toggle");
    await expect(toggle).toBeVisible({ timeout: 20_000 });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    const kids = row.getByTestId("child-row");
    await expect(kids).toHaveCount(3);
    for (const n of names) await expect(kids.filter({ hasText: n })).toHaveCount(1);
    await expect(kids.filter({ hasText: "saves prompt-cache" })).toHaveCount(0);
    await shoot(page, "agent-names-01-tree");
    await page.setViewportSize({ width: 390, height: 844 });
    await shoot(page, "agent-names-02-phone");
  } finally {
    await request.delete(`/api/sessions/${id}`);
  }
});
