import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: what each agent is doing now. A coordinator starts three agents:
// one thinks, then runs a long command; one runs a command after another with
// no thinking; one asks the owner. The agent line in the coordinator and the
// sidebar's tree show, for each, the newest sentence of its thinking, else the
// call it runs as the transcript says it, else that it needs the owner, with
// its steps, time and spend, and the line changes as the agent works. The
// daemon tells a line at most every 15 s an agent, only to a page that shows
// the tree. The coordinator's status read has one line per live agent of its
// tree and none of another tree's, and asks no model.
test("each agent's line says what it is doing now", async ({ page, request }) => {
  test.setTimeout(180_000);
  const model = "scripted:stand-in-strict";
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === model), "needs the scripted provider: the stand-in thinks and calls tools on demand");
  const made: string[] = [];
  const session = async (title: string) => {
    const { session: s } = await (await request.post("/api/sessions", { data: { model, title } })).json();
    made.push(s.id);
    await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "full-auto" } });
    return s.id as string;
  };
  const calls = (l: unknown[]) => `script:calls ${JSON.stringify(l)}`;
  const spawn = (message: string) => ({ name: "spawn_agent", input: { message, isolation: "none" } });
  type Line = { agent_id: string; text: string; from: string; steps: number; usd: number; since: number; need?: boolean };
  const nowOf = async (id: string) => (await (await request.get(`/api/automation/now?session=${id}`)).json()) as { lines: Line[]; text: string };
  try {
    const id = await session("Coordinator");
    // Frames of the page's socket: how often each agent's line was told.
    const told = new Map<string, { at: number; need: boolean }[]>();
    page.on("websocket", (ws) => ws.on("framereceived", (f) => {
      const s = String(f.payload);
      if (!s.includes('"agents_now"')) return;
      for (const l of JSON.parse(s).data.lines as Line[]) (told.get(l.agent_id) ?? told.set(l.agent_id, []).get(l.agent_id)!).push({ at: Date.now(), need: !!l.need });
    }));
    await page.goto(`/s/${id}`);
    const thinker = `Thinker\n${calls([
      { name: "Bash", input: { command: "sleep 20; echo read" }, think: "First I look at how the store keeps agents. Reading the store schema." },
      { name: "Bash", input: { command: "sleep 30; echo checked" }, think: "The schema has the column. Checking the migration next." },
    ])}`;
    const runner = `Runner\n${calls([1, 2, 3, 4, 5, 6].map((n) => ({ name: "Bash", input: { command: `sleep 6; echo pass-${n}` } })))}`;
    const asker = `Asker\n${calls([{ name: "AskUserQuestion", input: { questions: [{ question: "Which store should I use?", header: "Store", options: [{ label: "SQLite" }, { label: "Valkey" }], multiSelect: false }] } }])}`;
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:batch ${JSON.stringify([spawn(thinker), spawn(runner), spawn(asker)])}` } });

    // The three lines, each from what its agent does.
    await expect.poll(async () => (await nowOf(id)).lines.length, { timeout: 30_000 }).toBe(3);
    const started = page.locator('[data-testid="work-step"][data-family="agents"]').locator("button.k-line").first();
    await expect(started).toBeVisible({ timeout: 30_000 });
    await started.click();
    const card = (title: string) => page.getByTestId("agent-call").filter({ hasText: title });
    await expect(card("Thinker").getByTestId("agent-now-text")).toHaveText("Reading the store schema.", { timeout: 20_000 });
    await expect(card("Thinker").getByTestId("agent-now")).toHaveAttribute("data-from", "thinking");
    await expect(card("Runner").getByTestId("agent-now-text")).toHaveText(/^Running sleep 6; echo pass-\d$/, { timeout: 20_000 });
    await expect(card("Asker").getByTestId("agent-now")).toHaveAttribute("data-need", "true", { timeout: 20_000 });
    await expect(card("Asker").getByTestId("agent-now-text")).toHaveText("Asking you");
    // Its steps and spend are the ledger's, as the daemon reads them.
    const first = await nowOf(id);
    const runnerLine = first.lines.find((l) => l.text.startsWith("Running"))!;
    await expect(card("Runner").getByTestId("agent-now-meta")).toContainText(`${runnerLine.steps} step`);

    // The status read: one line per live agent of this tree, none of another tree's, and no model request.
    const other = await session("Another tree");
    await request.post(`/api/sessions/${other}/messages`, { data: { text: `script:batch ${JSON.stringify([spawn(`Elsewhere\n${calls([{ name: "Bash", input: { command: "sleep 40" } }])}`)])}` } });
    await expect.poll(async () => (await nowOf(other)).lines.length, { timeout: 30_000 }).toBe(1);
    const usage = async () => JSON.stringify((await (await request.get(`/api/sessions/${id}`)).json()).session.usage);
    const before = await usage();
    const status = (await nowOf(id)).text;
    expect(status.split("\n")).toHaveLength(3);
    for (const name of ["Thinker", "Runner", "Asker (", "needs the owner"]) expect(status).toContain(name);
    expect(status).not.toContain("Elsewhere");
    expect(await usage()).toBe(before);
    await shoot(page, "agent-now-01-cards");

    // The lines change as the agents work: the runner's command, the thinker's next sentence.
    const was = await card("Runner").getByTestId("agent-now-text").textContent();
    await expect(card("Runner").getByTestId("agent-now-text")).not.toHaveText(was!, { timeout: 25_000 });
    await expect(card("Thinker").getByTestId("agent-now-text")).toHaveText("Checking the migration next.", { timeout: 30_000 });

    // The sidebar's tree is one line a row: the same line is the row's tooltip, with its steps, time and cost.
    const row = page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`).locator("xpath=..");
    const toggle = row.getByTestId("children-toggle");
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    const kid = (title: string) => row.getByTestId("child-row").filter({ hasText: title });
    await expect(row.getByTestId("agent-now")).toHaveCount(0);
    await expect(kid("Thinker").getByTestId("child-session")).toHaveAttribute("title", /Checking the migration next\./, { timeout: 20_000 });
    await shoot(page, "agent-now-02-tree");

    // At most one telling a line every 15 s (a little less for the timer's own beat), for every agent told twice.
    // A line whose owner's part changed is told at once by design (dueAt): the asker's first line can come a
    // moment before its question does, so that telling is not counted.
    const gaps = [...told.values()].flatMap((ts) => ts.slice(1).flatMap((t, i) => (t.need === ts[i]!.need ? [t.at - ts[i]!.at] : [])));
    expect(gaps.length).toBeGreaterThan(0);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(14_000);
    // Of another tree, the page that shows none of it hears nothing.
    const elsewhere = (await nowOf(other)).lines[0]!.agent_id;
    expect(told.has(elsewhere)).toBe(false);
  } finally {
    for (const s of made) await request.delete(`/api/sessions/${s}`);
  }
});
