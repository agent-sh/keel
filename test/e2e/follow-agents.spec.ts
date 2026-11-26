import { expect, test, type APIRequestContext, type Locator, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: following a coordinator's agents from where the owner is, counted in presses. Each test walks one
// task the way a pointer does it and counts what it took: a press (a click) and a dwell (the pointer held on a
// control until its tooltip shows). The counts before the change are in each test's words.
const MODEL = "scripted:stand-in-strict";
const calls = (l: unknown[]) => `script:calls ${JSON.stringify(l)}`;
const bash = (command: string) => ({ name: "Bash", input: { command } });
const spawn = (message: string) => ({ name: "spawn_agent", input: { message, isolation: "none" } });

async function skipless(request: APIRequestContext) {
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === MODEL), "needs the scripted provider: the stand-in starts agents and runs commands on demand");
}
type Node = { id: string; title: string; session_id: string; status: string };
const treeOf = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/sessions/${id}/agents`)).json()).tree as Node[];
// A coordinator with three agents: two at work on different steps, one that asks the owner.
async function coordinator(request: APIRequestContext, title: string) {
  const { session: s } = await (await request.post("/api/sessions", { data: { model: MODEL, title } })).json();
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "full-auto" } });
  const asker = `Asker\n${calls([{ name: "AskUserQuestion", input: { questions: [{ question: "Which parser should I keep?", header: "Parser", options: [{ label: "Old" }, { label: "New" }], multiSelect: false }] } }])}`;
  await request.post(`/api/sessions/${s.id}/messages`, { data: { text: `script:batch ${JSON.stringify([
    spawn(`Indexer\n${calls([bash("sleep 300; echo index the docs")])}`),
    spawn(`Linter\n${calls([bash("sleep 300; echo lint the tree")])}`),
    spawn(asker),
  ])}` } });
  await expect.poll(async () => (await treeOf(request, s.id)).map((a) => a.title).sort(), { timeout: 30_000 }).toEqual(["Asker", "Indexer", "Linter"]);
  const t = Object.fromEntries((await treeOf(request, s.id)).map((a) => [a.title, a])) as Record<"Indexer" | "Linter" | "Asker", Node>;
  return { id: s.id as string, t, stop: async () => { for (const a of Object.values(t)) await request.post(`/api/sessions/${s.id}/agents/${a.id}/stop`); } };
}
// What a task took.
const counter = (page: Page) => {
  const c = { presses: 0, dwells: 0 };
  return {
    c,
    press: async (l: Locator) => { c.presses++; await l.click(); },
    dwell: async (l: Locator) => { c.dwells++; await l.hover(); await expect(page.locator(".k-tip[data-open]")).toBeVisible(); },
  };
};

test("what each agent is on is read from the tree and from the Agents list with no pointer held on a row", async ({ page, request }) => {
  test.setTimeout(120_000);
  await skipless(request);
  const { id, t, stop } = await coordinator(request, "Follow the lanes");
  try {
    await page.setViewportSize({ width: 1920, height: 1040 });
    // He reads one agent; the coordinator's tree is open in the list, as he left it (the choice is kept).
    await page.addInitScript((c) => localStorage.setItem("keel.agentsOpen", JSON.stringify({ [c]: true })), id);
    await page.goto(`/s/${t.Indexer.session_id}`);
    const { c, press } = counter(page);
    const row = (name: string) => page.getByTestId("child-row").filter({ has: page.getByTestId("child-title").getByText(name, { exact: true }) });
    // Before: each row said "Working" and the step was in its tooltip: a dwell a row, three for three agents.
    // Now each row at work says its step and how long it has been on it, and the one that asks says what it asks.
    await expect(row("Indexer").getByTestId("child-why")).toContainText("sleep 300; echo index the docs", { timeout: 30_000 });
    await expect(row("Linter").getByTestId("child-why")).toContainText("sleep 300; echo lint the tree", { timeout: 30_000 });
    await expect(row("Indexer").getByTestId("child-why-time")).toHaveText(/^now$|^\d+m$/);
    await expect(row("Asker").getByTestId("child-why")).toContainText("Which parser should I keep?", { timeout: 30_000 });
    // The state's one word stays on the row's first line.
    await expect(row("Linter").getByTestId("child-state")).toHaveText("Working");
    await expect(row("Asker").getByTestId("child-state")).toHaveText("Needs you");
    // An agent at work has a still dot: a tree of working agents breathed a halo a row, louder than the one that asks.
    const halo = (name: string) => row(name).locator('.k-mark[data-watch="work"]').evaluate((el) => getComputedStyle(el, "::after").display);
    expect(await halo("Linter")).toBe("none");
    expect(await halo("Indexer")).toBe("none");
    // The row that asks says more than news: no unread dot beside its word, as a session's row.
    await expect(row("Asker").locator('[data-testid="child-unread"], [data-testid="child-fresh"]')).toBeHidden();
    // The line is cut where the row ends, never wrapped: a row is two lines at most.
    expect(await row("Linter").getByTestId("child-session").evaluate((el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(document.documentElement).fontSize))).toBeLessThan(2.8);
    expect(c).toEqual({ presses: 0, dwells: 0 });
    await shoot(page, "follow-agents-01-tree");
    await page.setViewportSize({ width: 1320, height: 860 });
    await shoot(page, "follow-agents-02-tree-1320");
    await page.setViewportSize({ width: 1920, height: 1040 });
    // The list folded: the open tree is a column of ticks under its session's word, one an agent in its state's
    // colour. (They were drawn zero wide: the folded list had an empty gap as tall as the tree.)
    await page.getByTestId("rail-toggle").click();
    const ticks = page.locator(".k-tick-kids").getByTestId("child-session");
    await expect(ticks).toHaveCount(3);
    for (const t of await ticks.all()) expect((await t.boundingBox())!.width).toBeGreaterThan(4);
    await expect(page.locator('.k-tick-kids [data-testid="child-session"][data-watch="need"]')).toHaveCount(1);
    await shoot(page, "follow-agents-02b-folded");
    await page.getByTestId("rail-toggle").click();
    // In the coordinator, the Agents list over the box says the same: one press. Before, its rows said the
    // agent's type and its age.
    await page.goto(`/s/${id}`);
    await press(page.getByTestId("dock-agents"));
    const listed = (name: string) => page.getByTestId("bg-agent").filter({ has: page.getByTestId("bg-agent-title").getByText(name, { exact: true }) });
    await expect(listed("Linter").getByTestId("bg-agent-on")).toContainText("sleep 300; echo lint the tree");
    await expect(listed("Linter").getByTestId("bg-agent-state")).toHaveText("Working");
    expect(c).toEqual({ presses: 1, dwells: 0 });
    await shoot(page, "follow-agents-03-list");
  } finally { await stop(); }
});

test("reading one agent, what two others ask is answered in four presses and he is back where he read", async ({ page, request }) => {
  test.setTimeout(120_000);
  await skipless(request);
  const { session: s } = await (await request.post("/api/sessions", { data: { model: MODEL, title: "Land the week" } })).json();
  const id = s.id as string;
  const stopAll = async () => { for (const a of await treeOf(request, id)) await request.post(`/api/sessions/${id}/agents/${a.id}/stop`); };
  try {
    // One agent at work (the one he reads), then two that wait on him: a question, and a command to allow.
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:batch ${JSON.stringify([spawn(`Reader\n${calls([bash("sleep 300; echo read")])}`)])}` } });
    await expect.poll(async () => (await treeOf(request, id)).map((a) => a.title), { timeout: 30_000 }).toEqual(["Reader"]);
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
    const asker = `Asker\n${calls([{ name: "AskUserQuestion", input: { questions: [{ question: "Which parser should I keep?", header: "Parser", options: [{ label: "Old" }, { label: "New" }], multiSelect: false }] } }])}`;
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:batch ${JSON.stringify([spawn(asker), spawn(`Pusher\n${calls([bash("touch pushed.txt")])}`)])}` } });
    await expect.poll(async () => (await treeOf(request, id)).length, { timeout: 30_000 }).toBe(3);
    const reader = (await treeOf(request, id)).find((a) => a.title === "Reader")!;
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`/s/${reader.session_id}`);
    const { c, press } = counter(page);
    const helm = page.locator(".k-station[data-helm]");
    const title = helm.getByTestId("session-title");
    // Before: nothing in an agent's pane said that others wait. The way was the coordinator's row in the list (one
    // press), its cards (three), then the tree and the agent's row to come back (two): six, five with the tree open.
    // Now the pane's dock says who waits, and a press on it goes the answering sequence's way.
    const others = helm.getByTestId("dock-others");
    await expect(others).toHaveText("2 need you", { timeout: 45_000 });
    await shoot(page, "follow-agents-04-others");
    await press(others);
    // Each answer moves on to the next that waits; the last one leads back.
    for (let i = 0; i < 2; i++) {
      await expect(title).toHaveText(/^(Asker|Pusher)$/, { timeout: 20_000 });
      const asks = helm.getByTestId("composer-asks");
      await expect(asks.locator("[data-ask-card]")).toHaveCount(1, { timeout: 20_000 });
      if ((await title.innerText()) === "Asker") {
        await press(asks.getByRole("radio", { name: "New" }));
        await press(asks.getByRole("button", { name: "Answer", exact: true }));
        await expect(title).not.toHaveText("Asker", { timeout: 20_000 });
      } else {
        await press(asks.getByRole("button", { name: /^Allow once/ }));
        await expect(title).not.toHaveText("Pusher", { timeout: 20_000 });
      }
    }
    await expect(title).toHaveText("Reader", { timeout: 20_000 });
    await expect(page).toHaveURL(new RegExp(`/s/${reader.session_id}`));
    expect(c).toEqual({ presses: 4, dwells: 0 });
    // Nothing waits: the dock says nothing of it.
    await expect(others).toHaveCount(0);
  } finally { await stopAll(); }
});

test("a finished agent's report is read beside its row in one press, without leaving the agent he reads", async ({ page, request }) => {
  test.setTimeout(120_000);
  await skipless(request);
  const { session: s } = await (await request.post("/api/sessions", { data: { model: MODEL, title: "Ship the notes" } })).json();
  const id = s.id as string;
  const stopAll = async () => { for (const a of await treeOf(request, id)) await request.post(`/api/sessions/${id}/agents/${a.id}/stop`); };
  try {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:batch ${JSON.stringify([spawn(`Reader\n${calls([bash("sleep 300; echo read")])}`)])}` } });
    await expect.poll(async () => (await treeOf(request, id)).map((a) => a.title), { timeout: 30_000 }).toEqual(["Reader"]);
    const reader = (await treeOf(request, id)).find((a) => a.title === "Reader")!;
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.addInitScript((c) => localStorage.setItem("keel.agentsOpen", JSON.stringify({ [c]: true })), id);
    await page.goto(`/s/${reader.session_id}`);
    const row = (name: string) => page.getByTestId("child-row").filter({ has: page.getByTestId("child-title").getByText(name, { exact: true }) });
    await expect(row("Reader")).toBeVisible({ timeout: 30_000 });
    // While he reads, another agent ends with a report.
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:batch ${JSON.stringify([spawn(`Scout\n${calls([bash("echo scouted the notes")])}`)])}` } });
    await expect(row("Scout").getByTestId("child-state")).toHaveText("Done", { timeout: 45_000 });
    await expect(row("Scout").getByTestId("child-fresh")).toBeVisible();
    const { c, press } = counter(page);
    // Before: the report was in the agent's own session: its row (a page turned), then the row of the agent he was
    // reading to come back: two presses, three with the tree folded. Now it opens beside the row.
    await row("Scout").hover();
    await press(row("Scout").getByTestId("child-report"));
    const peek = page.getByTestId("report-peek");
    await expect(peek.getByTestId("report-peek-body")).toContainText("scouted the notes", { timeout: 20_000 });
    await expect(peek.locator(".k-surface-title")).toHaveText("Scout");
    expect(c).toEqual({ presses: 1, dwells: 0 });
    // He is where he was, and the report was looked at: its row's mark is gone.
    await expect(page).toHaveURL(new RegExp(`/s/${reader.session_id}`));
    await expect(row("Scout").getByTestId("child-fresh")).toHaveCount(0);
    // It stands beside the list, in the window, and scrolls inside itself.
    const box = (await peek.boundingBox())!, rail = (await row("Scout").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(rail.x + rail.width - 40);
    expect(box.y + box.height).toBeLessThanOrEqual(1040);
    await shoot(page, "follow-agents-05-report");
    await page.keyboard.press("Escape");
    await expect(peek).toHaveCount(0);
    // An agent at work has no report to read yet.
    await row("Reader").hover();
    await expect(row("Reader").getByTestId("child-report")).toHaveCount(0);
    // From the coordinator: the Agents list, then the report beside the whole list; its head leads into the session.
    await page.goto(`/s/${id}`);
    await press(page.getByTestId("dock-agents"));
    const listed = page.getByTestId("bg-agent").filter({ has: page.getByTestId("bg-agent-title").getByText("Scout", { exact: true }) });
    await press(listed.getByTestId("bg-agent-report"));
    await expect(peek.getByTestId("report-peek-body")).toContainText("scouted the notes", { timeout: 20_000 });
    expect(c).toEqual({ presses: 3, dwells: 0 });
    // Beside the list, on the side that has the room: it covers none of the list's rows.
    const list = (await page.getByTestId("background-popup").boundingBox())!, beside = (await peek.boundingBox())!;
    expect(beside.x + beside.width <= list.x + 1 || beside.x >= list.x + list.width - 1).toBe(true);
    await shoot(page, "follow-agents-06-report-list");
    await peek.getByTestId("report-peek-open").click();
    const scout = (await treeOf(request, id)).find((a) => a.title === "Scout")!;
    await expect(page).toHaveURL(new RegExp(`/s/${scout.session_id}`));
    await expect(peek).toHaveCount(0);
  } finally { await stopAll(); }
});
