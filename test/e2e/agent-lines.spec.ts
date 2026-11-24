import { expect, test, type APIRequestContext } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a parent's page shows its agents live. Under the step that started
// them, while any agent of the tree works, one line per agent of the whole
// tree: name, place (a step further in a level), its state word, what it does
// now, how long it has worked, a needs-you mark, and a press that opens it.
// The home screen at a desk lists the sessions at work, each with its step and
// time. An agent's own page names the way up its tree in its head, each step a
// link. All on the scripted stand-in.
const MODEL = "scripted:stand-in-strict";
const calls = (l: unknown[]) => `script:calls ${JSON.stringify(l)}`;
const bash = (command: string) => ({ name: "Bash", input: { command } });
const spawn = (message: string) => ({ name: "spawn_agent", input: { message, isolation: "none" } });

async function skipless(request: APIRequestContext) {
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === MODEL), "needs the scripted provider: the stand-in starts agents and runs commands on demand");
}
async function session(request: APIRequestContext, title: string) {
  const { session: s } = await (await request.post("/api/sessions", { data: { model: MODEL, title } })).json();
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "full-auto" } });
  return s.id as string;
}
type Node = { id: string; title: string; session_id: string; parent_id: string; depth: number; status: string };
const treeOf = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/sessions/${id}/agents`)).json()).tree as Node[];
// A tree three deep: a coordinator that starts a worker, and an asker beside it, all at work until stopped.
async function tree(request: APIRequestContext, id: string) {
  const worker = `Worker\n${calls([bash("sleep 300; echo worker")])}`;
  const coordinator = `Coordinator\n${calls([spawn(worker), bash("sleep 300; echo coordinator")])}`;
  const asker = `Asker\n${calls([{ name: "AskUserQuestion", input: { questions: [{ question: "Which parser should I keep?", header: "Parser", options: [{ label: "Old" }, { label: "New" }], multiSelect: false }] } }])}`;
  await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:batch ${JSON.stringify([spawn(coordinator), spawn(asker)])}` } });
  await expect.poll(async () => (await treeOf(request, id)).map((a) => `${a.title}:${a.depth}`).sort(), { timeout: 30_000 }).toEqual(["Asker:1", "Coordinator:1", "Worker:2"]);
  const t = await treeOf(request, id);
  return Object.fromEntries(t.map((a) => [a.title, a])) as Record<"Coordinator" | "Worker" | "Asker", Node>;
}
const stopAll = async (request: APIRequestContext, root: string, t: Record<string, Node>) => {
  for (const a of [t.Coordinator!, t.Asker!]) await request.post(`/api/sessions/${root}/agents/${a.id}/stop`);
};

test("under the step that started them, a line per agent of the whole tree", async ({ page, request }) => {
  test.setTimeout(120_000);
  await skipless(request);
  const id = await session(request, "Refactor the parser");
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${id}`);
  const t = await tree(request, id);
  const step = page.locator('[data-testid="work-step"][data-family="agents"]').first();
  const lines = step.getByTestId("agent-lines").getByTestId("agent-line");
  // The whole tree, in its order: each agent's own agents right under it, a level further in.
  await expect(lines).toHaveCount(3, { timeout: 30_000 });
  const names = await lines.getByTestId("agent-line-name").allTextContents();
  expect(names.indexOf("Worker")).toBe(names.indexOf("Coordinator") + 1);
  const line = (name: string) => lines.filter({ has: page.getByTestId("agent-line-name").getByText(name, { exact: true }) });
  await expect(line("Worker")).toHaveAttribute("data-depth", "2");
  await expect(line("Coordinator")).toHaveAttribute("data-depth", "1");
  // One state word, what it does now and how long it has worked.
  await expect(line("Worker").getByTestId("agent-line-state")).toHaveText("Working", { timeout: 20_000 });
  await expect(line("Worker").getByTestId("agent-line-step")).toContainText("sleep 300; echo worker", { timeout: 20_000 });
  await expect(line("Worker").getByTestId("agent-line-time")).toHaveText(/^\d+s$|^\d+m \d\ds$/);
  // The agent that asks the owner carries the mark, and its press goes where it asks.
  await expect(line("Asker")).toHaveAttribute("data-need", "true", { timeout: 20_000 });
  await expect(line("Asker").getByTestId("agent-line-need")).toHaveText("Needs you");
  await expect(line("Asker").getByTestId("agent-line-step")).toContainText("Which parser should I keep?");
  // The agent's name is whole: nothing beside it cuts it.
  expect(await line("Coordinator").getByTestId("agent-line-name").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await shoot(page, "agent-lines-01-tree");
  await page.setViewportSize({ width: 1400, height: 900 });
  await shoot(page, "agent-lines-02-tree-1400");
  await page.setViewportSize({ width: 1920, height: 1040 });
  // A press opens the agent two levels down.
  await line("Worker").click();
  await expect(page).toHaveURL(new RegExp(`/s/${t.Worker.session_id}`));
  await page.goBack();
  // Once nothing of the tree works, the lines go: the step is one line again.
  await stopAll(request, id, t);
  await expect(step.getByTestId("agent-lines")).toHaveCount(0, { timeout: 30_000 });
});

test("the home screen at a desk lists the sessions at work, with the step and its time", async ({ page, request }) => {
  test.setTimeout(90_000);
  await skipless(request);
  const id = await session(request, "Reindex the docs");
  await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([bash("sleep 300; echo reindex")]) } });
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto("/");
  const row = page.getByTestId("home-working").locator(`[data-session="${id}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByTestId("home-kind")).toHaveText("Working");
  await expect(row).toContainText("sleep 300; echo reindex");
  await expect(row.getByTestId("home-clock")).toHaveText(/^\d+s$|^\d+m/);
  await shoot(page, "agent-lines-03-home");
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(row).toBeVisible();
  await shoot(page, "agent-lines-04-home-1400");
  await page.setViewportSize({ width: 1920, height: 1040 });
  await request.post(`/api/sessions/${id}/interrupt`);
});

test("an agent's head names the way up its tree, each step a link", async ({ page, request }) => {
  test.setTimeout(120_000);
  await skipless(request);
  const id = await session(request, "Refactor the billing parser");
  const t = await tree(request, id);
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${t.Worker.session_id}`);
  const crumbs = page.getByTestId("station-head").getByTestId("station-crumbs");
  // The root by its title; the agents between as one link up where the head has the room of a desk's.
  const root = crumbs.getByTestId("station-crumb").first();
  await expect(root).toHaveText("Refactor the billing parser");
  await expect(root).toHaveAttribute("href", `/s/${id}`);
  await expect(crumbs.getByTestId("station-crumb").filter({ hasText: "Coordinator" })).toHaveAttribute("href", `/s/${t.Coordinator.session_id}`);
  await shoot(page, "agent-lines-05-crumbs");
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(crumbs).toBeVisible();
  await shoot(page, "agent-lines-06-crumbs-1400");
  await page.setViewportSize({ width: 1920, height: 1040 });
  // Up one: the coordinator's page names its root alone.
  const up = crumbs.locator('[data-testid="station-crumb-up"]:visible, [data-testid="station-crumb"]:visible').filter({ hasNotText: "Refactor the billing parser" }).first();
  await up.click();
  await expect(page).toHaveURL(new RegExp(`/s/${t.Coordinator.session_id}`));
  await expect(page.getByTestId("station-head").getByTestId("station-crumb")).toHaveCount(1);
  // Up to the root: a session that is nobody's agent has no way up.
  await page.getByTestId("station-head").getByTestId("station-crumb").click();
  await expect(page).toHaveURL(new RegExp(`/s/${id}$`));
  await expect(page.getByTestId("station-head").getByTestId("station-crumbs")).toHaveCount(0);
  await stopAll(request, id, t);
});
