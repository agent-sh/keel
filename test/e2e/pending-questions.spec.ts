import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

const MODEL = "scripted:stand-in";
const question = { name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color should I use?", options: [{ label: "Teal" }, { label: "Amber" }], multiSelect: false }] } };
const script = (call: unknown) => `script:calls ${JSON.stringify([call])}`;

test("only live questions mark an unopened session and its parent as Needs you", async ({ page, request }) => {
  test.skip(!(await (await request.get("/api/models")).json()).models.some((m: { id: string }) => m.id === MODEL), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const made: string[] = [];
  const create = async (title: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title } })).json();
    const id = session.id as string;
    made.push(id);
    return id;
  };
  const send = async (id: string, call: unknown) => expect((await request.post(`/api/sessions/${id}/messages`, { data: { text: script(call) } })).ok()).toBeTruthy();
  const pending = async (id: string) => (await (await request.get(`/api/sessions/${id}/questions`)).json()).pending as string[];
  const waiting = (id: string) => expect.poll(() => pending(id)).toHaveLength(1);
  const row = (id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);
  const pane = page.getByTestId("station-word");
  const card = page.getByTestId("question");
  const loaded = new Set<string>();
  page.on("request", (r) => {
    const m = new URL(r.url()).pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (r.method() === "GET" && m) loaded.add(m[1]!);
  });
  try {
    const other = await create("Other session");
    const asker = await create("Pick an accent color");
    await send(asker, question);
    await waiting(asker);
    await page.goto(`/s/${other}`);
    await expect(row(asker).getByTestId("row-state")).toHaveText("Needs you");
    await expect(pane).not.toHaveText("Needs you");
    expect(loaded.has(asker)).toBe(false);
    await shoot(page, "pending-questions-01-unopened");

    // Reading its notification does not answer the question.
    expect((await request.post("/api/alerts/read", { data: { session_id: asker } })).ok()).toBeTruthy();
    await expect(row(asker)).not.toHaveAttribute("data-unread", "true");
    await expect(row(asker).getByTestId("row-state")).toHaveText("Needs you");

    await page.getByTestId("rail-toggle").click();
    await expect(row(asker)).toHaveAttribute("data-watch", "need");
    await row(asker).hover();
    await expect(page.getByTestId("rail-card")).toContainText("Needs you");
    await shoot(page, "pending-questions-02-rail");
    await row(asker).click();
    await expect(pane).toHaveText("Needs you");
    await expect(card).toHaveAttribute("data-state", "open");
    await page.getByTestId("rail-toggle").click();
    await shoot(page, "pending-questions-03-pane");
    await card.getByRole("radio", { name: "Amber" }).click();
    await card.getByTestId("question-submit").click();
    await expect(card).toHaveAttribute("data-state", "answered");
    await expect(row(asker)).toHaveAttribute("data-watch", "done");
    await expect(pane).toHaveText("Done");

    // A second question streams in. Stopping the turn closes it, but keeps the transcript.
    await send(asker, question);
    await expect(pane).toHaveText("Needs you");
    await expect(card.last()).toHaveAttribute("data-state", "open");
    expect((await request.post(`/api/sessions/${asker}/interrupt`)).ok()).toBeTruthy();
    await expect(pane).toHaveText("Stopped");
    await expect(card.last()).toHaveAttribute("data-state", "closed");
    expect(await pending(asker)).toEqual([]);
    await page.reload();
    await expect(pane).toHaveText("Stopped");
    await expect(card.last()).toHaveAttribute("data-state", "closed");

    const parent = await create("Parent with a question from an agent");
    await request.put(`/api/sessions/${parent}/permissions`, { data: { mode: "full-auto" } });
    await send(parent, { name: "spawn_agent", input: { message: `Color helper\n${script(question)}` } });
    const agents = async () => (await (await request.get(`/api/sessions/${parent}/agents`)).json()).agents as { session_id: string }[];
    await expect.poll(async () => (await agents())[0]?.session_id).toBeTruthy();
    const child = (await agents())[0]!.session_id;
    await waiting(child);
    await expect.poll(async () => (await (await request.get(`/api/sessions/${parent}`)).json()).running).toBe(false);
    await expect(row(parent).getByTestId("row-state")).toHaveText("Needs you");
    expect(loaded.has(parent)).toBe(false);
    await row(parent).click();
    await expect(pane).toHaveText("Needs you");
    const childLink = page.getByRole("button", { name: /Color helper.*is waiting for your answer/ });
    await expect(childLink).toBeVisible();
    await shoot(page, "pending-questions-04-child-wait");
    expect(loaded.has(child)).toBe(false);
    expect(await pending(parent)).toEqual([]);
    const [callId] = await pending(child);
    expect((await request.post(`/api/sessions/${child}/questions/${callId}`, { data: { answers: { "0": { picked: ["Teal"] } } } })).ok()).toBeTruthy();
    await expect(pane).not.toHaveText("Needs you");
    await expect(row(parent)).not.toHaveAttribute("data-watch", "need");
    await expect(childLink).toHaveCount(0);
  } finally {
    for (const id of made.reverse()) await request.delete(`/api/sessions/${id}`);
  }
});
